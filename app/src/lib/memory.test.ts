import { describe, expect, it } from "vitest";
import {
  MIN_AGENT_RSS_BYTES,
  fleetMemory,
  fleetStrip,
  pressureBannerLine,
  formatGb,
  formatGbPair,
  freeBytes,
  meanRssByProfile,
  perAgentEstimate,
  pressureFromLevel,
  pressureOf,
  rootsFromWatchList,
  usedBytes,
  type SystemMemorySample,
} from "$lib/memory";

const GB = 1024 ** 3;

function sample(over: Partial<SystemMemorySample> = {}): SystemMemorySample {
  return {
    supported: true,
    totalBytes: 32 * GB,
    freePercent: 50,
    pressureLevel: 1,
    swapUsedBytes: 0,
    sampledAtMs: 1_700_000_000_000,
    ...over,
  };
}

describe("pressureFromLevel", () => {
  it("reads the kernel's three documented levels", () => {
    expect(pressureFromLevel(1)).toBe("normal");
    expect(pressureFromLevel(2)).toBe("warn");
    expect(pressureFromLevel(4)).toBe("critical");
  });

  // The direction that matters: a failed sysctl writes 0, and a 0 that
  // read as "critical" would hold every launch on a machine with
  // nothing wrong with it.
  it("reads an unanswered sysctl as normal, never as pressure", () => {
    expect(pressureFromLevel(0)).toBe("normal");
    expect(pressureFromLevel(3)).toBe("normal");
    expect(pressureFromLevel(-1)).toBe("normal");
  });
});

describe("pressureOf", () => {
  it("takes the level from a supported sample", () => {
    expect(pressureOf(sample({ pressureLevel: 4 }))).toBe("critical");
  });

  // An unsupported host must behave exactly as gavin did before the
  // probe existed.
  it("is normal for an unsupported host and for no sample at all", () => {
    expect(pressureOf(sample({ supported: false, pressureLevel: 4 }))).toBe("normal");
    expect(pressureOf(null)).toBe("normal");
  });
});

describe("usedBytes / freeBytes", () => {
  it("turns the kernel's free percentage into bytes", () => {
    expect(usedBytes(sample({ freePercent: 25 }))).toBe(24 * GB);
    expect(freeBytes(sample({ freePercent: 25 }))).toBe(8 * GB);
  });

  // Null, not zero: an unmeasured machine and a full one must not look
  // alike to a caller that is deciding whether to start work.
  it("says nothing when nothing was measured", () => {
    expect(usedBytes(null)).toBeNull();
    expect(usedBytes(sample({ supported: false }))).toBeNull();
    expect(usedBytes(sample({ totalBytes: 0 }))).toBeNull();
    expect(freeBytes(sample({ supported: false }))).toBeNull();
  });

  it("clamps a percentage outside 0-100 rather than inventing negative memory", () => {
    expect(usedBytes(sample({ freePercent: 140 }))).toBe(0);
    expect(usedBytes(sample({ freePercent: -5 }))).toBe(32 * GB);
  });
});

describe("formatGb", () => {
  it("drops the decimal above ten gigabytes", () => {
    expect(formatGb(32 * GB)).toBe("32 GB");
    expect(formatGb(26.4 * GB)).toBe("26 GB");
  });

  // The floor itself is 1.5 GB, so a format that rounded it to "2 GB"
  // would misstate the one number the estimate is built on.
  it("keeps one decimal below ten, so the 1.5 GB floor reads as itself", () => {
    expect(formatGb(MIN_AGENT_RSS_BYTES)).toBe("1.5 GB");
    expect(formatGb(4 * GB)).toBe("4 GB");
    expect(formatGb(0.6 * GB)).toBe("0.6 GB");
  });

  it("refuses to overstate a figure under a tenth of a gigabyte", () => {
    expect(formatGb(0)).toBe("<0.1 GB");
    expect(formatGb(1024 * 1024)).toBe("<0.1 GB");
  });
});

