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
import { handleSessionStatusChanged, layoutState, loadAgentProfiles, reloadAppSettings } from "$lib/core/layoutState";
import { parseSessionStatus } from "$lib/core/notifications";
import type { Workspace, WorkspacesData } from "$lib/core/workspace";
import { themeState } from "$lib/ui/themeState.svelte";
import { applyInitTracking, nameForRoot } from "$lib/workspace/workspaceOpen";
import { adoptSettingsRecord, type WorkspaceSettingsRecord } from "$lib/workspace/workspaceSettings";
import type { Capabilities, Landing } from "$companion/channel/messages";
import type { ChannelPort } from "$companion/channel/port";
import { channel, connectChannel, disconnectChannel } from "$companion/remote/connection";
import {
  backToWorkspaces,
  initialView,
  loadView,
  openWorkspace as openWorkspaceIn,
  placeFiles as placeFilesIn,
  reconcileView,
  saveView,
  showScreen as showScreenIn,
  showSurface as showSurfaceIn,
  type FilesPlace,
  type Screen,
  type Surface,
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
/// Where the shell asked this bundle to land: an inbox item's session or
/// card, until the human goes somewhere else. Not remembered on the
/// Device -- a landing is for this opening alone.
const landingStore = writable<Landing | null>(null);

export const connection: Readable<Connection> = { subscribe: connectionStore.subscribe };
export const view: Readable<ViewState> = { subscribe: viewStore.subscribe };
export const landing: Readable<Landing | null> = { subscribe: landingStore.subscribe };

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
  landingStore.set(null);
  show(openWorkspaceIn(get(viewStore), workspaceId));
}

export function showWorkspaces(): void {
  landingStore.set(null);
  show(backToWorkspaces(get(viewStore)));
}

/// Another surface of the open workspace. A landing is the board's to
/// reveal, and leaving the board is going somewhere else.
export function showSurface(surface: Surface): void {
  const current = get(viewStore);
  if (current.workspaceId === null || current.surface === surface) return;
  landingStore.set(null);
  show(showSurfaceIn(current, surface));
}

/// One of the Workstation's own screens, from the workspace list: its
/// settings, or adding a workspace -- or the list itself again.
export function showScreen(screen: Screen): void {
  landingStore.set(null);
  show(showScreenIn(get(viewStore), screen));
}

/// Where the Files surface has got to, remembered with the rest of the
/// view.
export function placeFiles(place: FilesPlace): void {
  const current = get(viewStore);
  if (current.files?.dir === place.dir && current.files.file === place.file) return;
  show(placeFilesIn(current, place));
}

/// Lands where the shell asked: the item's workspace, with its card (or
/// the card running its session) for the board to reveal. A workspace
/// this Workstation no longer has is not a place, and the view stays
/// where it was remembered.
export function land(where: Landing): void {
  if (!get(layoutState).workspaces.some((w) => w.id === where.workspace)) return;
  landingStore.set(where);
  show(openWorkspaceIn(get(viewStore), where.workspace));
}

/// Leaves this Workstation for the Workstations hub.
export async function returnToHub(): Promise<void> {
  await channel()?.returnToHub();
}

// ---- Settings ----------------------------------------------------------

const saveProblemStore = writable<string | null>(null);

/// Why the last setting the human changed was not saved, or null.
export const saveProblem: Readable<string | null> = { subscribe: saveProblemStore.subscribe };

/// Whether a settings screen has been opened on this connection. Until
/// one has, the app-wide settings are nobody's to keep current, and a
/// change at the desk costs the phone no reads.
let settingsShown = false;
let profilesRead = false;

/// What the settings screens draw: every app-wide setting, read fresh each
/// time one opens, and the agent profile table once a connection -- its
/// model catalogue can cost the desk a subprocess to answer. Through the
/// desktop's own loaders, into the stores its settings panels read.
export async function loadSettings(): Promise<void> {
  settingsShown = true;
  const reads = [reloadAppSettings()];
  if (!profilesRead) {
    profilesRead = true;
    reads.push(loadAgentProfiles());
  }
  await Promise.all(reads);
}

/// Runs one of the desktop's settings writers and says what went wrong.
///
/// Those writers do not throw: a failure goes into the desk's error state,
/// which at the desk is the overlay over the whole window. A phone draws
/// no such overlay, so the failure is taken out of that state -- which is
/// put back -- and shown beside the settings instead. The few writers that
/// do throw (the pause cycle, the launch wall) are caught the same way.
export async function saveSetting(write: () => Promise<unknown>): Promise<void> {
  saveProblemStore.set(null);
  try {
    await write();
  } catch (e) {
    saveProblemStore.set(e instanceof Error ? e.message : String(e));
    return;
  }
  const after = get(layoutState);
  if (after.status === "error") {
    saveProblemStore.set(after.errorMessage);
    layoutState.update((s) => ({ ...s, status: "ready", errorMessage: "" }));
  }
}

export function dismissSaveProblem(): void {
  saveProblemStore.set(null);
}

/// How a folder becomes a workspace: set up for gavin first, with the git
/// question answered, or added as it is.
export interface FolderSetup {
  trackInGit: boolean;
}

/// Adds a workspace on `folder`, named for it as the desk names one it
/// opens (`nameForRoot`), and opens it.
///
/// With `setup`, gavin is scaffolded there first -- before the workspace
/// exists, as the desk's own "Open workspace…" does (workspaceOpen.ts), so
/// the watch each desk window arms for the new root sees the skeleton in
/// its first push. The git question is answered with it, and recorded as
/// asked, so the desk's wizard does not put it again.
///
/// Rejects with the Workstation's words, for the screen to show.
export async function addWorkspace(folder: string, setup: FolderSetup | null): Promise<void> {
  const name = nameForRoot(folder);
  if (setup) {
    await backend.initGavinRoot(folder, name);
    await applyInitTracking(folder, setup.trackInGit);
  }
  const added = await backend.addWorkspace({
    name,
    rootPath: folder,
    ...(setup ? { gitTrackingAsked: true } : {}),
  });
  // The host announces it as `workspaces-synced` as well. Read here too,
  // so the new workspace is in hand before it is opened, whichever of the
  // two lands first.
  adoptWorkspaces(await backend.getWorkspacesState());
  openWorkspace(added.id);
}

/// Another writer's change to one workspace's settings -- the desk, or
/// this phone's own echo, which is the host's copy and so is taken too.
/// Only settings move; the desk's layout of it is not the phone's.
function adoptSettings(record: WorkspaceSettingsRecord): void {
  const before = get(layoutState).workspaces.find((w) => w.id === record.id);
  layoutState.update((s) => ({ ...s, workspaces: adoptSettingsRecord(s.workspaces, record) }));
  const after = get(layoutState).workspaces.find((w) => w.id === record.id);
  // A folder bound or moved at the desk is a board and a tree to read.
  if (after && after.rootPath !== before?.rootPath) loadCards([after]);
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
    settingsShown = false;
    profilesRead = false;
    saveProblemStore.set(null);
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
    stops.push(
      await listen<{ origin: string; record: WorkspaceSettingsRecord }>("workspace-settings-synced", (event) => {
        adoptSettings(event.payload.record);
      })
    );
    // Every app-wide setting read again, as the desk does: the event names
    // none of them. The theme always -- every screen is drawn in it -- and
    // the rest only once a settings screen has drawn them.
    stops.push(
      await listen<{ origin: string }>("app-settings-synced", () => {
        if (settingsShown) void reloadAppSettings();
        else void themeState.reload();
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
    landingStore.set(null);
    if (capabilities.landing) land(capabilities.landing);

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
