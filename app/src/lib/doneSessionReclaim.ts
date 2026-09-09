// What the memory wall is allowed to END, and when.
//
// `launchGate.ts` holds new starts and stops nothing -- and on a machine
// at critical pressure that was found to be half an answer. The gate
// cannot see the idle agent that finished a card an hour ago and is
// still holding six gigabytes of MCP servers and a language server; six
// of those thrash a 32 GB Mac exactly as hard as six busy ones, and no
// queued launch ever drains while they sit there. This module names the
// sessions gavin may close to make room, and the conditions under which
// it may. Pure and unit-tested, for the reason the gate is: the rule
// that decides whether a session dies belongs in the file with the
// tests beside it.
//
// ## What qualifies
//
// A session has to be ALL of these, and the list is the whole policy:
//
//   * an agent the daemon is holding and has measured (a row in the
//     memory poll's `agentSessions`) -- a plain shell carries no command
//     and is never touched;
//   * bound to a card whose EFFECTIVE status is the board's done column,
//     read through `effectiveStatus` so a nested task under a done plan
//     counts as done and a nested task under a live plan does not;
//   * neither working nor waiting on the human, the sidebar recap's own
//     idle bucket (`idleTabsOnPage` uses the same two statuses);
//   * quiet for a grace period: neither the session's status nor the
//     card's file has changed for `IDLE_GRACE_MS`. The card's mtime is
//     part of the clock on purpose -- the commonest thing an agent does
//     after writing Done is commit, and "idle" is only two silent
//     seconds;
//   * on a page, unpinned, and not the workspace's main agent. Pinning
//     is the app's one "keep this tab" gesture and every bulk close
//     honours it; the main agent lives outside every page tree and is
//     the Home tab's, not a card's.
//
// ## When
//
// Two triggers, matching the two halves of the card that asked for
// this. CRITICAL pressure is "RAM usage is high": the kernel is about to
// swap, and an idle finished agent is the cheapest memory on the machine.
// WARN pressure with work waiting -- a queued launch, or a running rail
// whose next step the gate is holding -- is "blocking other tasks": the
// machine is not yet in trouble, but it is short, and the sessions in the
// way have nothing left to do. Warn pressure with nothing waiting closes
// nothing, because there is nothing to make room FOR, and a transcript
// the human may still want to read is worth more than a gigabyte nobody
// has asked for.
//
// One session per pass, biggest first, paced by `mayReclaim`: a close
// takes seconds to reach the sample, and the point is the smallest
// number of closes that clears the pressure, not the largest.

import type { StatusSince } from "$lib/attentionInbox";
import type { ConfirmOptions } from "$lib/dialog";
import type { GavinTree } from "$lib/gavin";
import type { Board } from "$lib/kanban";
import type { LaunchConfig } from "$lib/launchGate";
import type { MemoryPressure } from "$lib/memory";
import type { Orchestration } from "$lib/orchestration";
import type { Workspace } from "$lib/workspace";
import { countsInFlight } from "$lib/launchGate";
import { isPinned } from "$lib/layout";
import { formatGb } from "$lib/memory";
import {
  cardIndex,
  doneColumn,
  effectiveStatus,
  planIndex,
  runningStageId,
  stepStateOf,
} from "$lib/orchestration";
import { sessionLabel } from "$lib/paths";
import { slugStatus } from "$lib/planBoard";
import { count } from "$lib/railConfirm";
import { findSessionLocation } from "$lib/workspace";

/// How long a session AND its card must have been quiet before the
/// session may be closed by itself.
///
/// Two minutes. The daemon's `idle` is two silent seconds, which is
/// what a `cargo test` that has stopped printing looks like -- and the
/// commonest thing an agent does after writing Done on its card is
/// commit, which the auto-commit block asks for in so many words. Two
/// minutes is longer than a commit and shorter than the time a machine
/// under pressure has, and the biggest session goes first, so the ones
/// that just finished are rarely the ones that matter.
export const IDLE_GRACE_MS = 120_000;

/// The floor on the gap between two automatic closes, lifted early once
/// the previous one has left the sample. Same shape and same reason as
/// `DRAIN_SPACING_MS`: a close that has not reached the poll yet is a
/// close the next decision cannot see.
export const RECLAIM_SPACING_MS = 10_000;

/// The slice of LayoutState this module reads. Structural, like
/// `ClosableState` in archiveClose.ts, so the module never imports
/// layoutState and drags its listeners into a test.
export interface ReclaimState {
  workspaces: Workspace[];
  activeWorkspaceId: string | null;
  sessionStatusById: Record<string, string>;
  statusSinceById: Record<string, StatusSince>;
  sessionNames: Record<string, string>;
  cwdBySessionId: Record<string, string>;
}