describe("formatGbPair", () => {
  // One "GB", not two: the gate puts a used figure beside a total in the
  // same breath, and repeating the unit reads as two measurements rather
  // than one ratio.
  it("gives two sizes one shared unit", () => {
    expect(formatGbPair(28 * GB, 32 * GB)).toBe("28 of 32 GB");
    expect(formatGbPair(1.5 * GB, 32 * GB)).toBe("1.5 of 32 GB");
  });
});

describe("rootsFromWatchList", () => {
  it("reads the roots out of watch-list's answer", () => {
    const json = '{"version":"2024.01.01.00","roots":["/Users/x/repo","/Users/x/repo-wt"]}';
    expect(rootsFromWatchList(json)).toEqual(["/Users/x/repo", "/Users/x/repo-wt"]);
  });

  // Every one of these is a real state: no CLI on the machine, a
  // truncated pipe, an error object, a server holding nothing. None of
  // them is worth taking a five-second poll down for.
  it("answers with no roots for anything that is not a root list", () => {
    expect(rootsFromWatchList("")).toEqual([]);
    expect(rootsFromWatchList("   ")).toEqual([]);
    expect(rootsFromWatchList("{not json")).toEqual([]);
    expect(rootsFromWatchList('{"error":"unable to talk to your watchman"}')).toEqual([]);
    expect(rootsFromWatchList('{"roots":[]}')).toEqual([]);
    expect(rootsFromWatchList('{"roots":"/one"}')).toEqual([]);
  });

  it("drops entries that are not paths rather than passing them on", () => {
    expect(rootsFromWatchList('{"roots":["/a",null,3,"","/b"]}')).toEqual(["/a", "/b"]);
  });
});

describe("meanRssByProfile", () => {
  it("averages each profile's measured trees", () => {
    const means = meanRssByProfile([
      { sessionId: "a", profileId: "claude-code", rssBytes: 4 * GB, processCount: 9 },
      { sessionId: "b", profileId: "claude-code", rssBytes: 2 * GB, processCount: 4 },
      { sessionId: "c", profileId: "codex", rssBytes: 3 * GB, processCount: 5 },
    ]);
    expect(means["claude-code"]).toBe(3 * GB);
    expect(means["codex"]).toBe(3 * GB);
  });

  // The floor is the whole safety of the estimate: a fleet of quiet
  // just-launched agents must not authorise eleven more.
  it("never reports a mean under the floor", () => {
    const means = meanRssByProfile([
      { sessionId: "a", profileId: "claude-code", rssBytes: 200 * 1024 * 1024, processCount: 1 },
    ]);
    expect(means["claude-code"]).toBe(MIN_AGENT_RSS_BYTES);
  });

  // Zero is what an UNMEASURED row carries, not a free agent. Averaging
  // it in would drag the estimate down with no measurement behind it.
  it("leaves unmeasured sessions out of the mean instead of counting them as free", () => {
    const means = meanRssByProfile([
      { sessionId: "a", profileId: "claude-code", rssBytes: 6 * GB, processCount: 9 },
      { sessionId: "b", profileId: "claude-code", rssBytes: 0, processCount: 0 },
    ]);
    expect(means["claude-code"]).toBe(6 * GB);
  });

  it("ignores sessions no profile claims", () => {
    expect(
      meanRssByProfile([{ sessionId: "a", profileId: null, rssBytes: 6 * GB, processCount: 9 }])
    ).toEqual({});
  });
});

describe("perAgentEstimate", () => {
  it("prefers what the running agents of that profile measure", () => {
    expect(perAgentEstimate("claude-code", { "claude-code": 5 * GB }, { "claude-code": 2 * GB })).toBe(
      5 * GB
    );
  });

  it("falls back to the last stored mean, then to the floor", () => {
    expect(perAgentEstimate("claude-code", {}, { "claude-code": 3 * GB })).toBe(3 * GB);
    expect(perAgentEstimate("claude-code", {}, {})).toBe(MIN_AGENT_RSS_BYTES);
    expect(perAgentEstimate(null, { "claude-code": 5 * GB })).toBe(MIN_AGENT_RSS_BYTES);
  });

  // A stored mean from a machine that once ran one quiet agent must not
  // authorise a burst, so the floor applies at every step and not only
  // to the default.
  it("floors a remembered mean as well as a fresh one", () => {
    expect(perAgentEstimate("claude-code", {}, { "claude-code": 100 * 1024 * 1024 })).toBe(
      MIN_AGENT_RSS_BYTES
    );
  });
});

