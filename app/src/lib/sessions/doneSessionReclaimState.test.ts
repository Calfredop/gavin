import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { get } from "svelte/store";

// Every store the watcher reads, replaced by one a test can drive. Real
// stores, hand-rolled inside the hoisted block for the reason
// launchQueue.test.ts gives: `vi.hoisted` runs before every import, and
// the module under test derives from these.
const probe = vi.hoisted(() => {
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
        value = fn(value);
        for (const run of [...subscribers]) run(value);
      },
    };
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type Any = any;
  return {
    layoutState: store<Any>({ workspaces: [], activeWorkspaceId: null }),
    kanbanState: store<Record<string, Any>>({}),
    gavinTrees: store<Record<string, Any>>({}),
    agentSessions: store<Record<string, { rssBytes: number }>>({}),
    memoryPressure: store<"normal" | "warn" | "critical">("normal"),
    systemMemory: store<Any>(null),
    launchConfigStore: store({ maxInFlight: 4, holdOnPressure: true, reclaimDoneSessions: true }),
    launchGateVerdict: store<Any>({ allowed: true, reason: null, why: null }),
    launchQueue: store<Any[]>([]),
    orchestrations: store<Record<string, Any>>({}),
    closeSession: vi.fn(),
    closeTabsNow: vi.fn(),
    askConfirm: vi.fn(),
    sendNotification: vi.fn(),
    isPermissionGranted: vi.fn(),
    requestPermission: vi.fn(),
  };
});

vi.mock("$lib/core/layoutState", () => ({ layoutState: probe.layoutState, closeSession: probe.closeSession }));
vi.mock("$lib/board/kanbanState", () => ({ kanbanState: probe.kanbanState }));
vi.mock("$lib/core/gavinState", () => ({ gavinTrees: probe.gavinTrees }));
vi.mock("$lib/agents/memoryState", () => ({
  agentSessions: probe.agentSessions,
  memoryPressure: probe.memoryPressure,
  systemMemory: probe.systemMemory,
}));
vi.mock("$lib/agents/launchQueue", () => ({
  launchConfigStore: probe.launchConfigStore,
  launchGateVerdict: probe.launchGateVerdict,
  launchQueue: probe.launchQueue,
}));
vi.mock("$lib/orchestration/orchestrationState", () => ({ orchestrations: probe.orchestrations }));
vi.mock("$lib/panes/tabActions", () => ({ closeTabsNow: probe.closeTabsNow }));
vi.mock("$lib/core/dialog", () => ({ askConfirm: probe.askConfirm }));
vi.mock("@tauri-apps/plugin-notification", () => ({
  sendNotification: probe.sendNotification,
  isPermissionGranted: probe.isPermissionGranted,
  requestPermission: probe.requestPermission,
}));

import { IDLE_GRACE_MS, RECLAIM_SPACING_MS } from "$lib/sessions/doneSessionReclaim";
import {
  __resetDoneSessionReclaimForTesting,
  reclaimDoneSessionsNow,
  reclaimLog,
  reclaimableNow,
  startDoneSessionReclaim,
} from "$lib/sessions/doneSessionReclaimState";

const GB = 1024 ** 3;
const NOW = 1_800_000_000_000;
const LONG_AGO = NOW - IDLE_GRACE_MS - 1;
const PLANS = "/repo/.gavin-root/plans";

function plan(path: string, status: string | null) {
  const fileName = path.split("/").pop()!;
  return {
    path,
    fileName,
    title: fileName.replace(/\.md$/, ""),
    status,
    priority: null,
    order: null,
    kind: "task",
    parent: null,
    labels: [],
    checklistDone: 0,
    checklistTotal: 0,
    parseWarning: false,
    modifiedAt: Math.floor(LONG_AGO / 1000),
  };
}

