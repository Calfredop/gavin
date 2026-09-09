import { describe, it, expect, vi, beforeEach } from "vitest";
import { get, writable } from "svelte/store";

vi.mock("$lib/core/backend", () => ({ toolRuns: vi.fn().mockResolvedValue([]) }));
vi.mock("$lib/core/layoutState", () => ({
  daemonCompat: writable({ daemonVersion: 30, appVersion: 30, degraded: false }),
  sessionExits: writable(new Map<string, number>()),
}));

import * as backend from "$lib/core/backend";
import { daemonCompat, sessionExits } from "$lib/core/layoutState";
import {
  noteToolRunStarted,
  refreshToolRuns,
  startToolRunWatcher,
  toolRunsStore,
  __resetForTesting,
} from "$lib/orchestration/toolRunsState";
import { lastRunsFor } from "$lib/workspace/workspaceTools";
import type { ToolRun } from "$lib/workspace/workspaceTools";

function row(over: Partial<ToolRun> = {}): ToolRun {
  return {
    id: 1,
    toolId: "u1",
    sessionId: "s-1",
    command: null,
    launchCwd: null,
    conversationId: null,
    startedAt: 1,
    endedAt: null,
    exitCode: null,
    outcome: "passed",
    ...over,
  };
}

const V30 = { daemonVersion: 30, appVersion: 30, degraded: false };
const V29 = { daemonVersion: 29, appVersion: 30, degraded: true };

let stop: (() => void) | null = null;

beforeEach(() => {
  stop?.();
  stop = null;
  __resetForTesting();
  vi.clearAllMocks();
  vi.mocked(backend.toolRuns).mockResolvedValue([]);
  daemonCompat.set(V30);
  sessionExits.set(new Map());
});

describe("refreshToolRuns", () => {
  it("stores what the daemon answers", async () => {
    vi.mocked(backend.toolRuns).mockResolvedValue([row()]);
    await refreshToolRuns("ws-1", V30);
    expect(lastRunsFor(get(toolRunsStore), "ws-1").get("u1")?.outcome).toBe("passed");
  });

  // The reason for a v29 daemon's empty list is already on every Run
  // button; a fetch error above the list would say it a second time
  // about a list that is empty for exactly that reason.
  it("asks nothing of a daemon that keeps no runs, and says nothing about it", async () => {
    await refreshToolRuns("ws-1", V29);
    expect(backend.toolRuns).not.toHaveBeenCalled();
    expect(get(toolRunsStore)["ws-1"]).toBeUndefined();
  });

  // A chip that blanks and comes back on every session exit reads as a
  // run that was lost.
  it("keeps the rows it has while a re-read is in flight", async () => {
    vi.mocked(backend.toolRuns).mockResolvedValue([row()]);
    await refreshToolRuns("ws-1", V30);
    let release: (value: ToolRun[]) => void = () => {};
    vi.mocked(backend.toolRuns).mockReturnValue(new Promise((r) => (release = r)));
    const inFlight = refreshToolRuns("ws-1", V30);
    expect(get(toolRunsStore)["ws-1"].runs).toHaveLength(1);
    expect(get(toolRunsStore)["ws-1"].loading).toBe(true);
    release([]);
    await inFlight;
    expect(get(toolRunsStore)["ws-1"].runs).toHaveLength(0);
  });

  it("reports a failed read without dropping the rows", async () => {
    vi.mocked(backend.toolRuns).mockResolvedValue([row()]);
    await refreshToolRuns("ws-1", V30);
    vi.mocked(backend.toolRuns).mockRejectedValue(new Error("socket gone"));
    await refreshToolRuns("ws-1", V30);
    expect(get(toolRunsStore)["ws-1"].error).toMatch(/socket gone/);
    expect(get(toolRunsStore)["ws-1"].runs).toHaveLength(1);
  });

  // A token counter, not an identity check: `$state` proxies objects, so
  // "is this still the fetch I started" cannot be answered by comparison.
  it("drops a superseded fetch's result", async () => {
    let releaseFirst: (value: ToolRun[]) => void = () => {};
    vi.mocked(backend.toolRuns).mockReturnValueOnce(new Promise((r) => (releaseFirst = r)));
    const first = refreshToolRuns("ws-1", V30);
    vi.mocked(backend.toolRuns).mockResolvedValue([row({ id: 2, outcome: "failed" })]);
    await refreshToolRuns("ws-1", V30);
    releaseFirst([row({ id: 1, outcome: "passed" })]);
    await first;
    expect(get(toolRunsStore)["ws-1"].runs[0].outcome).toBe("failed");
  });
});

describe("noteToolRunStarted", () => {
  // The daemon has the real row; this buys the half-second before the
  // next fetch, which is precisely when the human is looking at the
  // button they just pressed.
  it("shows the run as running straight away", () => {
    noteToolRunStarted({
      workspaceId: "ws-1",
      toolId: "u1",
      sessionId: "s-9",
      command: "x",
      launchCwd: "/r",
      conversationId: null,
    });
    const run = lastRunsFor(get(toolRunsStore), "ws-1").get("u1");
    expect(run?.outcome).toBe("running");
    expect(run?.sessionId).toBe("s-9");
  });

  it("replaces the tool's previous row rather than stacking one on it", async () => {
    vi.mocked(backend.toolRuns).mockResolvedValue([row({ outcome: "failed" })]);
    await refreshToolRuns("ws-1", V30);
    noteToolRunStarted({
      workspaceId: "ws-1",
      toolId: "u1",
      sessionId: "s-9",
      command: null,
      launchCwd: null,
      conversationId: null,
    });
    expect(get(toolRunsStore)["ws-1"].runs).toHaveLength(1);
    expect(get(toolRunsStore)["ws-1"].runs[0].sessionId).toBe("s-9");
  });
});

describe("the session-exit watcher", () => {
  // The whole reason this store is not two lines: the daemon closes a
  // command or script run by itself and pushes nothing, so a tab left
  // open would show `running` on a tool that finished a minute ago.
  it("re-reads every loaded workspace when a session ends", async () => {
    await refreshToolRuns("ws-1", V30);
    await refreshToolRuns("ws-2", V30);
    stop = startToolRunWatcher();
    vi.mocked(backend.toolRuns).mockClear();

    sessionExits.set(new Map([["s-1", 0]]));
    await Promise.resolve();

    expect(vi.mocked(backend.toolRuns).mock.calls.map((c) => c[0]).sort()).toEqual(["ws-1", "ws-2"]);
  });

  // A store emits its current value on subscribe, and that emission is
  // not a session ending.
  it("does not fire on the subscription's own first emission", async () => {
    await refreshToolRuns("ws-1", V30);
    vi.mocked(backend.toolRuns).mockClear();
    stop = startToolRunWatcher();
    await Promise.resolve();
    expect(backend.toolRuns).not.toHaveBeenCalled();
  });

  it("stops when it is torn down", async () => {
    await refreshToolRuns("ws-1", V30);
    stop = startToolRunWatcher();
    stop();
    stop = null;
    vi.mocked(backend.toolRuns).mockClear();
    sessionExits.set(new Map([["s-1", 0]]));
    await Promise.resolve();
    expect(backend.toolRuns).not.toHaveBeenCalled();
  });
});