describe("fleetMemory", () => {
  it("sums every measured tree and counts the sessions", () => {
    const fleet = fleetMemory([
      { sessionId: "a", profileId: "claude-code", rssBytes: 4 * GB, processCount: 9 },
      { sessionId: "b", profileId: "claude-code", rssBytes: 2 * GB, processCount: 4 },
    ]);
    expect(fleet.rssBytes).toBe(6 * GB);
    expect(fleet.agents).toBe(2);
    expect(fleet.meanByProfile["claude-code"]).toBe(3 * GB);
  });

  it("is empty for a fleet with no agents", () => {
    expect(fleetMemory([])).toEqual({ rssBytes: 0, agents: 0, meanByProfile: {} });
  });
});

describe("fleetStrip", () => {
  const machine = sample({ freePercent: 18.75 });

  it("names the agents and how full the machine is", () => {
    expect(fleetStrip({ inFlight: 4, ceiling: 4, sample: machine, pressure: "normal" })).toEqual({
      text: "Agents 4/4 · 26 of 32 GB",
      tone: "neutral",
    });
  });

  it("drops the ceiling when there is none", () => {
    expect(
      fleetStrip({ inFlight: 2, ceiling: null, sample: machine, pressure: "normal" })?.text
    ).toBe("Agents 2 · 26 of 32 GB");
  });

  // A half that could not be read is left out, never printed as a zero.
  it("drops the machine when nothing was measured", () => {
    expect(fleetStrip({ inFlight: 2, ceiling: 4, sample: null, pressure: "normal" })?.text).toBe(
      "Agents 2/4"
    );
  });

  // A permanent "Agents 0/4 · 9 of 32 GB" trains the eye to skip the
  // row, and this row has to be readable on the one day it says
  // something.
  it("says nothing at all when nothing is running and nothing is wrong", () => {
    expect(fleetStrip({ inFlight: 0, ceiling: 4, sample: machine, pressure: "normal" })).toBeNull();
  });

  it("speaks up under pressure even with no agent of gavin's own running", () => {
    const strip = fleetStrip({ inFlight: 0, ceiling: 4, sample: machine, pressure: "critical" });
    expect(strip?.text).toBe("Agents 0/4 · 26 of 32 GB");
    expect(strip?.tone).toBe("danger");
  });

  it("carries the pressure as its tone", () => {
    expect(fleetStrip({ inFlight: 1, ceiling: 4, sample: machine, pressure: "warn" })?.tone).toBe(
      "warning"
    );
    expect(fleetStrip({ inFlight: 1, ceiling: 4, sample: machine, pressure: "normal" })?.tone).toBe(
      "neutral"
    );
  });
});

describe("pressureBannerLine", () => {
  it("names what gavin's own agents hold, and that starts are held", () => {
    expect(
      pressureBannerLine({ pressure: "critical", agents: 6, agentBytes: 18 * GB })
    ).toBe("Memory is critical: 6 agents hold 18 GB. New launches are held.");
  });

  it("singularizes a lone agent", () => {
    expect(pressureBannerLine({ pressure: "critical", agents: 1, agentBytes: 3 * GB })).toBe(
      "Memory is critical: 1 agent holds 3 GB. New launches are held."
    );
  });

  // The machine can be critical with nothing of gavin's running: a
  // banner that then said "0 agents hold 0 GB" would read as a bug.
  it("says so plainly when none of it is gavin's", () => {
    expect(pressureBannerLine({ pressure: "critical", agents: 0, agentBytes: 0 })).toBe(
      "Memory is critical: gavin is running no agents. New launches are held."
    );
  });

  // A banner at warn would be up half the time on a busy machine, which
  // is how a banner stops being read.
  it("stays down below critical", () => {
    expect(pressureBannerLine({ pressure: "warn", agents: 6, agentBytes: 18 * GB })).toBeNull();
    expect(pressureBannerLine({ pressure: "normal", agents: 6, agentBytes: 18 * GB })).toBeNull();
  });
});