/// One session the wall may close, with what closing it buys.
export interface ReclaimCandidate {
  sessionId: string;
  workspaceId: string;
  cardPath: string;
  cardTitle: string;
  /// The session's tab label, the way Pane and the notifications name it.
  label: string;
  /// What its process tree measured, or 0 for a row the daemon could not
  /// measure -- which sorts last, because a close whose gain is unknown
  /// is the close to make when nothing else is left.
  rssBytes: number;
  /// Epoch milliseconds: the later of the session's last status change
  /// and the card's last write.
  quietSinceMs: number;
}

export interface ReclaimInput {
  state: ReclaimState;
  /// Every open workspace's board, by workspace id.
  boards: Record<string, Board | undefined>;
  /// Every open workspace's gavin tree, by workspace id.
  trees: Record<string, GavinTree | undefined>;
  /// The memory poll's agent rows, by session id. Membership is what
  /// says "a live agent the daemon measured".
  agents: Record<string, { rssBytes: number }>;
  nowMs: number;
  /// How long a session and its card must have been quiet. Defaults to
  /// `IDLE_GRACE_MS`; the banner's manual close passes zero, because a
  /// human looking at the tabs is the grace period.
  graceMs?: number;
}

/// Every session the wall may close right now, biggest first.
///
/// A session bound to two card paths (a re-key the app was told about
/// late, a nested child and its parent) is listed once, under whichever
/// binding claims it first -- it can only die once, and the notice must
/// only count it once.
export function reclaimCandidates(input: ReclaimInput): ReclaimCandidate[] {
  const grace = input.graceMs ?? IDLE_GRACE_MS;
  const { state } = input;
  const claimed = new Set<string>();
  const out: ReclaimCandidate[] = [];
  for (const ws of state.workspaces) {
    const board = input.boards[ws.id];
    if (!board) continue;
    const done = doneColumn(board);
    if (!done) continue;
    const doneSlug = slugStatus(done.name);
    const cards = cardIndex(input.trees[ws.id]);
    const plans = planIndex(cards);
    for (const binding of board.cardSessions) {
      const id = binding.sessionId;
      if (claimed.has(id)) continue;
      const agent = input.agents[id];
      if (!agent) continue;
      if (ws.mainSessionId === id) continue;
      if (countsInFlight(state.sessionStatusById[id])) continue;
      const at = findSessionLocation(state, id);
      if (!at) continue;
      const page = state.workspaces
        .find((w) => w.id === at.workspaceId)
        ?.pages.find((p) => p.id === at.pageId);
      if (!page || isPinned(page.layout, id)) continue;
      const entry = cards.get(binding.path);
      if (!entry) continue;
      const status = effectiveStatus(entry, plans);
      if (status === null || slugStatus(status) !== doneSlug) continue;
      // No stamp means gavin has never seen a status for this session,
      // so how long it has been quiet is unknowable -- and an unknown
      // wait is not a wait that has been served.
      const since = state.statusSinceById[id];
      if (!since) continue;
      const quietSinceMs = Math.max(since.at, (entry.plan.modifiedAt ?? 0) * 1000);
      if (input.nowMs - quietSinceMs < grace) continue;
      claimed.add(id);
      out.push({
        sessionId: id,
        workspaceId: ws.id,
        cardPath: binding.path,
        cardTitle: entry.plan.title,
        label: sessionLabel(state.sessionNames, state.cwdBySessionId, id),
        rssBytes: Math.max(0, agent.rssBytes),
        quietSinceMs,
      });
    }
  }
  return out.sort((a, b) => b.rssBytes - a.rssBytes || a.quietSinceMs - b.quietSinceMs);
}

/// Which half of the card a close answers: the machine is critical, or
/// work is waiting behind a memory hold.
export type ReclaimReason = "critical" | "blocking";

export interface ReclaimTriggerInput {
  config: LaunchConfig;
  pressure: MemoryPressure;
  /// Intents in the launch queue, app-wide.
  queued: number;
  /// Rails whose next step the gate is holding (`heldRailCount`).
  railsHeld: number;
}

/// Whether the wall may close a session now, and why. Null is the
/// ordinary answer.
///
/// Critical pressure needs nothing else: the kernel is saying the
/// machine is about to swap. Warn pressure needs something waiting,
/// because closing a finished agent buys nothing anyone asked for
/// otherwise -- and at normal pressure there is no memory to make.
export function reclaimTrigger(input: ReclaimTriggerInput): ReclaimReason | null {
  if (!input.config.reclaimDoneSessions) return null;
  if (input.pressure === "critical") return "critical";
  if (input.pressure === "warn" && input.queued + input.railsHeld > 0) return "blocking";
  return null;
}

