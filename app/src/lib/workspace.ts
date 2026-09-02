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
  /// The Unstaged block's share (0-1) of the two lists' height in the
  /// Changes column; Staged takes the rest. Absent = an even split.
  unstagedShare?: number;
  diffLayout?: "unified" | "split";
  skipHunkDiscardConfirm?: boolean;
  /// Collapsed sidebar sections of the Git tab, keyed by section id.
  navCollapsed?: Record<string, boolean>;
  /// Selected worktree path; absent = the root checkout.
  worktree?: string;
  /// History graph scope: all branches (default) or the current branch.
  graphAll?: boolean;
  /// A "Commit via agent" run still in flight. The run is a HIDDEN daemon
  /// session that no page references, so this is the only record of it --
  /// see gitState's adoptAgentCommits.
  agentCommit?: AgentCommitRecord;
}

/// An in-flight hidden commit run: its session id, and the checkout it
/// was launched against. The cwd is recorded rather than re-derived from
/// `worktree` -- switching worktrees mid-run abandons the run, and by
/// then `worktree` points somewhere else.
export interface AgentCommitRecord {
  sessionId: string;
  cwd: string;
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
  /// Terminal font size for this workspace's panes; absent means inherit
  /// the app-wide setting (and, failing that, gavin's default). Machine-
  /// local like the accent colour -- how big the type is on this screen is
  /// not a fact about the project.
  terminalFontSize?: number;
  /// Git tab preferences (splitters, diff layout, discard-confirm opt-out).
  gitView?: GitViewPrefs;
  /// When this workspace was last switched to, epoch milliseconds.
  /// Absent means never switched to since the field shipped -- which is
  /// how the app hub orders its recents: stamped newest first, then the
  /// never-stamped ones in their stored order.
  lastActiveAt?: number;
}

/// A workspace that left the app through the sidebar X, kept so its
/// daemon rows can be found again.
///
/// Every row the daemon holds for a workspace -- board columns and
/// labels, rails and their run state, workspace-scoped tools and group
/// templates, card<->session links -- is keyed by the workspace's id,
/// which is a uuid minted at creation and written nowhere on disk.
/// Re-adding the same folder mints a NEW uuid, so without this record
/// the old rows exist but nothing can ever name them again. The
/// tombstone is the only bridge back, which is why the X writes one and
/// the delete wizard (which means it) does not.
export interface RemovedWorkspace {
  id: string;
  name: string;
  /// The root the workspace was bound to -- the key a reclaim matches
  /// on, since it is the only thing about a workspace that survives
  /// outside the app.
  rootPath: string;
  /// Epoch milliseconds, so the newest match wins when a folder has been
  /// added and removed more than once.
  removedAt: number;
}

/// How many tombstones are kept. A cap rather than an expiry: the list
/// costs nothing until it is long, and "I removed that months ago" is
/// exactly the case a reclaim is for. Oldest fall off the end.
export const REMOVED_WORKSPACES_LIMIT = 20;

export interface WorkspacesData {
  workspaces: Workspace[];
  activeWorkspaceId: string | null;
  /// Tombstones for workspaces the X removed, newest first. Optional so
  /// every config.json written before this field loads unchanged.
  removedWorkspaces?: RemovedWorkspace[];
}

/// Whether two root paths name the same directory as far as a reclaim is
/// concerned. Only trailing separators are normalized: a path that came
/// from the folder picker and one persisted months ago differ by a
/// trailing slash often enough to matter, and nothing else about them can
/// be compared without touching the filesystem, which this module never
/// does.
function sameRoot(a: string, b: string): boolean {
  const trim = (p: string) => p.replace(/[/\\]+$/, "");
  return trim(a) === trim(b) && trim(a) !== "";
}

/// Records that a workspace left the app. Called with the workspace
/// still present in `state`, because the name and root it stores are
/// read off it.
///
/// Written only for a workspace that had a root: a rootless one owns no
/// files and, having never been bound, has nothing a later folder pick
/// could match it against. An earlier tombstone for the same id or the
/// same root is dropped rather than kept beside the new one -- two
/// records for one folder would make "the newest match" a question about
/// list order instead of about time.
export function rememberRemoved(
  state: WorkspacesData,
  workspaceId: string,
  now: number
): WorkspacesData {
  const ws = state.workspaces.find((w) => w.id === workspaceId);
  const rootPath = ws?.rootPath?.trim();
  if (!ws || !rootPath) return state;
  const kept = (state.removedWorkspaces ?? []).filter(
    (t) => t.id !== ws.id && !sameRoot(t.rootPath, rootPath)
  );
  const tombstone: RemovedWorkspace = {
    id: ws.id,
    name: ws.name,
    rootPath,
    removedAt: now,
  };
  return {
    ...state,
    removedWorkspaces: [tombstone, ...kept].slice(0, REMOVED_WORKSPACES_LIMIT),
  };
}

