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
import {
  handleCwdChanged,
  handleSessionStatusChanged,
  layoutState,
  loadAgentProfiles,
  reloadAppSettings,
} from "$lib/core/layoutState";
import { parseSessionStatus } from "$lib/core/notifications";
import type { Workspace, WorkspacesData } from "$lib/core/workspace";
import { rereadAfterOtherWindowWrote } from "$lib/orchestration/orchestrationState";
import { allSessionIds } from "$lib/panes/layout";
import { destroyTerminal } from "$lib/terminal/terminalRegistry";
import { themeState } from "$lib/ui/themeState.svelte";
import { applyInitTracking, nameForRoot } from "$lib/workspace/workspaceOpen";
import { adoptSettingsRecord, type WorkspaceSettingsRecord } from "$lib/workspace/workspaceSettings";
import type { Capabilities, Landing } from "$companion/channel/messages";
import type { ChannelPort } from "$companion/channel/port";
import {
  DEFAULT_APPEARANCE,
  loadAppearance,
  localThemePref,
  saveAppearance,
  type Appearance,
} from "$companion/state/appearance";
import { channel, connectChannel, disconnectChannel } from "$companion/remote/connection";
import { browserSessionEnded, reassertBrowserViews, startBrowserViews } from "$companion/state/browser";
import { connectionChanged, onReconnect, resetReachability } from "$companion/state/reachability";
import { forgetSession, resetSessions, startedHere } from "$companion/state/sessions";
import { resetTurns, turnMovedOn } from "$companion/state/turn";
import {
  backToWorkspaces,
  closePage as closePageIn,
  closeTerminal as closeTerminalIn,
  initialView,
  loadView,
  openPage as openPageIn,
  openTerminal as openTerminalIn,
  openWorkspace as openWorkspaceIn,
  placeFiles as placeFilesIn,
  reconcileSession,
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

/// The card the human has just come back from to its board, which the
/// board opens on: a phone that drew the board afresh on the column work
/// is in flight in would lose their place every time they looked at a
/// card. In memory only, like a landing.
const returnedFromStore = writable<string | null>(null);

/// The phone's own appearance for this Workstation (`appearance.ts`).
const appearanceStore = writable<Appearance>(DEFAULT_APPEARANCE);

export const connection: Readable<Connection> = { subscribe: connectionStore.subscribe };
export const view: Readable<ViewState> = { subscribe: viewStore.subscribe };
export const landing: Readable<Landing | null> = { subscribe: landingStore.subscribe };
export const returnedFrom: Readable<string | null> = { subscribe: returnedFromStore.subscribe };
export const appearance: Readable<Appearance> = { subscribe: appearanceStore.subscribe };

/// Writes a view down on the Device. Null until a Workstation is
/// connected, since a view belongs to one.
let remember: ((next: ViewState) => void) | null = null;
/// The same for the phone's appearance.
let rememberAppearance: ((next: Appearance) => void) | null = null;

/// Draws this Workstation's UI in `next` on this phone, and keeps the
/// choice on the Device. Never a write to the Workstation: its theme is
/// the desk's, changed only by the desk's own control.
export function setAppearance(next: Appearance): void {
  appearanceStore.set(next);
  rememberAppearance?.(next);
  void themeState.setLocal(localThemePref(next));
}

/// The one door every change of view goes through.
function show(next: ViewState): void {
  const before = get(viewStore);
  returnedFromStore.set(
    before.page?.kind === "card" && !next.page && next.workspaceId === before.workspaceId ? before.page.path : null
  );
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
/// reveal, and leaving the board is going somewhere else -- as is the tab
/// already shown, tapped from a card or a terminal over it.
export function showSurface(surface: Surface): void {
  const current = get(viewStore);
  if (current.workspaceId === null) return;
  if (current.surface === surface && !current.page && current.sessionId === null) return;
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

/// Whether a workspace holds a session, as a place to go: on one of its
/// pages, as its own agent, or started from this phone in it.
function holdsSession(ws: Workspace, sessionId: string): boolean {
  return (
    ws.mainSessionId === sessionId ||
    ws.pages.some((p) => allSessionIds(p.layout).includes(sessionId)) ||
    get(startedHere)[sessionId] === ws.id ||
    commitAgentOf(ws) === sessionId
  );
}

/// The hidden agent the desk is committing a workspace with: on no page,
/// and opened from the Git surface's Show the agent.
function commitAgentOf(ws: Workspace): string | null {
  return ws.gitView?.agentCommit?.sessionId ?? null;
}

/// Every session the view could have open in a workspace.
function sessionsOf(ws: Workspace | undefined): string[] {
  if (!ws) return [];
  const ids = ws.pages.flatMap((p) => allSessionIds(p.layout));
  if (ws.mainSessionId) ids.push(ws.mainSessionId);
  for (const [id, workspaceId] of Object.entries(get(startedHere))) if (workspaceId === ws.id) ids.push(id);
  const committing = commitAgentOf(ws);
  if (committing) ids.push(committing);
  return ids;
}

/// A session's terminal, in the workspace that holds it.
export function openTerminal(sessionId: string): void {
  const ws = get(layoutState).workspaces.find((w) => holdsSession(w, sessionId));
  if (!ws) return;
  landingStore.set(null);
  show(openTerminalIn(ws.id, sessionId));
}

/// Back from a terminal to its workspace's sessions.
export function closeTerminal(): void {
  show(closeTerminalIn(get(viewStore)));
}

/// One of the open workspace's cards, over its board.
export function openCard(path: string): void {
  if (get(viewStore).workspaceId === null) return;
  landingStore.set(null);
  show(openPageIn(get(viewStore), { kind: "card", path }));
}

/// The open workspace's PRD, over its board.
export function openPrd(): void {
  if (get(viewStore).workspaceId === null) return;
  landingStore.set(null);
  show(openPageIn(get(viewStore), { kind: "prd" }));
}

/// Back from a card or the PRD to the surface under it: the board, on the
/// card's column, or the Decisions or Review list. An inbox item's card
/// stays outlined on the board: coming back to the board from the card it
/// landed on is not going somewhere else.
export function closePage(): void {
  show(closePageIn(get(viewStore)));
}

/// The open card's file moved -- Done files it under `done/`, archiving
/// under `archive/` -- and its path is its identity, so the view follows.
export function followCard(from: string, to: string): void {
  const current = get(viewStore);
  if (from === to || current.page?.kind !== "card" || current.page.path !== from) return;
  show(openPageIn(current, { kind: "card", path: to }));
}

/// Lands where the shell asked. A session the workspace holds opens its
/// terminal, which is the place an agent waiting on the human is
/// answered; a card opens over its board, which is where a decision is
/// answered and a human test passed; anything else opens the board with
/// the card running the item's session, for the board to reveal. A
/// workspace this Workstation no longer has is not a place, and the view
/// stays where it was remembered.
export function land(where: Landing): void {
  const ws = get(layoutState).workspaces.find((w) => w.id === where.workspace);
  if (!ws) return;
  if (where.target.kind === "session" && holdsSession(ws, where.target.id)) {
    landingStore.set(null);
    show(openTerminalIn(ws.id, where.target.id));
    return;
  }
  landingStore.set(where);
  const board = showSurfaceIn(openWorkspaceIn(get(viewStore), ws.id), "board");
  show(where.target.kind === "card" ? openPageIn(board, { kind: "card", path: where.target.path }) : board);
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

/// The workspaces read again, for a caller that must hold what the desk
/// wrote before it answered: the write's `workspaces-synced` and the
/// answer reach the phone by separate ways.
export async function readWorkspacesAgain(): Promise<void> {
  adoptWorkspaces(await backend.getWorkspacesState());
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
  const reconciled = reconcileSession(
    reconcileView(
      current,
      data.workspaces.map((w) => w.id)
    ),
    sessionsOf(data.workspaces.find((w) => w.id === current.workspaceId))
  );
  if (reconciled !== current) show(reconciled);
}

/// A session has ended at the Workstation. Its terminal is let go -- the
/// desk's handler for this is the one that saves the desk's layout, so it
/// is not the phone's -- and a view showing it goes back to the list.
function sessionEnded(sessionId: string): void {
  forgetSession(sessionId);
  browserSessionEnded(sessionId);
  if (get(viewStore).sessionId === sessionId) show(closeTerminalIn(get(viewStore)));
  destroyTerminal(sessionId);
}

/// Every session's status as the Workstation holds it now. Written
/// straight into the map rather than through the desktop's change
/// handler: a status that was already in place is not a transition.
///
/// `afterGap`: read again once the connection is back. The pushes sent
/// while it was down never arrived, so the Workstation's status is taken
/// over the one heard before the gap, rather than only where none was.
async function loadSessions(afterGap = false): Promise<void> {
  const [baselines, sessionNames] = await Promise.all([
    backend.getSessionBaselines().catch(() => null),
    backend.getSessionNames().catch(() => null),
  ]);
  layoutState.update((s) => {
    const sessionStatusById = { ...s.sessionStatusById };
    const statusSinceById = { ...s.statusSinceById };
    const failureReasonById = { ...s.failureReasonById };
    const interruptedSessionIds = new Set(s.interruptedSessionIds);
    const cwdBySessionId = { ...s.cwdBySessionId };
    for (const b of baselines?.sessions ?? []) {
      // A cwd already heard is newer than the read.
      cwdBySessionId[b.id] ??= b.cwd;
      const status = parseSessionStatus(b.status);
      if (sessionStatusById[b.id] === undefined) {
        sessionStatusById[b.id] = status;
        statusSinceById[b.id] ??= { at: Date.now(), watched: false };
      } else if (afterGap && sessionStatusById[b.id] !== status) {
        sessionStatusById[b.id] = status;
        statusSinceById[b.id] = { at: Date.now(), watched: false };
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
      cwdBySessionId,
      sessionNames: sessionNames ? { ...sessionNames, ...s.sessionNames } : s.sessionNames,
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
  resetReachability();
  const client = connectChannel(port);
  const stops: UnlistenFn[] = [client.onConnection(connectionChanged)];
  const disconnect = (): void => {
    for (const stop of stops.splice(0)) stop();
    remember = null;
    rememberAppearance = null;
    resetSessions();
    resetTurns();
    settingsShown = false;
    profilesRead = false;
    saveProblemStore.set(null);
    resetReachability();
    disconnectChannel();
  };

  try {
    const capabilities = await client.capabilities();
    // Listeners before reads: an event sent to nobody is lost, and a
    // change made at the desk between the read and the listener would be
    // one the phone never shows.
    stops.push(
      await listen<[string, string]>("session-status-changed", (event) => {
        turnMovedOn(event.payload[0], event.payload[1]);
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
    // A workspace's orchestration, written at the desk -- by its
    // scheduler, as it runs a rail this phone armed -- or by an agent,
    // or by this phone. Re-read, never merged: the Workstation's copy is
    // the one every window agrees on. The desk's own re-read, so a burst
    // is read once and a save of this phone's in flight is waited for.
    // A plan arriving ticks the desk's scheduler by hand, and here that
    // pass is gated shut (`runsRailsFor`).
    stops.push(
      await listen<{ origin: string; payload: string }>("orchestration-written", (event) => {
        rereadAfterOtherWindowWrote(event.payload.payload);
      })
    );
    stops.push(
      await listen<[string, unknown]>("orchestration-changed", (event) => {
        rereadAfterOtherWindowWrote(event.payload[0]);
      })
    );
    // What the sessions list and the terminals read. Each is recorded in
    // memory only: the desk's handlers for these persist what they hear
    // (a name, a closed tab), and that is the desk's to do once.
    stops.push(
      await listen<[string, number]>("session-exited", (event) => {
        sessionEnded(event.payload[0]);
      })
    );
    stops.push(
      await listen<[string, string]>("cwd-changed", (event) => {
        handleCwdChanged(event.payload[0], event.payload[1]);
      })
    );
    stops.push(
      await listen<[string, string]>("session-named", (event) => {
        const [id, name] = event.payload;
        layoutState.update((s) => ({ ...s, sessionNames: { ...s.sessionNames, [id]: name } }));
      })
    );
    stops.push(
      await listen<[string, string]>("session-failed", (event) => {
        const [id, reason] = event.payload;
        layoutState.update((s) => ({ ...s, failureReasonById: { ...s.failureReasonById, [id]: reason } }));
      })
    );
    // Which agents' browsers are running, for the button beside each
    // terminal; their frames are listened for only while a view is up.
    stops.push(await startBrowserViews());

    const data = await backend.getWorkspacesState();
    const workstationId = capabilities.workstation.id;
    // The phone's own appearance before anything is drawn: a choice that
    // is not the Workstation's needs nothing from it, so it lands at once
    // instead of after the desk's theme has been asked for.
    const chosen = loadAppearance(storage, workstationId);
    appearanceStore.set(chosen);
    const local = localThemePref(chosen);
    if (local) void themeState.setLocal(local);
    else themeState.local = null;
    rememberAppearance = (next) => saveAppearance(storage, workstationId, next);
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

  // What every screen draws from, read again once the connection is back:
  // the pushes sent while it was down never arrived. Each open surface
  // re-reads its own (`onReconnect` in each).
  stops.push(
    onReconnect(() => {
      void backend
        .getWorkspacesState()
        .then(adoptWorkspaces)
        .catch(() => {});
      void loadSessions(true);
      reassertBrowserViews();
    })
  );

  // Not awaited: neither holds up the list. The theme repaints when it
  // arrives, and a row draws its agents when their statuses do.
  void themeState.init();
  void loadSessions();
  return disconnect;
}
