import { writable, derived, get } from "svelte/store";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { confirm } from "@tauri-apps/plugin-dialog";
import type { LayoutNode } from "./layout";
import * as layout from "./layout";
import * as backend from "./backend";
import * as terminalRegistry from "./terminalRegistry";
import * as workspace from "./workspace";
import type { Workspace, WorkspacesData, GitStatus, GitViewPrefs, RemovedWorkspace } from "./workspace";
import { sessionLabel } from "./paths";
import { buildRunCommand, noPromptReason } from "./cardRun";
import { workspaceIdForSession } from "./workspace";
import { maybeNotifyStatusChange, type SessionStatus } from "./notifications";
import { initGavinListeners, watchRootedWorkspaces, gavinTrees } from "./gavinState";
import { followRenamedContext } from "./planExplorer";
import {
  normalizeColor,
  resolveAgentConfig,
  type AgentProfileInfo,
  type McpFormatInfo,
} from "./settings";
import type { BoardTab, GavinTree } from "./gavin";
import { themeState } from "./ui/themeState.svelte";
import type { DaemonCompat } from "./daemonCompat";

export type { SessionStatus };

// A pane tab that shows a file instead of a terminal session. Keyed by
// the same opaque tab-id space session ids live in -- a tab id present in
// fileTabsById is a file tab, one absent from it is a terminal session.
export interface FileTab {
  path: string;
}

export interface LayoutState {
  status: "connecting" | "ready" | "error";
  errorMessage: string;
  workspaces: Workspace[];
  activeWorkspaceId: string | null;
  focusedSessionId: string | null;
  cwdBySessionId: Record<string, string>;
  sessionNames: Record<string, string>;
  sessionStatusById: Record<string, SessionStatus>;
  gitStatusById: Record<string, GitStatus | null>;
  restoredSessionIds: Set<string>;
  fileTabsById: Record<string, FileTab>;
  boardTabsById: Record<string, BoardTab>;
  /// Workspaces the sidebar X removed, newest first. Persisted with the
  /// workspaces themselves; see workspace.ts's RemovedWorkspace for why
  /// removing a workspace has to leave a record at all.
  removedWorkspaces: RemovedWorkspace[];
}

const initialState: LayoutState = {
  status: "connecting",
  errorMessage: "",
  workspaces: [],
  activeWorkspaceId: null,
  focusedSessionId: null,
  cwdBySessionId: {},
  sessionNames: {},
  sessionStatusById: {},
  gitStatusById: {},
  restoredSessionIds: new Set(),
  fileTabsById: {},
  boardTabsById: {},
  removedWorkspaces: [],
};

export const layoutState = writable<LayoutState>(initialState);

// The compat verdict Rust negotiated with the daemon at connect time.
// null until the first successful probe -- DaemonCompatBanner
// stays silent on null the same way compatMessage does. Refreshed
// wherever this module re-syncs against a (re)connected daemon; see
// refreshDaemonCompat.
export const daemonCompat = writable<DaemonCompat | null>(null);

/// The last request the daemon refused on the streaming connection, or
/// null once nothing is outstanding.
///
/// Separate from `status: "error"` on purpose. That means the CONNECTION
/// is gone and there is no app left to show; this means one Attach /
/// WriteInput / ResizeSession came back rejected while everything else
/// kept working -- typically for a session id that has just exited.
/// Routing the second through the first is what turned a stray resize
/// into "the app crashed with the Daemon restart error": a whole window
/// replaced over one dead pane. DaemonRequestErrorBanner renders this as
/// a dismissible strip instead, so the failure is still visible and the
/// app is still usable.
export const daemonRequestError = writable<string | null>(null);

/// Whether the app hub -- the fleet overview above every workspace -- has
/// taken over the main pane.
///
/// Deliberately NOT persisted, and deliberately not a workspace
/// `activeView`: it is app-level, it belongs to no workspace, and a
/// relaunch should land where you left off working rather than on a
/// launcher you happened to have open. It is also not a router: the app
/// is a single page, and this is the flag +page.svelte branches on ahead
/// of the workspace it would otherwise render.
export const appHubOpen = writable(false);

export function openAppHub(): void {
  appHubOpen.set(true);
}

export function closeAppHub(): void {
  appHubOpen.set(false);
}

// Pulls the current compat verdict from the Rust side. Called at every
// point this module already re-syncs against a (re)connected daemon --
// the workspaces-ready event, pollForStartupState's success path, and
// restartDaemonInPlace -- so the banner and featureBlockedReason never
// keep serving a verdict from a connection that no longer exists.
// Best-effort: a failed fetch (including, in tests, backend.daemonCompat
// simply not being mocked) leaves the previous value in place rather than
// blanking the banner over a transient IPC hiccup.
//
// Returns the verdict now in force -- the fresh one, or the retained
// previous one when the probe failed -- so a caller that restarted the
// daemon can compare it against what it saw beforehand. Reading the store
// after the call would work equally well; returning it keeps the "did this
// restart change anything?" question answerable without a store read
// racing the next refresh.
async function refreshDaemonCompat(): Promise<DaemonCompat | null> {
  try {
    const compat = await backend.daemonCompat();
    daemonCompat.set(compat);
    return compat;
  } catch {
    // leave the previous verdict in place
    return get(daemonCompat);
  }
}

function setError(message: string): void {
  layoutState.update((s) => ({ ...s, status: "error", errorMessage: message }));
}

// Shared by every action below that ends in "mutate the active page's
// tree, then persist the whole workspaces array" -- extracted so that
// pattern exists exactly once instead of once per action.
//
// The tombstone list is read off the store rather than taken as a third
// argument. Thirty-odd call sites pass whatever workspaces they just
// computed; making each of them also remember an unrelated list is how a
// carry-through field gets silently wiped by the one site that forgot
// it. The store is where the list lives, so the two callers that CHANGE
// it (closeWorkspace, and the reclaim prompt) write it there first and
// then persist like everyone else.
async function persistWorkspaces(workspaces: Workspace[], activeWorkspaceId: string | null): Promise<void> {
  try {
    await backend.setWorkspacesState(
      workspaces,
      activeWorkspaceId,
      get(layoutState).removedWorkspaces ?? []
    );
  } catch (e) {
    setError(String(e));
  }
}

/// Makes a workspace the active one: stamps it as last used, and takes
/// the app hub down. Every path that puts a workspace on screen goes
/// through here rather than calling workspace.switchWorkspace directly
/// -- the stamp is what the hub's recents order is built on, and the
/// hub must not survive underneath the workspace the user just chose,
/// and both are far too easy to forget one call site at a time.
function activateWorkspace(state: WorkspacesData, workspaceId: string): WorkspacesData {
  closeAppHub();
  return workspace.switchWorkspace(state, workspaceId, Date.now());
}

// The directory a blank terminal opened inside a workspace should start
// in: that workspace's bound root. Undefined for a rootless workspace
// (the Scratchpad, or one whose root has never been picked), which is
// how the Rust side is told "no target" and falls back to $HOME. Every
// spawn-a-blank-terminal path -- new page, split, new tab -- goes
// through this, so they all land in the same place instead of dumping
// the user in their home directory.
function freshSessionCwd(workspaceId: string): string | undefined {
  return workspaceRootPath(workspaceId) ?? undefined;
}

/// A workspace's bound root folder, or null when it has none (the
/// Scratchpad, or one never pointed at a repo). Exported because a card
/// attachment's relative path resolves against the ROOT and nothing
/// else: a rail's step runs in a worktree and a board Run runs in the
/// card's context folder, so resolving against a cwd would hand two
/// sessions two different files from one card.
export function workspaceRootPath(workspaceId: string): string | null {
  return get(layoutState).workspaces.find((w) => w.id === workspaceId)?.rootPath || null;
}

// Every terminal/agent session id currently live anywhere in the app --
// every page of every workspace, main agent sessions included -- with
// file and board tabs excluded (they share the tab-id space, but the
// daemon has never heard of them, so they cost a restart nothing). This
// is exactly the set a daemon restart would end -- DaemonCompatBanner
// uses its size for compatMessage's "restarting will end N running
// agents" warning. Recomputed on demand rather than tracked
// incrementally: handleSessionExited already keeps every tree pruned to
// only sessions that are still alive, so there is nothing stale here to
// filter by status.
export function runningSessionCount(state: LayoutState): number {
  const ids = new Set<string>();
  for (const ws of state.workspaces) {
    if (ws.mainSessionId) ids.add(ws.mainSessionId);
    for (const page of ws.pages) {
      for (const id of layout.allSessionIds(page.layout)) {
        if (!state.fileTabsById[id] && !state.boardTabsById[id]) ids.add(id);
      }
    }
  }
  return ids.size;
}

// Shared by every action that creates exactly one fresh session before
// mutating a tree (splitPane, addTab). Returns null -- having already
// called setError -- on failure, so callers just check for null rather
// than duplicating their own try/catch.
async function createFreshSession(workspaceId: string): Promise<string | null> {
  try {
    return await backend.createSession(freshSessionCwd(workspaceId));
  } catch (e) {
    setError(String(e));
    return null;
  }
}

/// The non-session tabs a close ended, handed back to the caller instead
/// of being pruned on the spot.
///
/// `fileTabsById`/`boardTabsById` are the ONLY thing that tells
/// Pane.svelte a tab is a file or a board rather than a terminal. Drop an
/// id from them while it is still in a layout tree and that pane falls
/// straight through to a `<TerminalPane>` for an id the daemon has never
/// heard of: it mounts, calls fit(), and asks the daemon to resize it.
/// The daemon answers "unknown session" on the STREAMING connection,
/// which the Rust relay turns into a `daemon-error` -- and that is a
/// whole-window "Couldn't connect to the daemon" overlay, not a
/// swallowed per-call failure (TerminalPane's own .catch never sees it).
/// So every caller updates the tree first and calls pruneClosedTabs
/// afterwards.
interface ClosedTabs {
  fileTabIds: string[];
  boardTabIds: string[];
}

// Every close path (tab, pane, page, workspace) ends the tabs it owns.
// A file tab is not a session -- killing it would ask the daemon to kill
// an id it has never heard of -- so it gets its watcher torn down instead.
// Returns null (having already called setError) if a real session kill
// failed, so callers can bail exactly as they do today.
async function endTabs(
  tabIds: string[],
  fileTabsById: Record<string, FileTab>,
  boardTabsById: Record<string, BoardTab>
): Promise<ClosedTabs | null> {
  const fileTabIds: string[] = [];
  const boardTabIds: string[] = [];
  for (const id of tabIds) {
    const fileTab = fileTabsById[id];
    if (fileTab) {
      // Best-effort: a watcher that's already gone (or was never
      // started because the file read failed) must not block the close.
      await backend.unwatchFileForViewer(fileTab.path).catch(() => {});
      fileTabIds.push(id);
      continue;
    }
    if (boardTabsById[id]) {
      // A board tab is not a session and holds no watcher of its own --
      // tree watching is workspace-level. Prune and persist only.
      boardTabIds.push(id);
      continue;
    }
    try {
      await backend.killSession(id);
    } catch (e) {
      setError(String(e));
      return null;
    }
  }
  return { fileTabIds, boardTabIds };
}

