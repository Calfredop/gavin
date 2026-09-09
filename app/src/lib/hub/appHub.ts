// What the app hub shows: the recents list, the age stamp beside each
// row, and the outbound links in the footer. Pure functions over data
// the app already holds -- AppHubView.svelte is a template over this
// module and holds no rules of its own.

import {
  findSessionLocation,
  sidebarWorkspaceOrder,
  type GitStatus,
  type Workspace,
  type WorkspacesData,
} from "$lib/workspace";
import type { FleetStrip } from "$lib/agents/memory";
import { sessionTabsOnly } from "$lib/panes/layout";
import {
  gitSummaryOf,
  kanbanSummary,
  railsSummary,
  workspaceAgentsSummary,
  workspaceSessionIds,
  type KanbanBucket,
  type KanbanSummary,
  type PageTabState,
  type RailsSummary,
  type WorkspaceAgentsSummary,
  type WorkspaceGitSummary,
} from "$lib/sidebar/sidebarSummary";
import { cardSessionState, type CardSessionState } from "$lib/board/columnRunAction";
import { cardIsOnARail, type LinkedCard } from "$lib/cards/cardTabLink";
import { cardIndex, effectiveStatus, planIndex, type Orchestration } from "$lib/orchestration/orchestration";
import { slugStatus } from "$lib/planBoard";
import { totalUsage, type SessionRow, type Totals } from "$lib/sessions/sessionsManager";
import {
  reportSeverity,
  unavailableReason,
  worstWindow,
  type AgentUsageReport,
  type UsageSeverity,
  type UsageWindow,
} from "$lib/agents/agentUsage";
import type { AgentProfileInfo } from "$lib/settings";
import type { Board } from "$lib/board/kanban";
import type { GavinTree } from "$lib/gavin";
import type { SessionStatus } from "$lib/notifications";
// Build-time, not a Tauri round trip: the hub's header must render on
// the very first frame, and a version is not worth an IPC failure mode.
// Keep in step with app/src-tauri/tauri.conf.json's own `version`, which
// is what the packaged app reports to the OS.
import { version } from "../../../package.json";

export const APP_VERSION: string = version;

