import { writable, get } from "svelte/store";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { LayoutNode } from "./layout";
import * as layout from "./layout";
import * as backend from "./backend";
import * as terminalRegistry from "./terminalRegistry";
import * as workspace from "./workspace";
import type { Workspace, WorkspacesData, GitStatus } from "./workspace";
import { sessionLabel } from "./paths";
import { maybeNotifyStatusChange, type SessionStatus } from "./notifications";
import { initGavinListeners, watchRootedWorkspaces } from "./gavinState";
import type { BoardTab } from "./gavin";

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
};

export const layoutState = writable<LayoutState>(initialState);

function setError(message: string): void {
  layoutState.update((s) => ({ ...s, status: "error", errorMessage: message }));
}

// Shared by every action below that ends in "mutate the active page's
// tree, then persist the whole workspaces array" -- extracted so that
// pattern exists exactly once instead of once per action.
async function persistWorkspaces(workspaces: Workspace[], activeWorkspaceId: string | null): Promise<void> {
  try {
    await backend.setWorkspacesState(workspaces, activeWorkspaceId);
  } catch (e) {
    setError(String(e));
  }
}

// Shared by every action that creates exactly one fresh session before
// mutating a tree (splitPane, addTab). Returns null -- having already
// called setError -- on failure, so callers just check for null rather
// than duplicating their own try/catch.
async function createFreshSession(): Promise<string | null> {
  try {
    return await backend.createSession();
  } catch (e) {
    setError(String(e));
    return null;
  }
}