/// Drops the tabs endTabs ended from the maps that classify them. Call
/// only once the layout tree no longer holds them -- see ClosedTabs.
async function pruneClosedTabs(closed: ClosedTabs): Promise<void> {
  if (closed.fileTabIds.length > 0) await pruneFileTabs(closed.fileTabIds);
  if (closed.boardTabIds.length > 0) await pruneBoardTabs(closed.boardTabIds);
}

// Mirrors pruneFileTabs: best-effort persistence, a failed prune costs a
// stale entry, never a broken close.
async function pruneBoardTabs(closedIds: string[]): Promise<void> {
  const remaining: Record<string, BoardTab> = {};
  for (const [id, tab] of Object.entries(get(layoutState).boardTabsById)) {
    if (!closedIds.includes(id)) remaining[id] = tab;
  }
  layoutState.update((s) => ({ ...s, boardTabsById: remaining }));
  await backend.setBoardTabs(remaining).catch(() => {});
}

// Drops closed file tabs from the map and persists the result.
//
// The sibling maps (cwdBySessionId, sessionNames, sessionStatusById) are
// deliberately never pruned, and this one initially followed them -- but
// they are in-memory only, whereas file_tabs is written to config.json.
// Left alone it would accumulate dead ids on disk forever, so the
// convention that justified not pruning does not actually apply here.
async function pruneFileTabs(closedIds: string[]): Promise<void> {
  const remaining: Record<string, FileTab> = {};
  for (const [id, tab] of Object.entries(get(layoutState).fileTabsById)) {
    if (!closedIds.includes(id)) remaining[id] = tab;
  }
  layoutState.update((s) => ({ ...s, fileTabsById: remaining }));

  const asPathMap: Record<string, string> = {};
  for (const [id, tab] of Object.entries(remaining)) {
    asPathMap[id] = tab.path;
  }
  // Best-effort, matching how this map is loaded: a failed prune costs a
  // stale entry, never a broken close.
  await backend.setFileTabs(asPathMap).catch(() => {});
}

// The active page's identity plus its current tree, or null if there's no
// active workspace, no active page, or either id is stale. Every
// tree-mutating action below starts by calling this.
function activePageLocation(
  state: WorkspacesData
): { workspaceId: string; pageId: string; tree: LayoutNode } | null {
  const ws = workspace.getActiveWorkspace(state);
  const page = ws && workspace.getActivePage(state);
  if (!ws || !page) return null;
  return { workspaceId: ws.id, pageId: page.id, tree: page.layout };
}

// The page that actually OWNS `sessionId`, for the actions the sidebar can
// aim at a tab on a page that isn't the one on screen. The tab bar only
// ever addresses the active page, so for it this resolves to exactly what
// activePageLocation returns; for the sidebar it is the difference between
// acting and silently doing nothing, since a tree lookup that misses
// returns the tree unchanged and the no-op gets persisted as if it worked.
// Falls back to the active page so a caller holding an id that belongs to
// no page (a just-closed tab) behaves as it did before.
function pageLocationForSession(
  state: WorkspacesData,
  sessionId: string
): { workspaceId: string; pageId: string; tree: LayoutNode } | null {
  const found = workspace.findSessionLocation(state, sessionId);
  if (!found) return activePageLocation(state);
  const page = state.workspaces
    .find((w) => w.id === found.workspaceId)
    ?.pages.find((p) => p.id === found.pageId);
  if (!page) return activePageLocation(state);
  return { workspaceId: found.workspaceId, pageId: found.pageId, tree: page.layout };
}

// Board tabs are pinned to a context by FOLDER PATH, so renaming or
// moving that folder on disk would otherwise strand every tab on it
// behind "this context no longer exists" -- a dead tab for what was only
// a rename. Follows it instead, on the same narrow inference the Plans
// tab uses for a renamed file, and re-persists so the repair survives a
// restart. A move the inference can't call leaves the tab alone, and the
// pane's own missing-context notice stands.
function repairBoardTabs(
  workspaceId: string,
  before: GavinTree | undefined,
  after: GavinTree | undefined
): void {
  const current = get(layoutState).boardTabsById;
  const boardTabsById: Record<string, BoardTab> = {};
  let moved = false;
  for (const [id, tab] of Object.entries(current)) {
    const to =
      tab.workspaceId === workspaceId
        ? followRenamedContext(before, after, tab.contextFolder)
        : null;
    boardTabsById[id] = to === null ? tab : { ...tab, contextFolder: to };
    moved ||= to !== null;
  }
  if (!moved) return;
  layoutState.update((s) => ({ ...s, boardTabsById }));
  // Best-effort, matching how this map is loaded and pruned: a failed
  // write costs the repair on the next restart, never a broken tab now.
  void backend.setBoardTabs(boardTabsById).catch(() => {});
}

const unlisteners: UnlistenFn[] = [];

/// Resolves once `fileTabsById`/`boardTabsById` hold what the Rust side
/// persisted -- see loadTabMaps. Both ready paths await it before letting
/// `status` leave "connecting", so no layout tree is ever rendered
/// against empty maps. Starts resolved so a test (or any caller) that
/// never ran bootstrap is not left hanging.
let tabMapsLoaded: Promise<void> = Promise.resolve();

