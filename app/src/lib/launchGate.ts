// The one gate every agent start passes through, and the one sentence it
// speaks when it refuses.
//
// Two guards, not one, and they answer different questions. The CEILING
// counts turns in flight: an agent that is working or asking is an agent
// whose process tree is growing, and four of those is what a 32 GB
// machine carries. The PRESSURE hold watches the machine itself, because
// the ceiling cannot see an agent that has gone idle holding six
// gigabytes -- eleven idle-but-fat sessions thrash exactly as hard as
// eleven busy ones.
//
// Neither ever stops anything in flight. A hold gates STARTS, the same
// posture the token pause already takes: gavin does not kill an agent
// mid-turn, does not suspend one, and does not decide that work already
// in flight was a mistake. The queue in `launchQueue.ts` is what makes
// that bearable -- a refused launch is not lost, it waits. The ONE thing
// the wall may end is an idle agent whose card is already done, and only
// while memory is short: `doneSessionReclaim.ts` owns that rule, and
// `reclaimDoneSessions` below is its switch.
//
// Pure and unit-tested. The whole value of this module is that the rule
// is one function with the machine's state as arguments: every surface
// (a card menu, a rail's scheduler, a confirm dialog, the settings
// panel) asks it the same way and gets the same sentence back.

import type { MemoryPressure } from "$lib/memory";
import { formatGbPair } from "$lib/memory";

/// The app-wide launch wall, as `config.json` stores it.
///
/// `maxInFlight: null` is a real answer -- no ceiling at all -- and not
/// the same as the shipped default. Zero is not expressible: a ceiling
/// of zero holds every launch for ever, which is not a setting.
export interface LaunchConfig {
  maxInFlight: number | null;
  holdOnPressure: boolean;
  /// Whether gavin may close an IDLE agent whose card is already in the
  /// done column when memory runs short -- the one exception to "nothing
  /// running is stopped". Its own switch rather than a mode of
  /// `holdOnPressure`, because holding a start costs nothing and closing
  /// a finished agent costs its transcript.
  reclaimDoneSessions: boolean;
}

/// Four agents, the pressure hold on, and finished cards' idle agents
/// reclaimable. Mirrors `LaunchConfig::default()` in `config.rs`;
/// shipped ON, unlike the pause cycle, because this is the guard that
/// stands between eleven rails and a watchdog reset.
export const DEFAULT_LAUNCH: LaunchConfig = {
  maxInFlight: 4,
  holdOnPressure: true,
  reclaimDoneSessions: true,
};

/// Why a launch is being held. `null` on an allowed verdict.
///
/// Two reasons rather than one string because they resolve differently:
/// a slot frees when an agent goes idle, and pressure clears when the
/// machine does. A surface that lumped them would have to say "try
/// again later" where it can say which of the two to wait for.
export type HoldReason = "ceiling" | "pressure";

export interface LaunchVerdict {
  allowed: boolean;
  reason: HoldReason | null;
  /// ONE sentence, ready to put in a badge tooltip, a queue row or an
  /// audit line. Null when the launch is allowed.
  why: string | null;
}

const ALLOWED: LaunchVerdict = { allowed: true, reason: null, why: null };

/// Everything the gate reads. Passed in rather than fetched so the rule
/// is testable and so two surfaces asking in the same tick cannot get
/// two different answers.
export interface GateInput {
  config: LaunchConfig;
  /// Agent sessions whose status is `working` or `waiting_for_input`,
  /// app-wide across every workspace and every window.
  inFlight: number;
  pressure: MemoryPressure;
  /// Bytes in use and bytes the machine has, or null when nothing was
  /// measured. Only ever used to phrase the sentence -- the HOLD comes
  /// from `pressure`, which is the kernel's own judgement.
  usedBytes: number | null;
  totalBytes: number | null;
  /// Epoch milliseconds. The hysteresis below is a function of it.
  nowMs: number;
  /// When pressure was last seen at something other than normal, epoch
  /// milliseconds, or null if it has never been. See `HYSTERESIS_MS`.
  pressureSinceMs: number | null;
}

/// How long pressure must read normal before held starts resume.
///
/// Thirty seconds, and it is not politeness. An agent's process tree
/// takes tens of seconds to reach its real size -- the CLI starts, then
/// its MCP servers, then whatever build it kicks off -- so the instant
/// pressure drops is exactly when the machine has the LEAST idea what it
/// has just committed to. Releasing there is how a queue of eleven
/// empties itself into the same crash it was built to prevent.
export const HYSTERESIS_MS = 30_000;

/// Whether the ceiling counts this session's status.
///
/// `working` and `waiting_for_input` (the app's word for "asking"), and
/// nothing else. An idle agent has finished its turn and frees its slot
/// even though its process is still there -- holding its slot would make
/// the ceiling a cap on open TABS, and the memory an idle agent is still
/// holding is the pressure guard's job, not this one's.
export function countsInFlight(status: string | null | undefined): boolean {
  return status === "working" || status === "waiting_for_input";
}