/// Workspaces in "most recently used first" order.
///
/// Two groups, never interleaved: everything with a `lastActiveAt`
/// stamp, newest first, then everything without one in the sidebar's own
/// order. An unstamped workspace is not "infinitely old" -- it is a
/// workspace this build has never seen switched to, which is a different
/// thing, and sorting it by a made-up zero would shuffle a fresh
/// install's list into reverse-creation order the first time the hub
/// opened. Falling back to sidebarWorkspaceOrder means the hub and the
/// sidebar list right below it agree until the stamps say otherwise.
///
/// Ties keep sidebar order for the same reason: two workspaces stamped
/// in the same millisecond is not information to sort on.
export function recentWorkspaces(workspaces: Workspace[]): Workspace[] {
  const ordered = sidebarWorkspaceOrder(workspaces);
  const stamped = ordered.filter((w) => typeof w.lastActiveAt === "number");
  const unstamped = ordered.filter((w) => typeof w.lastActiveAt !== "number");
  // Index into `ordered` breaks ties, so the sort stays deterministic
  // regardless of the engine's own stability guarantees.
  const rank = new Map(ordered.map((w, i) => [w.id, i]));
  stamped.sort((a, b) => {
    const diff = (b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0);
    return diff !== 0 ? diff : (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0);
  });
  return [...stamped, ...unstamped];
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

/// A short age for a hub row: "just now", "5m ago", "3h ago", "2d ago",
/// "6w ago". Coarse on purpose -- the row answers "which of these was I
/// in last", not "how long exactly", and a precise duration would only
/// make the column wider.
///
/// Null (never switched to) reads as "never", and so does a stamp in the
/// future: a clock that has moved backwards is the only way to get one,
/// and inventing "in 3 hours" for it would be worse than admitting the
/// app does not know.
export function relativeTime(then: number | null | undefined, now: number): string {
  if (typeof then !== "number") return "never";
  const delta = now - then;
  if (delta < 0) return "never";
  if (delta < MINUTE) return "just now";
  if (delta < HOUR) return `${Math.floor(delta / MINUTE)}m ago`;
  if (delta < DAY) return `${Math.floor(delta / HOUR)}h ago`;
  if (delta < WEEK) return `${Math.floor(delta / DAY)}d ago`;
  return `${Math.floor(delta / WEEK)}w ago`;
}

export interface AppLink {
  id: string;
  label: string;
  /// Null means "there is nothing to link to yet". A link with a null
  /// url is never rendered -- see appLinks() -- because a dead link in
  /// the footer is worse than no link at all.
  url: string | null;
}

/// The hub's outbound links. Gavin's own repo and issues, plus a website
/// slot that stays null until there is a site: shipping a placeholder
/// that 404s would be the one thing this footer must not do. Fill the
/// url in and the row appears; nothing else has to change.
export const APP_LINKS: AppLink[] = [
  { id: "repo", label: "GitHub repository", url: "https://github.com/Calfredop/gavin" },
  { id: "issues", label: "Report an issue", url: "https://github.com/Calfredop/gavin/issues" },
  { id: "website", label: "Website", url: null },
];

/// The links that actually render, in declaration order.
export function appLinks(links: AppLink[] = APP_LINKS): AppLink[] {
  return links.filter((l) => l.url !== null);
}

/// The one-line recap beside a hub row: what is happening in that
/// workspace right now, then how much of it there is.
///
/// Built from workspaceAgentsSummary rather than from a count of its
/// own, so this line and the sidebar's per-page recaps underneath it
/// are the same arithmetic. Quiet buckets are omitted -- "0 running"
/// beside "0 waiting" is three words that say nothing -- which leaves a
/// resting workspace showing only its size.
export function workspaceRecapLine(summary: WorkspaceAgentsSummary): string {
  const parts: string[] = [];
  // Broken first: it is the one bucket the human cannot leave alone, and
  // before v21 it was counted as idle -- so a hub row said "3 pages" for
  // a workspace whose whole rail had stopped.
  if (summary.failed > 0) parts.push(`${summary.failed} stopped`);
  if (summary.running > 0) parts.push(`${summary.running} running`);
  if (summary.waiting > 0) parts.push(`${summary.waiting} waiting`);
  parts.push(summary.pages === 0 ? "no pages" : plural(summary.pages, "page"));
  return parts.join(" · ");
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

// ---------------------------------------------------------------------
// The fleet: what is running right now, and what it all adds up to.
//
// Everything below is one pure walk over stores the app already keeps
// filled (the sidebar's recap effect fetches every rooted workspace's
// board and orchestration), so the fleet costs no traffic of its own
// and can never disagree with the sidebar sitting beside it -- the two
// go through the same tallies (sidebarSummary.ts) and the same liveness
// vocabulary (columnRunAction's cardSessionState).
// ---------------------------------------------------------------------

/// What a card's agent is doing, in the order a human wants to hear it.
///
/// `waiting` and `interrupted` both mean "this one needs you": one is an
/// agent asking a question, the other a run the daemon replaced with a
/// bare shell after a restart. They lead for that reason -- the same
/// rule railPhase follows when it puts attention ahead of running.
export type TaskPhase = "waiting" | "failed" | "interrupted" | "working" | "idle";

const PHASE_RANK: Record<TaskPhase, number> = {
  waiting: 0,
  failed: 1,
  interrupted: 2,
  working: 3,
  idle: 4,
};

/// The word each phase goes by on screen and in a label. Here rather
/// than in the template so one vocabulary covers the row, its tooltip
/// and the group's own tally.
export const PHASE_LABEL: Record<TaskPhase, string> = {
  waiting: "Waiting for you",
  failed: "Stopped — something broke",
  interrupted: "Interrupted",
  working: "Working",
  idle: "Idle",
};

/// One card with an agent behind it right now. Extends LinkedCard, so a
/// row hands straight to openLinkedCard -- the hub's jump and the tab
/// bar's are the same jump.
export interface RunningTask extends LinkedCard {
  workspaceId: string;
  sessionId: string;
  phase: TaskPhase;
  /// The column the BOARD shows this card in, through effectiveStatus --
  /// a nested task reads its parent's status, never its own absent one.
  /// Null when the tree has not caught up with a file that exists.
  cardStatus: string | null;
  /// The page whose tab holds the session, resolved wherever it actually
  /// lives now: a tab can be dragged to another page, or another
  /// workspace, long after the card bound to it. Null only for a session
  /// no tree holds, which cardSessionState has already ruled out here.
  pageId: string | null;
  pageName: string | null;
  /// The workspace the TAB is in, which is not always the one the card
  /// is filed in -- a tab can be dragged across workspaces, and the jump
  /// to the terminal has to follow it rather than the card.
  pageWorkspaceId: string | null;
}

export interface WorkspaceRunning {
  workspaceId: string;
  name: string;
  /// The workspace's accent, for the group's stripe. Absent means the
  /// default -- the same thing it means on a hub row.
  color?: string;
  tasks: RunningTask[];
  /// Live agents in this workspace that are working or waiting on a
  /// human with NO card behind them: a terminal someone started by hand.
  ///
  /// Deliberately narrower than the card side, which counts an idle
  /// bound agent as a task in flight. A bound card is work that was
  /// started and has not finished, however quiet its agent has gone; an
  /// idle unbound terminal is just a terminal, and counting those would
  /// put a number on every workspace that has ever been opened.
  looseAgents: number;
}

/// The stores this whole file reads, structurally. Everything here is a
/// slice of LayoutState -- named this way so the pure functions can be
/// driven from a fixture without building one.
export type FleetState = WorkspacesData &
  PageTabState & {
    interruptedSessionIds: ReadonlySet<string>;
    gitStatusById: Record<string, GitStatus | null>;
  };

/// One bundle for both fleet questions below, so the column and the
/// stats strip above it are two views of exactly one set of inputs.
export interface FleetInput {
  state: FleetState;
  boards: Record<string, Board | undefined>;
  trees: Record<string, GavinTree | undefined>;
  orchestrations: Record<string, Orchestration | undefined>;
  /// Per workspace, the rails a human is holding up
  /// (railsWantingAttention). Absent reads as "nothing wants a human",
  /// which is also what a workspace whose orchestration has not loaded
  /// looks like.
  attention?: Record<string, ReadonlySet<string>>;
  /// Workspaces with a "Commit via agent" run in flight. A hidden
  /// session with no tab, so it cannot be counted from the layout.
  committing?: ReadonlySet<string>;
  /// The fleet strip the sidebar footer draws (launchQueue's
  /// `fleetStripLine`), passed in rather than recomputed: the hub and the
  /// footer are on screen together, and two arithmetics for one number is
  /// the shape that drifts. Absent means nothing worth a row, which is
  /// also what a machine nothing has measured looks like.
  memory?: FleetStrip | null;
}

/// Every card with a live agent behind it, grouped by workspace.
///
/// The groups come in recentWorkspaces order rather than by how busy
/// they are: the hub already lists the fleet in that order right beside
/// this column, and a list that reshuffled itself as agents came and
/// went would be unreadable precisely when it matters most. A workspace
/// with nothing running is left out entirely.
///
/// Liveness goes through cardSessionState, so the hub, the board's dot
/// and the card menu agree on what "busy" means: a binding whose session
/// exited is not a running task, and a binding whose run the daemon
/// replaced with a bare shell is a task that STOPPED, not one that is
/// working.
export function runningTasks(input: FleetInput): WorkspaceRunning[] {
  const groups: WorkspaceRunning[] = [];
  for (const ws of recentWorkspaces(input.state.workspaces)) {
    const board = input.boards[ws.id];
    const orch = input.orchestrations[ws.id];
    const cards = cardIndex(input.trees[ws.id]);
    const plans = planIndex(cards);
    const bound = new Set<string>();
    const tasks: RunningTask[] = [];
    for (const cs of board?.cardSessions ?? []) {
      const liveness = cardSessionState(input.state, cs);
      if (liveness !== "live" && liveness !== "interrupted") continue;
      bound.add(cs.sessionId);
      const entry = cards.get(cs.path);
      const title = entry?.plan.title?.trim();
      tasks.push({
        workspaceId: ws.id,
        sessionId: cs.sessionId,
        path: cs.path,
        // The file name is the fallback the tab bar's link already uses
        // for a card the tree has not seen yet -- never a blank row.
        title: title || (cs.path.split("/").at(-1) ?? cs.path),
        cardStatus: entry ? effectiveStatus(entry, plans) : null,
        phase: taskPhase(liveness, input.state.sessionStatusById[cs.sessionId]),
        ...tabLocation(input.state, cs.sessionId),
        view: cardIsOnARail(orch, cs.path) ? "orchestration" : "kanban",
      });
    }
    // Phase first, then title: two agents in the same state are listed
    // in an order that does not move as one of them thinks.
    tasks.sort(
      (a, b) => PHASE_RANK[a.phase] - PHASE_RANK[b.phase] || a.title.localeCompare(b.title)
    );
    const looseAgents = countLooseAgents(ws, input.state, bound);
    if (tasks.length > 0 || looseAgents > 0) {
      groups.push({ workspaceId: ws.id, name: ws.name, color: ws.color, tasks, looseAgents });
    }
  }
  return groups;
}

function taskPhase(liveness: CardSessionState, status: SessionStatus | undefined): TaskPhase {
  // Checked before any status, exactly as the board's dot checks it: the
  // daemon's status for an interrupted session describes the bare shell
  // that replaced the agent, so reading it would report a run that is
  // not happening as working or idle.
  if (liveness === "interrupted") return "interrupted";
  // Same precedence, sharper reason: a failed agent's status IS `failed`,
  // but every surface used to read the quiet seconds behind it as idle.
  if (liveness === "failed") return "failed";
  if (status === "waiting_for_input") return "waiting";
  if (status === "working") return "working";
  return "idle";
}

/// Where the session's tab actually is right now. Resolved fresh from
/// the layout rather than from the binding, which stores a bare session
/// id: a tab can be dragged to another page, or another workspace, long
/// after a card bound to it, and "open the terminal" has to follow the
/// tab rather than the card.
function tabLocation(
  state: FleetState,
  sessionId: string
): Pick<RunningTask, "pageId" | "pageName" | "pageWorkspaceId"> {
  const at = findSessionLocation(state, sessionId);
  if (!at) return { pageId: null, pageName: null, pageWorkspaceId: null };
  const ws = state.workspaces.find((w) => w.id === at.workspaceId);
  return {
    pageId: at.pageId,
    pageName: ws?.pages.find((p) => p.id === at.pageId)?.name ?? null,
    pageWorkspaceId: at.workspaceId,
  };
}

function countLooseAgents(ws: Workspace, state: FleetState, bound: Set<string>): number {
  const ids = sessionTabsOnly(workspaceSessionIds(ws), state.fileTabsById, state.boardTabsById, state.cardTabsById);
  let n = 0;
  for (const id of ids) {
    if (bound.has(id)) continue;
    const status = state.sessionStatusById[id];
    if (status === "working" || status === "waiting_for_input") n += 1;
  }
  return n;
}

/// How many running tasks the whole fleet holds -- the number the column
/// heading shows, counted off the very groups it renders.
export function runningTaskCount(groups: WorkspaceRunning[]): number {
  return groups.reduce((n, g) => n + g.tasks.length, 0);
}

export interface FleetSummary {
  /// Every workspace the app holds.
  workspaces: number;
  /// Those with a bound root. The only ones that can have a board, rails
  /// or a PRD at all, which is why a fleet of unrooted workspaces shows
  /// empty card and rail tallies rather than a fault.
  rooted: number;
  /// Tabs and the agents behind them, summed over every workspace --
  /// `pages` included, so the strip's page count and the per-row recaps
  /// underneath it are one walk of one list.
  agents: WorkspaceAgentsSummary;
  /// Deduped by repoRoot across the WHOLE fleet: two workspaces opened
  /// on the same checkout are one repo, and summing per-workspace
  /// tallies would count it twice.
  git: WorkspaceGitSummary;
  /// Every board's columns folded together by slug, so the strip can be
  /// handed to kanbanColumnChips exactly like a single workspace's.
  cards: KanbanSummary;
  rails: RailsSummary;
  /// Cards with an agent behind them, fleet-wide -- the same count the
  /// column beside the strip renders.
  tasks: number;
  /// How many agents are running against the ceiling, and how full the
  /// machine is -- the sidebar footer's own strip, on the hub. Null when
  /// there is nothing worth a badge.
  memory: FleetStrip | null;
}

/// The whole fleet in one line of badges: how much of it there is, and
/// how much of it is moving.
///
/// Every part is the sidebar's own per-workspace tally summed rather
/// than a count of its own, for the reason workspaceRecapLine already
/// gives: the hub and the sidebar are on screen together, and two
/// arithmetics for one number is the shape that drifts.
export function fleetSummary(input: FleetInput): FleetSummary {
  const workspaces = input.state.workspaces;
  const agents: WorkspaceAgentsSummary = {
    pages: 0,
    tabs: 0,
    agents: 0,
    running: 0,
    waiting: 0,
    failed: 0,
    idle: 0,
  };
  const rails: RailsSummary = { running: 0, attention: 0, done: 0, idle: 0, total: 0 };
  const boards: KanbanSummary[] = [];
  const sessionIds: string[] = [];
  for (const ws of workspaces) {
    const ownAgents = workspaceAgentsSummary(ws, input.state);
    agents.pages += ownAgents.pages;
    agents.tabs += ownAgents.tabs;
    agents.agents += ownAgents.agents;
    agents.running += ownAgents.running;
    agents.waiting += ownAgents.waiting;
    agents.failed += ownAgents.failed;
    agents.idle += ownAgents.idle;
    const ownRails = railsSummary(input.orchestrations[ws.id], input.attention?.[ws.id]);
    rails.running += ownRails.running;
    rails.attention += ownRails.attention;
    rails.done += ownRails.done;
    rails.idle += ownRails.idle;
    rails.total += ownRails.total;
    boards.push(kanbanSummary(input.boards[ws.id], input.trees[ws.id]));
    sessionIds.push(...workspaceSessionIds(ws));
  }
  return {
    workspaces: workspaces.length,
    rooted: workspaces.filter((w) => Boolean(w.rootPath)).length,
    agents,
    // One flag for the fleet: the strip has one git badge, and "somebody
    // somewhere is committing" is exactly what it can say.
    git: gitSummaryOf(sessionIds, input.state.gitStatusById, (input.committing?.size ?? 0) > 0),
    cards: mergeKanbanSummaries(boards),
    rails,
    tasks: runningTaskCount(runningTasks(input)),
    memory: input.memory ?? null,
  };
}

/// Folds many boards onto one. The three buckets add up; the per-column
/// detail merges by SLUG -- the very key kanbanSummary buckets by -- so
/// "To Do" and "to do" on two boards are one column here, and the fleet
/// strip can be expanded column by column like a single workspace's.
///
/// First-appearance order, which is the first board's own column order
/// followed by whatever later boards add. A merged strip that reordered
/// itself as counts changed would be harder to read than a stable one,
/// the same reason planSummary sorts at all.
function mergeKanbanSummaries(list: KanbanSummary[]): KanbanSummary {
  const merged: KanbanSummary = { todo: 0, inProgress: 0, done: 0, total: 0, columns: [] };
  const bySlug = new Map<string, KanbanBucket>();
  for (const summary of list) {
    merged.todo += summary.todo;
    merged.inProgress += summary.inProgress;
    merged.done += summary.done;
    merged.total += summary.total;
    for (const column of summary.columns) {
      const slug = slugStatus(column.name);
      const seen = bySlug.get(slug);
      if (seen) {
        seen.count += column.count;
      } else {
        const bucket: KanbanBucket = { name: column.name, count: column.count };
        bySlug.set(slug, bucket);
        merged.columns.push(bucket);
      }
    }
  }
  return merged;
}

// ---------------------------------------------------------------------
// The two recaps the hub carries under the fleet: what the daemon is
// holding, and what the agents have left to spend.
//
// Both are folds over lists somebody else already built --
// `sessionRows` from the task manager, `agentUsageStore` from the pause
// clock -- for the reason the whole file gives: the hub sits one modal
// away from the panels these numbers come from, and a second arithmetic
// is the shape that drifts. Nothing here re-derives a state, a rate or a
// percentage.
//
// The usage side costs nothing: `startPauseClock` already reads every
// profile in use, app-wide, whether or not the hub is open. The session
// side is the one thing on this surface with a reader of its own -- no
// store holds the daemon's session list -- and the template owns that
// poll, for exactly as long as the hub is mounted.
// ---------------------------------------------------------------------

/// How many stale sessions the hub names before it stops and counts the
/// rest. Four: enough that the usual case (one survivor, one exited row)
/// is shown whole, few enough that a daemon full of dead rows cannot
/// push the fleet off the screen.
export const RECAP_ROWS = 4;

export interface SessionsRecap {
  /// Every session the daemon is holding, whether or not a tab is
  /// showing it.
  sessions: number;
  /// Sessions nothing on screen is showing. Not a fault -- a commit run
  /// and an orchestration Organize are both meant to be invisible -- but
  /// it is the number that says how much of the fleet is off-screen.
  hidden: number;
  stale: number;
  /// What the whole list costs, through the task manager's own sum, so
  /// the hub and the panel can never state different totals for one
  /// daemon.
  totals: Totals;
  /// The stale rows themselves, in the order `sessionRows` already put
  /// them in -- attention first. Never re-sorted here: the rows are
  /// rebuilt on every poll, and a recap that ranked them by cost would
  /// reshuffle under the pointer.
  attention: SessionRow[];
  /// Stale rows the cap left out, so the panel can say "+3 more" rather
  /// than quietly showing four of seven.
  more: number;
}

/// The task manager, folded to what fits on the hub.
///
/// `stale` and `hidden` are counted over EVERY row, not over the capped
/// list, because they are the two numbers that decide whether the panel
/// is worth opening at all.
export function sessionsRecap(rows: SessionRow[], limit = RECAP_ROWS): SessionsRecap {
  const cap = Math.max(0, limit);
  const stale = rows.filter((r) => r.stale);
  return {
    sessions: rows.length,
    hidden: rows.filter((r) => !r.visible).length,
    stale: stale.length,
    totals: totalUsage(rows),
    attention: stale.slice(0, cap),
    more: Math.max(0, stale.length - cap),
  };
}

/// The hub's one line about sessions worth a second look.
///
/// Only the parts that are non-zero, the rule `workspaceRecapLine`
/// already follows: a line that always reads "0 hidden · 0 stale" trains
/// the eye to skip the one place those two numbers appear. Null when
/// there is nothing to say, so a quiet daemon costs no line at all.
export function sessionsAttentionLine(recap: SessionsRecap): string | null {
  const parts: string[] = [];
  if (recap.hidden > 0) parts.push(`${recap.hidden} hidden`);
  if (recap.stale > 0) parts.push(`${recap.stale} stale`);
  return parts.length > 0 ? parts.join(" · ") : null;
}

export interface UsageRecapRow {
  profileId: string;
  label: string;
  /// How many workspaces launch this agent. The reason the row is on the
  /// hub at all: one window's limits are shared by every workspace
  /// pointed at that agent, and the count is what says how much of the
  /// fleet stops when it runs out.
  workspaces: number;
  /// Null while the first read is still in flight. Deliberately NOT
  /// `unsupported`, which is a probe that answered "there is nothing to
  /// read" -- "checking…" and "this agent publishes no limits" are
  /// different sentences.
  report: AgentUsageReport | null;
  /// The window nearest its ceiling, which is the one that will stop
  /// work first. Null whenever there are no numbers.
  worst: UsageWindow | null;
  severity: UsageSeverity | null;
}

export interface UsageRecapInput {
  /// The profile table, in its own order.
  profiles: AgentProfileInfo[];
  /// The profile each workspace actually launches, by workspace id. A
  /// null value is a workspace whose agent has not resolved yet.
  profileByWorkspace: Record<string, string | null>;
  /// The newest reading per profile id, as agentUsageStore holds it.
  reports: Record<string, AgentUsageReport>;
}

/// One row per agent the fleet actually runs.
///
/// Only profiles some workspace launches, exactly as the usage panel
/// filters: a bar for an agent nobody here uses means nothing, and for
/// the profiles with no probe it would be a paragraph of apology on the
/// home screen.
///
/// In the PROFILE TABLE's order rather than worst-first. The two
/// surfaces are one modal apart, and a hub that ranked by percentage
/// would list the same two agents in a different order from the panel it
/// opens -- and would reorder itself as the numbers moved.
export function usageRecap(input: UsageRecapInput): UsageRecapRow[] {
  const counts = new Map<string, number>();
  for (const profileId of Object.values(input.profileByWorkspace)) {
    if (!profileId) continue;
    counts.set(profileId, (counts.get(profileId) ?? 0) + 1);
  }
  return input.profiles
    .filter((p) => counts.has(p.id))
    .map((p) => {
      const report = input.reports[p.id] ?? null;
      return {
        profileId: p.id,
        label: p.label,
        workspaces: counts.get(p.id) ?? 0,
        report,
        worst: report ? worstWindow(report) : null,
        severity: report ? reportSeverity(report) : null,
      };
    });
}

/// The agent nearest its ceiling, for the one badge a heading has room
/// for. Null when nothing in the fleet has a number -- which must read
/// as "gavin cannot see", never as "plenty left", so a caller omits the
/// badge rather than drawing an "ok" one.
export function worstUsageRow(rows: UsageRecapRow[]): UsageRecapRow | null {
  let worst: UsageRecapRow | null = null;
  for (const row of rows) {
    const window = row.worst;
    if (!window) continue;
    if (!worst || window.usedPercent > (worst.worst?.usedPercent ?? -1)) worst = row;
  }
  return worst;
}

/// What a usage row says INSTEAD of a bar, or null when it has one.
///
/// Three absences, three sentences, and the one that must never be
/// collapsed into the others is the first: a profile nobody has read yet
/// is not a profile with no limits. The last case -- a report that
/// arrived `ready` and carried no windows -- has no reason of its own to
/// print, and would otherwise render as an empty row.
export function usageRowNote(row: UsageRecapRow, nowMs: number): string | null {
  if (row.report === null) return "Checking\u2026";
  if (row.worst) return null;
  return unavailableReason(row.report, row.label, nowMs) ?? "No limits reported.";
}
