import type { PauseCycle } from "$lib/agentPause";
import type { ComplexityTable } from "$lib/cards/complexity";
import type { LayoutNode } from "$lib/layout";
import { allSessionIds, findLeafPath } from "$lib/layout";

export interface Page {
  id: string;
  name: string;
  layout: LayoutNode;
  focusedSessionId: string | null;
  /// When this page was pinned, epoch milliseconds; absent means not
  /// pinned. See `pinnedFirst` for why the pin is a moment rather than
  /// a flag, and why it never touches the stored order.
  pinnedAt?: number;
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
  /// How many times gavin has RE-RUN this commit prompt by itself after
  /// a transient failure. A retry, not a resume: a headless run exits and
  /// holds no conversation, and "commit pending changes" is harmless to
  /// repeat -- which is why it gets a retry where every other run gets a
  /// reopened conversation.
  ///
  /// On the record rather than in memory because a hidden run outlives
  /// the window that started it (`adoptAgentCommits`), so a counter in
  /// the window would reset on the very event the record exists for.
  /// Absent reads as zero.
  retries?: number;
}

/// An orchestration agent run: the session doing it, what it is, and the
/// name to call it by. Unlike AgentCommitRecord's the session is VISIBLE
/// (it lands on the Agents page), so the layout tree already knows it
/// exists -- what the tree cannot say is what it is doing, and a button
/// that has to refuse a second run has to name the first.
/// A "Develop into a plan…" run still in flight: the card being reshaped,
/// and the session doing it.
///
/// Its own record because a develop run binds NOTHING -- no card<->session
/// binding, no status write, since developing a card is not starting it
/// (cardRunActions.ts's developCard). Without it the app cannot tell that
/// the card it is about to hand an agent is being REWRITTEN underneath,
/// which is the one way two runs on one card destroy work rather than
/// merely duplicating it.
export interface DevelopingCardRecord {
  /// Absolute path of the card file, the same key `cardSessions` uses.
  path: string;
  sessionId: string;
}

