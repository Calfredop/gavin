import { beforeEach, describe, expect, it, vi } from "vitest";
import { get } from "svelte/store";

// The probe, replaced by three stores a test can drive. The real module
// polls the daemon on a timer and reads `layoutState`; what this file is
// about is what the queue does with the ANSWER.
/// Hoisted so the `vi.mock` factories below -- which are lifted above
/// every import in the file -- can close over them. REAL stores, not
/// bare objects: `get()` and `derived()` need the store contract, and a
/// stub makes the failure read as an unrelated crash.
const probe = vi.hoisted(() => {
  /// A minimal writable, hand-rolled inside the hoisted block.
  ///
  /// `vi.hoisted` runs before every import in the file, so it cannot
  /// `import` svelte's own -- and the mocks below need REAL stores, because
  /// the module under test subscribes to them and derives from them. The
  /// store contract is three methods; this is those three.
  function store<T>(initial: T) {
    let value = initial;
    const subscribers = new Set<(v: T) => void>();
    return {
      subscribe(run: (v: T) => void) {
        subscribers.add(run);
        run(value);
        return () => void subscribers.delete(run);
      },
      set(next: T) {
        value = next;
        for (const run of [...subscribers]) run(value);
      },
      update(fn: (v: T) => T) {
        const next = fn(value);
        value = next;
        for (const run of [...subscribers]) run(value);
      },
    };
  }

  return {
    agentSessions: store<Record<string, { rssBytes: number }>>({}),
    memoryPressure: store<"normal" | "warn" | "critical">("normal"),
    systemMemory: store<unknown>({
      supported: true,
      totalBytes: 32 * 1024 ** 3,
      freePercent: 50,
      pressureLevel: 1,
      swapUsedBytes: 0,
      sampledAtMs: 0,
    }),
    fleetMemory: store({ rssBytes: 0, agents: 0, meanByProfile: {} as Record<string, number> }),
    storedMeans: store<Record<string, number>>({}),
    layoutState: store<{ sessionStatusById: Record<string, string> }>({ sessionStatusById: {} }),
  };
});
const { agentSessions, memoryPressure, systemMemory, layoutState } = probe;
vi.mock("$lib/agents/memoryState", () => ({
  agentSessions: probe.agentSessions,
  memoryPressure: probe.memoryPressure,
  systemMemory: probe.systemMemory,
  fleetMemory: probe.fleetMemory,
  storedMeans: probe.storedMeans,
}));
vi.mock("$lib/layoutState", () => ({
  layoutState: probe.layoutState,
  resolvedAgentFor: () => ({ profileId: "claude-code" }),
}));

vi.mock("$lib/shell/appWindowState", () => ({ currentWindowLabel: () => "main" }));
vi.mock("$lib/agents/agentPauseState", () => ({ setGateReasonHook: vi.fn() }));
vi.mock("$lib/backend", () => ({
  getLaunchConfig: vi.fn().mockResolvedValue(null),
  setLaunchConfig: vi.fn().mockResolvedValue(undefined),
}));

// The five modules the drain hands an intent back to. Each is loaded by
// a dynamic import inside `execute`, so mocking them here is what lets a
// test see which launcher a queued intent reached.
const launchQueuedCard = vi.fn().mockResolvedValue(undefined);
const launchQueuedTool = vi.fn().mockResolvedValue(undefined);
const launchQueuedReview = vi.fn().mockResolvedValue(undefined);
const launchQueuedCommit = vi.fn().mockResolvedValue(undefined);
const launchQueuedOrchestrationAgent = vi.fn().mockResolvedValue(undefined);
vi.mock("$lib/cards/cardRunActions", () => ({ launchQueuedCard }));
vi.mock("$lib/workspaceToolsActions", () => ({ launchQueuedTool }));
vi.mock("$lib/review/codeReviewActions", () => ({ launchQueuedReview }));
vi.mock("$lib/git/gitState", () => ({ launchQueuedCommit }));
vi.mock("$lib/orchestration/orchestrationState", () => ({ launchQueuedOrchestrationAgent }));

import {
  __resetLaunchQueueForTesting,
  cancelCardLaunches,
  cancelLaunch,
  enqueueLaunch,
  holdOrQueue,
  inFlightCount,
  launchBlockedReason,
  launchConfigStore,
  launchGateVerdict,
  launchQueue,
  launchQueueKey,
  loadLaunchQueue,
  mayLaunch,
  parseLaunchQueue,
  queuedCount,
  queuedForCard,
  saveLaunchQueue,
  startLaunchQueue,
  stopLaunchQueue,
  type LaunchIntent,
} from "$lib/agents/launchQueue";