/// How many rails have a step the gate is holding right now.
///
/// The same rule the rail header draws its "Held" badge from
/// (OrchestrationRail's `heldStep`): the rail is running, the gate says
/// no, and the stage the rail is ON still has a pending step. A pending
/// step three stages away is waiting on the rail, not on memory, and
/// counting it would close sessions to make room for a launch that is
/// not due.
export function heldRailCount(
  orchestrations: Record<string, Orchestration | undefined>,
  launchAllowed: boolean
): number {
  if (launchAllowed) return 0;
  let held = 0;
  for (const orch of Object.values(orchestrations)) {
    if (!orch) continue;
    for (const rail of orch.rails) {
      const stageId = runningStageId(orch, rail.id);
      if (!stageId) continue;
      const stage = rail.stages.find((s) => s.id === stageId);
      if (stage?.steps.some((step) => stepStateOf(orch, step.id) === "pending")) held += 1;
    }
  }
  return held;
}

export interface ReclaimPaceInput {
  /// When the last automatic close was issued, epoch milliseconds, or
  /// null if none has been.
  lastReclaimMs: number | null;
  nowMs: number;
  /// Whether the fleet has shrunk since that close -- the sample has
  /// caught up, and there is nothing left to wait for.
  lastReclaimObserved: boolean;
}

/// Whether another automatic close may be issued. `mayDrain`'s pacing
/// half, without the verdict: the caller has already asked
/// `reclaimTrigger`.
export function mayReclaim(input: ReclaimPaceInput): boolean {
  if (input.lastReclaimMs === null) return true;
  if (input.lastReclaimObserved) return true;
  return input.nowMs - input.lastReclaimMs >= RECLAIM_SPACING_MS;
}

/// One close gavin made by itself, kept so a surface can say so.
export interface ReclaimRecord {
  sessionId: string;
  label: string;
  cardTitle: string;
  rssBytes: number;
  atMs: number;
  reason: ReclaimReason;
}

function bytesOf(records: Array<{ rssBytes: number }>): number {
  return records.reduce((total, r) => total + Math.max(0, r.rssBytes), 0);
}

/// "to free 3.1 GB", or nothing when no session in the batch was
/// measured -- a "0 GB" nobody measured would say the closes bought
/// nothing, which is the opposite of unknown.
function freeingClause(bytes: number): string {
  return bytes > 0 ? ` to free ${formatGb(bytes)}` : "";
}

/// The OS notification for a burst of automatic closes. One body for
/// the whole burst, because five notifications ten seconds apart is how
/// a notification stops being read -- and names the session when there
/// is only one, because "1 idle agent" is a count where a name would do.
export function reclaimNoticeBody(records: ReclaimRecord[]): string {
  const why = records.some((r) => r.reason === "critical")
    ? "memory was critical"
    : "launches were held for memory";
  const freeing = freeingClause(bytesOf(records));
  if (records.length === 1) {
    const [r] = records;
    return `Closed idle agent "${r.label}" of done card "${r.cardTitle}"${freeing} — ${why}.`;
  }
  return `Closed ${count(records.length, "idle agent")} of done cards${freeing} — ${why}.`;
}

/// How long a close stays mentioned on the pressure banner.
export const RECLAIMED_CLAUSE_WINDOW_MS = 10 * 60_000;

/// The banner's account of what the wall has closed lately, or null.
///
/// A window rather than "since the app started", because the banner is
/// about the pressure that is up NOW, and a close from this morning is
/// not why there is room this afternoon.
export function reclaimedClause(records: ReclaimRecord[], nowMs: number): string | null {
  const recent = records.filter((r) => nowMs - r.atMs <= RECLAIMED_CLAUSE_WINDOW_MS);
  if (recent.length === 0) return null;
  const bytes = bytesOf(recent);
  const size = bytes > 0 ? ` (${formatGb(bytes)})` : "";
  return `Closed ${count(recent.length, "idle agent")} of done cards${size}.`;
}

/// The label of the banner's manual close, or null when there is nothing
/// it could close -- a button that opens a dialog saying "nothing to do"
/// is a button that should not have been there.
export function reclaimNowLabel(candidates: ReclaimCandidate[]): string | null {
  if (candidates.length === 0) return null;
  return `Close ${count(candidates.length, "agent")} of done cards`;
}

/// The confirmation behind that button, in confirmClose.ts's voice: the
/// question, then what it costs and what stays. Every candidate is
/// named, because a close picked by status is the one close where the
/// human cannot see the target set -- the tabs are spread over pages
/// that may not be on screen.
export function reclaimNowPrompt(
  candidates: ReclaimCandidate[]
): ConfirmOptions & { lines: string[] } {
  const n = candidates.length;
  const bytes = bytesOf(candidates);
  const lines = [
    `Ends ${count(n, "terminal session")}${bytes > 0 ? `, freeing about ${formatGb(bytes)}` : ""}.`,
    ...candidates.map((c) => `${c.label} — ${c.cardTitle}`),
    "Idle means the agent is neither working nor waiting on you, and its card is already done.",
    'Each card keeps its binding, so "Re-launch agent" can bring one back.',
  ];
  return {
    title: `Close ${count(n, "idle agent")} of done cards?`,
    lines,
    confirmLabel: `Close ${count(n, "session")}`,
    danger: true,
  };
}