/// One workspace whose Agents page holds two idle agents, both bound to
/// done cards: a big one and a small one.
function seed(): void {
  probe.layoutState.set({
    workspaces: [
      {
        id: "ws",
        name: "repo",
        rootPath: "/repo",
        pages: [
          {
            id: "pg",
            name: "Agents",
            layout: { type: "leaf", tabs: ["s-small", "s-big"], activeTabIndex: 0 },
            focusedSessionId: null,
          },
        ],
        activePageId: "pg",
      },
    ],
    activeWorkspaceId: "ws",
    sessionStatusById: { "s-small": "idle", "s-big": "idle" },
    statusSinceById: {
      "s-small": { at: LONG_AGO, watched: true },
      "s-big": { at: LONG_AGO, watched: true },
    },
    sessionNames: { "s-big": "big run", "s-small": "small run" },
    cwdBySessionId: {},
  });
  probe.kanbanState.set({
    ws: {
      columns: [
        { id: "todo", name: "To Do", position: 0 },
        { id: "done", name: "Done", position: 1 },
      ],
      labels: [],
      cardSessions: [
        { path: `${PLANS}/done/a.md`, sessionId: "s-big", cwd: "/repo", command: "claude" },
        { path: `${PLANS}/done/b.md`, sessionId: "s-small", cwd: "/repo", command: "claude" },
      ],
    },
  });
  probe.gavinTrees.set({
    ws: {
      rootPath: "/repo",
      rootMissing: false,
      contexts: [
        {
          folderPath: "/repo/.gavin-root",
          kind: "root",
          name: "root",
          plans: [plan(`${PLANS}/done/a.md`, "Done"), plan(`${PLANS}/done/b.md`, "Done")],
          docs: [],
          specs: [],
          hasPrd: true,
          configWarning: false,
        },
      ],
    },
  });
  probe.agentSessions.set({ "s-big": { rssBytes: 5 * GB }, "s-small": { rssBytes: 1 * GB } });
  probe.memoryPressure.set("normal");
  probe.systemMemory.set(null);
  probe.launchConfigStore.set({ maxInFlight: 4, holdOnPressure: true, reclaimDoneSessions: true });
  probe.launchGateVerdict.set({ allowed: true, reason: null, why: null });
  probe.launchQueue.set([]);
  probe.orchestrations.set({});
}

/// The close as the app performs it: the session leaves its page. A
/// mock that did nothing would look like a refused kill, which the
/// watcher deliberately does not announce.
function closeRemovesFromTree(): void {
  probe.closeSession.mockImplementation(async (id: string) => {
    probe.layoutState.update((s: { workspaces: Array<{ pages: Array<{ layout: { tabs: string[] } }> }> }) => ({
      ...s,
      workspaces: s.workspaces.map((w) => ({
        ...w,
        pages: w.pages.map((p) => ({
          ...p,
          layout: { ...p.layout, tabs: p.layout.tabs.filter((t) => t !== id) },
        })),
      })),
    }));
  });
}

/// Pressure changed, and the poller landed a sample: the two things a
/// real tick does together.
function tick(pressure: "normal" | "warn" | "critical"): void {
  probe.memoryPressure.set(pressure);
  probe.systemMemory.set({ supported: true, totalBytes: 32 * GB, freePercent: 10, pressureLevel: 4, swapUsedBytes: 0, sampledAtMs: Date.now() });
}

async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(1);
}

let stop: (() => void) | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  __resetDoneSessionReclaimForTesting();
  probe.closeSession.mockReset();
  probe.closeTabsNow.mockReset().mockResolvedValue(undefined);
  probe.askConfirm.mockReset();
  probe.sendNotification.mockReset();
  probe.isPermissionGranted.mockReset().mockResolvedValue(true);
  probe.requestPermission.mockReset().mockResolvedValue("granted");
  closeRemovesFromTree();
  seed();
});

afterEach(() => {
  stop?.();
  stop = null;
  __resetDoneSessionReclaimForTesting();
  vi.useRealTimers();
});

