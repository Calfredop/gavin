import type { LayoutNode } from "./layout";
import { allSessionIds } from "./layout";

export interface Page {
  id: string;
  name: string;
  layout: LayoutNode;
  focusedSessionId: string | null;
}

export interface Workspace {
  id: string;
  name: string;
  pages: Page[];
  activePageId: string | null;
}

export interface WorkspacesData {
  workspaces: Workspace[];
  activeWorkspaceId: string | null;
}

export function createWorkspace(state: WorkspacesData, id: string, name: string): WorkspacesData {
  const workspace: Workspace = { id, name, pages: [], activePageId: null };
  return { workspaces: [...state.workspaces, workspace], activeWorkspaceId: id };
}

export function renameWorkspace(state: WorkspacesData, workspaceId: string, name: string): WorkspacesData {
  return {
    ...state,
    workspaces: state.workspaces.map((w) => (w.id === workspaceId ? { ...w, name } : w)),
  };
}

export function switchWorkspace(state: WorkspacesData, workspaceId: string): WorkspacesData {
  return { ...state, activeWorkspaceId: workspaceId };
}

// Removes the workspace and, if it was the active one, falls back to the
// first remaining workspace (or null if none are left) -- the same
// silent-fallback rule already used throughout this app for stale/removed
// ids.
export function removeWorkspace(state: WorkspacesData, workspaceId: string): WorkspacesData {
  const workspaces = state.workspaces.filter((w) => w.id !== workspaceId);
  const activeWorkspaceId =
    state.activeWorkspaceId === workspaceId ? (workspaces[0]?.id ?? null) : state.activeWorkspaceId;
  return { workspaces, activeWorkspaceId };
}

export function createPage(
  state: WorkspacesData,
  workspaceId: string,
  pageId: string,
  name: string,
  layout: LayoutNode
): WorkspacesData {
  const page: Page = { id: pageId, name, layout, focusedSessionId: null };
  return {
    ...state,
    workspaces: state.workspaces.map((w) =>
      w.id === workspaceId ? { ...w, pages: [...w.pages, page], activePageId: pageId } : w
    ),
  };
}

export function renamePage(state: WorkspacesData, workspaceId: string, pageId: string, name: string): WorkspacesData {
  return {
    ...state,
    workspaces: state.workspaces.map((w) =>
      w.id === workspaceId ? { ...w, pages: w.pages.map((p) => (p.id === pageId ? { ...p, name } : p)) } : w
    ),
  };
}

export function switchPage(state: WorkspacesData, workspaceId: string, pageId: string): WorkspacesData {
  return {
    ...state,
    workspaces: state.workspaces.map((w) => (w.id === workspaceId ? { ...w, activePageId: pageId } : w)),
  };
}

// Removes the page and, if it was its workspace's active one, falls back
// to that workspace's first remaining page (or null). The workspace
// itself is never removed here, even if this empties its whole pages
// list -- an empty `pages: []` is a normal, representable state (unlike
// an empty page layout, which isn't representable at all -- see
// updatePageLayout's doc comment).
export function removePage(state: WorkspacesData, workspaceId: string, pageId: string): WorkspacesData {
  return {
    ...state,
    workspaces: state.workspaces.map((w) => {
      if (w.id !== workspaceId) return w;
      const pages = w.pages.filter((p) => p.id !== pageId);
      const activePageId = w.activePageId === pageId ? (pages[0]?.id ?? null) : w.activePageId;
      return { ...w, pages, activePageId };
    }),
  };
}

// The one primitive every tree-mutating layoutState.ts action goes
// through: replace one page's LayoutNode with a new one. There is no
// "clear a page's layout" counterpart -- Page.layout is never null on
// the Rust side (there's no representable "empty tree"), so a page whose
// last pane closes must be removed entirely via removePage instead of
// having its layout set to anything here.
export function updatePageLayout(
  state: WorkspacesData,
  workspaceId: string,
  pageId: string,
  layout: LayoutNode
): WorkspacesData {
  return {
    ...state,
    workspaces: state.workspaces.map((w) =>
      w.id === workspaceId ? { ...w, pages: w.pages.map((p) => (p.id === pageId ? { ...p, layout } : p)) } : w
    ),
  };
}

export function getActiveWorkspace(state: WorkspacesData): Workspace | null {
  return state.workspaces.find((w) => w.id === state.activeWorkspaceId) ?? null;
}

export function getActivePage(state: WorkspacesData): Page | null {
  const workspace = getActiveWorkspace(state);
  if (!workspace) return null;
  return workspace.pages.find((p) => p.id === workspace.activePageId) ?? null;
}

export function getActiveTree(state: WorkspacesData): LayoutNode | null {
  return getActivePage(state)?.layout ?? null;
}

// Resolves what focus should be for a given page: its own previously
// remembered focusedSessionId if that session is still present in its
// tree, otherwise the first session in tree order. Returns null for a
// page with no sessions (or no page at all).
export function resolveFocusForPage(page: Page | null): string | null {
  if (!page) return null;
  if (page.focusedSessionId && allSessionIds(page.layout).includes(page.focusedSessionId)) {
    return page.focusedSessionId;
  }
  return allSessionIds(page.layout)[0] ?? null;
}

// Sets one page's remembered focus -- called whenever the app's live
// focus lands on a session in that page, so the page "remembers" it even
// after becoming inactive (unlike the app-wide, ephemeral
// LayoutState.focusedSessionId, which only ever reflects the currently
// visible page).
export function setPageFocus(
  state: WorkspacesData,
  workspaceId: string,
  pageId: string,
  sessionId: string | null
): WorkspacesData {
  return {
    ...state,
    workspaces: state.workspaces.map((w) =>
      w.id === workspaceId
        ? { ...w, pages: w.pages.map((p) => (p.id === pageId ? { ...p, focusedSessionId: sessionId } : p)) }
        : w
    ),
  };
}

// Recomputes focus for whatever page is active in `state` (preferring
// that page's own remembered focus, falling back to its first session),
// writes the result onto that page via setPageFocus so it survives the
// page becoming inactive again, and returns both the updated state and
// the resolved session id in one step. Used by every action that changes
// which page is active, or that removes whatever the focused session was.
export function resolveActiveFocus(
  state: WorkspacesData
): { state: WorkspacesData; focusedSessionId: string | null } {
  const ws = getActiveWorkspace(state);
  const page = getActivePage(state);
  if (!ws || !page) return { state, focusedSessionId: null };
  const focusedSessionId = resolveFocusForPage(page);
  return { state: setPageFocus(state, ws.id, page.id, focusedSessionId), focusedSessionId };
}

export function allSessionIdsInWorkspace(workspace: Workspace): string[] {
  return workspace.pages.flatMap((p) => allSessionIds(p.layout));
}
