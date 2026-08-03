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

export type { SessionStatus };

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

  void pollForStartupState();
}

export function teardown(): void {
  unlisteners.forEach((unlisten) => unlisten());
  unlisteners.length = 0;
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
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (get(layoutState).status === "connecting") {
    setError("Timed out waiting for the daemon to become reachable.");
  }
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
  try {
    await backend.killSession(sessionId);
  } catch (e) {
    setError(String(e));
    return;
  }
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

// Shared by the "cwd-changed" event listener in bootstrap() and this
// file's own tests. Entries are never removed when a session closes; a
// stale in-memory map entry per session that ever existed in one app run
// is not a meaningful memory concern.
export function handleCwdChanged(sessionId: string, cwd: string): void {
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

  for (const id of sessionIds) {
    try {
      await backend.killSession(id);
    } catch (e) {
      setError(String(e));
      return;
    }
  }

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

// Kills every session across every page of the workspace, then removes
// it -- the same escalation as closePane, one level up. Confirm-before
// prompting is the caller's (Sidebar.svelte's) responsibility, matching
// how confirmPaneClose/confirmTabClose already work.
export async function closeWorkspace(workspaceId: string): Promise<void> {
  const state = get(layoutState);
  const ws = state.workspaces.find((w) => w.id === workspaceId);
  if (!ws) return;
  const sessionIds = workspace.allSessionIdsInWorkspace(ws);

  for (const id of sessionIds) {
    try {
      await backend.killSession(id);
    } catch (e) {
      setError(String(e));
      return;
    }
  }
  for (const id of sessionIds) {
    terminalRegistry.destroyTerminal(id);
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

  for (const id of sessionIds) {
    try {
      await backend.killSession(id);
    } catch (e) {
      setError(String(e));
      return;
    }
  }
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