describe("the watcher", () => {
  it("closes nothing while the machine is fine", async () => {
    stop = startDoneSessionReclaim();
    await settle();
    tick("normal");
    await settle();
    expect(probe.closeSession).not.toHaveBeenCalled();
  });

  it("at critical pressure closes the biggest idle agent of a done card, once, and says so", async () => {
    stop = startDoneSessionReclaim();
    tick("critical");
    await settle();
    expect(probe.closeSession).toHaveBeenCalledTimes(1);
    expect(probe.closeSession).toHaveBeenCalledWith("s-big");
    expect(get(reclaimLog)).toHaveLength(1);
    expect(get(reclaimLog)[0]).toMatchObject({ sessionId: "s-big", label: "big run", cardTitle: "a", reason: "critical" });

    // Another sample lands at once: the first close has not reached the
    // poll and the spacing has not run, so the small one waits.
    tick("critical");
    await settle();
    expect(probe.closeSession).toHaveBeenCalledTimes(1);

    // The poll sees the fleet shrink: the next close may go.
    probe.agentSessions.set({ "s-small": { rssBytes: 1 * GB } });
    tick("critical");
    await settle();
    expect(probe.closeSession).toHaveBeenCalledTimes(2);
    expect(probe.closeSession).toHaveBeenLastCalledWith("s-small");

    // One notification for the burst, after it has quietened.
    expect(probe.sendNotification).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(probe.sendNotification).toHaveBeenCalledTimes(1);
    expect(probe.sendNotification.mock.calls[0][0].body).toBe(
      "Closed 2 idle agents of done cards to free 6 GB — memory was critical."
    );
  });

  it("lets the spacing alone release the next close when the sample never shrinks", async () => {
    stop = startDoneSessionReclaim();
    tick("critical");
    await settle();
    expect(probe.closeSession).toHaveBeenCalledTimes(1);
    // The re-check timer fires before the spacing has run: still one.
    await vi.advanceTimersByTimeAsync(RECLAIM_SPACING_MS / 2);
    expect(probe.closeSession).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(RECLAIM_SPACING_MS);
    expect(probe.closeSession).toHaveBeenCalledTimes(2);
  });

  it("at warn pressure closes only once work is waiting behind the hold", async () => {
    stop = startDoneSessionReclaim();
    tick("warn");
    await settle();
    expect(probe.closeSession).not.toHaveBeenCalled();

    probe.launchGateVerdict.set({ allowed: false, reason: "pressure", why: "Held: memory pressure" });
    probe.launchQueue.set([{ id: "q1", kind: "commit", workspaceId: "ws", label: "Commit", askedAtMs: NOW, retries: 0 }]);
    await settle();
    expect(probe.closeSession).toHaveBeenCalledTimes(1);
    expect(get(reclaimLog)[0].reason).toBe("blocking");
  });

  it("counts a held rail as waiting work", async () => {
    stop = startDoneSessionReclaim();
    probe.launchGateVerdict.set({ allowed: false, reason: "pressure", why: "Held: memory pressure" });
    probe.orchestrations.set({
      ws: {
        rails: [
          {
            id: "r1",
            name: "Rail",
            position: 0,
            worktreePath: null,
            stages: [{ id: "st1", position: 0, steps: [{ id: "a", position: 0, cardPath: "/a.md" }] }],
          },
        ],
        conflictNotes: [],
        railRuns: [{ railId: "r1", state: "running", currentStageId: "st1" }],
        stepRuns: [],
      },
    });
    tick("warn");
    await settle();
    expect(probe.closeSession).toHaveBeenCalledTimes(1);
  });

  it("does nothing with the switch off", async () => {
    probe.launchConfigStore.set({ maxInFlight: 4, holdOnPressure: true, reclaimDoneSessions: false });
    stop = startDoneSessionReclaim();
    tick("critical");
    await settle();
    expect(probe.closeSession).not.toHaveBeenCalled();
  });

  it("never announces a close that did not happen", async () => {
    // The close path reports a refused kill to the error strip and
    // returns; the session is still on its page.
    probe.closeSession.mockReset().mockResolvedValue(undefined);
    stop = startDoneSessionReclaim();
    tick("critical");
    await settle();
    expect(probe.closeSession).toHaveBeenCalledTimes(1);
    expect(get(reclaimLog)).toEqual([]);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(probe.sendNotification).not.toHaveBeenCalled();
  });

  it("stops closing when torn down", async () => {
    stop = startDoneSessionReclaim();
    stop();
    stop = null;
    tick("critical");
    await settle();
    expect(probe.closeSession).not.toHaveBeenCalled();
  });
});

describe("the manual close", () => {
  it("offers every idle agent of a done card with no grace, asks once, and closes them all", async () => {
    // Just went idle: the watcher would wait; the human need not.
    probe.layoutState.update((s: { statusSinceById: Record<string, unknown> }) => ({
      ...s,
      statusSinceById: { ...s.statusSinceById, "s-small": { at: NOW - 1000, watched: true } },
    }));
    expect(get(reclaimableNow).map((c) => c.sessionId)).toEqual(["s-big", "s-small"]);

    probe.askConfirm.mockResolvedValue(true);
    expect(await reclaimDoneSessionsNow()).toBe(2);
    expect(probe.askConfirm).toHaveBeenCalledTimes(1);
    expect(probe.askConfirm.mock.calls[0][0].title).toBe("Close 2 idle agents of done cards?");
    expect(probe.closeTabsNow).toHaveBeenCalledWith(["s-big", "s-small"]);
    // The human's close, not gavin's: the log is what gavin did by itself.
    expect(get(reclaimLog)).toEqual([]);
  });

  it("closes nothing when declined, and asks nothing when there is nothing", async () => {
    probe.askConfirm.mockResolvedValue(false);
    expect(await reclaimDoneSessionsNow()).toBe(0);
    expect(probe.closeTabsNow).not.toHaveBeenCalled();

    probe.agentSessions.set({});
    expect(get(reclaimableNow)).toEqual([]);
    probe.askConfirm.mockReset();
    expect(await reclaimDoneSessionsNow()).toBe(0);
    expect(probe.askConfirm).not.toHaveBeenCalled();
  });
});
