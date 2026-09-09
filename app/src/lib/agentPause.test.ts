import { describe, expect, it } from "vitest";
import type { AgentUsageReport } from "$lib/agentUsage";
import {
  DEFAULT_CYCLE,
  MIN_PERIOD_MINUTES,
  type PauseCycle,
  cyclePhase,
  maxPauseMinutes,
  pauseBlockedReason,
  pauseLabel,
  pauseVerdict,
  validateCycle,
} from "$lib/agentPause";

const MIN = 60_000;
const ANCHOR = 1_700_000_000_000;

function cycle(over: Partial<PauseCycle> = {}): PauseCycle {
  return { ...DEFAULT_CYCLE, enabled: true, anchorMs: ANCHOR, ...over };
}

const NO_USAGE: AgentUsageReport = { state: "unsupported" };

function atLimit(usedPercent: number, resetsAt: number | null): AgentUsageReport {
  return {
    state: "ready",
    windows: [{ id: "seven_day", label: "Weekly", usedPercent, resetsAt }],
    plan: null,
    observedAt: Math.floor(ANCHOR / 1000),
    cached: false,
  };
}

describe("validateCycle", () => {
  it("accepts the default", () => {
    expect(validateCycle(DEFAULT_CYCLE)).toBeNull();
  });

  it("refuses a period so short the pause is always on screen", () => {
    expect(validateCycle({ periodMinutes: MIN_PERIOD_MINUTES - 1, pauseMinutes: 1 })).toMatch(
      /at least 15 minutes/
    );
  });

  /// A cycle that pauses more than it runs is a stop switch wearing a
  /// schedule, and somebody would have to notice that themselves.
  it("refuses a pause longer than half the period", () => {
    expect(maxPauseMinutes(300)).toBe(150);
    expect(validateCycle({ periodMinutes: 300, pauseMinutes: 150 })).toBeNull();
    expect(validateCycle({ periodMinutes: 300, pauseMinutes: 151 })).toMatch(/less time working/);
  });

  it("refuses a pause of nothing", () => {
    expect(validateCycle({ periodMinutes: 300, pauseMinutes: 0 })).toMatch(/at least a minute/);
  });
});

describe("cyclePhase", () => {
  const c = cycle({ periodMinutes: 300, pauseMinutes: 10 });

  it("runs through the head of the period and pauses in its tail", () => {
    expect(cyclePhase(c, ANCHOR).paused).toBe(false);
    expect(cyclePhase(c, ANCHOR + 289 * MIN).paused).toBe(false);
    expect(cyclePhase(c, ANCHOR + 290 * MIN).paused).toBe(true);
    expect(cyclePhase(c, ANCHOR + 299 * MIN).paused).toBe(true);
    expect(cyclePhase(c, ANCHOR + 300 * MIN).paused).toBe(false);
  });

  it("reports when the current phase ends, absolutely", () => {
    expect(cyclePhase(c, ANCHOR).changesAt).toBe(ANCHOR + 290 * MIN);
    expect(cyclePhase(c, ANCHOR + 295 * MIN).changesAt).toBe(ANCHOR + 300 * MIN);
  });

  /// The point of the whole module. A machine that slept for two days
  /// wakes into whichever phase the wall clock says, having run no timer
  /// at all -- there is nothing to catch up and nothing to replay.
  it("lands in the right phase after a long sleep", () => {
    // Ten whole periods later the phase must repeat exactly, because
    // nothing accumulated across them -- there was no timer to drift.
    const tenPeriods = 10 * 300 * MIN;
    expect(cyclePhase(c, ANCHOR + tenPeriods).paused).toBe(false);
    expect(cyclePhase(c, ANCHOR + tenPeriods + 295 * MIN).paused).toBe(true);
    expect(cyclePhase(c, ANCHOR + tenPeriods + 295 * MIN).changesAt).toBe(
      ANCHOR + tenPeriods + 300 * MIN
    );
    // And a wake that lands mid-pause after an unaligned sleep is paused
    // on the wall clock's say-so, having run nothing while asleep.
    const twoDays = 2 * 24 * 60 * MIN; // 2880m = 9 periods + 180m
    expect(cyclePhase(c, ANCHOR + twoDays).paused).toBe(false);
    expect(cyclePhase(c, ANCHOR + twoDays + 115 * MIN).paused).toBe(true);
  });

  /// Same anchor, same answer, no matter how many times the app restarted
  /// in between -- which is what makes the anchor worth persisting.
  it("is a pure function of the anchor and the clock", () => {
    const later = ANCHOR + 12345 * MIN;
    expect(cyclePhase(c, later)).toEqual(cyclePhase({ ...c }, later));
  });

  /// The clock CAN move backwards -- a DST boundary, a manual correction
  /// -- and a single modulo would return a negative remainder that reads
  /// as deep inside the pause.
  it("survives a clock that moved behind the anchor", () => {
    const before = ANCHOR - 5 * MIN;
    expect(cyclePhase(c, before).paused).toBe(true);
    expect(cyclePhase(c, ANCHOR - 295 * MIN).paused).toBe(false);
  });

  it("never pauses while the cycle is off", () => {
    const off = cycle({ enabled: false });
    expect(cyclePhase(off, ANCHOR + 295 * MIN).paused).toBe(false);
    expect(cyclePhase(off, ANCHOR + 295 * MIN).changesAt).toBe(Number.POSITIVE_INFINITY);
  });

  /// A stored cycle can be nonsense if somebody hand-edits config.json,
  /// and a pause that fills its period would stop the workspace forever.
  it("refuses to pause on an impossible cycle", () => {
    expect(cyclePhase(cycle({ periodMinutes: 10, pauseMinutes: 10 }), ANCHOR + MIN).paused).toBe(
      false
    );
    expect(cyclePhase(cycle({ pauseMinutes: 0 }), ANCHOR + 299 * MIN).paused).toBe(false);
  });
});

