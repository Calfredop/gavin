import { writable, get } from "svelte/store";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { LayoutNode } from "./layout";
import * as layout from "./layout";
import * as backend from "./backend";
import * as terminalRegistry from "./terminalRegistry";
import * as workspace from "./workspace";
import type { Workspace, WorkspacesData } from "./workspace";

export interface LayoutState {
  status: "connecting" | "ready" | "error";
  errorMessage: string;
  workspaces: Workspace[];
  activeWorkspaceId: string | null;
  focusedSessionId: string | null;
  cwdBySessionId: Record<string, string>;
  sessionNames: Record<string, string>;
}

const initialState: LayoutState = {
  status: "connecting",
  errorMessage: "",
  workspaces: [],
  activeWorkspaceId: null,
  focusedSessionId: null,
  cwdBySessionId: {},
  sessionNames: {},
};

export const layoutState = writable<LayoutState>(initialState);

function setError(message: string): void {
  layoutState.update((s) => ({ ...s, status: "error", errorMessage: message }));
}

// The first session id in the active page's tree, in tree order -- used
// to pick a sensible focus target whenever the active page changes out
// from under the current focus (bootstrap, or after removing whatever was
// focused).
function initialFocusedSessionId(data: WorkspacesData): string | null {
  const tree = workspace.getActiveTree(data);
  return tree ? (layout.allSessionIds(tree)[0] ?? null) : null;
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
        return {
          ...s,
          status: "ready",
          workspaces: event.payload.workspaces,
          activeWorkspaceId: event.payload.activeWorkspaceId,
          focusedSessionId: initialFocusedSessionId(event.payload),
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
        return {
          ...s,
          status: "ready",
          workspaces: data.workspaces,
          activeWorkspaceId: data.activeWorkspaceId,
          focusedSessionId: initialFocusedSessionId(data),
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
  const workspaces = workspace.updatePageLayout(state, location.workspaceId, location.pageId, newTree).workspaces;
  layoutState.update((s) => ({ ...s, workspaces, focusedSessionId: newId }));
  await persistWorkspaces(workspaces, state.activeWorkspaceId);
}

export async function addTab(targetSessionId: string): Promise<void> {
  const state = get(layoutState);
  const location = activePageLocation(state);
  if (!location) return;
  const newId = await createFreshSession();
  if (!newId) return;
  const newTree = layout.addTab(location.tree, targetSessionId, newId);
  const workspaces = workspace.updatePageLayout(state, location.workspaceId, location.pageId, newTree).workspaces;
  layoutState.update((s) => ({ ...s, workspaces, focusedSessionId: newId }));
  await persistWorkspaces(workspaces, state.activeWorkspaceId);
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
  const updated = newTree
    ? workspace.updatePageLayout(state, found.workspaceId, found.pageId, newTree)
    : workspace.removePage(state, found.workspaceId, found.pageId);

  const focusedSessionId =
    state.focusedSessionId === sessionId ? initialFocusedSessionId(updated) : state.focusedSessionId;

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
  const workspaces = workspace.updatePageLayout(state, location.workspaceId, location.pageId, newTree).workspaces;
  layoutState.update((s) => ({ ...s, workspaces, focusedSessionId: sessionId }));
  await persistWorkspaces(workspaces, state.activeWorkspaceId);
}

export function focusPane(sessionId: string): void {
  layoutState.update((s) => ({ ...s, focusedSessionId: sessionId }));
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

  const updated = tree
    ? workspace.updatePageLayout(state, location.workspaceId, location.pageId, tree)
    : workspace.removePage(state, location.workspaceId, location.pageId);

  const focusedSessionId = sessionIds.includes(state.focusedSessionId ?? "")
    ? initialFocusedSessionId(updated)
    : state.focusedSessionId;

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
  layoutState.update((s) => ({ ...s, workspaces: data.workspaces, activeWorkspaceId: data.activeWorkspaceId, focusedSessionId: initialFocusedSessionId(data) }));
  await persistWorkspaces(data.workspaces, data.activeWorkspaceId);
}

export async function renameWorkspace(workspaceId: string, name: string): Promise<void> {
  const state = get(layoutState);
  const data = workspace.renameWorkspace(state, workspaceId, name);
  layoutState.update((s) => ({ ...s, workspaces: data.workspaces }));
  await persistWorkspaces(data.workspaces, data.activeWorkspaceId);
}

export async function switchWorkspace(workspaceId: string): Promise<void> {
  const state = get(layoutState);
  const data = workspace.switchWorkspace(state, workspaceId);
  layoutState.update((s) => ({ ...s, activeWorkspaceId: data.activeWorkspaceId, focusedSessionId: initialFocusedSessionId(data) }));
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

  const data = workspace.removeWorkspace(state, workspaceId);
  const focusedSessionId = sessionIds.includes(state.focusedSessionId ?? "")
    ? initialFocusedSessionId(data)
    : state.focusedSessionId;

  layoutState.update((s) => ({
    ...s,
    workspaces: data.workspaces,
    activeWorkspaceId: data.activeWorkspaceId,
    focusedSessionId,
  }));
  await persistWorkspaces(data.workspaces, data.activeWorkspaceId);
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
  const data = workspace.createPage(state, workspaceId, pageId, name, tree);
  layoutState.update((s) => ({
    ...s,
    workspaces: data.workspaces,
    activeWorkspaceId: workspaceId,
    focusedSessionId: freshIds[0] ?? null,
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
  const data = workspace.switchPage(state, workspaceId, pageId);
  layoutState.update((s) => ({ ...s, workspaces: data.workspaces, focusedSessionId: initialFocusedSessionId(data) }));
  await persistWorkspaces(data.workspaces, data.activeWorkspaceId);
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

  const data = workspace.removePage(state, workspaceId, pageId);
  const focusedSessionId = sessionIds.includes(state.focusedSessionId ?? "")
    ? initialFocusedSessionId(data)
    : state.focusedSessionId;

  layoutState.update((s) => ({
    ...s,
    workspaces: data.workspaces,
    activeWorkspaceId: data.activeWorkspaceId,
    focusedSessionId,
  }));
  await persistWorkspaces(data.workspaces, data.activeWorkspaceId);
}