// Every close path (tab, pane, page, workspace) ends the tabs it owns.
// A file tab is not a session -- killing it would ask the daemon to kill
// an id it has never heard of -- so it gets its watcher torn down instead.
// Returns false (having already called setError) if a real session kill
// failed, so callers can bail exactly as they do today.
async function endTabs(
  tabIds: string[],
  fileTabsById: Record<string, FileTab>,
  boardTabsById: Record<string, BoardTab>
): Promise<boolean> {
  const closedFileTabIds: string[] = [];
  const closedBoardTabIds: string[] = [];
  for (const id of tabIds) {
    const fileTab = fileTabsById[id];
    if (fileTab) {
      // Best-effort: a watcher that's already gone (or was never
      // started because the file read failed) must not block the close.
      await backend.unwatchFileForViewer(fileTab.path).catch(() => {});
      closedFileTabIds.push(id);
      continue;
    }
    if (boardTabsById[id]) {
      // A board tab is not a session and holds no watcher of its own --
      // tree watching is workspace-level. Prune and persist only.
      closedBoardTabIds.push(id);
      continue;
    }
    try {
      await backend.killSession(id);
    } catch (e) {
      setError(String(e));
      return false;
    }
  }
  if (closedFileTabIds.length > 0) await pruneFileTabs(closedFileTabIds);
  if (closedBoardTabIds.length > 0) await pruneBoardTabs(closedBoardTabIds);
  return true;
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

const unlisteners: UnlistenFn[] = [];

export async function bootstrap(): Promise<void> {
  unlisteners.push(
    await listen<WorkspacesData>("workspaces-ready", (event) => {
      layoutState.update((s) => {
        if (s.status !== "connecting") return s;
        const resolved = workspace.resolveActiveFocus(event.payload);
        return {
          ...s,
          status: "ready",
          workspaces: resolved.state.workspaces,
          activeWorkspaceId: resolved.state.activeWorkspaceId,
          focusedSessionId: resolved.focusedSessionId,
        };
      });
      watchRootedWorkspaces(event.payload.workspaces);
    })
  );
  unlisteners.push(
    await listen<[string, number]>("session-exited", (event) => {
      handleSessionExited(event.payload[0]);
    })
  );
  unlisteners.push(
    await listen<string>("daemon-error", (event) => {
      setError(event.payload);
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
  // Registered before any watchGavinRoot can fire (the two ready paths
  // below) -- gavin-tree-changed pushes with no listener would be lost,
  // not buffered.
  unlisteners.push(await initGavinListeners());
  unlisteners.push(
    await listen<[string, string, string, string]>("agent-session-spawned", (event) => {
      handleAgentSessionSpawned(event.payload[0], event.payload[1]);
    })
  );

  backend.setOnWriteInputHook((sessionId) => clearRestoredMarker(sessionId));

  // Session names are frontend-set, never externally/daemon-driven, so
  // there's no live event for them (unlike cwd) -- a one-shot fetch is
  // sufficient. Best-effort: a failure here just means renamed tabs show
  // their fallback label until the next successful rename, not a reason
  // to block startup.
  void backend
    .getSessionNames()
    .then((sessionNames) => {
      layoutState.update((s) => ({ ...s, sessionNames }));
    })
    .catch(() => {});

  // Like session names: frontend-owned, never externally driven, so a
  // one-shot fetch is sufficient -- no live event. Best-effort, matching
  // getSessionNames: a failure means file tabs render their error state
  // until the next successful load, not a reason to block startup.
  void backend
    .getFileTabs()
    .then((fileTabs) => {
      const fileTabsById: Record<string, FileTab> = {};
      for (const [tabId, path] of Object.entries(fileTabs)) {
        fileTabsById[tabId] = { path };
      }
      layoutState.update((s) => ({ ...s, fileTabsById }));
    })
    .catch(() => {});

  // Like file tabs: frontend-owned, one-shot, best-effort.
  void backend
    .getBoardTabs()
    .then((boardTabsById) => {
      layoutState.update((s) => ({ ...s, boardTabsById }));
    })
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
    const reconnected = await backend.restartDaemon();
    if (!reconnected) {
      setError("Daemon restarted — quit and relaunch gavin to reconnect.");
      return;
    }
  } catch (e) {
    setError(String(e));
    return;
  }
  void pollForStartupState();
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
      layoutState.update((s) => {
        if (s.status !== "connecting") return s;
        const resolved = workspace.resolveActiveFocus(data);
        return {
          ...s,
          status: "ready",
          workspaces: resolved.state.workspaces,
          activeWorkspaceId: resolved.state.activeWorkspaceId,
          focusedSessionId: resolved.focusedSessionId,
        };
      });
      watchRootedWorkspaces(data.workspaces);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (get(layoutState).status === "connecting") {
    setError("Timed out waiting for the daemon to become reachable.");
  }
}

// Binds (or re-binds) a workspace to a root directory: persists the new
// rootPath, tears down the old watch when the root actually changed, and
// starts the new one. Init (scaffolding) happens BEFORE this is called --
// see WorkspaceRootControl -- so the first push already sees the skeleton.
export async function setWorkspaceRoot(workspaceId: string, rootPath: string): Promise<void> {
  const state = get(layoutState);
  const previous = state.workspaces.find((w) => w.id === workspaceId)?.rootPath;
  const workspaces = state.workspaces.map((w) => (w.id === workspaceId ? { ...w, rootPath } : w));
  layoutState.update((s) => ({ ...s, workspaces }));
  await persistWorkspaces(workspaces, state.activeWorkspaceId);
  if (previous && previous !== rootPath) {
    await backend.unwatchGavinRoot(workspaceId).catch(() => {});
  }
  void backend.watchGavinRoot(workspaceId, rootPath).catch(() => {});
}

export const DEFAULT_AGENT_COMMAND = "claude";

// Starts the workspace's main agent: a normal daemon session at the
// workspace root, remembered on the workspace rather than placed in a
// page tree (D12). Never called automatically.
export async function startMainAgent(workspaceId: string): Promise<void> {
  const state = get(layoutState);
  const ws = state.workspaces.find((w) => w.id === workspaceId);
  if (!ws?.rootPath || ws.mainSessionId) return;
  let sessionId: string;
  try {
    sessionId = await backend.createSession(ws.rootPath, ws.agentCommand ?? DEFAULT_AGENT_COMMAND);
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

export async function setAgentCommand(workspaceId: string, command: string): Promise<void> {
  const state = get(layoutState);
  const trimmed = command.trim();
  const workspaces = state.workspaces.map((w) =>
    w.id === workspaceId ? { ...w, agentCommand: trimmed || undefined } : w
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

export async function splitPane(targetSessionId: string, direction: "row" | "column"): Promise<void> {
  const state = get(layoutState);
  const location = activePageLocation(state);
  if (!location) return;
  const newId = await createFreshSession();
  if (!newId) return;
  const newTree = layout.splitLeaf(location.tree, targetSessionId, direction, newId);
  const withTree = workspace.updatePageLayout(state, location.workspaceId, location.pageId, newTree);
  const data = workspace.setPageFocus(withTree, location.workspaceId, location.pageId, newId);
  layoutState.update((s) => ({ ...s, workspaces: data.workspaces, focusedSessionId: newId }));
  await persistWorkspaces(data.workspaces, state.activeWorkspaceId);
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
  const newId = await createFreshSession();
  if (!newId) return;
  const newTree = layout.addTab(location.tree, targetSessionId, newId);
  const withTree = workspace.updatePageLayout(state, location.workspaceId, location.pageId, newTree);
  const data = workspace.setPageFocus(withTree, location.workspaceId, location.pageId, newId);
  layoutState.update((s) => ({ ...s, workspaces: data.workspaces, focusedSessionId: newId }));
  await persistWorkspaces(data.workspaces, state.activeWorkspaceId);
}

export async function closeSession(sessionId: string): Promise<void> {
  const state = get(layoutState);
  if (!(await endTabs([sessionId], state.fileTabsById, state.boardTabsById))) return;
  handleSessionExited(sessionId);
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
export function handleSessionExited(sessionId: string): void {
  const state = get(layoutState);
  // A main agent session lives outside every page tree (D12), so the
  // search below can never find it -- without this branch its terminal
  // would sit dead on the home forever.
  const owningWorkspace = state.workspaces.find((w) => w.mainSessionId === sessionId);
  if (owningWorkspace) {
    clearMainSession(owningWorkspace.id);
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
  void maybeNotifyStatusChange(sessionId, previousStatus, status, label);
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
  const switched = workspace.switchWorkspace(switchedPage, workspaceId);
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

  if (!(await endTabs(sessionIds, state.fileTabsById, state.boardTabsById))) return;

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
  await persistWorkspaces(updated.workspaces, updated.activeWorkspaceId);
}

export async function createWorkspace(name: string): Promise<void> {
  const state = get(layoutState);
  const id = crypto.randomUUID();
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
  const switched = workspace.switchWorkspace(state, workspaceId);
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
  const data = workspace.switchWorkspaceView(state, workspaceId, view);
  layoutState.update((s) => ({ ...s, workspaces: data.workspaces }));
  await persistWorkspaces(data.workspaces, data.activeWorkspaceId);
}

// Kills every session across every page of the workspace, then removes
// it -- the same escalation as closePane, one level up. Confirm-before
// prompting is the caller's (Sidebar.svelte's) responsibility, matching
// how confirmPaneClose/confirmTabClose already work.
export async function closeWorkspace(workspaceId: string): Promise<void> {
  const state = get(layoutState);
  const ws = state.workspaces.find((w) => w.id === workspaceId);
  if (!ws) return;
  const sessionIds = workspace.allSessionIdsInWorkspace(ws);

  if (!(await endTabs(sessionIds, state.fileTabsById, state.boardTabsById))) return;
  for (const id of sessionIds) {
    terminalRegistry.destroyTerminal(id);
  }

  try {
    await backend.deleteBoard(workspaceId);
  } catch (e) {
    setError(String(e));
    return;
  }

  let updated = workspace.removeWorkspace(state, workspaceId);
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
  await persistWorkspaces(updated.workspaces, updated.activeWorkspaceId);
}

// Creates N fresh daemon sessions, builds a tree via buildTree (typically
// one of layout.ts's preset generators), and appends it as a new page to
// the given workspace -- always an explicit workspaceId, never "whichever
// workspace happens to be active," so a caller (e.g. Sidebar.svelte's
// per-workspace "+" button) can add a page to a workspace without first
// switching to it. The new page (and its workspace) become active,
// mirroring "a new tab becomes the active one" elsewhere in this app.
export async function createPage(
  workspaceId: string,
  buildTree: (freshIds: string[]) => LayoutNode,
  sessionCount: number,
  name: string
): Promise<void> {
  const state = get(layoutState);
  if (!state.workspaces.some((w) => w.id === workspaceId)) return;
  let freshIds: string[];
  try {
    freshIds = await Promise.all(Array.from({ length: sessionCount }, () => backend.createSession()));
  } catch (e) {
    setError(String(e));
    return;
  }
  const tree = buildTree(freshIds);
  const pageId = crypto.randomUUID();
  const created = workspace.createPage(state, workspaceId, pageId, name, tree);
  const focusedSessionId = freshIds[0] ?? null;
  const data = workspace.setPageFocus(created, workspaceId, pageId, focusedSessionId);
  layoutState.update((s) => ({
    ...s,
    workspaces: data.workspaces,
    activeWorkspaceId: workspaceId,
    focusedSessionId,
  }));
  await persistWorkspaces(data.workspaces, data.activeWorkspaceId);
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
  const switched = workspace.switchWorkspace(switchedPage, workspaceId);
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

  if (!(await endTabs(sessionIds, state.fileTabsById, state.boardTabsById))) return;
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
    data = workspace.switchWorkspace(workspace.switchPage(data, targetWorkspaceId, pageId), targetWorkspaceId);
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
