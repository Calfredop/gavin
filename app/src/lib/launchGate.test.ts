import { describe, expect, it } from "vitest";
import {
  DEFAULT_LAUNCH,
  DRAIN_SPACING_MS,
  HYSTERESIS_MS,
  countsInFlight,
  gateBlockedReason,
  holdDetail,
  holdLabel,
  launchVerdict,
  mayDrain,
  type GateInput,
} from "./launchGate";

const GB = 1024 ** 3;
const NOW = 1_700_000_000_000;

function input(over: Partial<GateInput> = {}): GateInput {
  return {
    config: DEFAULT_LAUNCH,
    inFlight: 0,
    pressure: "normal",
    usedBytes: 8 * GB,
    totalBytes: 32 * GB,
    nowMs: NOW,
    pressureSinceMs: null,
    ...over,
  };
}

describe("countsInFlight", () => {
  // An agent that has finished its turn frees its slot even though its
  // process is still there: holding it would make the ceiling a cap on
  // open tabs, and the memory it still holds is the pressure guard's job.
  it("counts only a working or asking agent", () => {
    expect(countsInFlight("working")).toBe(true);
    expect(countsInFlight("waiting_for_input")).toBe(true);
    expect(countsInFlight("idle")).toBe(false);
    expect(countsInFlight("failed")).toBe(false);
    expect(countsInFlight("unknown")).toBe(false);
    expect(countsInFlight(null)).toBe(false);
    expect(countsInFlight(undefined)).toBe(false);
  });
});

describe("the ceiling", () => {
  it("allows a launch below it", () => {
    expect(launchVerdict(input({ inFlight: 3 }))).toEqual({
      allowed: true,
      reason: null,
      why: null,
    });
  });

  // The boundary is the whole setting: four means four running, so the
  // FIFTH is the one that waits.
  it("holds at the boundary, not one past it", () => {
    const at = launchVerdict(input({ inFlight: 4 }));
    expect(at.allowed).toBe(false);
    expect(at.reason).toBe("ceiling");
    expect(at.why).toBe("Waiting for a slot: 4 of 4 agents running");
    expect(launchVerdict(input({ inFlight: 3 })).allowed).toBe(true);
  });

  it("reports the real count when the fleet is already over the ceiling", () => {
    expect(launchVerdict(input({ inFlight: 7 })).why).toBe(
      "Waiting for a slot: 7 of 4 agents running"
    );
  });

  // Blank is a real answer -- somebody with memory to spare -- and must
  // behave exactly as gavin did before the wall existed.
  it("never holds when the ceiling is blank", () => {
    const cfg = { maxInFlight: null, holdOnPressure: true };
    expect(launchVerdict(input({ config: cfg, inFlight: 40 })).allowed).toBe(true);
  });

  it("holds before it looks at memory, so a full fleet is not reported as pressure", () => {
    const verdict = launchVerdict(input({ inFlight: 4, pressure: "critical" }));
    expect(verdict.reason).toBe("ceiling");
  });
});

describe("the pressure hold", () => {
  it("holds under warn pressure and names how full the machine is", () => {
    const verdict = launchVerdict(input({ pressure: "warn", usedBytes: 28 * GB }));
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toBe("pressure");
    expect(verdict.why).toBe("Held: memory pressure, 28 of 32 GB in use");
  });

  it("says critical when it is critical", () => {
    expect(launchVerdict(input({ pressure: "critical", usedBytes: 31 * GB })).why).toBe(
      "Held: memory is critical, 31 of 32 GB in use"
    );
  });

  // A figure nobody measured must not be printed as a zero.
  it("omits the usage clause when nothing was measured", () => {
    expect(
      launchVerdict(input({ pressure: "warn", usedBytes: null, totalBytes: null })).why
    ).toBe("Held: memory pressure");
  });

  it("does not hold when the human has turned the pressure guard off", () => {
    const cfg = { maxInFlight: 4, holdOnPressure: false };
    expect(launchVerdict(input({ config: cfg, pressure: "critical" })).allowed).toBe(true);
  });
});

describe("hysteresis", () => {
  // The queue must not empty into the machine the instant the kernel
  // stops complaining: a process tree takes tens of seconds to reach its
  // real size, so that instant is when the machine knows least.
  it("keeps holding until pressure has read normal for the full window", () => {
    const justRecovered = launchVerdict(
      input({ pressure: "normal", pressureSinceMs: NOW - 5_000 })
    );
    expect(justRecovered.allowed).toBe(false);
    expect(justRecovered.reason).toBe("pressure");
    expect(justRecovered.why).toBe("Held: memory just recovered, resuming in 25s");
  });

  it("releases once the window has passed", () => {
    expect(
      launchVerdict(input({ pressure: "normal", pressureSinceMs: NOW - HYSTERESIS_MS })).allowed
    ).toBe(true);
  });

  it("never holds a machine that has not been under pressure at all", () => {
    expect(launchVerdict(input({ pressure: "normal", pressureSinceMs: null })).allowed).toBe(true);
  });

  it("does not apply the window when the pressure guard is off", () => {
    const cfg = { maxInFlight: 4, holdOnPressure: false };
    expect(
      launchVerdict(input({ config: cfg, pressure: "normal", pressureSinceMs: NOW - 1_000 }))
        .allowed
    ).toBe(true);
  });
});

describe("gateBlockedReason", () => {
  it("is null while work may start, and the sentence when it may not", () => {
    expect(gateBlockedReason(launchVerdict(input()))).toBeNull();
    expect(gateBlockedReason(launchVerdict(input({ inFlight: 4 })))).toBe(
      "Waiting for a slot: 4 of 4 agents running"
    );
  });
});

describe("badge wording", () => {
  it("gives each hold one label and one detail", () => {
    expect(holdLabel("ceiling")).toBe("Queued");
    expect(holdDetail("ceiling")).toBe("waiting for a slot");
    expect(holdLabel("pressure")).toBe("Held");
    expect(holdDetail("pressure")).toBe("memory pressure");
  });
});

describe("mayDrain", () => {
  const allowed = launchVerdict(input());
  const held = launchVerdict(input({ inFlight: 4 }));

  it("never drains while the gate is holding", () => {
    expect(
      mayDrain({ verdict: held, lastLaunchMs: null, nowMs: NOW, lastLaunchObserved: true })
    ).toBe(false);
  });

  it("drains the first one immediately", () => {
    expect(
      mayDrain({ verdict: allowed, lastLaunchMs: null, nowMs: NOW, lastLaunchObserved: false })
    ).toBe(true);
  });

  // One at a time and paced: a burst released together is a burst, and
  // the gate would wave all of them through against a sample none of
  // them are in yet.
  it("waits out the spacing after a launch nothing has measured yet", () => {
    expect(
      mayDrain({
        verdict: allowed,
        lastLaunchMs: NOW - 5_000,
        nowMs: NOW,
        lastLaunchObserved: false,
      })
    ).toBe(false);
    expect(
      mayDrain({
        verdict: allowed,
        lastLaunchMs: NOW - DRAIN_SPACING_MS,
        nowMs: NOW,
        lastLaunchObserved: false,
      })
    ).toBe(true);
  });

  // The spacing is a floor a measurement can lift early: once the tree
  // is in the sample there is nothing left to wait for.
  it("releases early once the last launch has turned up in the sample", () => {
    expect(
      mayDrain({
        verdict: allowed,
        lastLaunchMs: NOW - 1_000,
        nowMs: NOW,
        lastLaunchObserved: true,
      })
    ).toBe(true);
  });
});
