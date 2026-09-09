// What the sidebar's recap rows count: per workspace, its git checkouts,
// its kanban cards and its orchestration rails; per page, its tabs and
// the agents behind them. Pure counting over data the app already holds,
// and always over the same projection the full view uses -- the git side
// reads the very per-session statuses the page rows show, the card side
// goes through boardSummary, the tab side goes through sessionTabsOnly --
// so a recap can never disagree with what it summarises, and no new
// polling is introduced.

import { allSessionIds, sessionTabsOnly } from "$lib/layout";
import { boardSummary } from "$lib/homeSummary";
import { isStepFinished, railStateOf, stepStateOf, type Orchestration, type Rail } from "$lib/orchestration";
import { slugStatus } from "$lib/planBoard";
import type { Board } from "$lib/kanban";
import type { GavinTree } from "$lib/gavin";
import type { GitStatus, Page, Workspace } from "$lib/workspace";
import type { SessionStatus } from "$lib/notifications";

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
///
/// Exported because the app hub asks the same question of the whole
/// fleet at once, and a second walk of the same trees is the shape that
/// drifts.
export function workspaceSessionIds(ws: Workspace): string[] {
  const ids = ws.pages.flatMap((p) => allSessionIds(p.layout));
  return ws.mainSessionId ? [...ids, ws.mainSessionId] : ids;
}

export function workspaceGitSummary(
  ws: Workspace,
  gitStatusById: Record<string, GitStatus | null>,
  committing = false
): WorkspaceGitSummary {
  return gitSummaryOf(workspaceSessionIds(ws), gitStatusById, committing);
}