/// Loads the two frontend-owned maps that say which layout-tree ids are
/// file views and which are boards.
///
/// Unlike session names, these are not cosmetic: every id NOT in them is
/// taken to be a daemon session. Empty maps therefore do not degrade to
/// "labels look wrong" -- they turn each restored file/board tab into a
/// <TerminalPane> that asks the daemon to resize an id it has never heard
/// of, and that answer arrives as a whole-window "Couldn't connect to the
/// daemon" (see ClosedTabs for the same failure reached from the close
/// path). So this retries the one failure it can actually hit -- FileTabs
/// and BoardTabs are `manage`d at the very end of session::bootstrap, so
/// an invoke that lands before it finishes rejects with "state not
/// managed", exactly the case pollForStartupState already spins on --
/// rather than swallowing it once and leaving the maps empty for the rest
/// of the run.
async function loadTabMaps(): Promise<void> {
  const maxAttempts = 15;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const [fileTabs, boardTabs] = await Promise.all([
      backend.getFileTabs().catch(() => null),
      backend.getBoardTabs().catch(() => null),
    ]);
    if (fileTabs && boardTabs) {
      const fileTabsById: Record<string, FileTab> = {};
      for (const [tabId, path] of Object.entries(fileTabs)) {
        fileTabsById[tabId] = { path };
      }
      layoutState.update((s) => ({ ...s, fileTabsById, boardTabsById: boardTabs }));
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  // Out of attempts: the daemon bootstrap that manages these states has
  // failed outright, and pollForStartupState's own timeout (or the
  // bootstrap error it surfaces) is what the human sees. Resolving here
  // rather than hanging keeps that path the one that reports it.
}

/// Refills what the frontend only ever learns from daemon pushes.
///
/// `cwdBySessionId`, `sessionStatusById`, `restoredSessionIds` and
/// `gitStatusById` are fed by the `cwd-changed` /
/// `session-status-changed` / `session-restored` / `git-status-changed`
/// events, whose baseline the daemon sends in reply to `Attach` -- and
/// `Attach` runs once per app PROCESS (session::attach_and_relay), not
/// once per frontend load. So a reloaded frontend starts blank on all
/// four and cannot refill them until the shell emits another OSC 7: the
/// terminal's tab loses its cwd-derived label, its status dot, and its
/// "open this context's board" button until the next prompt. Under
/// `tauri dev` that is every frontend edit.
///
/// Git is the worst of the four, and the reason this does two round
/// trips instead of one. The other three come back on the session's next
/// prompt; `git-status-changed` is change-only by design (see the
/// daemon's `trigger_recheck`), so once a repo root's poller has cached
/// a status, NOTHING re-sends it until the repo itself changes -- and a
/// checkout that is already dirty stays byte-identical through a day of
/// editing. The chip, the page rows' branch lines and the pane's dot
/// simply stay gone. Its answer comes from the host's own git rather
/// than a new daemon request, so a daemon a build behind still gets it.
///
/// Never overwrites a value already in the store: a push that has landed
/// is newer than this snapshot. `undefined` is the test, not falsiness --
/// a landed `null` means "this session is in no repo", which is an answer
/// and must not be overwritten either. Status is written straight into
/// the map rather than through handleSessionStatusChanged -- re-reading a
/// state the human has already seen is not a transition, and must not
/// fire an OS notification for it.
async function seedSessionBaselines(): Promise<void> {
  // Same wait loadTabMaps satisfies: once those maps have come back, the
  // Rust side has managed CommandConnection too.
  await tabMapsLoaded;
  const baselines = await backend.getSessionBaselines().catch(() => null);
  if (!baselines) return;
  const known = get(layoutState);
  const fresh = baselines.filter((b) => known.cwdBySessionId[b.id] === undefined);
  for (const b of fresh) {
    // Not a plain map write: handleCwdChanged also mirrors the cwd into
    // terminalRegistry, which the xterm link provider reads synchronously.
    handleCwdChanged(b.id, b.cwd);
  }
  layoutState.update((s) => {
    const sessionStatusById = { ...s.sessionStatusById };
    const restoredSessionIds = new Set(s.restoredSessionIds);
    for (const b of baselines) {
      if (sessionStatusById[b.id] === undefined) sessionStatusById[b.id] = b.status;
      if (b.restored) restoredSessionIds.add(b.id);
    }
    return { ...s, sessionStatusById, restoredSessionIds };
  });
  // Last, and awaited separately: this one shells out to git once per
  // distinct checkout, so it must never hold up the three maps above --
  // those are what the tab labels paint from.
  const gitStatuses = await backend.getGitBaselines(baselines.map((b) => b.cwd)).catch(() => null);
  if (!gitStatuses) return;
  layoutState.update((s) => {
    const gitStatusById = { ...s.gitStatusById };
    baselines.forEach((b, i) => {
      const status = gitStatuses[i];
      if (status !== undefined && gitStatusById[b.id] === undefined) gitStatusById[b.id] = status;
    });
    return { ...s, gitStatusById };
  });
}

export async function bootstrap(): Promise<void> {
  // Ahead of the workspace listeners: the theme should be correct on the
  // first painted frame, and it has no dependency on workspace state.
  await themeState.init();
  // Started before the ready paths that await it, so the maps are already
  // in flight by the time either of them has a payload to apply.
  tabMapsLoaded = loadTabMaps();
  void seedSessionBaselines();
  unlisteners.push(
    await listen<WorkspacesData>("workspaces-ready", async (event) => {
      // Awaited BEFORE the tree lands in the store: a file or board tab
      // rendered against empty maps is a TerminalPane for a non-session
      // id (see loadTabMaps).
      await tabMapsLoaded;
      layoutState.update((s) => {
        if (s.status !== "connecting") return s;
        const resolved = workspace.resolveActiveFocus(event.payload);
        return {
          ...s,
          status: "ready",
          workspaces: resolved.state.workspaces,
          activeWorkspaceId: resolved.state.activeWorkspaceId,
          focusedSessionId: resolved.focusedSessionId,
          removedWorkspaces: event.payload.removedWorkspaces ?? [],
        };
      });
      watchRootedWorkspaces(event.payload.workspaces);
      void refreshDaemonCompat();
    })
  );
  unlisteners.push(
    await listen<[string, number]>("session-exited", (event) => {
      // Recorded BEFORE the layout change, so the orchestration tick
      // this triggers already sees the code (tools spec §3.1). The
      // other way round, a tool step would read as "nobody witnessed
      // the outcome" on every single run.
      recordSessionExit(event.payload[0], event.payload[1]);
      handleSessionExited(event.payload[0]);
    })
  );
  unlisteners.push(
    // The connection itself is gone (the relay's read failed, the daemon
    // closed the socket, or bootstrap never got one) -- there is no
    // working app left behind this, so it IS the whole-window overlay.
    await listen<string>("daemon-error", (event) => {
      setError(event.payload);
    })
  );
  unlisteners.push(
    // One request the daemon refused, on a connection that is still up.
    // Deliberately NOT setError: everything else in the app keeps
    // working, so this surfaces as a banner over it (see
    // DaemonRequestErrorBanner) rather than replacing it.
    await listen<string>("daemon-request-error", (event) => {
      daemonRequestError.set(event.payload);
    })
  );
  unlisteners.push(
    await listen<[string, string]>("cwd-changed", (event) => {
      handleCwdChanged(event.payload[0], event.payload[1]);
    })
  );
  unlisteners.push(
    await listen<[string, SessionStatus]>("session-status-changed", (event) => {
      handleSessionStatusChanged(event.payload[0], event.payload[1]);
    })
  );
  unlisteners.push(
    await listen<[string, GitStatus | null]>("git-status-changed", (event) => {
      handleGitStatusChanged(event.payload[0], event.payload[1]);
    })
  );
  unlisteners.push(
    await listen<string>("session-restored", (event) => {
      handleSessionRestored(event.payload);
    })
  );
  // An agent naming its own tab (gavin_name_session). Straight into
  // setSessionName: an agent rename and a human rename are the same
  // rename, and must persist the same way.
  unlisteners.push(
    await listen<[string, string]>("session-named", (event) => {
      void setSessionName(event.payload[0], event.payload[1]);
    })
  );
  // Registered before any watchGavinRoot can fire (the two ready paths
  // below) -- gavin-tree-changed pushes with no listener would be lost,
  // not buffered.
  unlisteners.push(await initGavinListeners());
  // Rides the tree store rather than the raw event so it sees every
  // update, pushes and on-demand refreshes alike. The first call carries
  // no previous tree, so nothing is ever "repaired" on startup.
  const previousTrees: Record<string, GavinTree> = {};
  unlisteners.push(
    gavinTrees.subscribe((trees) => {
      for (const [workspaceId, tree] of Object.entries(trees)) {
        const previous = previousTrees[workspaceId];
        previousTrees[workspaceId] = tree;
        if (previous !== undefined && previous !== tree) {
          repairBoardTabs(workspaceId, previous, tree);
        }
      }
    })
  );
  // Imported dynamically on purpose: orchestrationState imports THIS
  // module (for resolvedAgentFor and createSessionOnPage), so a static
  // import here would close a cycle. By the time bootstrap runs, this
  // module is fully evaluated and the load is safe.
  const { initOrchestrationListeners } = await import("./orchestrationState");
  unlisteners.push(await initOrchestrationListeners());
  unlisteners.push(
    await listen<[string, string, string, string]>("agent-session-spawned", (event) => {
      handleAgentSessionSpawned(event.payload[0], event.payload[1]);
    })
  );

  backend.setOnWriteInputHook((sessionId) => clearRestoredMarker(sessionId));

  // Session names are only ever WRITTEN from this side (a human rename,
  // or an agent's gavin_name_session arriving on "session-named" above,
  // which lands in the same setSessionName), so the stored map cannot
  // drift behind our back -- a one-shot fetch at startup is sufficient,
  // unlike cwd. Best-effort: a failure here just means renamed tabs show
  // their fallback label until the next successful rename, not a reason
  // to block startup.
  void backend
    .getSessionNames()
    .then((sessionNames) => {
      layoutState.update((s) => ({ ...s, sessionNames }));
    })
    .catch(() => {});

  // The agent profile table: static Rust data, so one fetch is enough.
  // Best-effort like the rest -- resolveAgentConfig falls back to
  // claude-code's defaults if this never arrives.
  void backend
    .agentProfiles()
    .then((profiles) => agentProfilesStore.set(profiles))
    .catch(() => {});

  void backend
    .mcpFormats()
    .then((formats) => mcpFormatsStore.set(formats))
    .catch(() => {});

  void backend
    .getAgentModelDefaults()
    .then((models) => agentModelDefaultsStore.set(models))
    .catch(() => {});

  void pollForStartupState();
}

export function teardown(): void {
  unlisteners.forEach((unlisten) => unlisten());
  unlisteners.length = 0;
}

// The connection-error overlay's recovery action: restart the daemon and
// try the whole startup again. Puts the store back into "connecting"
// first -- both ready paths (the workspaces-ready listener and
// pollForStartupState below) ignore payloads unless the status is
// "connecting", so without this the retry would succeed invisibly.
export async function retryConnect(): Promise<void> {
  layoutState.update((s) => ({ ...s, status: "connecting", errorMessage: "" }));
  try {
    await backend.restartDaemon();
  } catch (e) {
    setError(String(e));
    return;
  }
  void pollForStartupState();
}

// The Settings button, as opposed to retryConnect's error-overlay one:
// the app here is healthy and stays up, so this neither touches `status`
// nor re-runs startup. The Rust side rewires the live connections in
// place and re-arms the gavin root watches, so all that is left is to
// refresh what a fresh daemon can no longer be asked about mid-flight.
//
// Throws on failure so the caller can render it beside the button --
// silently swallowing it would leave the human with a dead daemon and no
// sign of it.
export async function restartDaemonInPlace(): Promise<DaemonCompat | null> {
  await backend.restartDaemon();
  // The workspaces payload is re-derived by the daemon on reconnect
  // (recover() spawns fresh shells and re-resolves ids), so pull the
  // authoritative copy rather than trusting the pre-restart one.
  const data = await backend.getWorkspacesState();
  const resolved = workspace.resolveActiveFocus(data);
  layoutState.update((s) => ({
    ...s,
    workspaces: resolved.state.workspaces,
    activeWorkspaceId: resolved.state.activeWorkspaceId,
    focusedSessionId: resolved.focusedSessionId,
  }));
  // A restart can hand the app a differently-versioned daemon than the
  // one it started with (session::reconnect's own doc comment) -- refresh
  // the stored verdict so the banner/gating never keep serving a stale one.
  //
  // Awaited, not fire-and-forget: the verdict is the only evidence a
  // caller has of what the restart actually achieved, and the honest
  // "restarted, and nothing moved" message depends on having it in hand
  // before the button leaves its Restarting… state.
  return await refreshDaemonCompat();
}

async function pollForStartupState(): Promise<void> {
  const maxAttempts = 15;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (get(layoutState).status !== "connecting") return;
    const [data, bootstrapError] = await Promise.all([
      backend.getWorkspacesState().catch(() => null),
      backend.getBootstrapError().catch(() => null),
    ]);
    if (bootstrapError) {
      setError(bootstrapError);
      return;
    }
    // `data` is `null` only when the invoke itself rejected (WorkspacesState
    // isn't managed yet -- bootstrap still running). An empty
    // `{workspaces: [], activeWorkspaceId: null}` is a real, resolved
    // object -- and therefore truthy -- so checking `data` itself (not a
    // field on it, like `data.workspaces.length`) is what correctly treats
    // "no workspaces yet" as ready rather than as still-connecting. See
    // get_workspaces_state's own doc comment on the Rust side for the same
    // rule stated from that side of the boundary.
    if (data) {
      // Same rule as the workspaces-ready listener: the tab maps must be
      // in the store before a tree that references them renders.
      await tabMapsLoaded;
      layoutState.update((s) => {
        if (s.status !== "connecting") return s;
        const resolved = workspace.resolveActiveFocus(data);
        return {
          ...s,
          status: "ready",
          workspaces: resolved.state.workspaces,
          activeWorkspaceId: resolved.state.activeWorkspaceId,
          focusedSessionId: resolved.focusedSessionId,
          removedWorkspaces: data.removedWorkspaces ?? [],
        };
      });
      watchRootedWorkspaces(data.workspaces);
      void refreshDaemonCompat();
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (get(layoutState).status === "connecting") {
    setError("Timed out waiting for the daemon to become reachable.");
  }
}

/// Restores a removed workspace's daemon rows onto an empty workspace by
/// giving it the removed one's id back.
///
/// Order is the whole point. The re-key happens BEFORE anything binds to
/// the id the workspace is being given up: the watch under the new id is
/// torn down first, the store and config.json are written next, and only
/// then is the restored id watched and its rows fetched. Doing it the
/// other way round leaves a watch pushing trees for an id no workspace
/// holds, and fetches a board under the id that is about to disappear.
async function restoreRemovedWorkspace(
  state: LayoutState,
  workspaceId: string,
  tombstone: RemovedWorkspace,
  rootPath: string
): Promise<void> {
  // reclaimable() insists the workspace is empty, so nothing is bound to
  // this id -- except, possibly, a watch from an earlier root pick.
  await backend.unwatchGavinRoot(workspaceId).catch(() => {});

  const data = workspace.restoreWorkspaceId(state, workspaceId, tombstone.id, rootPath);
  layoutState.update((s) => ({
    ...s,
    workspaces: data.workspaces,
    activeWorkspaceId: data.activeWorkspaceId,
    removedWorkspaces: data.removedWorkspaces ?? [],
  }));
  await persistWorkspaces(data.workspaces, data.activeWorkspaceId);

  void backend.watchGavinRoot(tombstone.id, rootPath).catch(() => {});

  // Dynamically imported for the reason the bootstrap listener states:
  // orchestrationState imports THIS module, so a static import would
  // close a cycle. The other two ride along rather than being imported
  // twice over.
  const [{ fetchBoard }, { fetchOrchestration }, { fetchTools }] = await Promise.all([
    import("./kanbanState"),
    import("./orchestrationState"),
    import("./toolsState"),
  ]);
  // These are the rows the tombstone existed to reach: the board with
  // its columns and labels, the rails, and the workspace's own tools.
  await Promise.all([
    fetchBoard(tombstone.id),
    fetchOrchestration(tombstone.id),
    fetchTools(tombstone.id),
  ]);
}

// Binds (or re-binds) a workspace to a root directory: persists the new
// rootPath, tears down the old watch when the root actually changed, and
// starts the new one. Init (scaffolding) happens BEFORE this is called --
// see WorkspaceRootControl -- so the first push already sees the skeleton.
//
// A folder that a removed workspace used to be bound to offers a reclaim
// first: its board, rails and tools are still in the daemon under an id
// nothing else can name, and binding a fresh workspace here is the only
// moment that record can be spent. Both answers consume the tombstone --
// Restore because the bridge has been crossed, Start fresh because the
// user has said no and the prompt must not return on the next pick.
export async function setWorkspaceRoot(workspaceId: string, rootPath: string): Promise<void> {
  const state = get(layoutState);
  const tombstone = workspace.reclaimable(state, workspaceId, rootPath);
  if (tombstone) {
    const restore = await confirm(
      `gavin has a board, rails and tools saved for "${tombstone.name}", which was removed from ` +
        `this folder. Restore them, or start this workspace fresh?`,
      { title: "gavin", okLabel: "Restore", cancelLabel: "Start fresh" }
    );
    if (restore) {
      await restoreRemovedWorkspace(state, workspaceId, tombstone, rootPath);
      return;
    }
    const dropped = workspace.forgetTombstone(state, tombstone.id);
    layoutState.update((s) => ({ ...s, removedWorkspaces: dropped.removedWorkspaces ?? [] }));
  }
  const previous = state.workspaces.find((w) => w.id === workspaceId)?.rootPath;
  const workspaces = state.workspaces.map((w) => (w.id === workspaceId ? { ...w, rootPath } : w));
  layoutState.update((s) => ({ ...s, workspaces }));
  await persistWorkspaces(workspaces, state.activeWorkspaceId);
  if (previous && previous !== rootPath) {
    await backend.unwatchGavinRoot(workspaceId).catch(() => {});
  }
  void backend.watchGavinRoot(workspaceId, rootPath).catch(() => {});
}

/// The Rust profile table, fetched once at bootstrap. Empty until then;
/// resolveAgentConfig degrades to its own claude-code fallbacks in that
/// window, so an early call is safe rather than wrong.
export const agentProfilesStore = writable<AgentProfileInfo[]>([]);

/// The MCP dialects a `custom` profile can be pointed at. Fetched with
/// the profile table and, like it, empty until then.
export const mcpFormatsStore = writable<McpFormatInfo[]>([]);

/// App-wide default model per profile id, from config.json. Empty until
/// bootstrap fetches it; resolveAgentConfig reads a missing entry as "no
/// model", so an early call is safe rather than wrong -- the same
/// posture agentProfilesStore takes above.
export const agentModelDefaultsStore = writable<Record<string, string>>({});

/// The workspace's resolved agent settings, from config.toml's [agent]
/// block on the root context plus the profile table.
export function resolvedAgentFor(workspaceId: string) {
  const tree = get(gavinTrees)[workspaceId];
  const rootContext = tree?.contexts.find((c) => c.kind === "root");
  return resolveAgentConfig(
    rootContext?.agent ?? null,
    get(agentProfilesStore),
    get(agentModelDefaultsStore)
  );
}

/// The same answer, reactively: `$resolvedAgents(workspaceId)`.
///
/// `resolvedAgentFor` above is three `get()`s, which is right for an
/// action -- it runs once, at the moment of the click -- and wrong for a
/// component, which would keep whatever the table said at mount. The
/// table is fetched asynchronously at bootstrap, so at mount it is
/// usually still empty: a control derived from the one-shot helper shows
/// claude-code's answer for the whole session, whatever the workspace
/// actually chose.
///
/// A store OF a function rather than one store per workspace, because
/// the workspace id is a prop the component already has and the three
/// inputs are app-wide.
export const resolvedAgents = derived(
  [gavinTrees, agentProfilesStore, agentModelDefaultsStore],
  ([$trees, $profiles, $models]) =>
    (workspaceId: string) =>
      resolveAgentConfig(
        $trees[workspaceId]?.contexts.find((c) => c.kind === "root")?.agent ?? null,
        $profiles,
        $models
      )
);

// Starts the workspace's main agent: a normal daemon session at the
// workspace root, remembered on the workspace rather than placed in a
// page tree (D12). Never called automatically.
export async function startMainAgent(workspaceId: string): Promise<void> {
  const state = get(layoutState);
  const ws = state.workspaces.find((w) => w.id === workspaceId);
  if (!ws?.rootPath || ws.mainSessionId) return;
  let sessionId: string;
  try {
    sessionId = await backend.createSession(
      ws.rootPath,
      resolvedAgentFor(workspaceId).launchCommand
    );
  } catch (e) {
    setError(String(e));
    return;
  }
  const workspaces = state.workspaces.map((w) =>
    w.id === workspaceId ? { ...w, mainSessionId: sessionId } : w
  );
  layoutState.update((s) => ({ ...s, workspaces }));
  await persistWorkspaces(workspaces, state.activeWorkspaceId);
}

/// Starts the main agent already working on something (the wizard's
/// agent-driven steps, W5). Same rules as startMainAgent -- needs a root,
/// refuses when one is already running -- so the session it records is
/// the same one the Home panel shows and bootstrap reattaches.
/// The workspace whose setup wizard is open, or null. A store rather
/// than a prop because two surfaces open it: the creation modal and the
/// Home tab's resume card.
export const wizardWorkspaceId = writable<string | null>(null);

export function openWizard(workspaceId: string): void {
  wizardWorkspaceId.set(workspaceId);
}

export function closeWizard(): void {
  wizardWorkspaceId.set(null);
}

export async function startMainAgentWithPrompt(
  workspaceId: string,
  prompt: string
): Promise<void> {
  const state = get(layoutState);
  const ws = state.workspaces.find((w) => w.id === workspaceId);
  if (!ws?.rootPath || ws.mainSessionId) return;
  const agent = resolvedAgentFor(workspaceId);
  const command = buildRunCommand(agent.launchCommand, agent.promptArgs, prompt);
  // The wizard gates this button on agentFlowAvailable, so reaching here
  // means the profile changed under an open wizard. Say why rather than
  // launching `cursor '<a whole prompt>'`, which opens a file picker on
  // a path nobody named.
  if (command === null) {
    setError(noPromptReason(agent.label));
    return;
  }
  let sessionId: string;
  try {
    sessionId = await backend.createSession(ws.rootPath, command);
  } catch (e) {
    setError(String(e));
    return;
  }
  const workspaces = state.workspaces.map((w) =>
    w.id === workspaceId ? { ...w, mainSessionId: sessionId } : w
  );
  layoutState.update((s) => ({ ...s, workspaces }));
  await persistWorkspaces(workspaces, state.activeWorkspaceId);
}

export async function stopMainAgent(workspaceId: string): Promise<void> {
  const state = get(layoutState);
  const ws = state.workspaces.find((w) => w.id === workspaceId);
  if (!ws?.mainSessionId) return;
  try {
    await backend.killSession(ws.mainSessionId);
  } catch (e) {
    // A session already gone is not a reason to keep a dead id on screen.
    setError(String(e));
  }
  clearMainSession(workspaceId);
}

/// Agent settings live in config.toml (D35/D41), so this goes through the
/// daemon rather than persistWorkspaces. The value comes back on the next
/// watcher push -- no optimistic local copy to fall out of sync.
export async function setAgentField(
  workspaceId: string,
  key: "profile" | "file" | "command" | "mcp_file" | "mcp_format" | "model",
  value: string
): Promise<void> {
  const ws = get(layoutState).workspaces.find((w) => w.id === workspaceId);
  if (!ws?.rootPath) return;
  try {
    await backend.setRootConfigField(ws.rootPath, key, value);
  } catch (e) {
    setError(String(e));
  }
}

/// The root config's `prd` — which document leads this workspace. Its own
/// function rather than a sixth key on setAgentField because it is not an
/// agent key: it lives at the document root, and it does not change when
/// the workspace switches CLI. An empty value clears it, putting the
/// workspace back on the scaffolded default.
export async function setPrdPath(workspaceId: string, value: string): Promise<void> {
  const ws = get(layoutState).workspaces.find((w) => w.id === workspaceId);
  if (!ws?.rootPath) return;
  try {
    await backend.setRootConfigField(ws.rootPath, "prd", value);
  } catch (e) {
    setError(String(e));
  }
}

/// The app-wide default model for one profile. Machine-local, so it goes
/// straight to config.json through Tauri and never touches the daemon --
/// which is why it keeps working against a daemon too old for
/// `[agent] model`.
export async function setAgentModelDefault(profileId: string, model: string): Promise<void> {
  try {
    await backend.setAgentModelDefault(profileId, model);
    agentModelDefaultsStore.update((current) => {
      const next = { ...current };
      if (model.trim()) next[profileId] = model.trim();
      else delete next[profileId];
      return next;
    });
  } catch (e) {
    setError(String(e));
  }
}

export async function setWorkspaceColor(workspaceId: string, color: string): Promise<void> {
  const state = get(layoutState);
  const normalized = normalizeColor(color);
  const workspaces = state.workspaces.map((w) =>
    w.id === workspaceId ? { ...w, color: normalized } : w
  );
  layoutState.update((s) => ({ ...s, workspaces }));
  await persistWorkspaces(workspaces, state.activeWorkspaceId);
}

/// One writer for every boolean workspace preference that lives in
/// config.json -- the notification toggles and the close confirm. Keyed
/// rather than one function each so a new toggle costs a union member,
/// and so no two of them can disagree about how they persist.
export async function setWorkspaceFlag(
  workspaceId: string,
  key: "notifyNeedsInput" | "notifyFinished" | "confirmTabClose",
  value: boolean
): Promise<void> {
  const state = get(layoutState);
  const workspaces = state.workspaces.map((w) =>
    w.id === workspaceId ? { ...w, [key]: value } : w
  );
  layoutState.update((s) => ({ ...s, workspaces }));
  await persistWorkspaces(workspaces, state.activeWorkspaceId);
}

// Git tab preferences (splitter widths, diff layout, discard-confirm
// opt-out): merged, never replaced, so one control's save can't clobber
// another's.
export async function setGitViewPrefs(workspaceId: string, patch: Partial<GitViewPrefs>): Promise<void> {
  const state = get(layoutState);
  const workspaces = state.workspaces.map((w) =>
    w.id === workspaceId ? { ...w, gitView: { ...(w.gitView ?? {}), ...patch } } : w
  );
  layoutState.update((s) => ({ ...s, workspaces }));
  await persistWorkspaces(workspaces, state.activeWorkspaceId);
}

function clearMainSession(workspaceId: string): void {
  const state = get(layoutState);
  // Captured before the clear, and only destroyed when there was one --
  // destroyTerminal("") would be a meaningless call.
  const sessionId = state.workspaces.find((w) => w.id === workspaceId)?.mainSessionId;
  if (!sessionId) return;
  const workspaces = state.workspaces.map((w) =>
    w.id === workspaceId ? { ...w, mainSessionId: undefined } : w
  );
  layoutState.update((s) => ({ ...s, workspaces }));
  terminalRegistry.destroyTerminal(sessionId);
  void persistWorkspaces(workspaces, state.activeWorkspaceId);
}

// Splits the pane holding `targetSessionId` and drops a fresh session into
// the new half. Scoped to the target's OWN page, and brings that page on
// screen: a split spawns a session and focuses it, so leaving it on an
// invisible page would be a terminal running where nobody can see it. Both
// are no-ops for the tab bar and the keyboard shortcut, which can only
// address the active page anyway -- they matter for the sidebar, which
// reaches every page of every workspace.
export async function splitPane(targetSessionId: string, direction: "row" | "column"): Promise<void> {
  const state = get(layoutState);
  const location = pageLocationForSession(state, targetSessionId);
  if (!location) return;
  const newId = await createFreshSession(location.workspaceId);
  if (!newId) return;
  const newTree = layout.splitLeaf(location.tree, targetSessionId, direction, newId);
  const withTree = workspace.updatePageLayout(state, location.workspaceId, location.pageId, newTree);
  const withFocus = workspace.setPageFocus(withTree, location.workspaceId, location.pageId, newId);
  const switchedPage = workspace.switchPage(withFocus, location.workspaceId, location.pageId);
  const switchedWs = activateWorkspace(switchedPage, location.workspaceId);
  const data = workspace.switchWorkspaceView(switchedWs, location.workspaceId, "terminal");
  layoutState.update((s) => ({
    ...s,
    workspaces: data.workspaces,
    activeWorkspaceId: data.activeWorkspaceId,
    focusedSessionId: newId,
  }));
  await persistWorkspaces(data.workspaces, data.activeWorkspaceId);
}

// Opens `path` as a new file tab, split beside the pane holding
// `anchorSessionId` -- the cmd+click-a-path flow's entry point. Mirrors
// splitPane exactly, except the new tab is a file tab (a fresh opaque id
// recorded in fileTabsById) rather than a freshly spawned session, so no
// create_session call happens at all.
export async function openFileInSplit(anchorSessionId: string, path: string): Promise<void> {
  const state = get(layoutState);
  const location = activePageLocation(state);
  if (!location) return;
  const tabId = crypto.randomUUID();
  const newTree = layout.splitLeaf(location.tree, anchorSessionId, "row", tabId);
  const withTree = workspace.updatePageLayout(state, location.workspaceId, location.pageId, newTree);
  const data = workspace.setPageFocus(withTree, location.workspaceId, location.pageId, tabId);
  const fileTabsById = { ...state.fileTabsById, [tabId]: { path } };
  layoutState.update((s) => ({ ...s, workspaces: data.workspaces, focusedSessionId: tabId, fileTabsById }));

  const asPathMap: Record<string, string> = {};
  for (const [id, tab] of Object.entries(fileTabsById)) {
    asPathMap[id] = tab.path;
  }
  try {
    await backend.setFileTabs(asPathMap);
  } catch (e) {
    setError(String(e));
    return;
  }
  await persistWorkspaces(data.workspaces, state.activeWorkspaceId);
}

// Opens a context board as a new board tab, split beside the pane holding
// `anchorSessionId` -- the pane board-icon flow's entry point. Mirrors
// openFileInSplit exactly, with boardTabsById/setBoardTabs in place of the
// file-tab map.
export async function openBoardInSplit(
  anchorSessionId: string,
  workspaceId: string,
  contextFolder: string
): Promise<void> {
  const state = get(layoutState);
  const location = activePageLocation(state);
  if (!location) return;
  const tabId = crypto.randomUUID();
  const newTree = layout.splitLeaf(location.tree, anchorSessionId, "row", tabId);
  const withTree = workspace.updatePageLayout(state, location.workspaceId, location.pageId, newTree);
  const data = workspace.setPageFocus(withTree, location.workspaceId, location.pageId, tabId);
  const boardTabsById = { ...state.boardTabsById, [tabId]: { workspaceId, contextFolder } };
  layoutState.update((s) => ({ ...s, workspaces: data.workspaces, focusedSessionId: tabId, boardTabsById }));
  try {
    await backend.setBoardTabs(boardTabsById);
  } catch (e) {
    setError(String(e));
    return;
  }
  await persistWorkspaces(data.workspaces, state.activeWorkspaceId);
}

export async function addTab(targetSessionId: string): Promise<void> {
  const state = get(layoutState);
  const location = activePageLocation(state);
  if (!location) return;
  const newId = await createFreshSession(location.workspaceId);
  if (!newId) return;
  const newTree = layout.addTab(location.tree, targetSessionId, newId);
  const withTree = workspace.updatePageLayout(state, location.workspaceId, location.pageId, newTree);
  const data = workspace.setPageFocus(withTree, location.workspaceId, location.pageId, newId);
  layoutState.update((s) => ({ ...s, workspaces: data.workspaces, focusedSessionId: newId }));
  await persistWorkspaces(data.workspaces, state.activeWorkspaceId);
}

export async function closeSession(sessionId: string): Promise<void> {
  const state = get(layoutState);
  const closed = await endTabs([sessionId], state.fileTabsById, state.boardTabsById);
  if (!closed) return;
  // Tree first, maps second (see ClosedTabs): the other order leaves the
  // tab in the tree for a render with nothing left to classify it.
  handleSessionExited(sessionId);
  await pruneClosedTabs(closed);
}

// Shared by closeSession (after a successful daemon-side kill) and the
// session-exited event listener (the session is already dead, so no
// killSession call happens here) -- both cases mean "remove this session
// from wherever it lives." Searches every page of every workspace, not
// just the active one -- a session-exited event can arrive for a session
// in a currently-invisible page, since inactive pages/workspaces keep
// their sessions running the same as inactive tabs always have. If
// removing it empties that page's tree entirely, the whole page is
// removed too (see workspace.ts's updatePageLayout doc comment for why
// there's no "clear the layout" alternative).
/// Exit code by session id, for sessions that have ended while this app
/// was running. A tool step is done or stalled by exactly this (tools
/// spec T5), and a session absent from here has no WITNESSED outcome --
/// which is a stall, not a pass.
///
/// Never pruned by age: an entry is a few bytes and the map only grows
/// with sessions that actually ended in this app run. Pruning it would
/// mean a slow rail's finished step could lose its verdict.
export const sessionExits = writable<Map<string, number>>(new Map());

export function recordSessionExit(sessionId: string, exitCode: number): void {
  sessionExits.update((m) => new Map(m).set(sessionId, exitCode));
}

export function handleSessionExited(sessionId: string): void {
  const state = get(layoutState);
  // A main agent session lives outside every page tree (D12), so the
  // search below can never find it -- without this branch its terminal
  // would sit dead on the home forever.
  const owner = workspaceIdForSession(state, sessionId);
  if (owner && state.workspaces.find((w) => w.id === owner)?.mainSessionId === sessionId) {
    clearMainSession(owner);
    return;
  }
  let found: { workspaceId: string; pageId: string; page: { layout: LayoutNode } } | null = null;
  for (const ws of state.workspaces) {
    for (const page of ws.pages) {
      if (layout.findLeafPath(page.layout, sessionId)) {
        found = { workspaceId: ws.id, pageId: page.id, page };
        break;
      }
    }
    if (found) break;
  }
  if (!found) return;

  const newTree = layout.closeTab(found.page.layout, sessionId);
  let updated = newTree
    ? workspace.updatePageLayout(state, found.workspaceId, found.pageId, newTree)
    : workspace.removePage(state, found.workspaceId, found.pageId);

  let focusedSessionId = state.focusedSessionId;
  if (state.focusedSessionId === sessionId) {
    const resolved = workspace.resolveActiveFocus(updated);
    updated = resolved.state;
    focusedSessionId = resolved.focusedSessionId;
  }

  layoutState.update((s) => ({
    ...s,
    workspaces: updated.workspaces,
    activeWorkspaceId: updated.activeWorkspaceId,
    focusedSessionId,
  }));
  terminalRegistry.destroyTerminal(sessionId);
  void persistWorkspaces(updated.workspaces, updated.activeWorkspaceId);
}

// An MCP-spawned session (daemon push, already Attached by the Rust
// relay). Lands on the workspace's "Agents" page -- found by name,
// created with the session as its first tab when absent. Never steals
// focus (createPage activates the new page, so the previous active page
// is restored). If the workspace no longer exists, the session is
// killed: an agent the human can't see is never allowed to keep running.
export function handleAgentSessionSpawned(workspaceId: string, sessionId: string): void {
  const state = get(layoutState);
  const ws = state.workspaces.find((w) => w.id === workspaceId);
  if (!ws) {
    void backend.killSession(sessionId).catch(() => {});
    return;
  }
  const base: WorkspacesData = { workspaces: state.workspaces, activeWorkspaceId: state.activeWorkspaceId };
  const agentsPage = ws.pages.find((p) => p.name === "Agents");
  let data: WorkspacesData;
  if (agentsPage) {
    const anchor = layout.allSessionIds(agentsPage.layout)[0];
    const newTree = layout.addTab(agentsPage.layout, anchor, sessionId);
    data = workspace.updatePageLayout(base, workspaceId, agentsPage.id, newTree);
  } else {
    const previousActive = ws.activePageId;
    data = workspace.createPage(base, workspaceId, crypto.randomUUID(), "Agents", {
      type: "leaf",
      tabs: [sessionId],
      activeTabIndex: 0,
    });
    if (previousActive) data = workspace.switchPage(data, workspaceId, previousActive);
  }
  layoutState.update((s) => ({ ...s, workspaces: data.workspaces }));
  void persistWorkspaces(data.workspaces, state.activeWorkspaceId);
}

// Shared by the "cwd-changed" event listener in bootstrap() and this
// file's own tests. Entries are never removed when a session closes; a
// stale in-memory map entry per session that ever existed in one app run
// is not a meaningful memory concern.
export function handleCwdChanged(sessionId: string, cwd: string): void {
  // Mirrored into terminalRegistry too: its xterm link provider resolves
  // relative paths against this cwd synchronously, so it can't read the
  // store (and can't import this module back -- that would be circular).
  terminalRegistry.setCwdForLinks(sessionId, cwd);
  layoutState.update((s) => ({ ...s, cwdBySessionId: { ...s.cwdBySessionId, [sessionId]: cwd } }));
}

// Shared by the "session-status-changed" event listener in bootstrap() and
// this file's own tests. Reads the *previous* status before overwriting
// the map -- undefined for a session's first-ever status report -- and
// hands both values plus a resolved display label to notifications.ts,
// which decides whether the specific transition is worth an OS
// notification. Like handleCwdChanged, entries are never removed on
// session exit.
export function handleSessionStatusChanged(sessionId: string, status: SessionStatus): void {
  const state = get(layoutState);
  const previousStatus = state.sessionStatusById[sessionId];
  layoutState.update((s) => ({ ...s, sessionStatusById: { ...s.sessionStatusById, [sessionId]: status } }));
  const label = sessionLabel(state.sessionNames, state.cwdBySessionId, sessionId);
  const owner = workspaceIdForSession(state, sessionId);
  const owningWs = owner ? state.workspaces.find((w) => w.id === owner) : undefined;
  // A session owned by no workspace (spawned but not yet landed) keeps
  // today's behaviour rather than going silent.
  void maybeNotifyStatusChange(sessionId, previousStatus, status, label, {
    needsInput: owningWs?.notifyNeedsInput ?? true,
    finished: owningWs?.notifyFinished ?? true,
  });
}

// Shared by the "git-status-changed" event listener in bootstrap() and
// this file's own tests. Unlike handleSessionStatusChanged, there is no
// previous-value read and no notification side effect -- git status
// changes are frequent (every fs-watch trigger, every OSC-133 idle
// prompt) and were never in scope for OS notifications, only the in-app
// dot/sidebar display. Like handleCwdChanged/handleSessionStatusChanged,
// entries are never removed on session exit.
export function handleGitStatusChanged(sessionId: string, status: GitStatus | null): void {
  layoutState.update((s) => ({ ...s, gitStatusById: { ...s.gitStatusById, [sessionId]: status } }));
}

// Shared by the "session-restored" event listener in bootstrap() and this
// file's own tests. Entries are added, never auto-removed by the passage
// of time -- clearRestoredMarker (below) is the only thing that removes
// one, driven by the user actually typing into (or pasting into) that
// specific session.
export function handleSessionRestored(sessionId: string): void {
  layoutState.update((s) => ({ ...s, restoredSessionIds: new Set(s.restoredSessionIds).add(sessionId) }));
}

// Called via backend.ts's writeInput hook on every single keystroke and
// paste across every session in the app -- checked against the current
// state BEFORE calling layoutState.update, so the overwhelmingly common
// case (a session that was never restored, or was already cleared) never
// triggers a store update or a new Set allocation at all.
export function clearRestoredMarker(sessionId: string): void {
  if (!get(layoutState).restoredSessionIds.has(sessionId)) return;
  layoutState.update((s) => {
    const next = new Set(s.restoredSessionIds);
    next.delete(sessionId);
    return { ...s, restoredSessionIds: next };
  });
}

// A blank (or whitespace-only) name clears the override rather than
// setting an empty string -- the tab falls back to its cwd-based label
// (or the session-id fragment) again. Updates local state immediately
// (the rename UI closes right away); the persist call is best-effort,
// matching every other action's error-surfacing pattern.
export async function setSessionName(sessionId: string, name: string): Promise<void> {
  const trimmed = name.trim();
  layoutState.update((s) => {
    const sessionNames = { ...s.sessionNames };
    if (trimmed) {
      sessionNames[sessionId] = trimmed;
    } else {
      delete sessionNames[sessionId];
    }
    return { ...s, sessionNames };
  });
  try {
    await backend.setSessionName(sessionId, trimmed);
  } catch (e) {
    setError(String(e));
  }
}

export async function switchToTab(sessionId: string): Promise<void> {
  const state = get(layoutState);
  const location = activePageLocation(state);
  if (!location) return;
  // The workspace is already the active one, so activateWorkspace never
  // runs -- but this is reachable from the sidebar with the hub up, and
  // choosing a tab plainly means "show me that tab".
  closeAppHub();
  const newTree = layout.switchTab(location.tree, sessionId);
  const withTree = workspace.updatePageLayout(state, location.workspaceId, location.pageId, newTree);
  const data = workspace.setPageFocus(withTree, location.workspaceId, location.pageId, sessionId);
  layoutState.update((s) => ({ ...s, workspaces: data.workspaces, focusedSessionId: sessionId }));
  await persistWorkspaces(data.workspaces, state.activeWorkspaceId);
}

// Makes sessionId's own page (and workspace) active, and that session
// itself the active tab within its pane AND the page's remembered focus
// -- unlike switchPage alone (which falls back to the page's own
// last-remembered focus, or its first session, not necessarily the one
// that was actually clicked). Used by the sidebar's expanded multi-repo
// session rows (Sidebar.svelte), where each row targets one specific
// session that may not already be its page's active tab, and that page
// may not even be the currently active one.
//
// Ordering below is load-bearing: resolveActiveFocus reads
// getActiveWorkspace/getActivePage, so it must run AFTER switchPage/
// switchWorkspace, not before -- hoisting it above them would silently
// resolve focus against the OLD active page and leave the clicked
// session unfocused, with no test failure in any case where the target
// page/workspace was already active (the only cases the single-workspace
// tests originally covered).
export async function switchToSessionInPage(workspaceId: string, pageId: string, sessionId: string): Promise<void> {
  const state = get(layoutState);
  const page = state.workspaces.find((w) => w.id === workspaceId)?.pages.find((p) => p.id === pageId);
  if (!page) return;
  const newTree = layout.switchTab(page.layout, sessionId);
  const withTree = workspace.updatePageLayout(state, workspaceId, pageId, newTree);
  const withFocus = workspace.setPageFocus(withTree, workspaceId, pageId, sessionId);
  const switchedPage = workspace.switchPage(withFocus, workspaceId, pageId);
  const switched = activateWorkspace(switchedPage, workspaceId);
  const resolved = workspace.resolveActiveFocus(switched);
  layoutState.update((s) => ({
    ...s,
    workspaces: resolved.state.workspaces,
    activeWorkspaceId: resolved.state.activeWorkspaceId,
    focusedSessionId: resolved.focusedSessionId,
  }));
  await persistWorkspaces(resolved.state.workspaces, resolved.state.activeWorkspaceId);
}

export function focusPane(sessionId: string): void {
  const state = get(layoutState);
  const location = activePageLocation(state);
  const workspaces = location
    ? workspace.setPageFocus(state, location.workspaceId, location.pageId, sessionId).workspaces
    : state.workspaces;
  layoutState.update((s) => ({ ...s, workspaces, focusedSessionId: sessionId }));
}

// Updates the active page's sizes without persisting -- used for live
// visual feedback while a divider drag is in progress. Call
// commitLayout() once, on drag-end, to actually persist.
export function previewResizePane(splitPath: number[], sizes: number[]): void {
  const state = get(layoutState);
  const location = activePageLocation(state);
  if (!location) return;
  const newTree = layout.resizeSplit(location.tree, splitPath, sizes);
  const workspaces = workspace.updatePageLayout(state, location.workspaceId, location.pageId, newTree).workspaces;
  layoutState.update((s) => ({ ...s, workspaces }));
}

// Persists whatever the current workspaces array is. Call once after a
// batch of previewResizePane calls (e.g. on pointerup), not per
// intermediate step.
export async function commitLayout(): Promise<void> {
  const state = get(layoutState);
  if (!activePageLocation(state)) return;
  await persistWorkspaces(state.workspaces, state.activeWorkspaceId);
}

// Closes every tab in the pane (within the active page) containing
// anySessionId -- distinct from closeSession (which closes just the one
// named session). Used by the toolbar's "Close Pane" button; Cmd+W stays
// scoped to a single tab via closeSession.
//
// Unlike the old single-tree model, this always persists the result --
// there's no "tree became null, can't persist null" case to skip anymore,
// since Page.layout is never null and an emptied page is removed via
// removePage rather than set to some unrepresentable empty value.
export async function closePane(anySessionId: string): Promise<void> {
  const state = get(layoutState);
  const location = activePageLocation(state);
  if (!location) return;
  const path = layout.findLeafPath(location.tree, anySessionId);
  if (!path) return;
  const leaf = layout.getNodeAtPath(location.tree, path);
  if (leaf.type !== "leaf") return;
  const sessionIds = [...leaf.tabs];

  const closed = await endTabs(sessionIds, state.fileTabsById, state.boardTabsById);
  if (!closed) return;

  let tree: LayoutNode | null = location.tree;
  for (const id of sessionIds) {
    if (!tree) break;
    tree = layout.closeTab(tree, id);
    terminalRegistry.destroyTerminal(id);
  }

  let updated = tree
    ? workspace.updatePageLayout(state, location.workspaceId, location.pageId, tree)
    : workspace.removePage(state, location.workspaceId, location.pageId);

  let focusedSessionId = state.focusedSessionId;
  if (sessionIds.includes(state.focusedSessionId ?? "")) {
    const resolved = workspace.resolveActiveFocus(updated);
    updated = resolved.state;
    focusedSessionId = resolved.focusedSessionId;
  }

  layoutState.update((s) => ({
    ...s,
    workspaces: updated.workspaces,
    activeWorkspaceId: updated.activeWorkspaceId,
    focusedSessionId,
  }));
  await pruneClosedTabs(closed);
  await persistWorkspaces(updated.workspaces, updated.activeWorkspaceId);
}

export async function createWorkspace(name: string): Promise<void> {
  const state = get(layoutState);
  const id = crypto.randomUUID();
  // createWorkspace makes the new workspace active without going through
  // switchWorkspace, so the hub is taken down here rather than there --
  // the hub's own "+ New workspace…" must land you in what it created.
  closeAppHub();
  const data = workspace.createWorkspace(state, id, name);
  const resolved = workspace.resolveActiveFocus(data);
  layoutState.update((s) => ({
    ...s,
    workspaces: resolved.state.workspaces,
    activeWorkspaceId: resolved.state.activeWorkspaceId,
    focusedSessionId: resolved.focusedSessionId,
  }));
  await persistWorkspaces(resolved.state.workspaces, resolved.state.activeWorkspaceId);
}

export async function renameWorkspace(workspaceId: string, name: string): Promise<void> {
  const state = get(layoutState);
  const data = workspace.renameWorkspace(state, workspaceId, name);
  layoutState.update((s) => ({ ...s, workspaces: data.workspaces }));
  await persistWorkspaces(data.workspaces, data.activeWorkspaceId);
}

export async function switchWorkspace(workspaceId: string): Promise<void> {
  const state = get(layoutState);
  const switched = activateWorkspace(state, workspaceId);
  const resolved = workspace.resolveActiveFocus(switched);
  layoutState.update((s) => ({
    ...s,
    workspaces: resolved.state.workspaces,
    activeWorkspaceId: resolved.state.activeWorkspaceId,
    focusedSessionId: resolved.focusedSessionId,
  }));
  await persistWorkspaces(resolved.state.workspaces, resolved.state.activeWorkspaceId);
}

export async function switchWorkspaceView(workspaceId: string, view: string): Promise<void> {
  const state = get(layoutState);
  // Same reason as switchToTab: the workspace is already active so
  // activateWorkspace never runs, but ⌘2 (and the tab row, and Home's
  // tiles) plainly mean "show me that tab" -- leaving the hub up would
  // change the view underneath it and look like nothing happened.
  closeAppHub();
  const data = workspace.switchWorkspaceView(state, workspaceId, view);
  layoutState.update((s) => ({ ...s, workspaces: data.workspaces }));
  await persistWorkspaces(data.workspaces, data.activeWorkspaceId);
}

// Kills every session across every page of the workspace, then removes
// it -- the same escalation as closePane, one level up. Confirm-before
// prompting is the caller's (Sidebar.svelte's) responsibility, matching
// how confirmPaneClose/confirmTabClose already work.
//
// App-side ONLY: not one file on disk and not one daemon row is touched.
// It used to delete the workspace's kanban board, which made the sidebar
// X silently destroy columns and labels that took real work to arrange --
// the same gesture that closes a tab. Removing a workspace's DATA is now
// the delete wizard's job (Settings > Danger zone), and this leaves a
// tombstone instead so those rows can be reclaimed: the workspace id is
// a uuid minted at creation, so without one the rows are unreachable
// forever.
//
// `remember: false` is the delete wizard's ending: it has just been
// through six screens deciding what to remove, so leaving a record
// offering to bring it all back would contradict the answer the user
// gave. Every other caller wants the tombstone, which is why it is the
// default rather than a flag each of them has to remember.
export async function closeWorkspace(
  workspaceId: string,
  opts: { remember?: boolean } = {}
): Promise<void> {
  const state = get(layoutState);
  const ws = state.workspaces.find((w) => w.id === workspaceId);
  if (!ws) return;
  const sessionIds = workspace.allSessionIdsInWorkspace(ws);

  const closed = await endTabs(sessionIds, state.fileTabsById, state.boardTabsById);
  if (!closed) return;
  for (const id of sessionIds) {
    terminalRegistry.destroyTerminal(id);
  }

  // Stamped BEFORE the removal, because the tombstone's name and root
  // are read off the workspace that is about to disappear. A rootless
  // workspace produces none -- see rememberRemoved.
  const remembered =
    opts.remember === false ? state : workspace.rememberRemoved(state, workspaceId, Date.now());
  let updated = workspace.removeWorkspace(remembered, workspaceId);
  let focusedSessionId = state.focusedSessionId;
  if (sessionIds.includes(state.focusedSessionId ?? "")) {
    const resolved = workspace.resolveActiveFocus(updated);
    updated = resolved.state;
    focusedSessionId = resolved.focusedSessionId;
  }

  layoutState.update((s) => ({
    ...s,
    workspaces: updated.workspaces,
    activeWorkspaceId: updated.activeWorkspaceId,
    focusedSessionId,
    // Into the store before the persist, which reads the list from
    // there rather than taking it as an argument.
    removedWorkspaces: updated.removedWorkspaces ?? [],
  }));
  await pruneClosedTabs(closed);
  await persistWorkspaces(updated.workspaces, updated.activeWorkspaceId);
}

/// The delete wizard's last act: the workspace leaves the app the way
/// the sidebar X removes one, but with no tombstone behind it. Named
/// rather than inlined so the one place that means "gone, and do not
/// offer it back" says so at the call site.
export function deleteWorkspaceFromApp(workspaceId: string): Promise<void> {
  return closeWorkspace(workspaceId, { remember: false });
}

// Creates N fresh daemon sessions, builds a tree via buildTree (typically
// one of layout.ts's preset generators), and appends it as a new page to
// the given workspace -- always an explicit workspaceId, never "whichever
// workspace happens to be active," so a caller (e.g. Sidebar.svelte's
// per-workspace "+" button) can add a page to a workspace without first
// switching to it. The new page (and its workspace) become active,
// mirroring "a new tab becomes the active one" elsewhere in this app.
/// Returns the new page's id, so a caller that must bind something to it
/// (an orchestration rail) does not have to guess which page appeared.
/// Null when the workspace is unknown or session creation failed.
/// `cwd` is where the fresh shells open; omitted, the workspace's own
/// root applies (freshSessionCwd), which is what the toolbar's "new
/// page" buttons want. A rail passes its checkout, so the page it spawns
/// for itself opens where that rail actually works rather than at the
/// workspace root.
///
/// `activate: false` builds the page WITHOUT switching to it. A page the
/// human asked for by name should come to the front; one the app made on
/// their behalf must not take the screen they were using -- pressing
/// Start on a rail would otherwise throw them off the Orchestration tab
/// they pressed it in. Same posture createSessionOnPage already takes
/// when it drops a rail's agent onto a page that is not on screen.
export async function createPage(
  workspaceId: string,
  buildTree: (freshIds: string[]) => LayoutNode,
  sessionCount: number,
  name: string,
  opts: { cwd?: string; activate?: boolean } = {}
): Promise<string | null> {
  const state = get(layoutState);
  const target = state.workspaces.find((w) => w.id === workspaceId);
  if (!target) return null;
  const previousPageId = target.activePageId;
  let freshIds: string[];
  try {
    const sessionCwd = opts.cwd || freshSessionCwd(workspaceId);
    freshIds = await Promise.all(
      Array.from({ length: sessionCount }, () => backend.createSession(sessionCwd))
    );
  } catch (e) {
    setError(String(e));
    return null;
  }
  const tree = buildTree(freshIds);
  const pageId = crypto.randomUUID();
  const created = workspace.createPage(state, workspaceId, pageId, name, tree);
  const focusedSessionId = freshIds[0] ?? null;
  const data = workspace.setPageFocus(created, workspaceId, pageId, focusedSessionId);
  const activate = opts.activate !== false;
  // workspace.createPage always activates what it appends, so the
  // non-activating case puts the workspace back on the page it was on.
  const workspaces = activate
    ? data.workspaces
    : data.workspaces.map((w) => (w.id === workspaceId ? { ...w, activePageId: previousPageId } : w));
  layoutState.update((s) => ({
    ...s,
    workspaces,
    activeWorkspaceId: activate ? workspaceId : s.activeWorkspaceId,
    focusedSessionId: activate ? focusedSessionId : s.focusedSessionId,
  }));
  await persistWorkspaces(workspaces, data.activeWorkspaceId);
  return pageId;
}

// Creates a fresh session for a kanban card link, homing it in the given
// workspace: added as a new tab on the workspace's active page if it has
// one, or a freshly created single-pane page (mirroring createPage's own
// default preset) if the workspace has zero pages yet. Unlike
// splitPane/addTab, this always targets an explicit workspaceId rather
// than "whichever page/workspace is currently active" -- the kanban hub
// this is called from is not necessarily showing a terminal view at all.
// cwd/command mirror SessionLink's own shape ("" / null both mean
// "use the default"), converted to undefined here -- the one place that
// conversion happens, so every caller (create-new, re-launch) can just
// pass a SessionLink's fields straight through.
/// createSessionForCard, but landing on a NAMED page rather than the
/// workspace's active one -- what an orchestration rail needs, since a
/// rail binds to a page (orchestration spec §4.3). A null or unknown
/// pageId falls back to createSessionForCard's behavior, which is the
/// Agents-page posture.
export async function createSessionOnPage(
  workspaceId: string,
  pageId: string | null,
  cwd: string,
  command: string | null
): Promise<string | null> {
  const state = get(layoutState);
  const ws = state.workspaces.find((w) => w.id === workspaceId);
  const page = pageId ? ws?.pages.find((p) => p.id === pageId) : undefined;
  if (!ws || !page) return createSessionForCard(workspaceId, cwd, command);

  let sessionId: string;
  try {
    sessionId = await backend.createSession(cwd || undefined, command ?? undefined);
  } catch (e) {
    setError(String(e));
    return null;
  }
  const anchor = layout.allSessionIds(page.layout)[0];
  const newTree = anchor
    ? layout.addTab(page.layout, anchor, sessionId)
    : layout.presetSingle(sessionId);
  const withTree = workspace.updatePageLayout(state, workspaceId, page.id, newTree);
  const data = workspace.setPageFocus(withTree, workspaceId, page.id, sessionId);
  layoutState.update((s) => ({ ...s, workspaces: data.workspaces }));
  await persistWorkspaces(data.workspaces, state.activeWorkspaceId);
  return sessionId;
}

export async function createSessionForCard(
  workspaceId: string,
  cwd: string,
  command: string | null
): Promise<string | null> {
  const state = get(layoutState);
  const ws = state.workspaces.find((w) => w.id === workspaceId);
  if (!ws) return null;

  let sessionId: string;
  try {
    sessionId = await backend.createSession(cwd || undefined, command ?? undefined);
  } catch (e) {
    setError(String(e));
    return null;
  }

  if (ws.pages.length === 0) {
    const pageId = crypto.randomUUID();
    const created = workspace.createPage(state, workspaceId, pageId, "Page 1", layout.presetSingle(sessionId));
    const data = workspace.setPageFocus(created, workspaceId, pageId, sessionId);
    layoutState.update((s) => ({
      ...s,
      workspaces: data.workspaces,
      activeWorkspaceId: workspaceId,
      focusedSessionId: sessionId,
    }));
    await persistWorkspaces(data.workspaces, data.activeWorkspaceId);
    return sessionId;
  }

  const pageId = ws.activePageId ?? ws.pages[0].id;
  const page = ws.pages.find((p) => p.id === pageId);
  if (!page) return sessionId;
  const anchor = layout.allSessionIds(page.layout)[0];
  const newTree = anchor ? layout.addTab(page.layout, anchor, sessionId) : layout.presetSingle(sessionId);
  const withTree = workspace.updatePageLayout(state, workspaceId, pageId, newTree);
  const data = workspace.setPageFocus(withTree, workspaceId, pageId, sessionId);
  layoutState.update((s) => ({ ...s, workspaces: data.workspaces }));
  await persistWorkspaces(data.workspaces, state.activeWorkspaceId);
  return sessionId;
}

export async function renamePage(workspaceId: string, pageId: string, name: string): Promise<void> {
  const state = get(layoutState);
  const data = workspace.renamePage(state, workspaceId, pageId, name);
  layoutState.update((s) => ({ ...s, workspaces: data.workspaces }));
  await persistWorkspaces(data.workspaces, data.activeWorkspaceId);
}

export async function switchPage(workspaceId: string, pageId: string): Promise<void> {
  const state = get(layoutState);
  const switchedPage = workspace.switchPage(state, workspaceId, pageId);
  const switched = activateWorkspace(switchedPage, workspaceId);
  const resolved = workspace.resolveActiveFocus(switched);
  layoutState.update((s) => ({
    ...s,
    workspaces: resolved.state.workspaces,
    activeWorkspaceId: resolved.state.activeWorkspaceId,
    focusedSessionId: resolved.focusedSessionId,
  }));
  await persistWorkspaces(resolved.state.workspaces, resolved.state.activeWorkspaceId);
}

// Kills every session in the page, then removes it -- same escalation as
// closeWorkspace, one level down. Confirm-before prompting is the
// caller's responsibility.
export async function closePage(workspaceId: string, pageId: string): Promise<void> {
  const state = get(layoutState);
  const page = state.workspaces.find((w) => w.id === workspaceId)?.pages.find((p) => p.id === pageId);
  if (!page) return;
  const sessionIds = layout.allSessionIds(page.layout);

  const closed = await endTabs(sessionIds, state.fileTabsById, state.boardTabsById);
  if (!closed) return;
  for (const id of sessionIds) {
    terminalRegistry.destroyTerminal(id);
  }

  let updated = workspace.removePage(state, workspaceId, pageId);
  let focusedSessionId = state.focusedSessionId;
  if (sessionIds.includes(state.focusedSessionId ?? "")) {
    const resolved = workspace.resolveActiveFocus(updated);
    updated = resolved.state;
    focusedSessionId = resolved.focusedSessionId;
  }

  layoutState.update((s) => ({
    ...s,
    workspaces: updated.workspaces,
    activeWorkspaceId: updated.activeWorkspaceId,
    focusedSessionId,
  }));
  await pruneClosedTabs(closed);
  await persistWorkspaces(updated.workspaces, updated.activeWorkspaceId);
}

export type DropTarget =
  | {
      kind: "page";
      workspaceId: string;
      pageId: string;
      mode: "left" | "right" | "top" | "bottom" | "center";
      // The specific pane within the target page this drop was aimed at,
      // if known (e.g. Pane.svelte always knows its own active tab).
      // Sidebar drops have no specific pane in mind -- the target page
      // isn't rendered while dragging from the sidebar -- so they omit
      // this, and movePaneOrTab falls back to the page's own remembered
      // focus, exactly as it did before this field existed.
      targetSessionId?: string;
    }
  | { kind: "workspace"; workspaceId: string };

// Moves a whole pane (source.kind === "pane") or a single tab
// (source.kind === "tab") from wherever it currently lives to the given
// target. Handles cross-page and same-page moves uniformly -- when
// source and target page happen to be identical, detach+graft still
// applies, they just both land on that one page's own layout, producing
// a single write instead of two. Dropping onto a workspace (not a
// specific page) always creates a brand-new page there; dropping onto a
// page either grafts a new split in one of 4 directions, or merges as a
// new tab into that page's remembered focused pane (mode "center"). No
// daemon calls are ever made -- this is pure restructuring of the
// already-loaded workspaces array, then a persist.
export async function movePaneOrTab(
  source: { kind: "pane" | "tab"; workspaceId: string; pageId: string; sessionId: string },
  target: DropTarget
): Promise<void> {
  const state = get(layoutState);
  const sourcePage = state.workspaces
    .find((w) => w.id === source.workspaceId)
    ?.pages.find((p) => p.id === source.pageId);
  if (!sourcePage) return;

  // No explicit "same page = no-op" guard here, deliberately: a page can
  // hold multiple panes (e.g. a 2x2 grid), and dragging one pane onto
  // another pane *within that same page* is a legitimate rearrangement,
  // not a no-op -- it produces a genuinely different tree (detach pane A,
  // graft it back in next to pane B in the chosen direction). The one
  // truly degenerate case -- detaching a page's ONLY pane and dropping it
  // back onto that same, now-just-removed page -- is already handled
  // correctly below without a special case: after workspace.removePage
  // runs, that page id no longer exists in `data` at all, so the
  // `if (!targetPage) return;` check further down fails to find it and
  // the whole operation aborts cleanly, before anything is written to the
  // store or persisted.
  const detachResult =
    source.kind === "pane"
      ? layout.detachLeaf(sourcePage.layout, source.sessionId)
      : layout.detachTab(sourcePage.layout, source.sessionId);
  if (!detachResult) return;
  const { tree: sourceTreeAfterDetach, detached } = detachResult;

  let data = sourceTreeAfterDetach
    ? workspace.updatePageLayout(state, source.workspaceId, source.pageId, sourceTreeAfterDetach)
    : workspace.removePage(state, source.workspaceId, source.pageId);

  if (target.kind === "workspace") {
    const targetWs = data.workspaces.find((w) => w.id === target.workspaceId);
    if (!targetWs) return;
    const pageId = crypto.randomUUID();
    data = workspace.createPage(
      data,
      target.workspaceId,
      pageId,
      `Page ${targetWs.pages.length + 1}`,
      detached
    );
  } else {
    const targetPage = data.workspaces
      .find((w) => w.id === target.workspaceId)
      ?.pages.find((p) => p.id === target.pageId);
    if (!targetPage) return;
    // If a specific pane was targeted and it's still present in the
    // (already-detached) target tree, aim the graft/merge at exactly
    // that pane. Otherwise fall back to the page's remembered focus
    // (mergeIntoActivePane's own existing fallback) or a whole-tree graft
    // (graftLeaf) -- the same behavior this had before targetSessionId
    // existed, still correct for Sidebar-originated drops which never
    // set it.
    const hasValidTarget =
      target.targetSessionId !== undefined && layout.findLeafPath(targetPage.layout, target.targetSessionId) !== null;
    const newTargetTree =
      target.mode === "center"
        ? layout.mergeIntoActivePane(
            targetPage.layout,
            hasValidTarget ? (target.targetSessionId as string) : targetPage.focusedSessionId,
            detached
          )
        : hasValidTarget
          ? layout.graftLeafAt(targetPage.layout, target.targetSessionId as string, detached, target.mode)
          : layout.graftLeaf(targetPage.layout, detached, target.mode);
    data = workspace.updatePageLayout(data, target.workspaceId, target.pageId, newTargetTree);
  }

  const resolved = workspace.resolveActiveFocus(data);
  layoutState.update((s) => ({
    ...s,
    workspaces: resolved.state.workspaces,
    activeWorkspaceId: resolved.state.activeWorkspaceId,
    focusedSessionId: resolved.focusedSessionId,
  }));
  await persistWorkspaces(resolved.state.workspaces, resolved.state.activeWorkspaceId);
}

// Reorders a tab within its own pane's tab bar -- always scoped to the
// active page, since dragging to reorder only ever happens on something
// currently rendered on screen.
export async function reorderTabWithinPane(sessionId: string, targetIndex: number): Promise<void> {
  const state = get(layoutState);
  const location = activePageLocation(state);
  if (!location) return;
  const newTree = layout.moveTabWithinLeaf(location.tree, sessionId, targetIndex);
  const data = workspace.updatePageLayout(state, location.workspaceId, location.pageId, newTree);
  layoutState.update((s) => ({ ...s, workspaces: data.workspaces }));
  await persistWorkspaces(data.workspaces, state.activeWorkspaceId);
}

// Pins or unpins a tab in the active page. The layout helpers keep pinned
// tabs as a prefix of the pane's tab list, so the tab visibly moves.
// Scoped to the tab's own page, not the active one -- see
// pageLocationForSession. Unlike splitPane this deliberately does NOT
// bring that page on screen: pinning is a bookkeeping change to where a
// tab sits in its own bar, and yanking the view away from what the user
// is looking at would be a far bigger side effect than the edit itself.
export async function setTabPinned(sessionId: string, pinned: boolean): Promise<void> {
  const state = get(layoutState);
  const location = pageLocationForSession(state, sessionId);
  if (!location) return;
  const newTree = pinned
    ? layout.pinTab(location.tree, sessionId)
    : layout.unpinTab(location.tree, sessionId);
  const data = workspace.updatePageLayout(state, location.workspaceId, location.pageId, newTree);
  layoutState.update((s) => ({ ...s, workspaces: data.workspaces }));
  await persistWorkspaces(data.workspaces, state.activeWorkspaceId);
}

export async function reorderWorkspaceAction(workspaceId: string, targetIndex: number): Promise<void> {
  const state = get(layoutState);
  const data = workspace.reorderWorkspace(state, workspaceId, targetIndex);
  layoutState.update((s) => ({ ...s, workspaces: data.workspaces }));
  await persistWorkspaces(data.workspaces, data.activeWorkspaceId);
}

// Moves a page to a new position (reorder within its workspace, or move
// to a different one). If the moved page was the currently active one,
// the app follows it -- activeWorkspaceId (and that workspace's own
// activePageId) switch to keep showing the same page, rather than
// silently changing what's on screen out from under the user mid-drag.
export async function movePageAction(pageId: string, targetWorkspaceId: string, targetIndex: number): Promise<void> {
  const state = get(layoutState);
  const wasActivePage = workspace.getActivePage(state)?.id === pageId;
  let data = workspace.movePage(state, pageId, targetWorkspaceId, targetIndex);
  if (wasActivePage) {
    data = activateWorkspace(workspace.switchPage(data, targetWorkspaceId, pageId), targetWorkspaceId);
  }
  const resolved = workspace.resolveActiveFocus(data);
  layoutState.update((s) => ({
    ...s,
    workspaces: resolved.state.workspaces,
    activeWorkspaceId: resolved.state.activeWorkspaceId,
    focusedSessionId: resolved.focusedSessionId,
  }));
  await persistWorkspaces(resolved.state.workspaces, resolved.state.activeWorkspaceId);
}