/// The newest tombstone for a root, or null. Newest by `removedAt`
/// rather than by position: the list is kept newest-first, but a caller
/// that trusts order alone would be wrong the first time anything writes
/// to it out of band.
///
/// A tombstone whose id belongs to a workspace that is currently in the
/// app is never returned -- that is a stale record for an id already in
/// use, and restoring onto it would collide with a live workspace.
export function matchTombstone(state: WorkspacesData, rootPath: string): RemovedWorkspace | null {
  const live = new Set(state.workspaces.map((w) => w.id));
  const matches = (state.removedWorkspaces ?? []).filter(
    (t) => sameRoot(t.rootPath, rootPath) && !live.has(t.id)
  );
  if (matches.length === 0) return null;
  return matches.reduce((best, t) => (t.removedAt > best.removedAt ? t : best));
}

/// Drops one tombstone by id -- what both answers to the reclaim prompt
/// end in. Restore consumes it (the workspace is back, so the bridge has
/// been crossed); Start fresh discards it deliberately, so the prompt
/// does not return on the next folder pick.
export function forgetTombstone(state: WorkspacesData, id: string): WorkspacesData {
  return {
    ...state,
    removedWorkspaces: (state.removedWorkspaces ?? []).filter((t) => t.id !== id),
  };
}

/// The tombstone a folder pick should offer to reclaim, or null.
///
/// Offered only on a workspace that has nothing in it yet: no root of its
/// own, no sessions in any page, and no main agent. That restriction is
/// what keeps the reclaim a simple id swap -- re-pointing a workspace
/// that already holds tabs, board tabs and a watch would have to migrate
/// all of them, and re-pointing one that is already bound is a different
/// question entirely ("move this workspace's rows?", which is out of
/// scope).
export function reclaimable(
  state: WorkspacesData,
  workspaceId: string,
  rootPath: string
): RemovedWorkspace | null {
  const ws = state.workspaces.find((w) => w.id === workspaceId);
  if (!ws) return null;
  if (ws.rootPath?.trim()) return null;
  if (ws.mainSessionId) return null;
  if (allSessionIdsInWorkspace(ws).length > 0) return null;
  return matchTombstone(state, rootPath);
}

/// Re-keys a workspace to a removed one's id and binds it to the root,
/// consuming the tombstone. The workspace object is carried over whole,
/// so its pages, its colour and its per-workspace settings travel with
/// it; only the id changes, which is what makes the daemon's rows --
/// keyed by that id and nothing else -- reachable again.
///
/// The NAME is deliberately not restored. The id is the unreachable
/// thing; the name is right there in the sidebar, and a user who has
/// just typed one meant it.
export function restoreWorkspaceId(
  state: WorkspacesData,
  workspaceId: string,
  restoredId: string,
  rootPath: string
): WorkspacesData {
  const forgotten = forgetTombstone(state, restoredId);
  return {
    ...forgotten,
    workspaces: forgotten.workspaces.map((w) =>
      w.id === workspaceId ? { ...w, id: restoredId, rootPath } : w
    ),
    activeWorkspaceId:
      forgotten.activeWorkspaceId === workspaceId ? restoredId : forgotten.activeWorkspaceId,
  };
}

// Well-known id for the always-present pinned pseudo-workspace -- a
// non-closable drawer for pages the user hasn't organized into a real
// workspace yet. It is DISPLAYED as "Scratchpad"; the id stays
// "__unfiled__" from when the drawer was called Unfiled, because
// changing it would orphan every page in every existing config.json.
// The Rust bootstrap ensures a workspace with this exact id always
// exists in WorkspacesData; must match config.rs's own copy exactly.
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
  // Spread, not a fresh literal: `removedWorkspaces` is a carry-through
  // field, and rebuilding the record without it silently drops every
  // tombstone the moment a workspace is created.
  return { ...state, workspaces: [...state.workspaces, workspace], activeWorkspaceId: id };
}

export function renameWorkspace(state: WorkspacesData, workspaceId: string, name: string): WorkspacesData {
  return {
    ...state,
    workspaces: state.workspaces.map((w) => (w.id === workspaceId ? { ...w, name } : w)),
  };
}

