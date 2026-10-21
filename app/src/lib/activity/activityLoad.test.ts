import { describe, it, expect, vi } from "vitest";
import type { Workspace } from "$lib/core/workspace";
import type { SshLinks } from "$lib/workspace/sshWorkspace";
import { FEATURE_MIN_VERSION } from "$lib/core/daemonCompat";
import {
  loadActivity,
  missingLines,
  planLoads,
  unavailableLine,
  unavailableTip,
  type LoadDeps,
} from "$lib/activity/activityLoad";

function ws(id: string, over: Partial<Workspace> = {}): Workspace {
  return { id, name: id.toUpperCase(), pages: [], activePageId: null, rootPath: `/r/${id}`, ...over };
}

const NEW = { daemonVersion: FEATURE_MIN_VERSION.activityCalendar, appVersion: FEATURE_MIN_VERSION.activityCalendar, degraded: false };
const OLD = { ...NEW, daemonVersion: FEATURE_MIN_VERSION.activityCalendar - 1, degraded: true };
const WINDOW = { since: 100, until: 200 };

function deps(over: Partial<LoadDeps> = {}): LoadDeps {
  return {
    activityRuns: vi.fn(async () => []),
    gitActivity: vi.fn(async () => ({ commits: [], pushes: [] })),
    ...over,
  };
}

describe("planLoads", () => {
  it("reads a local workspace's runs and history, and only runs without a folder", () => {
    const [local, folderless] = planLoads([ws("a"), ws("b", { rootPath: undefined })], NEW, {});
    expect(local).toMatchObject({ unreachable: null, runs: "read", git: "read", cwd: "/r/a" });
    expect(folderless).toMatchObject({ runs: "read", git: "none", cwd: null });
  });

  it("does not ask a local daemon too old for the run read, and still reads git", () => {
    const [plan] = planLoads([ws("a")], OLD, {});
    expect(plan.git).toBe("read");
    expect(typeof plan.runs === "object" && plan.runs.blocked).toContain(`v${FEATURE_MIN_VERSION.activityCalendar}`);
  });

  it("gates an ssh workspace on its host's link and its host's daemon, never the local one", () => {
    const remote = ws("s", { ssh: { host: "box" } });
    const down: SshLinks = { box: { status: "lost", message: "gone" } };
    expect(planLoads([remote], NEW, down)[0].unreachable).toContain("Not connected to box");
    expect(planLoads([remote], NEW, {})[0].unreachable).toContain("Connecting to box");

    const oldHost: SshLinks = { box: { status: "ready", daemonVersion: FEATURE_MIN_VERSION.activityCalendar - 1 } };
    const plan = planLoads([remote], NEW, oldHost)[0];
    expect(plan.unreachable).toBeNull();
    expect(typeof plan.runs === "object" && plan.runs.blocked).toContain("on box");
    expect(plan.git).toBe("read");

    const newHost: SshLinks = { box: { status: "ready", daemonVersion: FEATURE_MIN_VERSION.activityCalendar } };
    expect(planLoads([remote], OLD, newHost)[0]).toMatchObject({ runs: "read", git: "read" });
  });
});

describe("loadActivity", () => {
  it("asks each workspace once per source, over the whole window", async () => {
    const d = deps();
    const load = await loadActivity(planLoads([ws("a"), ws("b", { rootPath: undefined })], NEW, {}), WINDOW, d);
    expect(d.activityRuns).toHaveBeenCalledTimes(2);
    expect(d.activityRuns).toHaveBeenCalledWith("a", 100, 200);
    expect(d.gitActivity).toHaveBeenCalledTimes(1);
    expect(d.gitActivity).toHaveBeenCalledWith("/r/a", 100);
    expect(load.sources.map((s) => [s.workspaceId, s.runs !== null, s.git !== null])).toEqual([
      ["a", true, true],
      ["b", true, false],
    ]);
    expect(load.unavailable).toEqual([]);
  });

  it("counts a workspace whose read failed, keeping what its other read returned", async () => {
    const d = deps({
      gitActivity: vi.fn(async (cwd: string) => {
        if (cwd === "/r/b") throw new Error("git timed out");
        return { commits: [], pushes: [] };
      }),
    });
    const load = await loadActivity(planLoads([ws("a"), ws("b")], NEW, {}), WINDOW, d);
    expect(load.unavailable).toEqual([{ workspaceId: "b", name: "B", reason: "git timed out" }]);
    expect(load.sources.find((s) => s.workspaceId === "b")).toMatchObject({ runs: [], git: null });
    expect(unavailableLine(load, "app")).toBe("1 workspace unavailable");
    expect(unavailableLine(load, "workspace")).toBe("Activity unavailable — git timed out");
    expect(unavailableTip(load)).toBe("B: git timed out");
  });

  it("skips an unreachable host without asking it anything", async () => {
    const d = deps();
    const plans = planLoads([ws("a"), ws("s", { ssh: { host: "box" } }), ws("t", { ssh: { host: "box" } })], NEW, {
      box: { status: "lost" },
    });
    const load = await loadActivity(plans, WINDOW, d);
    expect(d.activityRuns).toHaveBeenCalledTimes(1);
    expect(load.sources.map((s) => s.workspaceId)).toEqual(["a"]);
    expect(unavailableLine(load, "app")).toBe("2 workspaces unavailable");
  });

  it("says once that a too-old daemon keeps the runs off, naming the workspaces", async () => {
    const d = deps();
    const load = await loadActivity(planLoads([ws("a"), ws("b")], OLD, {}), WINDOW, d);
    expect(d.activityRuns).not.toHaveBeenCalled();
    expect(load.sources.every((s) => s.runs === null && s.git !== null)).toBe(true);
    expect(load.missing).toHaveLength(1);
    const [line] = missingLines(load, "app");
    expect(line).toMatch(/^Runs are not shown for A, B\. Needs daemon v\d+/);
    expect(missingLines(load, "workspace")[0]).toMatch(/^Runs are not shown\. Needs daemon/);
    expect(load.unavailable).toEqual([]);
  });
});
