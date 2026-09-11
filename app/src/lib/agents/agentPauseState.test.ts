import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { get } from "svelte/store";

const backendMock = vi.hoisted(() => ({
  getAgentPause: vi.fn(),
  setAgentPause: vi.fn(async () => {}),
  agentUsage: vi.fn(),
}));

vi.mock("$lib/core/backend", () => backendMock);

const resolvedAgentForMock = vi.hoisted(() =>
  vi.fn(() => ({ profileId: "claude-code" }))
);

vi.mock("$lib/core/layoutState", async () => {
  const { writable } = await import("svelte/store");
  return {
    layoutState: writable({
      workspaces: [] as unknown[],
      activeWorkspaceId: null as string | null,
    }),
    resolvedAgentFor: resolvedAgentForMock,
    agentDefaultsStore: writable({
      customCommand: "",
      customModelFlag: "",
      complexity: {},
      agentFallback: [] as string[],
      fallbackThresholds: {} as Record<string, number>,
    }),
  };
});

import { DEFAULT_CYCLE, type PauseCycle } from "$lib/agents/agentPause";
import type { AgentUsageReport } from "$lib/agents/agentUsage";
import { USAGE_CACHE_KEY, saveUsageCache } from "$lib/agents/agentUsage";
import {
  agentPauseStore,
  agentUsageStore,
  editableCycle,
  effectiveCycle,
  hydrateUsageCache,
  loadAgentPause,
  mayStartWork,
  nowStore,
  pausedWorkspaces,
  pausedWorkspaceKey,
  pauseFor,
  profilesInUse,
  refreshUsage,
  saveAgentPause,
  launchDecision,
  launchPauseHold,
  startBlockedReason,
  stopPauseClock,
  usageRefreshingStore,
} from "$lib/agents/agentPauseState";
import { layoutState, agentDefaultsStore } from "$lib/core/layoutState";

const ANCHOR = 1_700_000_000_000;
const MIN = 60_000;

function cycle(over: Partial<PauseCycle> = {}): PauseCycle {
  return { ...DEFAULT_CYCLE, enabled: true, anchorMs: ANCHOR, ...over };
}

beforeEach(() => {
  vi.clearAllMocks();
  resolvedAgentForMock.mockReturnValue({ profileId: "claude-code" });
  agentPauseStore.set(null);
  agentUsageStore.set({});
  usageRefreshingStore.set({});
  layoutState.set({ workspaces: [], activeWorkspaceId: null } as never);
  agentDefaultsStore.set({
    customCommand: "",
    customModelFlag: "",
    complexity: {},
    agentFallback: [],
    fallbackThresholds: {},
  });
});

afterEach(() => {
  stopPauseClock();
  vi.useRealTimers();
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
  const readyReport: AgentUsageReport = {
    state: "ready",
    windows: [{ id: "five_hour", label: "5-hour", usedPercent: 12, resetsAt: null }],
    plan: "max",
    observedAt: 1,
    cached: false,
  };

  it("stores what the host reported", async () => {
    backendMock.agentUsage.mockResolvedValueOnce(readyReport);
    await refreshUsage("claude-code");
    expect(get(agentUsageStore)["claude-code"]).toEqual(readyReport);
  });

  it("marks the profile as refreshing for the life of the probe", async () => {
    let sawRefreshing = false;
    backendMock.agentUsage.mockImplementation(async () => {
      sawRefreshing = get(usageRefreshingStore)["claude-code"] === true;
      return readyReport;
    });
    await refreshUsage("claude-code");
    expect(sawRefreshing).toBe(true);
    expect(get(usageRefreshingStore)["claude-code"]).toBeUndefined();
  });

  /// Last known numbers stay on screen when the probe cannot answer.
  /// Replacing them with a gap would flash yesterday's bars away on
  /// every restart whose first call failed.
  it("keeps a still-open reading when the read fails", async () => {
    agentUsageStore.set({ "claude-code": readyReport });
    backendMock.agentUsage.mockRejectedValueOnce(new Error("ipc down"));
    await refreshUsage("claude-code");
    expect(get(agentUsageStore)["claude-code"]).toEqual(readyReport);
  });

  it("reports unavailability when there is nothing still-open to keep", async () => {
    backendMock.agentUsage.mockRejectedValueOnce(new Error("ipc down"));
    await refreshUsage("claude-code");
    expect(get(agentUsageStore)["claude-code"].state).toBe("unavailable");
  });
});