export interface OrchestrationAgentRecord {
  sessionId: string;
  /// The rail being reorganized; null/absent for a whole-tab Organize.
  railId?: string | null;
  /// What the human calls this run ("Organize", "Reorganize “backend”").
  /// Stored rather than re-derived: a rail can be renamed or deleted
  /// while its run is still going, and the blocked button still has to
  /// say what is holding the slot.
  label: string;
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
  /// The orchestration agent run (an Organize, or one rail's Reorganize)
  /// still in flight. One slot per workspace, because both requests end
  /// in a write of the WHOLE plan -- see orchestrationAgent.ts, which
  /// owns every rule about it.
  orchestrationAgent?: OrchestrationAgentRecord;
  /// The cards being developed right now, one record per in-flight
  /// "Develop into a plan…" run. Absent or empty means none. A LIST, not
  /// a single slot like the orchestration agent above: two develop runs
  /// on two different cards divide the work, and it is the same card
  /// twice that conflicts. developingCards.ts owns the rules.
  developingCards?: DevelopingCardRecord[];
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
  /// Whether a card filed in this workspace starts carrying the
  /// auto-commit block; absent means inherit the app-wide setting (and,
  /// failing that, gavin's default of off). Machine-local like the accent
  /// colour -- whether this human wants agents committing for them is a
  /// habit, not a fact about the project.
  autoCommit?: boolean;
  /// The main agent cell's share (0-1) of the Home tab's row; the
  /// PRD/Board/Orchestration column takes the rest. Absent means the
  /// split the tab shipped with. Machine-local (D35) like the accent
  /// colour -- how wide a terminal wants to be on this screen is not a
  /// fact about the project.
  homeAgentShare?: number;
  /// Whether gavin may resume this workspace's standalone CARD runs by
  /// itself when their agent breaks. Absent means NO -- the opposite of
  /// every other toggle here, because this one is consent rather than a
  /// habit: a run that restarts itself hours after the human walked away
  /// made a decision that was theirs unless they made it in advance.
  ///
  /// A rail's own opt-in lives on the rail (`Rail.autoResume`), not here:
  /// a rail is a durable object the human designed, shared with every
  /// agent that reads the plan, while a card run is an ad-hoc launch from
  /// this machine.
  autoResumeRuns?: boolean;
  /// Git tab preferences (splitters, diff layout, discard-confirm opt-out).
  gitView?: GitViewPrefs;
  /// When this workspace was last switched to, epoch milliseconds.
  /// Absent means never switched to since the field shipped -- which is
  /// how the app hub orders its recents: stamped newest first, then the
  /// never-stamped ones in their stored order.
  lastActiveAt?: number;
  /// This workspace's own agent pause cycle. Absent means INHERIT the
  /// app-wide one, which is not the same as off: a workspace that wants
  /// no pause while the app has one stores a cycle with `enabled: false`.
  agentPause?: PauseCycle;
  /// When this workspace was pinned to the top of the sidebar, epoch
  /// milliseconds; absent means not pinned. Same rule and same reason as
  /// `Page.pinnedAt`, one level up.
  pinnedAt?: number;
  /// This workspace's overrides of the app-wide complexity table, keyed
  /// by level name. Overridden PER LEVEL: a level with no entry here
  /// means "whatever the app says", so a workspace that only cares about
  /// its hardest cards need not restate the other four. Absent (rather
  /// than empty) is the ordinary inheriting case.
  complexityAgents?: ComplexityTable;
  /// Whether the human has been ASKED whether gavin's own files belong in
  /// this repo's git history. Not the answer: that is the ignore rule in
  /// the repository itself, which git owns and this must never shadow.
  ///
  /// It exists because the setup wizard's git step has no other way to
  /// know it is finished -- both answers are legitimate, and "tracked" is
  /// indistinguishable on disk from "nobody has decided yet". Machine-
  /// local like the rest here: whether THIS person has seen a question is
  /// not a fact about the project.
  gitTrackingAsked?: boolean;
  /// The digest of the `.gavin-root/config.toml` execution keys this
  /// human has approved for this workspace (`workspaceTrust.ts`). Absent
  /// means nothing has been approved, which is the state a freshly cloned
  /// repo starts in and the state every workspace that names none of
  /// those keys stays in forever.
  ///
  /// Machine-local, and emphatically so: it is a statement by THIS person
  /// about THIS checkout, and a copy of it in the repo would let the repo
  /// vouch for itself.
  trustedConfigHash?: string;
  /// The human's recorded answer to a distinct SET of foreign MCP
  /// servers `setupAgentIntegration` found already declared in this
  /// workspace's target MCP config file (AG-07, `mcpServerTrust.ts`) --
  /// "keep" or "isolate" -- and the digest of exactly that set. Same
  /// shape and reason as `trustedConfigHash` one field up: a changed set
  /// puts the question back until it is answered again, and it is
  /// machine-local for the same reason.
  mcpForeignServersChoice?: { hash: string; action: "keep" | "isolate" };
  /// Card path -> the digest of the card CONTENT this human has read
  /// before letting an agent have it (`cardReview.ts`, AG-01/AG-02).
  ///
  /// A card's body is the prompt and the board shows only its title, so a
  /// cloned repo's cards would otherwise reach an agent on the first Run
  /// unread. This records that a person looked. Absent — the state every
  /// workspace starts in — means no card has been reviewed, which is the
  /// safe reading: the gate asks.
  ///
  /// Keyed by the card's path, so a card whose body changes (an edit, a
  /// colleague's commit, a `git pull`) stops matching and is asked about
  /// again. gavin's own writers stamp it in the same breath as the write:
  /// the ⌘N composer records what the human just typed, the card editor
  /// records what they just saved, so authoring a card never trips the
  /// gate on it.
  ///
  /// Machine-local, and emphatically so, for `trustedConfigHash`'s
  /// reason one field up: a copy of this in the repository would let the
  /// repository vouch for its own cards.
  reviewedCards?: Record<string, string>;
  /// Whether a card filed in this workspace must be reviewed before its
  /// first Run (`cardReview.ts`, AG-01). Absent means inherit the app-wide
  /// setting (and, failing that, gavin's default of requiring it).
  /// Machine-local like `autoCommit`: whether THIS human wants the gate on
  /// this machine is a habit, not a fact about the project.
  requireReview?: boolean;
  /// Whether the human has been ASKED whether this workspace requires the
  /// first-Run review. Not the answer -- `requireReview` (or its absence)
  /// is that. Same shape and reason as `gitTrackingAsked`: both answers are
  /// legitimate, and leaving the gate on its default is indistinguishable
  /// on disk from nobody having decided yet.
  requireReviewAsked?: boolean;
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

/// Whether two root paths name the same directory as far as gavin is
/// concerned -- a reclaim match, and "is this folder already open in a
/// workspace?" when one is picked (workspaceOpen.ts). Only trailing
/// separators are normalized: a path that came from the folder picker
/// and one persisted months ago differ by a trailing slash often enough
/// to matter, and nothing else about them can be compared without
/// touching the filesystem, which this module never does.
export function sameRoot(a: string, b: string): boolean {
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

// One place decides whether a hub view is offered, so the rule stays
// testable -- workspaceViews.ts imports Svelte components, which this
// project's vitest setup cannot process.
export function hubViewIsVisible(view: { requiresRoot?: boolean }, hasRoot: boolean): boolean {
  return !view.requiresRoot || hasRoot;
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

/// Stamps (or clears) a page's pin. `undefined` unpins, and stores the
/// absence rather than a zero: "never pinned" and "pinned at the epoch"
/// have to stay different answers, since `pinnedFirst` reads the field's
/// TYPE to decide which group a row is in.
export function setPagePinnedAt(
  state: WorkspacesData,
  workspaceId: string,
  pageId: string,
  pinnedAt: number | undefined
): WorkspacesData {
  return {
    ...state,
    workspaces: state.workspaces.map((w) =>
      w.id === workspaceId
        ? { ...w, pages: w.pages.map((p) => (p.id === pageId ? { ...p, pinnedAt } : p)) }
        : w
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
///
/// `showScratchpad` is that same contract's other half. A human who has
/// switched the Scratchpad off (sidebarPrefs.ts) has no row for it, so
/// the digits must close up over the gap rather than spend one on a
/// workspace nothing on screen names -- and both readers have to make
/// that decision the same way, which is why it is a parameter here and
/// not a filter each of them applies afterwards. It defaults to true so
/// the app hub, which lists what EXISTS rather than what is pinned,
/// keeps its own answer without asking.
export function sidebarWorkspaceOrder(
  workspaces: Workspace[],
  showScratchpad = true
): Workspace[] {
  const unfiled = showScratchpad ? workspaces.filter((w) => w.id === UNFILED_WORKSPACE_ID) : [];
  const rest = workspaces.filter((w) => w.id !== UNFILED_WORKSPACE_ID);
  return [...unfiled, ...pinnedFirst(rest)];
}

/// The order the sidebar renders a workspace's pages in: pinned ones
/// first, then the rest as stored. Shared with the ⌘⇧-number router for
/// the same reason `sidebarWorkspaceOrder` is -- a hint badge and the
/// shortcut it promises must count the same rows.
export function sidebarPageOrder(pages: Page[]): Page[] {
  return pinnedFirst(pages);
}

/// Whether a row is pinned. One reader for the field's absence rule, so
/// no surface decides for itself whether a `pinnedAt` of 0 counts.
export function isPinned(item: { pinnedAt?: number }): boolean {
  return typeof item.pinnedAt === "number";
}

/// Pinned rows first, in the order they were pinned; everything else
/// after them in the order it was already in.
///
/// The pin is a MOMENT rather than a flag, and it deliberately leaves
/// the stored array alone. Hoisting the row in the array instead would
/// answer "on top" for one pin and lose the question for two, and worse:
/// unpinning would have nowhere to put the row back, so a pin the human
/// undid a second later would still have rearranged their sidebar for
/// good. Ordering pinned rows by when they were pinned is also the only
/// rule a human already holds -- the row you pinned first is the row at
/// the top -- so it needs no explaining anywhere in the UI.
///
/// Ties break on stored position, so two rows pinned in the same
/// millisecond sort deterministically rather than by whatever the
/// engine's sort happens to do.
export function pinnedFirst<T extends { pinnedAt?: number }>(items: T[]): T[] {
  const indexed = items.map((item, index) => ({ item, index }));
  const pinned = indexed.filter((e) => typeof e.item.pinnedAt === "number");
  const rest = indexed.filter((e) => typeof e.item.pinnedAt !== "number");
  pinned.sort((a, b) => {
    const diff = (a.item.pinnedAt ?? 0) - (b.item.pinnedAt ?? 0);
    return diff !== 0 ? diff : a.index - b.index;
  });
  return [...pinned, ...rest].map((e) => e.item);
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
/// - `failed` -- the process is still there and still at its prompt, but
///   its agent stopped because something BROKE: the daemon matched the
///   profile's error text on the rendered screen, or watched the machine
///   sleep through the conversation. Unlike `interrupted` there is a
///   resumable conversation behind it.
export type SessionLiveness = "live" | "interrupted" | "failed" | "gone";

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
  state: WorkspacesData & {
    interruptedSessionIds: ReadonlySet<string>;
    failureReasonById?: Record<string, string>;
  },
  sessionId: string
): SessionLiveness {
  if (!findSessionLocation(state, sessionId)) return "gone";
  // `failed` before `interrupted`: a session can be both only if the
  // daemon restarted and then the bare shell's replacement broke, and
  // the failure is both the newer fact and the one with a resumable
  // conversation behind it.
  if (state.failureReasonById?.[sessionId] !== undefined) return "failed";
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