/// A localStorage stand-in: vitest's node environment has none, which is
/// exactly why every persistence function here takes one.
function fakeStorage(): Pick<Storage, "getItem" | "setItem" | "removeItem"> & {
  map: Map<string, string>;
} {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

/// Lets the drain's dynamic imports and awaits settle.
async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/// A measured agent row: the fields the queue's own joins read.
function rss(): { rssBytes: number } {
  return { rssBytes: 2 * 1024 ** 3 };
}

const CARD = {
  kind: "card",
  workspaceId: "w1",
  label: "Login flow",
  cardPath: "plans/login.md",
  mode: "run",
  automatic: false,
} as const;

beforeEach(() => {
  __resetLaunchQueueForTesting();
  agentSessions.set({});
  memoryPressure.set("normal");
  layoutState.set({ sessionStatusById: {} });
  launchQueuedCard.mockClear();
  launchQueuedTool.mockClear();
  launchQueuedReview.mockClear();
  launchQueuedCommit.mockClear();
  launchQueuedOrchestrationAgent.mockClear();
});

describe("inFlightCount", () => {
  // The join is the point: sessions says which are agents, statuses say
  // what each is doing. Either alone would be wrong in opposite
  // directions -- every open terminal, or every agent tab ever left.
  it("counts agent sessions that are working or asking, and nothing else", () => {
    agentSessions.set({ a: rss(), b: rss(), c: rss(), d: rss() });
    layoutState.set({
      sessionStatusById: {
        a: "working",
        b: "waiting_for_input",
        c: "idle",
        d: "failed",
        // A shell the fleet sample never listed: not an agent, not counted.
        shell: "working",
      },
    });
    expect(get(inFlightCount)).toBe(2);
  });
});

describe("the verdict store", () => {
  it("allows starts on a quiet machine", () => {
    expect(get(launchGateVerdict).allowed).toBe(true);
    expect(mayLaunch()).toBe(true);
    expect(launchBlockedReason()).toBeNull();
  });

  it("holds once the ceiling is full", () => {
    agentSessions.set({ a: rss(), b: rss(), c: rss(), d: rss() });
    layoutState.set({
      sessionStatusById: { a: "working", b: "working", c: "working", d: "working" },
    });
    expect(mayLaunch()).toBe(false);
    expect(launchBlockedReason()).toBe("Waiting for a slot: 4 of 4 agents running");
  });

  it("holds under memory pressure", () => {
    memoryPressure.set("critical");
    expect(mayLaunch()).toBe(false);
    expect(launchBlockedReason()).toContain("Held: memory is critical");
  });
});

describe("holdOrQueue", () => {
  it("lets a launch through and queues nothing while starts are allowed", () => {
    expect(holdOrQueue(CARD)).toBeNull();
    expect(get(launchQueue)).toEqual([]);
  });

  it("queues the intent and hands back the gate's sentence when it holds", () => {
    memoryPressure.set("warn");
    const why = holdOrQueue(CARD);
    expect(why).toContain("Held: memory pressure");
    expect(get(launchQueue)).toHaveLength(1);
    expect(queuedForCard("w1", "plans/login.md")?.mode).toBe("run");
  });

  // Pressing Run twice on one card must not queue two launches of it,
  // and neither must a surface that re-renders and asks again.
  it("does not queue the same launch twice", () => {
    memoryPressure.set("warn");
    holdOrQueue(CARD);
    holdOrQueue(CARD);
    expect(get(launchQueue)).toHaveLength(1);
  });

  // A resume and a run on the same card are different launches with
  // different prompts, so they are different intents.
  it("treats a different mode on the same card as its own intent", () => {
    memoryPressure.set("warn");
    holdOrQueue(CARD);
    holdOrQueue({ ...CARD, mode: "resume" });
    expect(get(launchQueue)).toHaveLength(2);
  });
});

describe("cancelling", () => {
  it("drops one intent by id", () => {
    memoryPressure.set("warn");
    const intent = enqueueLaunch(CARD);
    enqueueLaunch({ ...CARD, cardPath: "plans/other.md" });
    cancelLaunch(intent.id);
    expect(get(launchQueue).map((i) => (i as { cardPath: string }).cardPath)).toEqual([
      "plans/other.md",
    ]);
  });

  it("drops every intent for one card", () => {
    memoryPressure.set("warn");
    enqueueLaunch(CARD);
    enqueueLaunch({ ...CARD, mode: "resume" });
    enqueueLaunch({ ...CARD, cardPath: "plans/other.md" });
    cancelCardLaunches("w1", "plans/login.md");
    expect(queuedCount()).toBe(1);
  });
});

describe("persistence", () => {
  it("round-trips a queue through storage", () => {
    const storage = fakeStorage();
    const queue: LaunchIntent[] = [
      { ...CARD, id: "q1", askedAtMs: 5 },
      { id: "q2", kind: "commit", workspaceId: "w1", label: "commit", askedAtMs: 6, retries: 1 },
    ];
    saveLaunchQueue(queue, storage);
    expect(loadLaunchQueue(storage)).toEqual(queue);
    expect(storage.map.has(launchQueueKey("main"))).toBe(true);
  });

  it("clears the key rather than storing an empty list", () => {
    const storage = fakeStorage();
    saveLaunchQueue([{ ...CARD, id: "q1", askedAtMs: 5 }], storage);
    saveLaunchQueue([], storage);
    expect(storage.map.has(launchQueueKey("main"))).toBe(false);
  });

  // A half-written or hand-edited entry must not reach the drain, which
  // would call a launcher with no arguments. One bad row must not cost
  // the other ten.
  it("drops rows that are not intents and keeps the rest", () => {
    const good = JSON.stringify({ ...CARD, id: "q1", askedAtMs: 5 });
    const raw = `[${good},{"id":"q2"},{"id":"q3","kind":"card","workspaceId":"w1","label":"x","askedAtMs":1},null,7]`;
    expect(parseLaunchQueue(raw)).toHaveLength(1);
  });

  it("reads unparseable or absent state as an empty queue", () => {
    expect(parseLaunchQueue(null)).toEqual([]);
    expect(parseLaunchQueue("not json")).toEqual([]);
    expect(parseLaunchQueue('{"queue":[]}')).toEqual([]);
  });
});

/// Fills the ceiling, so the gate holds for a reason with no hysteresis
/// attached -- unlike pressure, a slot frees the instant an agent goes
/// idle.
function fillCeiling(): void {
  agentSessions.set({ a: rss(), b: rss(), c: rss(), d: rss() });
  layoutState.set({
    sessionStatusById: { a: "working", b: "working", c: "working", d: "working" },
  });
}

function freeSlots(): void {
  agentSessions.set({});
  layoutState.set({ sessionStatusById: {} });
}

describe("draining", () => {
  it("releases a queued intent as soon as a slot frees", async () => {
    fillCeiling();
    holdOrQueue(CARD);
    startLaunchQueue();
    await settle();
    expect(launchQueuedCard).not.toHaveBeenCalled();

    freeSlots();
    await settle();
    expect(launchQueuedCard).toHaveBeenCalledTimes(1);
    expect(get(launchQueue)).toHaveLength(0);
    stopLaunchQueue();
  });

  // One at a time: the gate's answer is about the fleet as it is now,
  // and every release changes that fleet. Draining two against one
  // reading is the burst this whole feature exists to stop.
  it("releases only one intent per pass, in arrival order", async () => {
    fillCeiling();
    holdOrQueue(CARD);
    holdOrQueue({ ...CARD, cardPath: "plans/second.md", label: "Second" });
    startLaunchQueue();
    await settle();
    freeSlots();
    await settle();
    expect(launchQueuedCard).toHaveBeenCalledTimes(1);
    expect(launchQueuedCard.mock.calls[0][0].cardPath).toBe("plans/login.md");
    expect(get(launchQueue)).toHaveLength(1);
    stopLaunchQueue();
  });

  // The hysteresis, end to end: a queue that emptied the instant the
  // kernel stopped complaining would empty into the same crash it was
  // built to prevent.
  it("keeps a queue held for the whole window after pressure lifts", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      memoryPressure.set("warn");
      holdOrQueue(CARD);
      startLaunchQueue();
      await settle();
      memoryPressure.set("normal");
      await settle();
      expect(launchQueuedCard).not.toHaveBeenCalled();

      vi.setSystemTime(Date.now() + 31_000);
      // The poller replacing the sample is what makes the verdict
      // recompute; nothing else ticks on that clock.
      systemMemory.update((sample) => ({ ...(sample as object) }));
      await settle();
      expect(launchQueuedCard).toHaveBeenCalledTimes(1);
    } finally {
      stopLaunchQueue();
      vi.useRealTimers();
    }
  });

  it("hands each kind of intent back to the module that owns it", async () => {
    startLaunchQueue();
    enqueueLaunch({ kind: "commit", workspaceId: "w1", label: "commit", retries: 0 });
    await settle();
    expect(launchQueuedCommit).toHaveBeenCalledTimes(1);
    stopLaunchQueue();
  });

  // A launcher that throws has already lost its own launch. The queue's
  // job is to keep going rather than retry the same intent for ever.
  it("does not put a failed launch back at the head of the queue", async () => {
    launchQueuedCard.mockRejectedValueOnce(new Error("no such card"));
    startLaunchQueue();
    enqueueLaunch(CARD);
    await settle();
    expect(get(launchQueue)).toHaveLength(0);
    stopLaunchQueue();
  });

  it("drains nothing while the gate is holding", async () => {
    fillCeiling();
    startLaunchQueue();
    enqueueLaunch(CARD);
    await settle();
    expect(launchQueuedCard).not.toHaveBeenCalled();
    expect(get(launchQueue)).toHaveLength(1);
    stopLaunchQueue();
  });
});

describe("the config store", () => {
  it("starts at the shipped default -- four agents, pressure hold on", () => {
    expect(get(launchConfigStore)).toEqual({ maxInFlight: 4, holdOnPressure: true, reclaimDoneSessions: true });
  });
});
