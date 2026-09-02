// When gavin may not START agent work, and why.
//
// Two independent reasons land here and are deliberately answered by one
// function, because every surface that has to explain a hold -- the rail,
// the card menu, the usage panel, auto-resume -- needs the SAME sentence
// and the same clock:
//
//  - **The cycle.** A duty cycle the human configured: sit out X minutes
//    of every Y hours, whether or not any agent is near a limit. This is
//    the only lever that works for Gemini, Cursor and opencode, which
//    publish no limits at all.
//  - **The limits.** A probe said a window is at or over the threshold.
//    Precise where it is available, and available for two profiles.
//
// A pause **never touches work already running** (the human's decision,
// 2026-09-02). It gates starts: rails do not launch the next step, card
// runs do not begin, auto-resume holds. An agent mid-turn finishes.
//
// ## Why every instant here is absolute
//
// The card asks for this to survive "hardware sleep, reset, restart", and
// the only way to get all three is to store WHEN, never HOW LONG LEFT.
// An interval timer is wrong the moment the lid closes: the machine wakes
// owing a countdown it never ran. A phase computed from a fixed anchor
// and the wall clock is right on wake, right after a daemon restart,
// right after a frontend reload, and right when the app was closed for a
// day -- because none of them are inputs. The only input is `now`.

import type { AgentUsageReport, UsageWindow } from "./agentUsage";
import { formatDuration, formatResetsIn, usageBlock } from "./agentUsage";

/// A configured duty cycle. Mirrors `AgentPauseConfig` in `config.rs`.
export interface PauseCycle {
  enabled: boolean;
  /// The full repeat, in minutes. `pauseMinutes` of it are the pause.
  periodMinutes: number;
  pauseMinutes: number;
  /// Epoch ms the phase is measured from. Fixed WHEN THE CYCLE IS TURNED
  /// ON and never rewritten afterwards -- re-anchoring on load would move
  /// the pause every time the app started, and re-anchoring on wake would
  /// mean a laptop that sleeps often never pauses at all.
  anchorMs: number;
  /// The percentage at which a probe's window blocks starts. Separate
  /// from `agentUsage`'s display bands on purpose: recolouring every bar
  /// because somebody moved their pause threshold is a bug, not a
  /// feature.
  limitPercent: number;
  /// Whether a probe's limits may pause at all. The cycle and the limit
  /// gate are independent -- somebody may want the precise one and not
  /// the blunt one, or the reverse for an agent with no probe.
  limitEnabled: boolean;
}

/// The default cycle offered when somebody first turns it on: sit out the
/// last ten minutes of every five hours.
///
/// Five hours because that is the window Claude Code and Codex both meter
/// against, so the pause lands at the end of a window rather than
/// straddling two. Ten minutes because the point is to stop a rail
/// spending the tail of a window on work the human is not watching, not
/// to slow the day down.
export const DEFAULT_CYCLE: Omit<PauseCycle, "anchorMs"> = {
  enabled: false,
  periodMinutes: 300,
  pauseMinutes: 10,
  limitPercent: 95,
  limitEnabled: true,
};

/// The smallest period worth having. Below this the pause is on screen
/// more than it is off, and a cycle that pauses every few minutes is
/// indistinguishable from gavin being broken.
export const MIN_PERIOD_MINUTES = 15;

/// A pause must leave more time working than paused, or the cycle is a
/// stop switch wearing a schedule. Half the period is the ceiling.
export function maxPauseMinutes(periodMinutes: number): number {
  return Math.max(1, Math.floor(periodMinutes / 2));
}

/// Returns a message when the cycle is unusable, or null. The panel shows
/// it beside the fields; nothing is saved while it is non-null.
export function validateCycle(cycle: Pick<PauseCycle, "periodMinutes" | "pauseMinutes">): string | null {
  if (!Number.isFinite(cycle.periodMinutes) || cycle.periodMinutes < MIN_PERIOD_MINUTES) {
    return `The period has to be at least ${MIN_PERIOD_MINUTES} minutes.`;
  }
  if (!Number.isFinite(cycle.pauseMinutes) || cycle.pauseMinutes < 1) {
    return "The pause has to be at least a minute.";
  }
  if (cycle.pauseMinutes > maxPauseMinutes(cycle.periodMinutes)) {
    return `A pause longer than ${maxPauseMinutes(cycle.periodMinutes)} minutes would leave less time working than paused.`;
  }
  return null;
}

