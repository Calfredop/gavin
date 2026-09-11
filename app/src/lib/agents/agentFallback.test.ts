import { describe, expect, it } from "vitest";
import type { AgentUsageReport } from "$lib/agents/agentUsage";
import {
  agentLimitSpent,
  agentsOwedArming,
  decideLaunch,
  effectiveFallbackChain,
  fallbackBlockedReason,
  newlyAddedToChain,
  sanitizeChain,
  type LaunchDecisionInput,
} from "$lib/agents/agentFallback";

const ANCHOR = 1_700_000_000;

function atLimit(usedPercent: number): AgentUsageReport {
  return {
    state: "ready",
    windows: [{ id: "five_hour", label: "5-hour", usedPercent, resetsAt: ANCHOR }],
    plan: null,
    observedAt: ANCHOR,
    cached: false,
  };
}

const UNSUPPORTED: AgentUsageReport = { state: "unsupported" };

function decide(over: Partial<LaunchDecisionInput> = {}) {
  return decideLaunch({
    resolvedProfileId: "claude-code",
    chain: ["codex"],
    usageByProfile: {},
    armed: new Set(["codex"]),
    limitEnabled: true,
    limitPercent: 95,
    cyclePaused: false,
    resume: false,
    ...over,
  });
}

describe("sanitizeChain", () => {
  it("drops blanks and keeps first-seen duplicates", () => {
    expect(sanitizeChain(["", "codex", "codex", " gemini ", "gemini"])).toEqual([
      "codex",
      "gemini",
    ]);
  });
});

describe("effectiveFallbackChain", () => {
  it("inherits the app chain when the workspace has none", () => {
    expect(effectiveFallbackChain(undefined, ["codex"])).toEqual(["codex"]);
    expect(effectiveFallbackChain(null, ["codex"])).toEqual(["codex"]);
  });

  it("treats an empty workspace array as an override to no fallback", () => {
    expect(effectiveFallbackChain([], ["codex"])).toEqual([]);
  });

  it("uses the workspace chain when present", () => {
    expect(effectiveFallbackChain(["gemini"], ["codex"])).toEqual(["gemini"]);
  });
});

describe("newlyAddedToChain", () => {
  it("reports ids that appeared, not a reorder", () => {
    expect(newlyAddedToChain(["codex", "gemini"], ["gemini", "codex"])).toEqual([]);
    expect(newlyAddedToChain(["codex"], ["codex", "gemini"])).toEqual(["gemini"]);
  });
});

describe("agentLimitSpent", () => {
  it("is false when limits are off, the probe is missing, or the agent has none", () => {
    expect(agentLimitSpent(atLimit(99), false, 95)).toBe(false);
    expect(agentLimitSpent(undefined, true, 95)).toBe(false);
    expect(agentLimitSpent(UNSUPPORTED, true, 95)).toBe(false);
  });

  it("is true at or over the threshold", () => {
    expect(agentLimitSpent(atLimit(95), true, 95)).toBe(true);
    expect(agentLimitSpent(atLimit(94), true, 95)).toBe(false);
  });
});

describe("decideLaunch", () => {
  it("holds every start during a cycle pause, even with a ready fallback", () => {
    expect(
      decide({
        cyclePaused: true,
        usageByProfile: { "claude-code": atLimit(99) },
      })
    ).toEqual({ kind: "pause", why: "cycle" });
  });

  it("uses the resolved agent when it is not spent", () => {
    expect(decide({ usageByProfile: { "claude-code": atLimit(10) } })).toEqual({
      kind: "use",
      profileId: "claude-code",
      viaFallback: false,
    });
  });

  it("walks to the first under-threshold armed chain agent", () => {
    expect(
      decide({
        chain: ["codex", "gemini"],
        usageByProfile: { "claude-code": atLimit(99), codex: atLimit(10) },
        armed: new Set(["codex", "gemini"]),
      })
    ).toEqual({ kind: "use", profileId: "codex", viaFallback: true });
  });

  it("skips a spent chain entry and uses the next", () => {
    expect(
      decide({
        chain: ["codex", "gemini"],
        usageByProfile: {
          "claude-code": atLimit(99),
          codex: atLimit(99),
          gemini: UNSUPPORTED,
        },
        armed: new Set(["codex", "gemini"]),
      })
    ).toEqual({ kind: "use", profileId: "gemini", viaFallback: true });
  });

  it("asks to arm the next usable chain agent rather than skipping it", () => {
    expect(
      decide({
        usageByProfile: { "claude-code": atLimit(99) },
        armed: new Set(),
      })
    ).toEqual({ kind: "arm", profileId: "codex" });
  });

  it("pauses when the chain is empty — today's pause-only behaviour", () => {
    expect(
      decide({
        chain: [],
        usageByProfile: { "claude-code": atLimit(99) },
      })
    ).toEqual({ kind: "pause", why: "usage-limit" });
  });

  it("never walks on resume — a spent primary stays a hold", () => {
    expect(
      decide({
        resume: true,
        usageByProfile: { "claude-code": atLimit(99) },
        armed: new Set(["codex"]),
      })
    ).toEqual({ kind: "pause", why: "usage-limit" });
  });

  it("treats a no-probe agent as eligible in the chain", () => {
    expect(
      decide({
        usageByProfile: { "claude-code": atLimit(99), codex: UNSUPPORTED },
      })
    ).toEqual({ kind: "use", profileId: "codex", viaFallback: true });
  });
});

describe("agentsOwedArming", () => {
  it("skips the workspace's own profile and already-armed ids", () => {
    expect(
      agentsOwedArming({
        chain: ["codex", "claude-code"],
        complexityProfiles: ["gemini", "codex"],
        armed: new Set(["codex"]),
        workspaceProfileId: "claude-code",
      })
    ).toEqual(["gemini"]);
  });
});

describe("fallbackBlockedReason", () => {
  it("is silent for a launch that may go, and names arming vs a spent chain", () => {
    expect(
      fallbackBlockedReason({ kind: "use", profileId: "codex", viaFallback: true })
    ).toBeNull();
    expect(fallbackBlockedReason({ kind: "arm", profileId: "codex" })).toMatch(
      /not set up/
    );
    expect(fallbackBlockedReason({ kind: "pause", why: "usage-limit" })).toMatch(
      /fallback chain/
    );
  });
});
