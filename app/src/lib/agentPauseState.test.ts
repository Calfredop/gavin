import { describe, expect, it, beforeEach, vi } from "vitest";
import { get } from "svelte/store";

const backendMock = vi.hoisted(() => ({
  getAgentPause: vi.fn(),
  setAgentPause: vi.fn(async () => {}),
  agentUsage: vi.fn(),
}));

vi.mock("$lib/backend", () => backendMock);

vi.mock("$lib/layoutState", async () => {
  const { writable } = await import("svelte/store");
  return {
    layoutState: writable({
      workspaces: [] as unknown[],
      activeWorkspaceId: null as string | null,
    }),
    resolvedAgentFor: vi.fn(() => ({ profileId: "claude-code" })),
  };
});

import { DEFAULT_CYCLE, type PauseCycle } from "$lib/agentPause";
import type { AgentUsageReport } from "$lib/agentUsage";
import {
  agentPauseStore,
  agentUsageStore,
  editableCycle,
  effectiveCycle,
  loadAgentPause,
  mayStartWork,
  nowStore,
  pausedWorkspaces,
  pauseFor,
  profilesInUse,
  refreshUsage,
  saveAgentPause,
  startBlockedReason,
} from "$lib/agentPauseState";
import { layoutState } from "$lib/layoutState";

const ANCHOR = 1_700_000_000_000;
const MIN = 60_000;

function cycle(over: Partial<PauseCycle> = {}): PauseCycle {
  return { ...DEFAULT_CYCLE, enabled: true, anchorMs: ANCHOR, ...over };
}

beforeEach(() => {
  vi.clearAllMocks();
  agentPauseStore.set(null);
  agentUsageStore.set({});
  layoutState.set({ workspaces: [], activeWorkspaceId: null } as never);
});

describe("effectiveCycle", () => {
  it("falls back to the app-wide cycle when a workspace has no override", () => {
    agentPauseStore.set(cycle());
    layoutState.set({ workspaces: [{ id: "w1" }], activeWorkspaceId: "w1" } as never);
    expect(effectiveCycle("w1")).toEqual(cycle());
  });

  /// The trap this whole shape exists to avoid. An absent override means
  /// INHERIT; a workspace that wants no pause while the app has one
  /// stores `enabled: false`. A truthiness check would make those the
  /// same thing and silently re-enable a workspace somebody switched off.
  it("treats an override with enabled:false as off, not as absent", () => {
    agentPauseStore.set(cycle({ enabled: true }));
    layoutState.set({
      workspaces: [{ id: "w1", agentPause: cycle({ enabled: false }) }],
      activeWorkspaceId: "w1",
    } as never);
    expect(effectiveCycle("w1")?.enabled).toBe(false);
    expect(pauseFor("w1", ANCHOR + 295 * MIN).paused).toBe(false);
  });

  it("prefers a workspace's own numbers over the app's", () => {
    agentPauseStore.set(cycle({ pauseMinutes: 10 }));
    layoutState.set({
      workspaces: [{ id: "w1", agentPause: cycle({ pauseMinutes: 30 }) }],
      activeWorkspaceId: "w1",
    } as never);
    expect(effectiveCycle("w1")?.pauseMinutes).toBe(30);
  });

  it("gives an editor fields even when nothing is configured", () => {
    expect(editableCycle(null)).toEqual({ ...DEFAULT_CYCLE, anchorMs: 0 });
  });
});

describe("saveAgentPause", () => {
  /// The anchor is the whole reason the cycle survives a restart. Minting
  /// a new one on every save would slide the pause forward each time
  /// somebody nudged a field, so a cycle under adjustment would never
  /// actually fire.
  it("stamps an anchor once and never rewrites it", async () => {
    await saveAgentPause({ ...DEFAULT_CYCLE, enabled: true, anchorMs: 0 });
    const stamped = get(agentPauseStore);
    expect(stamped?.anchorMs).toBeGreaterThan(0);

    await saveAgentPause({ ...stamped!, pauseMinutes: 25 });
    expect(get(agentPauseStore)?.anchorMs).toBe(stamped!.anchorMs);
    expect(get(agentPauseStore)?.pauseMinutes).toBe(25);
  });

  it("clears to no cycle at all", async () => {
    await saveAgentPause(null);
    expect(get(agentPauseStore)).toBeNull();
    expect(backendMock.setAgentPause).toHaveBeenCalledWith(null);
  });
});