/// How full the machine is, as one clause: "28 of 32 GB in use". Null
/// when nothing was measured, and the sentence then simply omits it
/// rather than printing a zero nobody measured.
function usageClause(usedBytes: number | null, totalBytes: number | null): string | null {
  if (usedBytes === null || totalBytes === null || totalBytes <= 0) return null;
  return `${formatGbPair(usedBytes, totalBytes)} in use`;
}

/// May a launch happen right now?
///
/// The ceiling is checked first because it is the cheaper answer and the
/// commoner one: a full ceiling on a quiet machine is the ordinary
/// working state of a fleet, and reporting it as memory pressure would
/// send somebody looking for a problem that is not there.
export function launchVerdict(input: GateInput): LaunchVerdict {
  const { config, inFlight, pressure, nowMs, pressureSinceMs } = input;

  const ceiling = config.maxInFlight;
  if (ceiling !== null && ceiling > 0 && inFlight >= ceiling) {
    return {
      allowed: false,
      reason: "ceiling",
      why: `Waiting for a slot: ${inFlight} of ${ceiling} agents running`,
    };
  }

  if (config.holdOnPressure) {
    const usage = usageClause(input.usedBytes, input.totalBytes);
    if (pressure !== "normal") {
      const head = pressure === "critical" ? "Held: memory is critical" : "Held: memory pressure";
      return { allowed: false, reason: "pressure", why: usage ? `${head}, ${usage}` : head };
    }
    // Normal, but not for long enough yet. The queue must not empty into
    // the machine the moment the kernel stops complaining.
    if (pressureSinceMs !== null && nowMs - pressureSinceMs < HYSTERESIS_MS) {
      const seconds = Math.max(1, Math.ceil((HYSTERESIS_MS - (nowMs - pressureSinceMs)) / 1000));
      return {
        allowed: false,
        reason: "pressure",
        why: `Held: memory just recovered, resuming in ${seconds}s`,
      };
    }
  }

  return ALLOWED;
}

/// The gate's answer as a blocked-reason string, matching the shape
/// `pauseBlockedReason` already returns: null while work may start.
export function gateBlockedReason(verdict: LaunchVerdict): string | null {
  return verdict.allowed ? null : verdict.why;
}

/// The shortest thing a badge can say. The full sentence goes in the
/// tooltip; this is what fits beside a card title.
export function holdLabel(reason: HoldReason): string {
  return reason === "ceiling" ? "Queued" : "Held";
}

/// The badge's second half: "Queued · waiting for a slot", "Held ·
/// memory pressure". One vocabulary, so the board card, the modal, the
/// rail header and the step chip cannot describe the same hold three
/// ways.
export function holdDetail(reason: HoldReason): string {
  return reason === "ceiling" ? "waiting for a slot" : "memory pressure";
}

// ---- Draining ----------------------------------------------------------------
//
// The queue drains ONE launch at a time and paces itself, and both halves
// matter. One at a time because a burst released together is a burst: the
// gate would wave all of them through against a sample none of them are
// in yet. Paced because a process tree does not appear in the sample the
// instant `createSession` returns -- the agent has to start, and its MCP
// servers after it.

/// The floor on the gap between two drained launches.
///
/// Twenty seconds, which is the other half of the same measurement
/// `HYSTERESIS_MS` rests on: it is roughly how long an agent takes to
/// reach its full tree size. A drain faster than that is a drain running
/// blind.
export const DRAIN_SPACING_MS = 20_000;

export interface DrainInput {
  verdict: LaunchVerdict;
  /// When the last queued launch was released, epoch milliseconds, or
  /// null if none has been.
  lastLaunchMs: number | null;
  nowMs: number;
  /// Whether a session started since `lastLaunchMs` has actually turned
  /// up in the memory sample. The spacing is a FLOOR that this can lift
  /// early: once the tree is measured there is nothing left to wait for,
  /// and holding a queue for the rest of twenty seconds against a fact
  /// already in hand is delay for its own sake.
  lastLaunchObserved: boolean;
}

/// Whether the queue may release its next intent.
///
/// Both conditions, in this order: the gate must say yes, and the
/// previous release must have settled. A caller that checked only the
/// gate would drain the whole queue in one tick, because none of the
/// launches it released are in the sample yet.
export function mayDrain(input: DrainInput): boolean {
  if (!input.verdict.allowed) return false;
  if (input.lastLaunchMs === null) return true;
  if (input.lastLaunchObserved) return true;
  return input.nowMs - input.lastLaunchMs >= DRAIN_SPACING_MS;
}