describe("hydrateUsageCache", () => {
  function fakeStorage() {
    const map = new Map<string, string>();
    return {
      map,
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
      removeItem: (k: string) => void map.delete(k),
    };
  }

  it("shows last cached readings before any probe returns", () => {
    const storage = fakeStorage();
    const report: AgentUsageReport = {
      state: "ready",
      windows: [{ id: "five_hour", label: "5-hour", usedPercent: 44, resetsAt: 2_000_000_000 }],
      plan: "max",
      observedAt: 1_700_000_000,
      cached: false,
    };
    saveUsageCache({ "claude-code": report }, storage, 1_700_000_000_000);
    hydrateUsageCache(1_700_000_000_000, storage);
    expect(get(agentUsageStore)["claude-code"]).toEqual({ ...report, cached: true });
  });

  it("does not resurrect a window whose reset has already passed", () => {
    const storage = fakeStorage();
    const nowMs = 1_700_000_000_000;
    const nowS = Math.floor(nowMs / 1000);
    storage.setItem(
      USAGE_CACHE_KEY,
      JSON.stringify({
        "claude-code": {
          state: "ready",
          windows: [{ id: "five_hour", label: "5-hour", usedPercent: 96, resetsAt: nowS - 10 }],
          plan: null,
          observedAt: nowS - 100,
          cached: true,
        },
      })
    );
    hydrateUsageCache(nowMs, storage);
    expect(get(agentUsageStore)["claude-code"]).toBeUndefined();
    expect(storage.map.has(USAGE_CACHE_KEY)).toBe(false);
  });

  it("drops a cached window the moment its reset arrives", () => {
    vi.useFakeTimers();
    const nowMs = 1_700_000_000_000;
    vi.setSystemTime(nowMs);
    const nowS = Math.floor(nowMs / 1000);
    const storage = fakeStorage();
    saveUsageCache(
      {
        "claude-code": {
          state: "ready",
          windows: [
            { id: "five_hour", label: "5-hour", usedPercent: 80, resetsAt: nowS + 2 },
            { id: "seven_day", label: "Weekly", usedPercent: 10, resetsAt: nowS + 3600 },
          ],
          plan: null,
          observedAt: nowS,
          cached: false,
        },
      },
      storage,
      nowMs
    );
    hydrateUsageCache(nowMs, storage);
    vi.advanceTimersByTime(2_100);
    const report = get(agentUsageStore)["claude-code"];
    expect(report?.state).toBe("ready");
    if (report?.state === "ready") {
      expect(report.windows.map((w) => w.id)).toEqual(["seven_day"]);
    }
    vi.useRealTimers();
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

  it("includes fallback-chain ids so their usage is polled", () => {
    layoutState.set({
      workspaces: [{ id: "w1", agentFallback: ["codex"] }],
      activeWorkspaceId: "w1",
    } as never);
    expect(profilesInUse()).toEqual(["claude-code", "codex"]);
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

  it("walks an armed fallback instead of holding when the primary is spent", () => {
    agentPauseStore.set(cycle({ enabled: false, limitPercent: 90 }));
    layoutState.set({
      workspaces: [{ id: "w1", agentFallback: ["codex"], armedAgents: ["codex"] }],
      activeWorkspaceId: "w1",
    } as never);
    agentUsageStore.set({
      "claude-code": {
        state: "ready",
        windows: [{ id: "seven_day", label: "Weekly", usedPercent: 97, resetsAt: null }],
        plan: null,
        observedAt: 1,
        cached: false,
      },
    });
    expect(launchDecision("w1", "claude-code", false)).toEqual({
      kind: "use",
      profileId: "codex",
      viaFallback: true,
    });
    expect(mayStartWork("w1")).toBe(true);
    expect(launchPauseHold("w1", ANCHOR).paused).toBe(false);
    expect(startBlockedReason("w1")).toBeNull();
  });

  it("walks a new launch at the profile fallback threshold while pause is still higher", () => {
    agentPauseStore.set(cycle({ enabled: false, limitPercent: 95 }));
    agentDefaultsStore.set({
      customCommand: "",
      customModelFlag: "",
      complexity: {},
      agentFallback: [],
      fallbackThresholds: { "claude-code": 80 },
    });
    layoutState.set({
      workspaces: [{ id: "w1", agentFallback: ["codex"], armedAgents: ["codex"] }],
      activeWorkspaceId: "w1",
    } as never);
    agentUsageStore.set({
      "claude-code": {
        state: "ready",
        windows: [{ id: "seven_day", label: "Weekly", usedPercent: 85, resetsAt: null }],
        plan: null,
        observedAt: 1,
        cached: false,
      },
    });
    expect(launchDecision("w1", "claude-code", false)).toEqual({
      kind: "use",
      profileId: "codex",
      viaFallback: true,
    });
    expect(launchDecision("w1", "claude-code", true)).toEqual({
      kind: "use",
      profileId: "claude-code",
      viaFallback: false,
    });
  });

  it("blocks and names the unarmed next chain agent rather than skipping it", () => {
    agentPauseStore.set(cycle({ enabled: false, limitPercent: 90 }));
    layoutState.set({
      workspaces: [{ id: "w1", agentFallback: ["codex"] }],
      activeWorkspaceId: "w1",
    } as never);
    agentUsageStore.set({
      "claude-code": {
        state: "ready",
        windows: [{ id: "seven_day", label: "Weekly", usedPercent: 97, resetsAt: null }],
        plan: null,
        observedAt: 1,
        cached: false,
      },
    });
    expect(launchDecision("w1", "claude-code", false)).toEqual({
      kind: "arm",
      profileId: "codex",
    });
    expect(mayStartWork("w1")).toBe(false);
    expect(launchPauseHold("w1", ANCHOR).why).toMatch(/not set up/);
  });

  /// A card whose complexity table names Claude still has to be able to
  /// start on this workspace's own agent when Claude is spent and nobody
  /// configured a fallback chain — switching the workspace to Cursor is
  /// how the human already said "run here instead".
  it("uses the workspace agent when the card's agent is spent and the chain is empty", () => {
    resolvedAgentForMock.mockReturnValue({ profileId: "cursor" });
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
      cursor: {
        state: "ready",
        windows: [
          { id: "total", label: "Total", usedPercent: 45, resetsAt: null },
          { id: "auto", label: "Auto", usedPercent: 45, resetsAt: null },
        ],
        plan: null,
        observedAt: 1,
        cached: false,
      },
    });
    expect(launchDecision("w1", "claude-code", false)).toEqual({
      kind: "use",
      profileId: "cursor",
      viaFallback: true,
    });
  });

  it("does not invent a usage pause when no cycle is configured at all", () => {
    layoutState.set({
      workspaces: [{ id: "w1", agentFallback: ["codex"], armedAgents: ["codex"] }],
      activeWorkspaceId: "w1",
    } as never);
    agentUsageStore.set({
      "claude-code": {
        state: "ready",
        windows: [{ id: "seven_day", label: "Weekly", usedPercent: 97, resetsAt: null }],
        plan: null,
        observedAt: 1,
        cached: false,
      },
    });
    expect(launchDecision("w1", "claude-code", false)).toEqual({
      kind: "use",
      profileId: "claude-code",
      viaFallback: false,
    });
    expect(mayStartWork("w1")).toBe(true);
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

  it("is empty when the primary is spent but an armed fallback can launch", () => {
    agentPauseStore.set(cycle({ enabled: false, limitPercent: 90 }));
    agentUsageStore.set({ "claude-code": atLimit(97) });
    layoutState.set({
      workspaces: [
        { id: "w1", name: "One", agentFallback: ["codex"], armedAgents: ["codex"] },
      ],
      activeWorkspaceId: "w1",
    } as never);
    nowStore.set(ANCHOR);
    expect(get(pausedWorkspaces)).toEqual([]);
  });

  // The scheduler's own input. It ticks every loaded workspace, so this
  // has to speak for every loaded workspace too -- and it has to stay
  // quiet on the thirty-second clock underneath, or the scheduler runs a
  // pass twice a minute for the life of the app.
  describe("pausedWorkspaceKey", () => {
    const twoWorkspaces = () =>
      layoutState.set({
        workspaces: [
          { id: "w1", name: "One" },
          { id: "w2", name: "Two" },
        ],
        activeWorkspaceId: "w1",
      } as never);

    it("emits once when a pause starts and once when it lifts", () => {
      agentPauseStore.set(cycle({ enabled: false, limitPercent: 90 }));
      agentUsageStore.set({ "claude-code": atLimit(12) });
      twoWorkspaces();
      nowStore.set(ANCHOR);

      const seen: string[] = [];
      const stop = pausedWorkspaceKey.subscribe((k) => seen.push(k));
      // The clock moving is not news: nothing about what is held changed.
      nowStore.set(ANCHOR + 30_000);
      nowStore.set(ANCHOR + 60_000);
      expect(seen).toEqual([""]);

      agentUsageStore.set({ "claude-code": atLimit(97) });
      agentUsageStore.set({ "claude-code": atLimit(12) });
      stop();
      expect(seen).toEqual(["", "w1 w2", ""]);
    });

    // The half a boolean cannot carry. One workspace resuming while
    // another is held reads as "still paused" to a flag, and the rail
    // that just became free never gets the tick that would launch it.
    it("emits when the SET moves, even though something is still held", () => {
      agentPauseStore.set(cycle({ enabled: false, limitPercent: 90 }));
      agentUsageStore.set({ "claude-code": atLimit(97) });
      twoWorkspaces();
      nowStore.set(ANCHOR);

      const seen: string[] = [];
      const stop = pausedWorkspaceKey.subscribe((k) => seen.push(k));
      // w1 can walk an armed fallback; w2 has none, so it stays held on
      // the same spent primary. New launches key off the profile's
      // fallback threshold, not a per-workspace pause percent, so this
      // is the remaining way one workspace frees while another does not.
      layoutState.set({
        workspaces: [
          { id: "w1", name: "One", agentFallback: ["codex"], armedAgents: ["codex"] },
          { id: "w2", name: "Two" },
        ],
        activeWorkspaceId: "w1",
      } as never);
      stop();
      expect(seen.at(0)).toBe("w1 w2");
      expect(seen.at(-1)).toBe("w2");
    });
  });
});
