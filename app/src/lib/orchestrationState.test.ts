import { describe, it, expect, vi, beforeEach } from "vitest";
import { get } from "svelte/store";

vi.mock("./backend", () => ({
  getOrchestration: vi.fn(),
  setOrchestration: vi.fn(),
  setRailRun: vi.fn(),
  setStepRun: vi.fn(),
}));

import * as backend from "./backend";
import {
  orchestrations,
  fetchOrchestration,
  mutatePlan,
  setRailRunAction,
  setStepRunAction,
  saveErrors,
  dismissSaveError,
  __resetForTesting,
} from "./orchestrationState";
import { emptyOrchestration } from "./orchestration";
import type { Orchestration, Rail } from "./orchestration";

function rail(id: string): Rail {
  return { id, name: id, position: 0, worktreePath: null, pageId: null, stages: [] };
}

function withRails(...ids: string[]): Orchestration {
  return { ...emptyOrchestration(), rails: ids.map(rail) };
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetForTesting();
});

describe("fetchOrchestration", () => {
  it("loads once and caches", async () => {
    vi.mocked(backend.getOrchestration).mockResolvedValue(withRails("r1"));
    await fetchOrchestration("ws-1");
    await fetchOrchestration("ws-1");
    expect(backend.getOrchestration).toHaveBeenCalledTimes(1);
    expect(get(orchestrations)["ws-1"].rails[0].id).toBe("r1");
  });

  it("leaves the workspace unset when the load fails", async () => {
    vi.mocked(backend.getOrchestration).mockRejectedValue(new Error("nope"));
    await fetchOrchestration("ws-1");
    expect(get(orchestrations)["ws-1"]).toBeUndefined();
  });
});

describe("mutatePlan", () => {
  it("applies optimistically and persists the whole plan", async () => {
    vi.mocked(backend.getOrchestration).mockResolvedValue(withRails("r1"));
    vi.mocked(backend.setOrchestration).mockResolvedValue(undefined);
    await fetchOrchestration("ws-1");

    await mutatePlan("ws-1", (o) => ({ ...o, rails: [...o.rails, rail("r2")] }));

    expect(get(orchestrations)["ws-1"].rails.map((r) => r.id)).toEqual(["r1", "r2"]);
    expect(backend.setOrchestration).toHaveBeenCalledWith(
      "ws-1",
      [expect.objectContaining({ id: "r1" }), expect.objectContaining({ id: "r2" })],
      []
    );
  });

  it("rolls back and records the message when the save fails", async () => {
    vi.mocked(backend.getOrchestration).mockResolvedValue(withRails("r1"));
    vi.mocked(backend.setOrchestration).mockRejectedValue(
      new Error("step t1 (/x/a.md) is running — pause or let it finish before removing it")
    );
    await fetchOrchestration("ws-1");

    await mutatePlan("ws-1", (o) => ({ ...o, rails: [] }));

    expect(get(orchestrations)["ws-1"].rails.map((r) => r.id)).toEqual(["r1"]);
    expect(get(saveErrors)["ws-1"]).toContain("is running");
    dismissSaveError("ws-1");
    expect(get(saveErrors)["ws-1"]).toBeUndefined();
  });

  it("is a no-op for a workspace that was never fetched", async () => {
    await mutatePlan("ws-nope", (o) => ({ ...o, rails: [rail("r1")] }));
    expect(backend.setOrchestration).not.toHaveBeenCalled();
  });
});

describe("run-state actions", () => {
  beforeEach(async () => {
    vi.mocked(backend.getOrchestration).mockResolvedValue(withRails("r1"));
    vi.mocked(backend.setRailRun).mockResolvedValue(undefined);
    vi.mocked(backend.setStepRun).mockResolvedValue(undefined);
    await fetchOrchestration("ws-1");
  });

  it("upserts a rail run in the store and persists it", async () => {
    await setRailRunAction("ws-1", "r1", "running", "s1");
    expect(get(orchestrations)["ws-1"].railRuns).toEqual([
      { railId: "r1", state: "running", currentStageId: "s1" },
    ]);
    expect(backend.setRailRun).toHaveBeenCalledWith("r1", "running", "s1");

    await setRailRunAction("ws-1", "r1", "paused", "s1");
    expect(get(orchestrations)["ws-1"].railRuns).toHaveLength(1);
    expect(get(orchestrations)["ws-1"].railRuns[0].state).toBe("paused");
  });

  it("upserts a step run in the store and persists it", async () => {
    await setStepRunAction("ws-1", "t1", "running", "sess-1", null);
    expect(get(orchestrations)["ws-1"].stepRuns).toEqual([
      { stepId: "t1", state: "running", sessionId: "sess-1", reason: null },
    ]);
    expect(backend.setStepRun).toHaveBeenCalledWith("t1", "running", "sess-1", null);
  });
});
