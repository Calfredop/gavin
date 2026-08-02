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

// Well-known id for the always-present "Unfiled" pseudo-workspace -- a
// pinned, non-closable, non-renameable workspace for pages the user
// hasn't organized into a real workspace yet. The Rust bootstrap ensures
// a workspace with this exact id always exists in WorkspacesData; must
// match config.rs's own copy of this constant exactly.
export const UNFILED_WORKSPACE_ID = "__unfiled__";

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
  if (workspaceId === UNFILED_WORKSPACE_ID) return state;
  const workspaces = state.workspaces.filter((w) => w.id !== workspaceId);
  const activeWorkspaceId =
    state.activeWorkspaceId === workspaceId ? (workspaces[0]?.id ?? null) : state.activeWorkspaceId;
  return { workspaces, activeWorkspaceId };
}

// Moves a workspace to a new index within the workspaces array. Clamped
// to the valid range. A no-op (returns state unchanged in effect) if
// workspaceId isn't found or targetIndex already matches its position.
export function reorderWorkspace(state: WorkspacesData, workspaceId: string, targetIndex: number): WorkspacesData {
  const currentIndex = state.workspaces.findIndex((w) => w.id === workspaceId);
  if (currentIndex === -1) return state;
  const workspaces = [...state.workspaces];
  const [moved] = workspaces.splice(currentIndex, 1);
  const clamped = Math.max(0, Math.min(targetIndex, workspaces.length));
  workspaces.splice(clamped, 0, moved);
  return { ...state, workspaces };
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

// Moves a page to a new position -- either within its current workspace
// (reorder) or into a different workspace (move). Both are the same
// operation, differing only in whether the source and target workspace
// ids happen to match. If the moved page was its source workspace's
// active page, that workspace's activePageId falls back to a sibling (or
// null) -- the same rule removePage already uses. The target workspace's
// own activePageId is left untouched by the move itself (a caller that
// wants the moved page to also become active, e.g. because it was the
// one the user was looking at, does that separately via switchWorkspace/
// switchPage).
export function movePage(
  state: WorkspacesData,
  pageId: string,
  targetWorkspaceId: string,
  targetIndex: number
): WorkspacesData {
  const sourceWorkspace = state.workspaces.find((w) => w.pages.some((p) => p.id === pageId));
  if (!sourceWorkspace) return state;
  const page = sourceWorkspace.pages.find((p) => p.id === pageId);
  if (!page) return state;
  const targetWorkspace = state.workspaces.find((w) => w.id === targetWorkspaceId);
  if (!targetWorkspace) return state;

  const workspaces = state.workspaces.map((w) => {
    if (w.id === sourceWorkspace.id && w.id === targetWorkspaceId) {
      const pages = w.pages.filter((p) => p.id !== pageId);
      const clamped = Math.max(0, Math.min(targetIndex, pages.length));
      pages.splice(clamped, 0, page);
      return { ...w, pages };
    }
    if (w.id === sourceWorkspace.id) {
      const pages = w.pages.filter((p) => p.id !== pageId);
      const activePageId = w.activePageId === pageId ? (pages[0]?.id ?? null) : w.activePageId;
      return { ...w, pages, activePageId };
    }
    if (w.id === targetWorkspaceId) {
      const pages = [...w.pages];
      const clamped = Math.max(0, Math.min(targetIndex, pages.length));
      pages.splice(clamped, 0, page);
      return { ...w, pages };
    }
    return w;
  });

  return { ...state, workspaces };
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
