import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { get } from "svelte/store";

const backendMock = vi.hoisted(() => ({
  agentUsage: vi.fn(),
}));

vi.mock("$lib/core/backend", () => backendMock);

const resolvedAgentForMock = vi.hoisted(() =>
  vi.fn(() => ({ profileId: "claude-code" }))
);

vi.mock("$lib/core/layoutState", async () => {
  const { writable } = await import("svelte/store");
  const agentDefaultsStore = writable({
    customCommand: "",
    customModelFlag: "",
    complexityTables: {},
    pauseCycles: {} as Record<string, unknown>,
    fallbackChains: {},
    fallbackThresholds: {} as Record<string, number>,
    actionPromptOverrides: {} as Record<string, string>,
  });
  return {
    layoutState: writable({
      workspaces: [] as unknown[],
      activeWorkspaceId: null as string | null,
    }),
    resolvedAgentFor: resolvedAgentForMock,
    agentDefaultsStore,
    // The real one writes through the host; the store is what these tests
    // read the pause cycles back out of.
    setAgentDefaults: vi.fn(async (next: unknown) => {
      agentDefaultsStore.set(next as never);
    }),
  };
});

// The other windows, as the host would carry them: `emit` is recorded,
// and `fire` plays a message another window sent.
const eventMock = vi.hoisted(() => {
  const handlers = new Map<string, Array<(event: { payload: unknown }) => void>>();
  return {
    handlers,
    listen: vi.fn(async (name: string, handler: (event: { payload: unknown }) => void) => {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
      return () => {
        handlers.set(
          name,
          (handlers.get(name) ?? []).filter((h) => h !== handler)
        );
      };
    }),
    emit: vi.fn(async (_name: string, _message: unknown) => {}),
    fire(name: string, payload: unknown): void {
      for (const handler of handlers.get(name) ?? []) handler({ payload });
    },
  };
});

vi.mock("@tauri-apps/api/event", () => ({ listen: eventMock.listen, emit: eventMock.emit }));

import { DEFAULT_CYCLE, type PauseCycle } from "$lib/agents/agentPause";
import type { AgentUsageReport } from "$lib/agents/agentUsage";
import { USAGE_CACHE_KEY, saveUsageCache } from "$lib/agents/agentUsage";
import {
  agentPauseStore,
  agentUsageStore,
  editableCycle,
  effectiveCycle,
  hydrateUsageCache,
  mayStartWork,
  nowStore,
  pausedWorkspaces,
  pausedWorkspaceKey,
  pauseFor,
  profilesInUse,
  refreshUsage,
  saveAgentPauseFor,
  launchDecision,
  launchPauseHold,
  startBlockedReason,
  initUsageSharing,
  startPauseClock,
  startUsagePoll,
  stopPauseClock,
  usageRefreshingStore,
} from "$lib/agents/agentPauseState";
import { layoutState, agentDefaultsStore } from "$lib/core/layoutState";
import { appDuty } from "$lib/shell/appDuty";

const ANCHOR = 1_700_000_000_000;
const MIN = 60_000;

function cycle(over: Partial<PauseCycle> = {}): PauseCycle {
  return { ...DEFAULT_CYCLE, enabled: true, anchorMs: ANCHOR, ...over };
}

