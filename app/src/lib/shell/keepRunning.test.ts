import { describe, it, expect } from "vitest";
import { agentRunning, closeDecision, sleepHoldAction } from "$lib/shell/keepRunning";

describe("closeDecision", () => {
  it("hides the main window while remote access is on", () => {
    expect(closeDecision({ mainWindow: true, remoteAccess: true })).toBe("hide");
  });

  it("asks, as before, while remote access is off", () => {
    expect(closeDecision({ mainWindow: true, remoteAccess: false })).toBe("ask");
  });

  // A daemon too old to have the switch, or one that did not answer. A
  // window that hid itself on a guess leaves an app that did not quit.
  it("reads an unknown switch as off", () => {
    expect(closeDecision({ mainWindow: true, remoteAccess: null })).toBe("ask");
  });

  it("closes a workspace window without a question either way", () => {
    expect(closeDecision({ mainWindow: false, remoteAccess: true })).toBe("close");
    expect(closeDecision({ mainWindow: false, remoteAccess: false })).toBe("close");
    expect(closeDecision({ mainWindow: false, remoteAccess: null })).toBe("close");
  });
});

describe("agentRunning", () => {
  it("counts an agent mid-turn", () => {
    expect(agentRunning(["a"], { a: "working" })).toBe(true);
  });

  it("counts an agent stopped on a question", () => {
    expect(agentRunning(["a"], { a: "waiting_for_input" })).toBe(true);
  });

  it("does not count an agent whose turn ended, failed, or is unknown", () => {
    expect(agentRunning(["a", "b", "c"], { a: "idle", b: "failed", c: "unknown" })).toBe(false);
  });

  // A dev server or a `tail -f` is busy for hours and is not an agent.
  it("ignores a busy session that is not an agent", () => {
    expect(agentRunning(["a"], { a: "idle", shell: "working" })).toBe(false);
  });

  it("does not count an agent with no status yet", () => {
    expect(agentRunning(["a"], {})).toBe(false);
  });

  it("counts one running agent among idle ones", () => {
    expect(agentRunning(new Set(["a", "b"]), { a: "idle", b: "working" })).toBe(true);
  });
});

describe("sleepHoldAction", () => {
  it("holds exactly while remote access is on and an agent is running", () => {
    expect(sleepHoldAction(true, true)).toBe("hold");
  });

  // Between two rail steps no agent is running for a few seconds; a
  // release there would let an idle Mac sleep mid-rail.
  it("lingers, rather than releasing, when the agents stop with remote access on", () => {
    expect(sleepHoldAction(true, false)).toBe("linger");
  });

  it("releases at once when remote access is off, running agents or not", () => {
    expect(sleepHoldAction(false, true)).toBe("release");
    expect(sleepHoldAction(false, false)).toBe("release");
  });

  it("never holds on an unknown switch", () => {
    expect(sleepHoldAction(null, true)).toBe("release");
  });
});