/// Makes a workspace active and stamps it as last used. `now` is passed
/// in rather than read from the clock so the stamp is testable and so
/// every path that switches (a sidebar click, a jump-to-session, a page
/// move) records the same kind of event -- the app hub's recents order
/// is only as honest as the least careful of those callers.
///
/// An unknown workspaceId still becomes the active id, exactly as it did
/// before the stamp existed: this module has never validated ids, and
/// the callers all resolve them first.
export function switchWorkspace(state: WorkspacesData, workspaceId: string, now: number): WorkspacesData {
  return {
    ...state,
    activeWorkspaceId: workspaceId,
    workspaces: state.workspaces.map((w) => (w.id === workspaceId ? { ...w, lastActiveAt: now } : w)),
  };
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
  // Spread for the same reason createWorkspace does: this is the one
  // function a tombstone is written alongside, so dropping the list here
  // would erase the record the very call that creates it depends on.
  return { ...state, workspaces, activeWorkspaceId };
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

// Whether a given hub tab is the thing on screen right now: its own
// workspace is the active one AND that tab is the view it is showing.
// Both halves matter -- a workspace parked on its Git tab shows nothing
// at all while a different workspace is active. Used to decide whether a
// background run that reports only into one tab still needs to
// interrupt the human; see notifications.ts.
export function hubViewIsOnScreen(state: WorkspacesData, workspaceId: string, viewId: string): boolean {
  if (state.activeWorkspaceId !== workspaceId) return false;
  const ws = state.workspaces.find((w) => w.id === workspaceId);
  return ws ? getActiveView(ws) === viewId : false;
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

/// The order the sidebar renders workspaces in: the Scratchpad pinned
/// to the top, then the rest as stored. Shared with the ⌘⌥-number
/// router so a hint badge and the shortcut can never point at
/// different workspaces.
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

/// What a session id bound to a run names now.
///
/// - `live` -- the id is in a layout tree and nothing says its run was
///   killed.
/// - `interrupted` -- the tab is there, but what is in it is a shell the
///   daemon spawned in place of the run (`SessionManager::recover`).
/// - `gone` -- no tree holds this id at all; the session exited, or the
///   startup reconciliation cleared its tab.
export type SessionLiveness = "live" | "interrupted" | "gone";

/// Resolves a bound session id into that vocabulary.
///
/// `findSessionLocation` alone answers a narrower question -- "is this id
/// somewhere in a layout tree" -- and a bare shell the daemon put back
/// after a restart satisfies it exactly as well as the agent that used to
/// be there. That is how an interrupted run kept reading as a live one on
/// every surface: the board's dot, the card menu, Develop's refusal, and
/// the orchestration scheduler's `liveSessionIds`.
///
/// Order matters: `gone` is checked first, so a session that both
/// vanished and was interrupted reads as gone. Nothing is offered to
/// resume a tab that is not there.
export function sessionLiveness(
  state: WorkspacesData & { interruptedSessionIds: ReadonlySet<string> },
  sessionId: string
): SessionLiveness {
  if (!findSessionLocation(state, sessionId)) return "gone";
  return state.interruptedSessionIds.has(sessionId) ? "interrupted" : "live";
}

/// The layout tabs the daemon has no session for.
///
/// Both of the app's liveness checks read the persisted LAYOUT TREE
/// rather than the daemon's session list, so a tab id left in a tree by a
/// session that failed to recover reads as a running agent forever: the
/// rail step stays `running` with no rule that can correct it (the wedge
/// spec §2.2 describes), the board's card stays "busy", and the tab
/// itself renders as a terminal for a session the daemon never had.
///
/// File and board tabs live in the same trees and are never sessions, so
/// they are excluded by id rather than by guesswork.
///
/// `liveSessionIds` empty is NOT taken as "the daemon has nothing":
/// clearing every tab on a read that failed or has not landed yet would
/// be far worse than leaving a stale one, so an empty set returns an
/// empty list. The daemon having genuinely zero sessions leaves nothing
/// to reconcile anyway -- the ids in the trees would all be stale, and
/// the next real read corrects them.
export function staleLayoutTabIds(
  state: WorkspacesData,
  liveSessionIds: ReadonlySet<string>,
  nonSessionTabIds: ReadonlySet<string>
): string[] {
  if (liveSessionIds.size === 0) return [];
  const stale: string[] = [];
  for (const ws of state.workspaces) {
    for (const page of ws.pages) {
      for (const id of allSessionIds(page.layout)) {
        if (nonSessionTabIds.has(id) || liveSessionIds.has(id)) continue;
        stale.push(id);
      }
    }
  }
  return stale;
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
