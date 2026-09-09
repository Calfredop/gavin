// What a "Run all" is about to cost, in one line, before it happens.
//
// The line exists because eleven rails looked exactly like two on the
// way in. Every confirm in the app names WHO is about to run
// (railConfirm, columnRunAction) and none of them named what it would
// take, so the one number that would have stopped the crash -- eleven
// times a gigabyte and a half, on a machine with fourteen free -- was
// the one number nobody could see.
//
// Two rules shape the arithmetic.
//
// **Never optimistic.** The per-agent figure is the measured mean of the
// running agents of that profile, and never below `MIN_AGENT_RSS_BYTES`.
// An estimate that came out low is the estimate that waves the burst
// through, so every fallback in `perAgentEstimate` steps UP.
//
// **Never invented.** A machine nothing has measured gets a line about
// the agents and no line about the memory, rather than a projection
// against a total of zero. "11 agents ≈ 17 GB" is useful on its own;
// "11 agents ≈ 17 GB on top of 0 GB in use, 0 GB total" is a lie with
// arithmetic in it.

import { formatGb, formatGbPair, perAgentEstimate, type SystemMemorySample } from "$lib/memory";
import { usedBytes as usedBytesOf } from "$lib/memory";

export interface EstimateInput {
  /// How many agents this press would start.
  count: number;
  /// The profile they will run on, for the per-agent figure. Null falls
  /// back to the floor, which is what an unrooted workspace or a profile
  /// nothing has measured deserves.
  profileId: string | null;
  /// Mean tree RSS per profile in the CURRENT sample (memoryState's
  /// `fleetMemory.meanByProfile`).
  means: Record<string, number>;
  /// The last means seen, across reloads (memoryState's `storedMeans`).
  storedMeans: Record<string, number>;
  /// How many agents that mean was taken from, so the line can say where
  /// its figure came from.
  measuredAgents: number;
  /// The machine, or null when nothing was measured.
  sample: SystemMemorySample | null;
  /// The ceiling in force, or null for none.
  maxInFlight: number | null;
  /// Agents already working or asking, app-wide.
  inFlight: number;
}

export interface LaunchEstimate {
  /// The whole sentence, or null when there is nothing to say (a press
  /// that starts nothing).
  line: string | null;
  /// A second line, warning-toned, when the projection does not fit in
  /// what is free. Null when it does, or when nothing was measured.
  warning: string | null;
  /// How many of them start now, and how many go into the queue. Shown
  /// in the line, and the reason the confirm is honest about a ceiling
  /// the human may have forgotten they set.
  startsNow: number;
  queues: number;
  /// Bytes the whole press is projected to add.
  projectedBytes: number;
}

const EMPTY: LaunchEstimate = {
  line: null,
  warning: null,
  startsNow: 0,
  queues: 0,
  projectedBytes: 0,
};

/// How many of `count` launches the ceiling lets start immediately.
///
/// A blank ceiling starts all of them; a full one starts none. The
/// arithmetic is deliberately the gate's own -- slots are `ceiling -
/// inFlight`, floored at zero -- so the number in the confirm is the
/// number the queue will actually produce.
export function slotsNow(count: number, maxInFlight: number | null, inFlight: number): number {
  if (maxInFlight === null || maxInFlight <= 0) return count;
  return Math.max(0, Math.min(count, maxInFlight - inFlight));
}

/// Where the per-agent figure came from, as a clause: "1.5 GB each, from
/// the 3 running now". Null when nothing is running, because "from the 0
/// running now" is not provenance, it is noise.
function provenance(perAgent: number, measuredAgents: number): string {
  const each = `${formatGb(perAgent)} each`;
  if (measuredAgents <= 0) return each;
  return `${each}, from the ${measuredAgents} running now`;
}

/// The estimate line for a press that would start `count` agents.
export function launchEstimate(input: EstimateInput): LaunchEstimate {
  const { count, sample, maxInFlight, inFlight } = input;
  if (count <= 0) return EMPTY;

  const perAgent = perAgentEstimate(input.profileId, input.means, input.storedMeans);
  const projectedBytes = perAgent * count;
  const startsNow = slotsNow(count, maxInFlight, inFlight);
  const queues = count - startsNow;

  const agents = `${count} ${count === 1 ? "agent" : "agents"} ≈ ${formatGb(projectedBytes)} (${provenance(perAgent, input.measuredAgents)})`;

  const used = usedBytesOf(sample);
  const total = sample?.supported ? sample.totalBytes : null;
  // No measurement, no projection. An unmeasured machine gets the half
  // of the sentence that is still true rather than arithmetic against a
  // total of zero.
  const machine =
    used !== null && total !== null ? ` on top of ${formatGbPair(used, total)}` : "";

  const queueClause =
    queues > 0
      ? ` ${startsNow} ${startsNow === 1 ? "starts" : "start"} now, ${queues} ${queues === 1 ? "queues" : "queue"}.`
      : "";

  const line = `${agents}${machine}.${queueClause}`;

  // The warning is about what is FREE, not about what is used: a machine
  // with 26 of 32 GB in use has six, and eleven agents do not fit in six
  // however comfortable 32 sounds.
  let warning: string | null = null;
  if (used !== null && total !== null) {
    const free = Math.max(0, total - used);
    // Measured against what will actually start, not against the whole
    // press: the queue is the answer to the rest, and warning about
    // memory the queue is going to wait for would be warning about the
    // feature working.
    if (perAgent * startsNow > free) {
      warning = `That is more than the ${formatGb(free)} free — the queue will hold the rest until memory frees.`;
    }
  }

  return { line, warning, startsNow, queues, projectedBytes };
}

/// The estimate as the lines a confirm dialog appends. Empty when there
/// is nothing to say, so a caller can spread it unconditionally.
export function estimateLines(estimate: LaunchEstimate): string[] {
  const lines: string[] = [];
  if (estimate.line) lines.push(estimate.line);
  if (estimate.warning) lines.push(estimate.warning);
  return lines;
}
