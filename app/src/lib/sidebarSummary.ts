// What the sidebar's recap rows count: per workspace, its git checkouts,
// its kanban cards and its orchestration rails; per page, its tabs and
// the agents behind them. Pure counting over data the app already holds,
// and always over the same projection the full view uses -- the git side
// reads the very per-session statuses the page rows show, the card side
// goes through boardSummary, the tab side goes through sessionTabsOnly --
// so a recap can never disagree with what it summarises, and no new
// polling is introduced.

import { allSessionIds, sessionTabsOnly } from "./layout";
import { boardSummary } from "./homeSummary";
import { railStateOf, stepStateOf, type Orchestration, type Rail } from "./orchestration";
import { slugStatus } from "./planBoard";
import type { Board } from "./kanban";
import type { GavinTree } from "./gavin";
import type { GitStatus, Page, Workspace } from "./workspace";
import type { SessionStatus } from "./notifications";

export interface WorkspaceGitSummary {
  /// Distinct repositories (by repoRoot) across the workspace's sessions.
  repoCount: number;
  /// How many of those have uncommitted changes.
  dirtyCount: number;
  /// Commits ahead/behind, summed over the repos that have an upstream --
  /// the same "only meaningful with an upstream" rule the page rows use.
  ahead: number;
  behind: number;
  /// A "Commit via agent" run in flight somewhere in this workspace. Not
  /// a count over sessions like the rest: the run is a HIDDEN session
  /// with no tab and no git status of its own, so it is passed in from
  /// the Git tab's own store.
  committing: boolean;
}

/// Whether the workspace's git chip renders at all. A run in flight
/// earns the chip on its own -- a workspace whose sessions have no repo
/// between them (or has no sessions yet) still has an agent committing
/// in it, and that is precisely when nothing else on screen says so.
export function showGitChip(git: WorkspaceGitSummary): boolean {
  return git.repoCount > 0 || git.committing;
}

/// Whose git status counts towards a workspace's recap: every page's
/// sessions, plus the main agent session, which lives outside every page
/// tree (D12) and is usually the one sitting in the workspace root. That
/// last part matters -- a rooted workspace whose pages are all empty
/// would otherwise show no git recap at all.
function workspaceSessionIds(ws: Workspace): string[] {
  const ids = ws.pages.flatMap((p) => allSessionIds(p.layout));
  return ws.mainSessionId ? [...ids, ws.mainSessionId] : ids;
}

export function workspaceGitSummary(
  ws: Workspace,
  gitStatusById: Record<string, GitStatus | null>,
  committing = false
): WorkspaceGitSummary {
  // Deduped by repoRoot exactly like summarizePageGitStatus: five
  // sessions sharing one checkout are one repo, not five. Sessions with
  // no repo (null or missing entry) are ignored rather than counted as a
  // group of their own.
  const byRepoRoot = new Map<string, GitStatus>();
  for (const id of workspaceSessionIds(ws)) {
    const status = gitStatusById[id];
    if (status) byRepoRoot.set(status.repoRoot, status);
  }
  let dirtyCount = 0;
  let ahead = 0;
  let behind = 0;
  for (const status of byRepoRoot.values()) {
    if (status.dirty) dirtyCount += 1;
    if (status.hasUpstream) {
      ahead += status.ahead;
      behind += status.behind;
    }
  }
  return { repoCount: byRepoRoot.size, dirtyCount, ahead, behind, committing };
}

export interface KanbanBucket {
  name: string;
  count: number;
}

export interface KanbanSummary {
  todo: number;
  inProgress: number;
  done: number;
  total: number;
  /// Every column's own count -- board order first, auto columns after --
  /// for the tooltip. The three buckets above fold custom columns
  /// together; this is where that detail survives.
  columns: KanbanBucket[];
}

const TODO_SLUG = slugStatus("To Do");
const DONE_SLUG = slugStatus("Done");

/// Folds a board of any shape onto the three buckets the sidebar has room
/// for. "To Do" and "Done" are matched by slug -- they are permanent
/// columns (planBoard's PERMANENT_COLUMN_NAMES), so there is always one
/// of each to match -- and EVERYTHING else counts as in progress: the
/// "In Progress" column itself, any custom column the human added, and
/// any auto column (a card whose status matches no column at all). By
/// elimination rather than by guessing: a "Blocked" card has certainly
/// started and has certainly not finished.
///
/// Built on boardSummary, which is built on mergePlanCards, so the
/// sidebar's tally can never disagree with the board it summarises.
export function kanbanSummary(board: Board | undefined, tree: GavinTree | undefined): KanbanSummary {
  const summary = boardSummary(board, tree);
  let todo = 0;
  let inProgress = 0;
  let done = 0;
  for (const column of summary.columns) {
    const slug = slugStatus(column.name);
    if (slug === TODO_SLUG) todo += column.planCount;
    else if (slug === DONE_SLUG) done += column.planCount;
    else inProgress += column.planCount;
  }
  for (const auto of summary.autoColumns) inProgress += auto.count;
  const columns = [
    ...summary.columns.map((c) => ({ name: c.name, count: c.planCount })),
    ...summary.autoColumns.map((a) => ({ name: a.status, count: a.count })),
  ];
  return { todo, inProgress, done, total: summary.totalCards, columns };
}

