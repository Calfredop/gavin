// The Companion's way into a Workstation: what it loads, what it keeps
// current, and where it is looking.
//
// This stands where the desktop's `layoutState.bootstrap()` stands, and
// is deliberately NOT a call to it. That bootstrap is the desk's: it
// starts the rail scheduler and every other duty that must run in one
// place only (the launch queue, auto-resume, the reclaim of idle
// sessions), and it repairs the desk's layout as it goes, saving what it
// repaired. Both are things a Device must never do (ADR 0003; spec,
// story 35).
//
// What it shares with that bootstrap is the important half: it fills the
// SAME stores, through the desktop's own loaders and handlers, so every
// desktop component and logic module the bundle imports reads the state
// it was written against.
import { get, writable, type Readable } from "svelte/store";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { fetchBoard } from "$lib/board/kanbanState";
import * as backend from "$lib/core/backend";
import { gavinTrees, initGavinListeners, refreshGavinTree } from "$lib/core/gavinState";
import { handleSessionStatusChanged, layoutState } from "$lib/core/layoutState";
import { parseSessionStatus } from "$lib/core/notifications";
import type { Workspace, WorkspacesData } from "$lib/core/workspace";
import { themeState } from "$lib/ui/themeState.svelte";
import type { Capabilities } from "$companion/channel/messages";
import type { ChannelPort } from "$companion/channel/port";
import { channel, connectChannel, disconnectChannel } from "$companion/remote/connection";
import {
  backToWorkspaces,
  initialView,
  loadView,
  openWorkspace as openWorkspaceIn,
  reconcileView,
  saveView,
  type ViewState,
  type ViewStorage,
} from "$companion/state/viewState";

export type Connection =
  | { status: "connecting" }
  | {
      status: "ready";
      workstation: Capabilities["workstation"];
      /// Whether the shell carries `return-to-hub`. A page opened
      /// outside the shell has no hub to go back to, and offers no
      /// button that would do nothing.
      canReturnToHub: boolean;
    }
  /// The Workstation could not be asked: its desktop app is not running,
  /// or the connection to it is gone. `reason` is its own.
  | { status: "unavailable"; reason: string };

const connectionStore = writable<Connection>({ status: "connecting" });
const viewStore = writable<ViewState>(initialView());

export const connection: Readable<Connection> = { subscribe: connectionStore.subscribe };
export const view: Readable<ViewState> = { subscribe: viewStore.subscribe };

/// Writes a view down on the Device. Null until a Workstation is
/// connected, since a view belongs to one.
let remember: ((next: ViewState) => void) | null = null;

/// The one door every change of view goes through.
function show(next: ViewState): void {
  viewStore.set(next);
  // The desktop's modules ask `layoutState` which workspace is open.
  // Answering them in memory is what keeps them right on a phone; the
  // desk's own answer is in its config, which this never writes.
  layoutState.update((s) =>
    s.activeWorkspaceId === next.workspaceId ? s : { ...s, activeWorkspaceId: next.workspaceId }
  );
  remember?.(next);
}

export function openWorkspace(workspaceId: string): void {
  if (!get(layoutState).workspaces.some((w) => w.id === workspaceId)) return;
  show(openWorkspaceIn(get(viewStore), workspaceId));
}

export function showWorkspaces(): void {
  show(backToWorkspaces(get(viewStore)));
}

/// Leaves this Workstation for the Workstations hub.
export async function returnToHub(): Promise<void> {
  await channel()?.returnToHub();
}

/// A workspace with a folder has cards; one without has terminals only.
function rooted(workspaces: Workspace[]): Workspace[] {
  return workspaces.filter((w) => Boolean(w.rootPath));
}

/// The boards and trees the workspace list counts from. No watch is
/// armed: the desk already watches every root it has open, and its
/// pushes reach a Device that listens for them. A board or a tree
/// already in hand is left alone -- a push is newer than a read.
function loadCards(workspaces: Workspace[]): void {
  for (const ws of rooted(workspaces)) {
    void fetchBoard(ws.id);
    if (!(ws.id in get(gavinTrees))) void refreshGavinTree(ws.id);
  }
}