// ---- The cycle's phase ------------------------------------------------------

export interface CyclePhase {
  paused: boolean;
  /// When the CURRENT phase ends -- when the pause lifts, or when the
  /// next one begins. Absolute epoch ms, so a caller may hold it across a
  /// sleep and still be right.
  changesAt: number;
}

/// Where the wall clock sits in the cycle right now.
///
/// The pause is the TAIL of each period, not the head, because the period
/// is meant to line up with a provider's usage window: sitting out the
/// last ten minutes of a five-hour window leaves the window's own reset
/// to end the pause. Putting the pause at the head would spend the fresh
/// window waiting.
export function cyclePhase(cycle: PauseCycle, nowMs: number): CyclePhase {
  const period = cycle.periodMinutes * 60_000;
  const pause = cycle.pauseMinutes * 60_000;
  if (!cycle.enabled || period <= 0 || pause <= 0 || pause >= period) {
    return { paused: false, changesAt: Number.POSITIVE_INFINITY };
  }
  // A double modulo, because the anchor CAN be in the future: the clock
  // moves backwards over a DST boundary and after a manual correction,
  // and a negative remainder would read as deep inside the pause.
  const into = (((nowMs - cycle.anchorMs) % period) + period) % period;
  const workFor = period - pause;
  const periodStart = nowMs - into;
  return into < workFor
    ? { paused: false, changesAt: periodStart + workFor }
    : { paused: true, changesAt: periodStart + period };
}

// ---- The verdict ------------------------------------------------------------

/// Why work is held, or null when it is not.
///
/// `until` is null only for a limit with no reset instant -- a hold with
/// no clock, which every surface must render as "until the limit clears"
/// rather than as a countdown it cannot compute.
export type PauseReason =
  | { kind: "cycle"; until: number }
  | { kind: "usage-limit"; window: UsageWindow; until: number | null };

export interface PauseVerdict {
  paused: boolean;
  reason: PauseReason | null;
  /// The sentence every surface prints. One string so the rail, the card
  /// menu and the panel cannot drift into three different explanations of
  /// the same hold.
  why: string | null;
  /// When this verdict could change, absolute epoch ms, or null when
  /// nothing here knows. A caller may sleep until then -- but must
  /// recompute rather than trust it, since a fresh probe can move it.
  until: number | null;
}

const RUNNING: PauseVerdict = { paused: false, reason: null, why: null, until: null };

/// The whole gate. Limits are checked BEFORE the cycle so the more
/// precise reason wins the sentence: told both "you are 97% through your
/// weekly window" and "the cycle pauses for ten minutes", the first is
/// the one worth reading, and it is the one whose clock is real.
export function pauseVerdict(
  cycle: PauseCycle,
  usage: AgentUsageReport,
  nowMs: number
): PauseVerdict {
  if (cycle.limitEnabled) {
    const block = usageBlock(usage, cycle.limitPercent);
    if (block.blocked && block.window) {
      const until = block.until == null ? null : block.until * 1000;
      const clock = formatResetsIn(block.until, nowMs);
      const tail = clock ? `, and it ${clock}` : ", and it has not said when that clears";
      return {
        paused: true,
        reason: { kind: "usage-limit", window: block.window, until },
        why: `the ${block.window.label} limit is ${Math.floor(block.window.usedPercent)}% used${tail}`,
        until,
      };
    }
  }

  const phase = cyclePhase(cycle, nowMs);
  if (phase.paused) {
    return {
      paused: true,
      reason: { kind: "cycle", until: phase.changesAt },
      why: `the scheduled pause has ${formatDuration((phase.changesAt - nowMs) / 1000)} left`,
      until: phase.changesAt,
    };
  }
  return RUNNING;
}

/// One line for a surface that has room for the state but not the reason
/// -- a sidebar strip, a tab badge. Null while nothing is held.
export function pauseLabel(verdict: PauseVerdict): string | null {
  if (!verdict.paused || !verdict.reason) return null;
  return verdict.reason.kind === "cycle" ? "Paused" : "At limit";
}

/// What to hand `autoResumeDecision`'s `blocked`, which reports it
/// verbatim in the audit trail. Prefixed so a trail line reads as a
/// sentence: "gavin already resumed this run once" sits beside "work is
/// paused: the scheduled pause has 4m left".
export function pauseBlockedReason(verdict: PauseVerdict): string | null {
  return verdict.paused && verdict.why ? `work is paused: ${verdict.why}` : null;
}