/// The app-wide cycle for one primary, written where it now lives: the
/// agent defaults. `null` removes the primary's key (never held).
function setAppCycle(value: PauseCycle | null, primary = "claude-code"): void {
  agentDefaultsStore.update((d) => {
    const pauseCycles = { ...((d as { pauseCycles?: Record<string, PauseCycle> }).pauseCycles ?? {}) };
    if (value) pauseCycles[primary] = value;
    else delete pauseCycles[primary];
    return { ...d, pauseCycles } as never;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  eventMock.handlers.clear();
  appDuty.set({ holder: "main", windows: ["main"] });
  resolvedAgentForMock.mockReturnValue({ profileId: "claude-code" });
  agentUsageStore.set({});
  usageRefreshingStore.set({});
  layoutState.set({ workspaces: [], activeWorkspaceId: null } as never);
  agentDefaultsStore.set({
    customCommand: "",
    customModelFlag: "",
    defaultAgent: "claude-code",
    complexityTables: {},
    pauseCycles: {},
    fallbackChains: {},
    fallbackThresholds: {},
    actionPromptOverrides: {},
  } as never);
});

afterEach(() => {
  stopPauseClock();
  vi.useRealTimers();
});

describe("effectiveCycle", () => {
  it("falls back to the app-wide cycle when a workspace has no override", () => {
    setAppCycle(cycle());
    layoutState.set({ workspaces: [{ id: "w1" }], activeWorkspaceId: "w1" } as never);
    expect(effectiveCycle("w1")).toEqual(cycle());
  });

  /// The trap this whole shape exists to avoid. An absent override means
  /// INHERIT; a workspace that wants no pause while the app has one
  /// stores `enabled: false`. A truthiness check would make those the
  /// same thing and silently re-enable a workspace somebody switched off.
  it("treats an override with enabled:false as off, not as absent", () => {
    setAppCycle(cycle({ enabled: true }));
    layoutState.set({
      workspaces: [{ id: "w1", pauseCycles: { "claude-code": cycle({ enabled: false }) } }],
      activeWorkspaceId: "w1",
    } as never);
    expect(effectiveCycle("w1")?.enabled).toBe(false);
    expect(pauseFor("w1", ANCHOR + 295 * MIN).paused).toBe(false);
  });

  it("prefers a workspace's own numbers over the app's", () => {
    setAppCycle(cycle({ pauseMinutes: 10 }));
    layoutState.set({
      workspaces: [{ id: "w1", pauseCycles: { "claude-code": cycle({ pauseMinutes: 30 }) } }],
      activeWorkspaceId: "w1",
    } as never);
    expect(effectiveCycle("w1")?.pauseMinutes).toBe(30);
  });

  it("gives an editor fields even when nothing is configured", () => {
    expect(editableCycle(null)).toEqual({ ...DEFAULT_CYCLE, anchorMs: 0 });
  });

  /// Cycles are per primary agent: a workspace on codex is not held by
  /// the cycle claude-code keeps, and an override for one primary says
  /// nothing about another.
  it("reads the cycle of the agent the workspace runs, not another agent's", () => {
    setAppCycle(cycle({ pauseMinutes: 10 }), "claude-code");
    setAppCycle(cycle({ pauseMinutes: 40 }), "codex");
    layoutState.set({ workspaces: [{ id: "w1" }], activeWorkspaceId: "w1" } as never);

    resolvedAgentForMock.mockReturnValue({ profileId: "codex" });
    expect(effectiveCycle("w1")?.pauseMinutes).toBe(40);
    resolvedAgentForMock.mockReturnValue({ profileId: "gemini" });
    expect(effectiveCycle("w1")).toBeNull();
  });

  it("answers for an explicit primary, whatever the workspace runs", () => {
    setAppCycle(cycle({ pauseMinutes: 40 }), "codex");
    layoutState.set({
      workspaces: [{ id: "w1", pauseCycles: { codex: cycle({ pauseMinutes: 55 }) } }],
      activeWorkspaceId: "w1",
    } as never);
    expect(effectiveCycle("w1", "codex")?.pauseMinutes).toBe(55);
    expect(effectiveCycle("w1", "claude-code")).toBeNull();
  });

  it("answers for the app default agent when asked outside any workspace", () => {
    setAppCycle(cycle({ pauseMinutes: 12 }), "codex");
    agentDefaultsStore.update((d) => ({ ...d, defaultAgent: "codex" }) as never);
    expect(effectiveCycle(null)?.pauseMinutes).toBe(12);
  });
});

describe("saveAgentPauseFor", () => {
  /// The anchor is the whole reason the cycle survives a restart. Minting
  /// a new one on every save would slide the pause forward each time
  /// somebody nudged a field, so a cycle under adjustment would never
  /// actually fire.
  it("stamps an anchor once and never rewrites it", async () => {
    await saveAgentPauseFor("claude-code", { ...DEFAULT_CYCLE, enabled: true, anchorMs: 0 });
    const stamped = get(agentPauseStore)["claude-code"];
    expect(stamped?.anchorMs).toBeGreaterThan(0);

    await saveAgentPauseFor("claude-code", { ...stamped!, pauseMinutes: 25 });
    expect(get(agentPauseStore)["claude-code"]?.anchorMs).toBe(stamped!.anchorMs);
    expect(get(agentPauseStore)["claude-code"]?.pauseMinutes).toBe(25);
  });

  it("clears one agent to no cycle at all without touching the others", async () => {
    setAppCycle(cycle(), "claude-code");
    setAppCycle(cycle({ pauseMinutes: 33 }), "codex");
    await saveAgentPauseFor("claude-code", null);
    expect(get(agentPauseStore)["claude-code"]).toBeUndefined();
    expect(get(agentPauseStore).codex?.pauseMinutes).toBe(33);
  });

  it("ignores a blank agent id rather than writing an unnamed key", async () => {
    await saveAgentPauseFor("  ", cycle());
    expect(get(agentPauseStore)).toEqual({});
  });
});

describe("agentPauseStore", () => {
  /// It is a view of the agent defaults, not a second copy: the cycles
  /// ride the same wholesale save as every other per-primary map.
  it("follows the agent defaults", () => {
    expect(get(agentPauseStore)).toEqual({});
    setAppCycle(cycle(), "codex");
    expect(get(agentPauseStore).codex).toEqual(cycle());
  });
});

describe("a fallback hop answers to the candidate's own cycle", () => {
  it("does not hop a spent primary onto an agent that is inside its own pause window", () => {
    setAppCycle(cycle({ enabled: false, limitPercent: 90, pauseMinutes: 10 }), "claude-code");
    // codex keeps a schedule too, and the clock is inside ITS pause.
    setAppCycle(cycle({ pauseMinutes: 10 }), "codex");
    layoutState.set({
      workspaces: [{ id: "w1", fallbackChains: { "claude-code": ["codex", "gemini"] }, armedAgents: ["codex", "gemini"] }],
      activeWorkspaceId: "w1",
    } as never);
    const spent = {
      state: "ready" as const,
      windows: [{ id: "seven_day", label: "Weekly", usedPercent: 97, resetsAt: null }],
      plan: null,
      observedAt: 1,
      cached: false,
    };
    agentUsageStore.set({ "claude-code": spent });
    const inCodexPause = ANCHOR + 295 * MIN;
    expect(launchDecision("w1", "claude-code", false, inCodexPause)).toEqual({
      kind: "use",
      profileId: "gemini",
      viaFallback: true,
    });
    // Outside codex's window it is the first hop again.
    expect(launchDecision("w1", "claude-code", false, ANCHOR + 100 * MIN)).toEqual({
      kind: "use",
      profileId: "codex",
      viaFallback: true,
    });
  });
});

describe("launchDecision keys the cycle by the launch's resolved primary", () => {
  it("holds a launch resolved to the agent whose cycle is paused, not one resolved elsewhere", () => {
    setAppCycle(cycle({ pauseMinutes: 10 }), "claude-code");
    layoutState.set({ workspaces: [{ id: "w1" }], activeWorkspaceId: "w1" } as never);
    const inPause = ANCHOR + 295 * MIN;
    expect(launchDecision("w1", "claude-code", false, inPause).kind).toBe("pause");
    // codex keeps no cycle, so a card routed there launches during
    // claude-code's pause.
    expect(launchDecision("w1", "codex", false, inPause)).toMatchObject({ kind: "use" });
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

  describe("overlapping calls", () => {
    const older: AgentUsageReport = { ...readyReport, observedAt: 100 };
    const newer: AgentUsageReport = {
      ...readyReport,
      windows: [{ id: "five_hour", label: "5-hour", usedPercent: 40, resetsAt: null }],
      observedAt: 200,
    };

    /// The poll's call, held open until the test answers it.
    function pendingPoll(): { answer: (r: AgentUsageReport) => void; fail: () => void } {
      const held = { answer: (_: AgentUsageReport) => {}, fail: () => {} };
      backendMock.agentUsage.mockImplementationOnce(
        () =>
          new Promise<AgentUsageReport>((resolve, reject) => {
            held.answer = resolve;
            held.fail = () => reject(new Error("curl timed out"));
          })
      );
      return held;
    }

    /// The host answers concurrently now, so a poll stuck on a slow curl
    /// can answer after a forced refresh that started later. Its reading
    /// is the older one and must not replace the refresh on screen.
    it("drops an older call's answer once a newer one has landed", async () => {
      const poll = pendingPoll();
      const polling = refreshUsage("claude-code");
      backendMock.agentUsage.mockResolvedValueOnce(newer);
      await refreshUsage("claude-code", true);
      expect(get(agentUsageStore)["claude-code"]).toEqual(newer);

      poll.answer(older);
      await polling;
      expect(get(agentUsageStore)["claude-code"]).toEqual(newer);
    });

    /// A failure replaces a reading with nothing still open in it. When
    /// the reading is a newer call's, the stale timer is what retires it,
    /// not an older curl's timeout.
    it("drops an older call's failure once a newer answer has landed", async () => {
      const sinceReset: AgentUsageReport = {
        ...newer,
        windows: [{ id: "five_hour", label: "5-hour", usedPercent: 40, resetsAt: 1 }],
      };
      const poll = pendingPoll();
      const polling = refreshUsage("claude-code");
      backendMock.agentUsage.mockResolvedValueOnce(sinceReset);
      await refreshUsage("claude-code", true);

      poll.fail();
      await polling;
      expect(get(agentUsageStore)["claude-code"]).toEqual(sinceReset);
    });

    /// A failure is not a reading, so it supersedes nothing: the poll
    /// that started first is still the newest answer there is.
    it("still takes an older call's answer when the newer call failed", async () => {
      const poll = pendingPoll();
      const polling = refreshUsage("claude-code");
      backendMock.agentUsage.mockRejectedValueOnce(new Error("ipc down"));
      await refreshUsage("claude-code", true);

      poll.answer(older);
      await polling;
      expect(get(agentUsageStore)["claude-code"]).toEqual(older);
    });

    it("keeps the refreshing badge up until the newest call answers", async () => {
      backendMock.agentUsage.mockResolvedValueOnce(older);
      const refresh = pendingPoll();
      const first = refreshUsage("claude-code");
      const second = refreshUsage("claude-code", true);
      await first;
      expect(get(usageRefreshingStore)["claude-code"]).toBe(true);

      refresh.answer(newer);
      await second;
      expect(get(usageRefreshingStore)["claude-code"]).toBeUndefined();
      expect(get(agentUsageStore)["claude-code"]).toEqual(newer);
    });

    it("keeps one profile's calls out of another's ordering", async () => {
      const poll = pendingPoll();
      const polling = refreshUsage("codex");
      backendMock.agentUsage.mockResolvedValueOnce(newer);
      await refreshUsage("claude-code", true);

      poll.answer(older);
      await polling;
      expect(get(agentUsageStore)["codex"]).toEqual(older);
    });
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
      workspaces: [{ id: "w1", fallbackChains: { "claude-code": ["codex"] } }],
      activeWorkspaceId: "w1",
    } as never);
    expect(profilesInUse()).toEqual(["claude-code", "codex"]);
  });

  it("unions every primary's chain, not only the workspace agent's", () => {
    layoutState.set({
      workspaces: [
        { id: "w1", fallbackChains: { "claude-code": ["codex"], gemini: ["opencode"] } },
      ],
      activeWorkspaceId: "w1",
    } as never);
    expect(profilesInUse()).toEqual(["claude-code", "codex", "opencode"]);
  });

  /// A rated card can launch on whichever agent the workspace agent's
  /// complexity table names, and that launch is gated on THAT agent's
  /// usage -- so it has to be read even when no chain mentions it.
  it("includes the agents the workspace agent's complexity table routes to", () => {
    agentDefaultsStore.update(
      (d) =>
        ({
          ...d,
          complexityTables: {
            "claude-code": { intricate: { profile: "codex", model: "" } },
            // Another primary's table is not this workspace's.
            gemini: { trivial: { profile: "opencode", model: "" } },
          },
        }) as never
    );
    layoutState.set({ workspaces: [{ id: "w1" }], activeWorkspaceId: "w1" } as never);
    expect(profilesInUse()).toEqual(["claude-code", "codex"]);
    // A workspace's own table replaces the app's for that agent.
    layoutState.set({
      workspaces: [{ id: "w1", complexityTables: { "claude-code": { trivial: { profile: "gemini", model: "" } } } }],
      activeWorkspaceId: "w1",
    } as never);
    expect(profilesInUse()).toEqual(["claude-code", "gemini"]);
  });
});

describe("the gate", () => {
  it("lets work start with no cycle configured at all", () => {
    layoutState.set({ workspaces: [{ id: "w1" }], activeWorkspaceId: "w1" } as never);
    expect(mayStartWork("w1")).toBe(true);
    expect(startBlockedReason("w1")).toBeNull();
  });

  it("reads the workspace's own agent for the limits that matter", () => {
    setAppCycle(cycle({ enabled: false, limitPercent: 90 }));
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
    setAppCycle(cycle({ enabled: false, limitPercent: 90 }));
    layoutState.set({
      workspaces: [{ id: "w1", fallbackChains: { "claude-code": ["codex"] }, armedAgents: ["codex"] }],
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
    agentDefaultsStore.set({
      customCommand: "",
      customModelFlag: "",
      defaultAgent: "claude-code",
      complexityTables: {},
      pauseCycles: {},
      fallbackChains: {},
      fallbackThresholds: { "claude-code": 80 },
      actionPromptOverrides: {},
    } as never);
    setAppCycle(cycle({ enabled: false, limitPercent: 95 }));
    layoutState.set({
      workspaces: [{ id: "w1", fallbackChains: { "claude-code": ["codex"] }, armedAgents: ["codex"] }],
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
    setAppCycle(cycle({ enabled: false, limitPercent: 90 }));
    layoutState.set({
      workspaces: [{ id: "w1", fallbackChains: { "claude-code": ["codex"] } }],
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
    setAppCycle(cycle({ enabled: false, limitPercent: 90 }));
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

  /// Per-primary chains: the chain that walks is the one stored FOR the
  /// launch's resolved agent, not the workspace profile's — a card the
  /// complexity table attributes to Claude walks Claude's chain even in a
  /// Cursor workspace.
  it("walks the chain of the card's resolved primary, not the workspace profile's", () => {
    resolvedAgentForMock.mockReturnValue({ profileId: "cursor" });
    setAppCycle(cycle({ enabled: false, limitPercent: 90 }));
    // Cycles are per primary now (the migration folds an old single cycle
    // onto every agent): a launch resolved to cursor is gated by cursor's.
    setAppCycle(cycle({ enabled: false, limitPercent: 90 }), "cursor");
    layoutState.set({
      workspaces: [
        {
          id: "w1",
          fallbackChains: { "claude-code": ["codex"], cursor: ["gemini"] },
          armedAgents: ["codex", "gemini"],
        },
      ],
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
      // The workspace agent is spent too, so the walk reaches the chain —
      // and must find claude-code's codex, never cursor's gemini.
      cursor: {
        state: "ready",
        windows: [
          { id: "total", label: "Total", usedPercent: 99, resetsAt: null },
          { id: "auto", label: "Auto", usedPercent: 99, resetsAt: null },
        ],
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
    // And cursor's own launches walk cursor's chain.
    expect(launchDecision("w1", "cursor", false)).toEqual({
      kind: "use",
      profileId: "gemini",
      viaFallback: true,
    });
  });

  /// The workspace-agent-first hop survives the per-primary map: it is
  /// tried after the spent primary and before that primary's chain.
  it("still tries the workspace agent before the resolved primary's chain", () => {
    resolvedAgentForMock.mockReturnValue({ profileId: "cursor" });
    setAppCycle(cycle({ enabled: false, limitPercent: 90 }));
    layoutState.set({
      workspaces: [
        {
          id: "w1",
          fallbackChains: { "claude-code": ["codex"] },
          armedAgents: ["codex"],
        },
      ],
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
      workspaces: [{ id: "w1", fallbackChains: { "claude-code": ["codex"] }, armedAgents: ["codex"] }],
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
    setAppCycle(cycle({ enabled: false, limitPercent: 90 }));
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
    setAppCycle(cycle({ enabled: false, limitPercent: 90 }));
    agentUsageStore.set({ "claude-code": atLimit(12) });
    layoutState.set({ workspaces: [{ id: "w1", name: "One" }], activeWorkspaceId: "w1" } as never);
    nowStore.set(ANCHOR);
    expect(get(pausedWorkspaces)).toEqual([]);
  });

  it("is empty when the primary is spent but an armed fallback can launch", () => {
    setAppCycle(cycle({ enabled: false, limitPercent: 90 }));
    agentUsageStore.set({ "claude-code": atLimit(97) });
    layoutState.set({
      workspaces: [
        { id: "w1", name: "One", fallbackChains: { "claude-code": ["codex"] }, armedAgents: ["codex"] },
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
      setAppCycle(cycle({ enabled: false, limitPercent: 90 }));
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
      setAppCycle(cycle({ enabled: false, limitPercent: 90 }));
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
          { id: "w1", name: "One", fallbackChains: { "claude-code": ["codex"] }, armedAgents: ["codex"] },
          { id: "w2", name: "Two" },
        ],
        activeWorkspaceId: "w1",
      } as never);
      stop();
      expect(seen.at(0)).toBe("w1 w2");
      expect(seen.at(-1)).toBe("w2");
    });

    // A card routed to codex launches on codex, gated on codex's own
    // cycle -- which the held-workspace set (read off the workspace's own
    // agent) cannot see. Without this a step skipped for codex's pause
    // would never hear that the pause lifted.
    it("emits when an agent a workspace can route to enters or leaves its own pause window", () => {
      agentDefaultsStore.update(
        (d) =>
          ({
            ...d,
            complexityTables: { "claude-code": { intricate: { profile: "codex", model: "" } } },
          }) as never
      );
      setAppCycle(cycle({ pauseMinutes: 10 }), "codex");
      layoutState.set({ workspaces: [{ id: "w1", name: "One" }], activeWorkspaceId: "w1" } as never);
      nowStore.set(ANCHOR + 100 * MIN);

      const seen: string[] = [];
      const stop = pausedWorkspaceKey.subscribe((k) => seen.push(k));
      // The workspace's own agent keeps no cycle, so it is never "held",
      // yet codex enters its window...
      nowStore.set(ANCHOR + 295 * MIN);
      // ...and leaves it again.
      nowStore.set(ANCHOR + 310 * MIN);
      stop();
      expect(seen).toEqual(["", " | w1:codex", ""]);
    });
  });
});

describe("usage across windows", () => {
  const readyReport: AgentUsageReport = {
    state: "ready",
    windows: [{ id: "five_hour", label: "5-hour", usedPercent: 12, resetsAt: null }],
    plan: "max",
    observedAt: 1,
    cached: false,
  };

  function readingsSent(): unknown[] {
    return eventMock.emit.mock.calls
      .filter(([name]) => name === "agent-usage-reading")
      .map(([, message]) => (message as { payload: unknown }).payload);
  }

  /// The pause clock is every window's; the probe is the app's. A window
  /// that is not the poller keeps its countdowns moving and asks nothing.
  it("starts the clock without probing anything", () => {
    layoutState.set({ workspaces: [{ id: "w1" }], activeWorkspaceId: "w1" } as never);
    startPauseClock();
    expect(backendMock.agentUsage).not.toHaveBeenCalled();
  });

  it("probes every profile in use when the poll starts", () => {
    backendMock.agentUsage.mockResolvedValue(readyReport);
    layoutState.set({ workspaces: [{ id: "w1" }], activeWorkspaceId: "w1" } as never);
    startUsagePoll();
    expect(backendMock.agentUsage).toHaveBeenCalledWith("claude-code", false);
  });

  it("tells the other windows every reading it lands", async () => {
    appDuty.set({ holder: "main", windows: ["main", "ws-2"] });
    backendMock.agentUsage.mockResolvedValueOnce(readyReport);
    await refreshUsage("claude-code");
    expect(readingsSent()).toEqual([
      { profileId: "claude-code", report: readyReport, sampled: true },
    ]);
  });

  it("tells them when a failure leaves the profile unavailable", async () => {
    appDuty.set({ holder: "main", windows: ["main", "ws-2"] });
    backendMock.agentUsage.mockRejectedValueOnce(new Error("ipc down"));
    await refreshUsage("claude-code");
    expect(readingsSent()).toEqual([
      {
        profileId: "claude-code",
        report: expect.objectContaining({ state: "unavailable" }),
        sampled: false,
      },
    ]);
  });

  /// A kept reading changed nothing, so there is nothing to tell.
  it("tells them nothing when a failure kept the last reading", async () => {
    appDuty.set({ holder: "main", windows: ["main", "ws-2"] });
    agentUsageStore.set({ "claude-code": readyReport });
    backendMock.agentUsage.mockRejectedValueOnce(new Error("ipc down"));
    await refreshUsage("claude-code");
    expect(readingsSent()).toEqual([]);
  });

  it("takes a reading another window landed without probing", async () => {
    await initUsageSharing();
    eventMock.fire("agent-usage-reading", {
      origin: "ws-2",
      payload: { profileId: "codex", report: readyReport, sampled: true },
    });
    expect(get(agentUsageStore)["codex"]).toEqual(readyReport);
    expect(backendMock.agentUsage).not.toHaveBeenCalled();
  });

  it("asks the poller for its readings when this window is not the poller", async () => {
    appDuty.set({ holder: "ws-2", windows: ["main", "ws-2"] });
    await initUsageSharing();
    expect(eventMock.emit).toHaveBeenCalledWith("agent-usage-wanted", {
      origin: "main",
      payload: null,
    });
  });

  it("answers a window that has just opened with every reading it holds", async () => {
    appDuty.set({ holder: "main", windows: ["main", "ws-2"] });
    const unsupported: AgentUsageReport = { state: "unsupported" };
    agentUsageStore.set({ "claude-code": readyReport, opencode: unsupported });
    await initUsageSharing();
    expect(eventMock.emit).not.toHaveBeenCalled();

    eventMock.fire("agent-usage-wanted", { origin: "ws-2", payload: null });
    expect(readingsSent()).toEqual([
      { profileId: "claude-code", report: readyReport, sampled: false },
      { profileId: "opencode", report: unsupported, sampled: false },
    ]);
  });

  it("leaves answering to the poller", async () => {
    appDuty.set({ holder: "ws-3", windows: ["main", "ws-2", "ws-3"] });
    agentUsageStore.set({ "claude-code": readyReport });
    await initUsageSharing();
    eventMock.emit.mockClear();
    eventMock.fire("agent-usage-wanted", { origin: "ws-2", payload: null });
    expect(readingsSent()).toEqual([]);
  });
});
