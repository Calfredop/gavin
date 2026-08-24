import type { LayoutNode } from "./layout";
import { allSessionIds, findLeafPath } from "./layout";

export interface Page {
  id: string;
  name: string;
  layout: LayoutNode;
  focusedSessionId: string | null;
}

export interface GitViewPrefs {
  navWidth?: number;
  listWidth?: number;
  diffLayout?: "unified" | "split";
  skipHunkDiscardConfirm?: boolean;
  /// Collapsed sidebar sections of the Git tab, keyed by section id.
  navCollapsed?: Record<string, boolean>;
  /// Selected worktree path; absent = the root checkout.
  worktree?: string;
  /// History graph scope: all branches (default) or the current branch.
  graphAll?: boolean;
}

export interface Workspace {
  id: string;
  name: string;
  pages: Page[];
  activePageId: string | null;
  activeView?: string;
  /// The hub tab this workspace was last showing. Kept apart from
  /// activeView, which the terminal overwrites -- this is what the
  /// sidebar's Hub button reopens, so leaving for a terminal and coming
  /// back lands where you left off instead of on Home.
  hubView?: string;
  /// The workspace's bound root directory (agent-orchestration phase).
  /// Optional; never auto-cleared when the directory goes missing on disk.
  rootPath?: string;
  /// The running main agent session (D12) -- outside every page tree.
  mainSessionId?: string;
  /// Launch command for it; "claude" when unset.
  /// Accent colour; absent means the default. Machine-local (D35).
  color?: string;
  /// Per-workspace notification toggles (D38); absent means on.
  notifyNeedsInput?: boolean;
  notifyFinished?: boolean;
  /// Whether closing a tab asks first; absent means on. Machine-local,
  /// like the notification toggles -- a habit, not a project setting.
  confirmTabClose?: boolean;
  /// Git tab preferences (splitters, diff layout, discard-confirm opt-out).
  gitView?: GitViewPrefs;
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

// Well-known id for the dev-only "Smoke Test" workspace, ensured by debug
// builds' Rust bootstrap and stripped by release builds. Must match
// config.rs's own copy of this constant exactly.
export const SMOKETEST_WORKSPACE_ID = "__smoketest__";

// Whether a workspace should be offered dev-only hub views (the
// smoke-test checklist): dev builds only, Smoke Test workspace only. Kept
// here rather than in workspaceViews.ts so it is testable -- that module
// imports Svelte components, which this project's vitest setup can't
// process (hence its no-component-tests convention).
export function showsDevOnlyViews(workspaceId: string, isDev: boolean): boolean {
  return isDev && workspaceId === SMOKETEST_WORKSPACE_ID;
}

// One place decides whether a hub view is offered, so the rule stays
// testable -- workspaceViews.ts imports Svelte components, which this
// project's vitest setup cannot process.
export function hubViewIsVisible(
  view: { devOnly?: boolean; requiresRoot?: boolean },
  workspaceId: string,
  isDev: boolean,
  hasRoot: boolean
): boolean {
  if (view.devOnly && !showsDevOnlyViews(workspaceId, isDev)) return false;
  if (view.requiresRoot && !hasRoot) return false;
  return true;
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

// Rooted workspaces land on the orchestration home (D33). A FALLBACK
// only: clicking any tab -- including the Terminal button -- persists
// activeView, so an explicit choice always wins and workspaces that
// already have one never shift.
export function getActiveView(ws: Workspace): string {
  return ws.activeView ?? (ws.rootPath ? "home" : "terminal");
}

// Switching to a hub tab also records it as the workspace's hubView --
// the tab its Hub button reopens. Switching to the terminal leaves that
// memory alone, which is the whole point: the terminal is a detour, not
// a new destination.
export function switchWorkspaceView(state: WorkspacesData, workspaceId: string, view: string): WorkspacesData {
  return {
    ...state,
    workspaces: state.workspaces.map((w) =>
      w.id === workspaceId ? { ...w, activeView: view, hubView: view === "terminal" ? w.hubView : view } : w
    ),
  };
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

/// The order the sidebar renders workspaces in: Unfiled pinned to the
/// top, then the rest as stored. Shared with the ⌘⌥-number router so a
/// hint badge and the shortcut can never point at different workspaces.
export function sidebarWorkspaceOrder(workspaces: Workspace[]): Workspace[] {
  const unfiled = workspaces.filter((w) => w.id === UNFILED_WORKSPACE_ID);
  const rest = workspaces.filter((w) => w.id !== UNFILED_WORKSPACE_ID);
  return [...unfiled, ...rest];
}

// Searches every workspace's every page for sessionId, fresh at call time
// (never cached) -- a card's sessionLink only stores a bare sessionId, and
// this is how "jump to session"/"is this session still alive" resolve
// which workspace/page currently hosts it, since a tab can move between
// pages and workspaces after a card links to it.
export function findSessionLocation(
  state: WorkspacesData,
  sessionId: string
): { workspaceId: string; pageId: string } | null {
  for (const ws of state.workspaces) {
    for (const page of ws.pages) {
      if (allSessionIds(page.layout).includes(sessionId)) {
        return { workspaceId: ws.id, pageId: page.id };
      }
    }
  }
  return null;
}

// A single session's git status, mirroring crates/protocol's GitStatus
// wire shape exactly (camelCase, per its own #[serde(rename_all =
// "camelCase")]). repoRoot identifies the repo by canonical filesystem
// path, not by branch name -- two unrelated repos could coincidentally
// both be on a branch called "main".
export interface GitStatus {
  repoRoot: string;
  branch: string;
  dirty: boolean;
  ahead: number;
  behind: number;
  hasUpstream: boolean;
}

/// A hub tab's label. Static for every view except the agent-file one,
/// whose label is the workspace's configured file name. Kept as a
/// resolver rather than widening HubView.label to a function, so
/// HUB_VIEWS stays a plain data table.
export function hubLabel(view: { id: string; label: string }, agentFileName: string): string {
  return view.id === "agent-file" ? agentFileName : view.label;
}

/// Which workspace owns a session: page trees first, then the main agent
/// session, which lives outside every tree by D12. Extracted because
/// handleSessionExited and handleSessionStatusChanged both need it and
/// were about to hold a third copy of the walk.
export function workspaceIdForSession(
  state: { workspaces: Workspace[] },
  sessionId: string
): string | null {
  for (const ws of state.workspaces) {
    if (ws.mainSessionId === sessionId) return ws.id;
    for (const page of ws.pages) {
      if (findLeafPath(page.layout, sessionId)) return ws.id;
    }
  }
  return null;
}