function adoptWorkspaces(data: WorkspacesData): void {
  layoutState.update((s) => ({
    ...s,
    status: "ready",
    workspaces: data.workspaces,
    removedWorkspaces: data.removedWorkspaces ?? [],
  }));
  loadCards(data.workspaces);
  const current = get(viewStore);
  const reconciled = reconcileView(
    current,
    data.workspaces.map((w) => w.id)
  );
  if (reconciled !== current) show(reconciled);
}

/// Every session's status as the Workstation holds it now. Written
/// straight into the map rather than through the desktop's change
/// handler: a status that was already in place is not a transition.
async function loadSessions(): Promise<void> {
  const [baselines, sessionNames] = await Promise.all([
    backend.getSessionBaselines().catch(() => null),
    backend.getSessionNames().catch(() => null),
  ]);
  layoutState.update((s) => {
    const sessionStatusById = { ...s.sessionStatusById };
    const statusSinceById = { ...s.statusSinceById };
    const failureReasonById = { ...s.failureReasonById };
    const interruptedSessionIds = new Set(s.interruptedSessionIds);
    for (const b of baselines?.sessions ?? []) {
      if (sessionStatusById[b.id] === undefined) {
        sessionStatusById[b.id] = parseSessionStatus(b.status);
        statusSinceById[b.id] ??= { at: Date.now(), watched: false };
      }
      if (b.interrupted) interruptedSessionIds.add(b.id);
      if (b.failureReason && failureReasonById[b.id] === undefined) {
        failureReasonById[b.id] = b.failureReason;
      }
    }
    return {
      ...s,
      sessionStatusById,
      statusSinceById,
      failureReasonById,
      interruptedSessionIds,
      sessionNames: sessionNames ?? s.sessionNames,
    };
  });
}

/// Connects the bundle to its Workstation and loads what the first
/// surfaces draw. Resolves once the workspace list is in hand -- or once
/// it is known that it cannot be -- with the teardown.
export async function connectWorkstation(
  port: ChannelPort,
  storage: ViewStorage | null
): Promise<() => void> {
  connectionStore.set({ status: "connecting" });
  const client = connectChannel(port);
  const stops: UnlistenFn[] = [];
  const disconnect = (): void => {
    for (const stop of stops.splice(0)) stop();
    remember = null;
    disconnectChannel();
  };

  try {
    const capabilities = await client.capabilities();
    // Listeners before reads: an event sent to nobody is lost, and a
    // change made at the desk between the read and the listener would be
    // one the phone never shows.
    stops.push(
      await listen<[string, string]>("session-status-changed", (event) => {
        handleSessionStatusChanged(event.payload[0], event.payload[1]);
      })
    );
    stops.push(
      await listen<{ origin: string; data: WorkspacesData }>("workspaces-synced", (event) => {
        adoptWorkspaces(event.payload.data);
      })
    );
    stops.push(await initGavinListeners());

    const data = await backend.getWorkspacesState();
    const workstationId = capabilities.workstation.id;
    // Restored BEFORE the workspaces land, and only then made the way
    // views are remembered: restoring must not count as a change.
    viewStore.set(
      reconcileView(
        loadView(storage, workstationId),
        data.workspaces.map((w) => w.id)
      )
    );
    layoutState.update((s) => ({ ...s, activeWorkspaceId: get(viewStore).workspaceId }));
    remember = (next) => saveView(storage, workstationId, next);
    adoptWorkspaces(data);

    connectionStore.set({
      status: "ready",
      workstation: capabilities.workstation,
      canReturnToHub: capabilities.messages.includes("return-to-hub"),
    });
  } catch (e) {
    disconnect();
    connectionStore.set({ status: "unavailable", reason: e instanceof Error ? e.message : String(e) });
    return () => {};
  }

  // Not awaited: neither holds up the list. The theme repaints when it
  // arrives, and a row draws its agents when their statuses do.
  void themeState.init();
  void loadSessions();
  return disconnect;
}