describe("pauseVerdict", () => {
  it("runs when neither reason applies", () => {
    const v = pauseVerdict(cycle(), NO_USAGE, ANCHOR);
    expect(v.paused).toBe(false);
    expect(v.why).toBeNull();
    expect(pauseLabel(v)).toBeNull();
    expect(pauseBlockedReason(v)).toBeNull();
  });

  it("holds on the cycle, with the time left in the sentence", () => {
    const v = pauseVerdict(cycle(), NO_USAGE, ANCHOR + 294 * MIN);
    expect(v.paused).toBe(true);
    expect(v.reason?.kind).toBe("cycle");
    expect(v.why).toBe("the scheduled pause has 6m left");
    expect(v.until).toBe(ANCHOR + 300 * MIN);
    expect(pauseLabel(v)).toBe("Paused");
    expect(pauseBlockedReason(v)).toBe("work is paused: the scheduled pause has 6m left");
  });

  it("holds on a limit, with its reset in the sentence", () => {
    const resetsAt = Math.floor(ANCHOR / 1000) + 2 * 3600;
    const v = pauseVerdict(cycle(), atLimit(97, resetsAt), ANCHOR);
    expect(v.paused).toBe(true);
    expect(v.reason?.kind).toBe("usage-limit");
    expect(v.why).toBe("the Weekly limit is 97% used, and it resets in 2h");
    expect(v.until).toBe(resetsAt * 1000);
    expect(pauseLabel(v)).toBe("At limit");
  });

  /// A limit with no reset instant is a hold with no clock, and the
  /// sentence has to say so rather than imply a countdown.
  it("says so when a limit gave no reset", () => {
    const v = pauseVerdict(cycle(), atLimit(99, null), ANCHOR);
    expect(v.why).toBe("the Weekly limit is 99% used, and it has not said when that clears");
    expect(v.until).toBeNull();
  });

  /// Told both, the precise reason wins: its clock is real, and "you are
  /// 97% through your weekly window" is the thing worth reading.
  it("prefers the limit's reason over the cycle's", () => {
    const resetsAt = Math.floor(ANCHOR / 1000) + 3600;
    const v = pauseVerdict(cycle(), atLimit(97, resetsAt), ANCHOR + 294 * MIN);
    expect(v.reason?.kind).toBe("usage-limit");
  });

  it("ignores limits below the threshold", () => {
    const v = pauseVerdict(cycle({ limitPercent: 95 }), atLimit(94, null), ANCHOR);
    expect(v.paused).toBe(false);
  });

  /// The two gates are independent: somebody may want the precise one
  /// without the blunt one, or the reverse for an agent with no probe.
  it("honours each gate's own switch", () => {
    const resetsAt = Math.floor(ANCHOR / 1000) + 3600;
    expect(pauseVerdict(cycle({ limitEnabled: false }), atLimit(99, resetsAt), ANCHOR).paused).toBe(
      false
    );
    const cycleOff = cycle({ enabled: false });
    expect(pauseVerdict(cycleOff, atLimit(99, resetsAt), ANCHOR).paused).toBe(true);
    expect(pauseVerdict(cycleOff, NO_USAGE, ANCHOR + 294 * MIN).paused).toBe(false);
  });

  /// Gavin not knowing is not evidence of a limit; a failed probe that
  /// paused a workspace would turn a network blip into a stoppage.
  it("never holds because a probe failed", () => {
    const broken: AgentUsageReport = { state: "unavailable", reason: "offline", retryAfter: null };
    expect(pauseVerdict(cycle({ limitPercent: 1 }), broken, ANCHOR).paused).toBe(false);
  });
});