/// The tally itself, over whatever set of sessions the caller cares
/// about: one workspace's (above) or the whole fleet's (the app hub).
/// The dedupe is what makes the second case correct rather than merely
/// convenient -- two workspaces opened on the SAME checkout are one
/// repo, and summing two per-workspace tallies would count it twice.
export function gitSummaryOf(
  sessionIds: Iterable<string>,
  gitStatusById: Record<string, GitStatus | null>,
  committing = false
): WorkspaceGitSummary {
  // Deduped by repoRoot exactly like summarizePageGitStatus: five
  // sessions sharing one checkout are one repo, not five. Sessions with
  // no repo (null or missing entry) are ignored rather than counted as a
  // group of their own.
  const byRepoRoot = new Map<string, GitStatus>();
  for (const id of sessionIds) {
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

export type ColumnTone = "todo" | "progress" | "done";

export interface KanbanColumnChip {
  /// The column's full name, for the label and the tooltip -- the strip
  /// itself only has room for the initials.
  name: string;
  initials: string;
  tone: ColumnTone;
  count: number;
}

/// A column name reduced to what a 200px row can draw: the first letter
/// of each word, upper-cased. Capped at three, so one long name
/// ("waiting on review from someone") cannot eat the whole strip on its
/// own -- the full name is a hover away in cardRecapTip either way. A
/// name with no letters or digits in it at all still gets a slot rather
/// than a blank, which would read as a rendering fault rather than as a
/// column the human named oddly.
function columnInitials(name: string): string {
  const words = name.split(/[^a-zA-Z0-9]+/).filter(Boolean);
  if (words.length === 0) return "?";
  return words
    .slice(0, 3)
    .map((w) => w[0].toUpperCase())
    .join("");
}

/// What the board group expands into when it is pointed at: one stat per
/// column, in the order kanbanSummary already put them -- board order
/// first, auto columns after -- so the expansion reads left to right the
/// way the board itself does.
///
/// Every column survives, including one standing at zero: this is the
/// DETAIL view the single total hides, and a board whose shape changed
/// with how full it happened to be would be worse than the total. The
/// tone comes off the very slug fold kanbanSummary counts by (the two
/// permanent ends by slug, everything else in progress by elimination),
/// so a column's colour can never disagree with the bucket its cards
/// were tallied into.
export function kanbanColumnChips(cards: KanbanSummary): KanbanColumnChip[] {
  return cards.columns.map((column) => {
    const slug = slugStatus(column.name);
    const tone: ColumnTone = slug === TODO_SLUG ? "todo" : slug === DONE_SLUG ? "done" : "progress";
    return { name: column.name, initials: columnInitials(column.name), tone, count: column.count };
  });
}

export type RailPhase = "running" | "attention" | "done" | "idle";

/// Which bucket a rail falls in. "attention" means a step of it is
/// waiting on a HUMAN (railsWantingAttention); "running" is the rail's
/// own run state; "done" means every step finished; everything else is
/// "idle" -- including `paused`, which is a rail that stopped rather than
/// one that arrived. A rail with no steps is idle, not vacuously done:
/// `every` on an empty list is true, and an empty rail has plainly not
/// completed anything.
///
/// Attention is checked FIRST, and so outranks even idle. A rail waiting
/// on a human is still running, but "3 running" says nothing about which
/// of the three wants you -- and a paused rail holding a step stuck
/// `running` with a live agent is the wedge that makes it uneditable and
/// undeletable, which is worth surfacing rather than filing under idle.
/// `attentionRailIds` is empty for every caller that has no orchestration
/// attention map to hand, which reads as "nothing wants a human".
export function railPhase(
  orch: Orchestration,
  rail: Rail,
  attentionRailIds: ReadonlySet<string> = new Set()
): RailPhase {
  if (attentionRailIds.has(rail.id)) return "attention";
  if (railStateOf(orch, rail.id) === "running") return "running";
  const steps = rail.stages.flatMap((stage) => stage.steps);
  // `skipped` counts as finished here: a rail whose every step is behind
  // it has nothing left to run, and filing it under "idle" would put it
  // back in the pile of rails waiting to be started.
  if (steps.length > 0 && steps.every((step) => isStepFinished(stepStateOf(orch, step.id))))
    return "done";
  return "idle";
}

export interface RailsSummary {
  running: number;
  attention: number;
  done: number;
  idle: number;
  total: number;
}

/// Tallies a workspace's rails by phase. An orchestration that has not
/// loaded yet (or a workspace with no root, which never gets one) counts
/// as no rails rather than as an error state -- the recap simply has
/// nothing to say about rails until it arrives.
export function railsSummary(
  orch: Orchestration | null | undefined,
  attentionRailIds: ReadonlySet<string> = new Set()
): RailsSummary {
  const summary: RailsSummary = { running: 0, attention: 0, done: 0, idle: 0, total: 0 };
  if (!orch) return summary;
  for (const rail of orch.rails) {
    summary[railPhase(orch, rail, attentionRailIds)] += 1;
    summary.total += 1;
  }
  return summary;
}

export type RailStatKey = "running" | "attention" | "done" | "idle";

/// Which of the four rail buckets the sidebar's recap strip actually
/// draws. The strip is ONE line across a 200px sidebar shared with a git
/// and a cards group, and four icon-and-number pairs is roughly twice the
/// width there is -- so the rails group answers one question at a time.
///
/// Active first: `running` and `attention` are what is happening right
/// now, and attention is the loudest thing this recap can say, so it is
/// never buried behind a done tally. Only when NOTHING is active does the
/// group fall back to the settled pair -- and then it shows both, since
/// two stats cost exactly what the active pair costs, so a quiet
/// workspace gets the complete answer for free.
///
/// Whatever is dropped here is still named in railRecapTip, which spells
/// out all four buckets; this decides what the row shows, not what the
/// human can find out.
export function railStripStats(rails: RailsSummary): RailStatKey[] {
  const active: RailStatKey[] = [];
  if (rails.running > 0) active.push("running");
  if (rails.attention > 0) active.push("attention");
  if (active.length > 0) return active;
  const settled: RailStatKey[] = [];
  if (rails.done > 0) settled.push("done");
  if (rails.idle > 0) settled.push("idle");
  return settled;
}

/// The three maps a page's tab tally reads, structurally rather than as
/// the whole LayoutState: two of them only ever answer "is this id a tab
/// of that kind", so `unknown` values are all this needs to know.
export interface PageTabState {
  sessionStatusById: Record<string, SessionStatus>;
  fileTabsById: Record<string, unknown>;
  boardTabsById: Record<string, unknown>;
  cardTabsById: Record<string, unknown>;
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
  /// Agents that stopped because something BROKE. Its own bucket for the
  /// same reason `waiting` has one, and a sharper one: before v21 these
  /// counted as `idle`, so the sidebar's recap said a workspace was
  /// quietly finished when what it actually was, was broken.
  failed: number;
  idle: number;
}

/// Tallies one page's tabs, and buckets the agents among them by status.
/// A session with no status recorded yet counts as idle -- a tab that has
/// never reported in has certainly not started working -- which is also
/// what keeps `running + waiting + failed + idle === agents` true at all
/// times.
///
/// Which tabs are agents goes through layout's sessionTabsOnly, the same
/// projection behind the close-page prompt's "N terminal sessions will
/// end", so the number the recap shows and the number that prompt warns
/// about are the same number.
export function pageAgentsSummary(page: Page, state: PageTabState): PageAgentsSummary {
  const ids = allSessionIds(page.layout);
  const agentIds = sessionTabsOnly(ids, state.fileTabsById, state.boardTabsById, state.cardTabsById);
  let running = 0;
  let waiting = 0;
  let failed = 0;
  for (const id of agentIds) {
    const status = state.sessionStatusById[id];
    if (status === "working") running += 1;
    else if (status === "waiting_for_input") waiting += 1;
    else if (status === "failed") failed += 1;
  }
  return {
    tabs: ids.length,
    agents: agentIds.length,
    running,
    waiting,
    failed,
    idle: agentIds.length - running - waiting - failed,
  };
}

export interface WorkspaceAgentsSummary extends PageAgentsSummary {
  /// How many pages were summed. The hub row's "4 pages" comes from
  /// here rather than from ws.pages.length so the count and the tallies
  /// beside it are one walk of one list.
  pages: number;
}

/// A whole workspace's tab and agent tally: pageAgentsSummary over every
/// page, plus the main agent session, which lives OUTSIDE every page
/// tree (D12).
///
/// Built by summing the per-page function rather than by re-walking the
/// layouts, so a hub row's "2 running · 4 pages" can never disagree with
/// the per-page recap the sidebar shows directly underneath it -- the
/// two are the same arithmetic over the same projection.
///
/// The main session is folded in as a tab and an agent of its own,
/// bucketed by the same status rule pageAgentsSummary uses (no status
/// recorded yet counts as idle), which keeps `running + waiting + idle
/// === agents` true for the workspace exactly as it is for a page. It is
/// counted once even if a page also happens to reference it: a workspace
/// with one agent must not read as two.
export function workspaceAgentsSummary(ws: Workspace, state: PageTabState): WorkspaceAgentsSummary {
  const total: WorkspaceAgentsSummary = {
    pages: ws.pages.length,
    tabs: 0,
    agents: 0,
    running: 0,
    waiting: 0,
    failed: 0,
    idle: 0,
  };
  for (const page of ws.pages) {
    const summary = pageAgentsSummary(page, state);
    total.tabs += summary.tabs;
    total.agents += summary.agents;
    total.running += summary.running;
    total.waiting += summary.waiting;
    total.failed += summary.failed;
    total.idle += summary.idle;
  }
  const main = ws.mainSessionId;
  if (main && !ws.pages.some((p) => allSessionIds(p.layout).includes(main))) {
    total.tabs += 1;
    total.agents += 1;
    const status = state.sessionStatusById[main];
    if (status === "working") total.running += 1;
    else if (status === "waiting_for_input") total.waiting += 1;
    else if (status === "failed") total.failed += 1;
    else total.idle += 1;
  }
  return total;
}

export type PageTabKind = "session" | "file" | "board" | "card";

export interface PageTabRow {
  id: string;
  kind: PageTabKind;
  /// The agent's live status -- null for a file, board or card tab, which
  /// no agent runs behind. A session that has not reported in yet reads as
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
    if (state.cardTabsById[id]) return { id, kind: "card", status: null };
    return { id, kind: "session", status: state.sessionStatusById[id] ?? "idle" };
  });
}

/// Whether the recap row has anything worth a row of its own. A workspace
/// with no repo, no card and no rail renders no recap at all rather than
/// an empty strip -- an all-zero tally is noise, not information.
export function hasRecap(git: WorkspaceGitSummary, cards: KanbanSummary, rails: RailsSummary): boolean {
  return showGitChip(git) || cards.total > 0 || rails.total > 0;
}