export type RailPhase = "running" | "done" | "idle";

/// Which bucket a rail falls in. "running" is the rail's own run state;
/// "done" means every step finished; everything else is "idle" --
/// including `paused`, which is a rail that stopped rather than one that
/// arrived. A rail with no steps is idle, not vacuously done: `every` on
/// an empty list is true, and an empty rail has plainly not completed
/// anything.
export function railPhase(orch: Orchestration, rail: Rail): RailPhase {
  if (railStateOf(orch, rail.id) === "running") return "running";
  const steps = rail.stages.flatMap((stage) => stage.steps);
  if (steps.length > 0 && steps.every((step) => stepStateOf(orch, step.id) === "done")) return "done";
  return "idle";
}

export interface RailsSummary {
  running: number;
  done: number;
  idle: number;
  total: number;
}

/// Tallies a workspace's rails by phase. An orchestration that has not
/// loaded yet (or a workspace with no root, which never gets one) counts
/// as no rails rather than as an error state -- the recap simply has
/// nothing to say about rails until it arrives.
export function railsSummary(orch: Orchestration | null | undefined): RailsSummary {
  const summary: RailsSummary = { running: 0, done: 0, idle: 0, total: 0 };
  if (!orch) return summary;
  for (const rail of orch.rails) {
    summary[railPhase(orch, rail)] += 1;
    summary.total += 1;
  }
  return summary;
}

/// The three maps a page's tab tally reads, structurally rather than as
/// the whole LayoutState: two of them only ever answer "is this id a tab
/// of that kind", so `unknown` values are all this needs to know.
export interface PageTabState {
  sessionStatusById: Record<string, SessionStatus>;
  fileTabsById: Record<string, unknown>;
  boardTabsById: Record<string, unknown>;
}

export interface PageAgentsSummary {
  /// Every tab on the page, agent-backed or not.
  tabs: number;
  /// Those tabs that are terminal sessions. `tabs - agents` is the file
  /// and board tabs, which no agent runs behind.
  agents: number;
  running: number;
  /// Blocked on the human. Its own bucket, in neither `running` nor
  /// `idle`: an agent waiting for input is plainly not working, and just
  /// as plainly not finished with you. The sidebar draws this count as
  /// the page row's attention badge rather than inside the recap.
  waiting: number;
  idle: number;
}

/// Tallies one page's tabs, and buckets the agents among them by status.
/// A session with no status recorded yet counts as idle -- a tab that has
/// never reported in has certainly not started working -- which is also
/// what keeps `running + waiting + idle === agents` true at all times.
///
/// Which tabs are agents goes through layout's sessionTabsOnly, the same
/// projection behind the close-page prompt's "N terminal sessions will
/// end", so the number the recap shows and the number that prompt warns
/// about are the same number.
export function pageAgentsSummary(page: Page, state: PageTabState): PageAgentsSummary {
  const ids = allSessionIds(page.layout);
  const agentIds = sessionTabsOnly(ids, state.fileTabsById, state.boardTabsById);
  let running = 0;
  let waiting = 0;
  for (const id of agentIds) {
    const status = state.sessionStatusById[id];
    if (status === "working") running += 1;
    else if (status === "waiting_for_input") waiting += 1;
  }
  return {
    tabs: ids.length,
    agents: agentIds.length,
    running,
    waiting,
    idle: agentIds.length - running - waiting,
  };
}

export type PageTabKind = "session" | "file" | "board";

export interface PageTabRow {
  id: string;
  kind: PageTabKind;
  /// The agent's live status -- null for a file or board tab, which no
  /// agent runs behind. A session that has not reported in yet reads as
  /// idle, the same default pageAgentsSummary counts by, so an expanded
  /// page's rows can never disagree with the tallies on its own row.
  status: SessionStatus | null;
}

/// One row per tab, in layout order (allSessionIds' own left-to-right,
/// top-to-bottom walk), each classified by kind. This is exactly what the
/// sidebar renders when a page is expanded, which is why the walk and the
/// classification live here rather than in the template: the expansion
/// and the recap have to be two views of one list.
export function pageTabRows(page: Page, state: PageTabState): PageTabRow[] {
  return allSessionIds(page.layout).map((id): PageTabRow => {
    if (state.boardTabsById[id]) return { id, kind: "board", status: null };
    if (state.fileTabsById[id]) return { id, kind: "file", status: null };
    return { id, kind: "session", status: state.sessionStatusById[id] ?? "idle" };
  });
}

/// Whether the recap row has anything worth a row of its own. A workspace
/// with no repo, no card and no rail renders no recap at all rather than
/// an empty strip -- an all-zero tally is noise, not information.
export function hasRecap(git: WorkspaceGitSummary, cards: KanbanSummary, rails: RailsSummary): boolean {
  return showGitChip(git) || cards.total > 0 || rails.total > 0;
}
