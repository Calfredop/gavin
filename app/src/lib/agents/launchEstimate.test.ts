import { describe, expect, it } from "vitest";
import { estimateLines, launchEstimate, slotsNow, type EstimateInput } from "$lib/agents/launchEstimate";
import { MIN_AGENT_RSS_BYTES, type SystemMemorySample } from "$lib/agents/memory";

const GB = 1024 ** 3;

function machine(over: Partial<SystemMemorySample> = {}): SystemMemorySample {
  return {
    supported: true,
    totalBytes: 32 * GB,
    // 14 GB in use of 32.
    freePercent: 56.25,
    pressureLevel: 1,
    swapUsedBytes: 0,
    sampledAtMs: 0,
    ...over,
  };
}

function input(over: Partial<EstimateInput> = {}): EstimateInput {
  return {
    count: 11,
    profileId: "claude-code",
    means: {},
    storedMeans: {},
    measuredAgents: 0,
    sample: machine(),
    maxInFlight: 4,
    inFlight: 0,
    ...over,
  };
}

describe("slotsNow", () => {
  it("starts everything when there is no ceiling", () => {
    expect(slotsNow(11, null, 3)).toBe(11);
  });

  it("starts what the ceiling leaves room for", () => {
    expect(slotsNow(11, 4, 0)).toBe(4);
    expect(slotsNow(11, 4, 3)).toBe(1);
  });

  it("starts nothing when the ceiling is already full or over", () => {
    expect(slotsNow(11, 4, 4)).toBe(0);
    expect(slotsNow(11, 4, 7)).toBe(0);
  });

  it("never claims more starts than were asked for", () => {
    expect(slotsNow(2, 4, 0)).toBe(2);
  });
});

describe("launchEstimate", () => {
  // The sentence the crash would have needed. Eleven agents, a measured
  // mean, a machine that has fourteen of thirty-two gigabytes gone, and
  // a ceiling that turns the other seven into a queue rather than a
  // reboot.
  it("gives the whole sentence when everything is known", () => {
    const estimate = launchEstimate(
      input({ means: { "claude-code": 1.5 * GB }, measuredAgents: 3 })
    );
    expect(estimate.line).toBe(
      "11 agents ≈ 17 GB (1.5 GB each, from the 3 running now) on top of 14 of 32 GB. 4 start now, 7 queue."
    );
    expect(estimate.startsNow).toBe(4);
    expect(estimate.queues).toBe(7);
  });

  it("drops the queue clause when everything fits under the ceiling", () => {
    const estimate = launchEstimate(
      input({ count: 3, means: { "claude-code": 2 * GB }, measuredAgents: 2 })
    );
    expect(estimate.line).toBe(
      "3 agents ≈ 6 GB (2 GB each, from the 2 running now) on top of 14 of 32 GB."
    );
    expect(estimate.queues).toBe(0);
  });

  // "from the 0 running now" is not provenance, it is noise.
  it("omits the provenance clause when nothing is running to measure", () => {
    const estimate = launchEstimate(input({ count: 2, measuredAgents: 0 }));
    expect(estimate.line).toBe("2 agents ≈ 3 GB (1.5 GB each) on top of 14 of 32 GB.");
  });

  // A machine nothing measured gets the half of the sentence that is
  // still true, rather than arithmetic against a total of zero.
  it("says nothing about the machine when nothing was measured", () => {
    const estimate = launchEstimate(input({ count: 2, sample: null }));
    expect(estimate.line).toBe("2 agents ≈ 3 GB (1.5 GB each).");
    expect(estimate.warning).toBeNull();
  });

  it("is silent about a press that starts nothing", () => {
    expect(launchEstimate(input({ count: 0 })).line).toBeNull();
    expect(estimateLines(launchEstimate(input({ count: 0 })))).toEqual([]);
  });

  // The floor is the safety of the whole line: a fleet of quiet
  // just-started agents must not authorise eleven more.
  it("never falls below the floor, whatever the sample says", () => {
    const estimate = launchEstimate(
      input({ count: 1, means: { "claude-code": 100 * 1024 * 1024 }, measuredAgents: 1 })
    );
    expect(estimate.projectedBytes).toBe(MIN_AGENT_RSS_BYTES);
  });

  it("falls back to the stored mean before the floor", () => {
    const estimate = launchEstimate(
      input({ count: 2, storedMeans: { "claude-code": 4 * GB } })
    );
    expect(estimate.projectedBytes).toBe(8 * GB);
  });
});

describe("the warning line", () => {
  // Measured against FREE, not against total: 32 GB sounds roomy and
  // six is what is actually there.
  it("warns when what starts now does not fit in what is free", () => {
    const estimate = launchEstimate(
      input({
        count: 11,
        // 26 of 32 in use, so 6 free.
        sample: machine({ freePercent: 18.75 }),
        means: { "claude-code": 3 * GB },
        measuredAgents: 2,
      })
    );
    expect(estimate.warning).toBe(
      "That is more than the 6 GB free — the queue will hold the rest until memory frees."
    );
    expect(estimateLines(estimate)).toHaveLength(2);
  });

  // The queue is the answer to the rest, so warning about memory it is
  // going to wait for would be warning about the feature working.
  it("measures only what actually starts, not the whole press", () => {
    const estimate = launchEstimate(
      input({
        count: 11,
        sample: machine({ freePercent: 18.75 }),
        means: { "claude-code": 1 * GB },
        measuredAgents: 2,
        maxInFlight: 2,
      })
    );
    // Two start, at the 1.5 GB floor: three gigabytes into six free.
    expect(estimate.warning).toBeNull();
  });

  it("never warns about a machine nobody measured", () => {
    expect(launchEstimate(input({ sample: null })).warning).toBeNull();
    expect(launchEstimate(input({ sample: machine({ supported: false }) })).warning).toBeNull();
  });
});