describe("loadAgentPause", () => {
  it("reads the stored cycle", async () => {
    backendMock.getAgentPause.mockResolvedValueOnce(cycle());
    await loadAgentPause();
    expect(get(agentPauseStore)).toEqual(cycle());
  });

  /// A failed read must leave the shipped default -- no cycle -- rather
  /// than anything that could pause a workspace on the strength of an
  /// error.
  it("falls back to no cycle when the read fails", async () => {
    agentPauseStore.set(cycle());
    backendMock.getAgentPause.mockRejectedValueOnce(new Error("nope"));
    await loadAgentPause();
    expect(get(agentPauseStore)).toBeNull();
  });
});

describe("refreshUsage", () => {
  it("stores what the host reported", async () => {
    const report: AgentUsageReport = {
      state: "ready",
      windows: [{ id: "five_hour", label: "5-hour", usedPercent: 12, resetsAt: null }],
      plan: "max",
      observedAt: 1,
      cached: false,
    };
    backendMock.agentUsage.mockResolvedValueOnce(report);
    await refreshUsage("claude-code");
    expect(get(agentUsageStore)["claude-code"]).toEqual(report);
  });

  /// A stale `ready` left in place after a failed read is a bar frozen at
  /// yesterday's number, which is worse than an honest gap.
  it("replaces a stale reading when the read fails", async () => {
    agentUsageStore.set({
      "claude-code": {
        state: "ready",
        windows: [{ id: "five_hour", label: "5-hour", usedPercent: 99, resetsAt: null }],
        plan: null,
        observedAt: 1,
        cached: false,
      },
    });
    backendMock.agentUsage.mockRejectedValueOnce(new Error("ipc down"));
    await refreshUsage("claude-code");
    expect(get(agentUsageStore)["claude-code"].state).toBe("unavailable");
  });
});

describe("profilesInUse", () => {
  it("lists each workspace's agent once", () => {
    layoutState.set({
      workspaces: [{ id: "w1" }, { id: "w2" }],
      activeWorkspaceId: "w1",
    } as never);
    expect(profilesInUse()).toEqual(["claude-code"]);
  });
});

describe("the gate", () => {
  it("lets work start with no cycle configured at all", () => {
    layoutState.set({ workspaces: [{ id: "w1" }], activeWorkspaceId: "w1" } as never);
    expect(mayStartWork("w1")).toBe(true);
    expect(startBlockedReason("w1")).toBeNull();
  });

  it("reads the workspace's own agent for the limits that matter", () => {
    agentPauseStore.set(cycle({ enabled: false, limitPercent: 90 }));
    layoutState.set({ workspaces: [{ id: "w1" }], activeWorkspaceId: "w1" } as never);
    agentUsageStore.set({
      "claude-code": {
        state: "ready",
        windows: [{ id: "seven_day", label: "Weekly", usedPercent: 97, resetsAt: null }],
        plan: null,
        observedAt: 1,
        cached: false,
      },
      // Another agent being full must not hold a workspace that does not
      // run it.
      gemini: {
        state: "ready",
        windows: [{ id: "five_hour", label: "5-hour", usedPercent: 100, resetsAt: null }],
        plan: null,
        observedAt: 1,
        cached: false,
      },
    });
    expect(startBlockedReason("w1")).toBe(
      "work is paused: the Weekly limit is 97% used, and it has not said when that clears"
    );
  });
});

describe("pausedWorkspaces", () => {
  function atLimit(percent: number): AgentUsageReport {
    return {
      state: "ready",
      windows: [{ id: "seven_day", label: "Weekly", usedPercent: percent, resetsAt: null }],
      plan: null,
      observedAt: 1,
      cached: false,
    };
  }

  it("names every held workspace, not only the one in front of you", () => {
    // The hub is about the whole fleet: a workspace can be at its limit
    // while the active one has room, and `activePause` cannot say so.
    agentPauseStore.set(cycle({ enabled: false, limitPercent: 90 }));
    agentUsageStore.set({ "claude-code": atLimit(97) });
    layoutState.set({
      workspaces: [
        { id: "w1", name: "One" },
        { id: "w2", name: "Two" },
      ],
      activeWorkspaceId: "w1",
    } as never);
    nowStore.set(ANCHOR);
    const held = get(pausedWorkspaces);
    expect(held.map((w) => w.name)).toEqual(["One", "Two"]);
    expect(held[0].verdict.why).toContain("97% used");
  });

  it("is empty while nothing is held", () => {
    agentPauseStore.set(cycle({ enabled: false, limitPercent: 90 }));
    agentUsageStore.set({ "claude-code": atLimit(12) });
    layoutState.set({ workspaces: [{ id: "w1", name: "One" }], activeWorkspaceId: "w1" } as never);
    nowStore.set(ANCHOR);
    expect(get(pausedWorkspaces)).toEqual([]);
  });
});
