import { describe, it, expect, vi, beforeEach } from "vitest";
import { get } from "svelte/store";

vi.mock("./backend", () => ({
  getOrchestration: vi.fn(),
  setOrchestration: vi.fn(),
  setRailRun: vi.fn(),
  setStepRun: vi.fn(),
  readFileForViewer: vi.fn(),
  setPlanFrontmatterField: vi.fn(),
  setSessionName: vi.fn(),
  getTools: vi.fn(),
  saveTool: vi.fn(),
  deleteTool: vi.fn(),
}));

// tick() reads four stores through get(), so each mock must expose a
// real store contract, not just its functions -- a bare object makes
// get() throw and the failure reads as an unrelated crash.
vi.mock("./layoutState", () => ({
  layoutState: { subscribe: (fn: (v: unknown) => void) => (fn({ workspaces: [] }), () => {}) },
  resolvedAgentFor: vi.fn(() => ({ command: "claude", file: "CLAUDE.md", profile: "claude-code" })),
  createSessionOnPage: vi.fn(),
  // tick() reads this through get(), so it has to be a real store.
  sessionExits: { subscribe: (fn: (v: unknown) => void) => (fn(new Map()), () => {}) },
}));
// kanbanState is an empty map on purpose: tick() bails early without a
// board, so the rail-control tests exercise arming without also running
// the scheduler.
vi.mock("./kanbanState", () => ({
  kanbanState: { subscribe: (fn: (v: unknown) => void) => (fn({}), () => {}) },
  linkCardSessionAction: vi.fn(),
}));
vi.mock("./gavinState", () => ({
  gavinTrees: {
    subscribe: (fn: (v: unknown) => void) => (
      fn({
        "ws-1": {
          rootPath: "/ws",
          rootMissing: false,
          contexts: [
            {
              folderPath: "/ws/.gavin-root",
              kind: "root",
              name: "ws",
              plans: [
                {
                  path: "/x/a.md",
                  fileName: "a.md",
                  title: "Wire the API",
                  status: "To Do",
                  priority: null,
                  order: null,
                  kind: "task",
                  parent: null,
                  labels: [],
                  checklistDone: 0,
                  checklistTotal: 0,
                  parseWarning: false,
                },
              ],
              docs: [],
              specs: [],
              hasPrd: true,
              configWarning: false,
            },
          ],
        },
      }),
      () => {}
    ),
  },
  patchPlanField: vi.fn(),
}));
vi.mock("./gitState", () => ({
  gitStore: { subscribe: (fn: (v: unknown) => void) => (fn({}), () => {}) },
  ensureGitView: vi.fn(),
  refresh: vi.fn(),
}));

import * as backend from "./backend";
import * as gavinState from "./gavinState";
import * as layoutStateModule from "./layoutState";
import * as kanbanStateModule from "./kanbanState";
import { toolRecords, __resetForTesting as toolsResetForTesting } from "./toolsState";
import {
  orchestrations,
  fetchOrchestration,
  startRail,
  pauseRail,
  resumeRail,
  retryStep,
  executeActions,
  mutatePlan,
  setRailRunAction,
  setStepRunAction,
  saveErrors,
  dismissSaveError,
  moveRailCardsAction,
  clearDoneStepsAction,
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

  // A pre-v11 daemon has no tool_id column, so a tool step handed to it
  // comes back as a step with neither a card nor a tool: an untitled
  // chip, and one the current daemon refuses to store, wedging every
  // later save. The app drops it on the way in.
  it("drops a step the daemon returned with neither a card nor a tool", async () => {
    vi.mocked(backend.getOrchestration).mockResolvedValue({
      ...emptyOrchestration(),
      rails: [
        {
          ...rail("r1"),
          stages: [
            {
              id: "st0",
              position: 0,
              steps: [
                { id: "t1", position: 0, cardPath: "/x/a.md", toolId: null },
                { id: "t2", position: 1, cardPath: "", toolId: null },
              ],
            },
          ],
        },
      ],
    });
    await fetchOrchestration("ws-1");
    expect(
      get(orchestrations)["ws-1"].rails[0].stages[0].steps.map((s) => s.id)
    ).toEqual(["t1"]);
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

// A rail with one stage of one step, bound to a worktree and a page --
// cardPath matches the CARD stubbed into gavinTrees above, so a launch
// reaches createSessionOnPage instead of stalling on a missing card.
function boundRail(): Orchestration {
  return {
    ...emptyOrchestration(),
    rails: [
      {
        id: "r1",
        name: "backend",
        position: 0,
        worktreePath: "/x/wt",
        pageId: "p1",
        stages: [{ id: "s1", position: 0, steps: [{ id: "t1", position: 0, cardPath: "/x/a.md" }] }],
      },
    ],
  };
}

describe("rail controls", () => {
  beforeEach(async () => {
    vi.mocked(backend.getOrchestration).mockResolvedValue(boundRail());
    vi.mocked(backend.setRailRun).mockResolvedValue(undefined);
    vi.mocked(backend.setStepRun).mockResolvedValue(undefined);
    await fetchOrchestration("ws-1");
  });

  it("Start arms the rail at its first unfinished stage", async () => {
    await startRail("ws-1", "r1");
    expect(backend.setRailRun).toHaveBeenCalledWith("r1", "running", "s1");
  });

  it("Start is a no-op for a rail whose every stage is done", async () => {
    await setStepRunAction("ws-1", "t1", "done", null, null);
    vi.mocked(backend.setRailRun).mockClear();
    await startRail("ws-1", "r1");
    expect(backend.setRailRun).not.toHaveBeenCalled();
  });

  it("Pause keeps the current stage", async () => {
    await startRail("ws-1", "r1");
    await pauseRail("ws-1", "r1");
    expect(backend.setRailRun).toHaveBeenLastCalledWith("r1", "paused", "s1");
  });

  it("Resume picks up at the stage the pause left the rail on", async () => {
    await startRail("ws-1", "r1");
    await pauseRail("ws-1", "r1");
    vi.mocked(backend.setRailRun).mockClear();
    await resumeRail("ws-1", "r1");
    expect(backend.setRailRun).toHaveBeenCalledWith("r1", "running", "s1");
  });

  // An edit, a reorganize or a Clear done that lands while a rail is
  // paused can take the very stage it is parked on. Handing that id back
  // to the scheduler finds no stage and calls the rail COMPLETE, so
  // pressing Play would idle the rail instead of running it.
  it("Resume re-arms when the stage it was paused on is gone", async () => {
    await setRailRunAction("ws-1", "r1", "paused", "swept-stage");
    vi.mocked(backend.setRailRun).mockClear();
    await resumeRail("ws-1", "r1");
    expect(backend.setRailRun).toHaveBeenCalledWith("r1", "running", "s1");
  });

  it("Resume on a rail with nothing left to run lets the tick complete it", async () => {
    await setStepRunAction("ws-1", "t1", "done", null, null);
    await setRailRunAction("ws-1", "r1", "paused", "swept-stage");
    vi.mocked(backend.setRailRun).mockClear();
    await resumeRail("ws-1", "r1");
    expect(backend.setRailRun).toHaveBeenCalledWith("r1", "running", null);
  });

  it("Retry returns a stalled step to pending and clears its reason", async () => {
    await setStepRunAction("ws-1", "t1", "stalled", "sess-1", "card file is missing");
    await retryStep("ws-1", "t1");
    expect(backend.setStepRun).toHaveBeenLastCalledWith("t1", "pending", null, null);
  });
});

describe("executeActions", () => {
  beforeEach(async () => {
    vi.mocked(backend.getOrchestration).mockResolvedValue({
      ...boundRail(),
      railRuns: [{ railId: "r1", state: "running", currentStageId: "s1" }],
    });
    vi.mocked(backend.setRailRun).mockResolvedValue(undefined);
    vi.mocked(backend.setStepRun).mockResolvedValue(undefined);
    await fetchOrchestration("ws-1");
  });

  it("a stall records the reason and pauses the owning rail", async () => {
    await executeActions("ws-1", [{ kind: "stall", stepId: "t1", reason: "card file is missing" }]);
    expect(backend.setStepRun).toHaveBeenCalledWith("t1", "stalled", null, "card file is missing");
    expect(backend.setRailRun).toHaveBeenCalledWith("r1", "paused", "s1");
  });

  // Rule 5 stops a rail that is ADVANCING. A rail that is idle or paused
  // has nothing to stop, and a reconciling stall must not relabel a rail
  // nobody started as "paused".
  it("a stall on a rail that is not running leaves its state alone", async () => {
    await setRailRunAction("ws-1", "r1", "idle", null);
    vi.mocked(backend.setRailRun).mockClear();
    await executeActions("ws-1", [
      { kind: "stall", stepId: "t1", reason: "agent exited before the card reached Done" },
    ]);
    expect(backend.setStepRun).toHaveBeenCalledWith(
      "t1",
      "stalled",
      null,
      "agent exited before the card reached Done"
    );
    expect(backend.setRailRun).not.toHaveBeenCalled();
  });

  it("markDone keeps the session id so the transcript stays reachable", async () => {
    await setStepRunAction("ws-1", "t1", "running", "sess-1", null);
    await executeActions("ws-1", [{ kind: "markDone", stepId: "t1" }]);
    expect(backend.setStepRun).toHaveBeenLastCalledWith("t1", "done", "sess-1", null);
  });

  it("advance moves the rail's current stage", async () => {
    await executeActions("ws-1", [{ kind: "advance", railId: "r1", stageId: "s2" }]);
    expect(backend.setRailRun).toHaveBeenLastCalledWith("r1", "running", "s2");
  });

  it("complete returns the rail to idle", async () => {
    await executeActions("ws-1", [{ kind: "complete", railId: "r1" }]);
    expect(backend.setRailRun).toHaveBeenLastCalledWith("r1", "idle", null);
  });

  it("a launch that cannot create a session stalls the step instead of throwing", async () => {
    vi.mocked(backend.readFileForViewer).mockResolvedValue({
      content: "---\ntitle: Wire the API\n---\ndo the thing",
      truncated: false,
      exists: true,
    });
    vi.mocked(layoutStateModule.createSessionOnPage).mockResolvedValue(null);
    await executeActions("ws-1", [{ kind: "launch", stepId: "t1" }]);
    expect(backend.setStepRun).toHaveBeenCalledWith(
      "t1",
      "stalled",
      null,
      expect.stringContaining("could not start")
    );
  });

  it("a launch binds the card session, records the session id, and writes In Progress", async () => {
    vi.mocked(backend.readFileForViewer).mockResolvedValue({
      content: "---\ntitle: Wire the API\n---\ndo the thing",
      truncated: false,
      exists: true,
    });
    vi.mocked(backend.setPlanFrontmatterField).mockImplementation(async (p) => p);
    vi.mocked(layoutStateModule.createSessionOnPage).mockResolvedValue("sess-9");
    await executeActions("ws-1", [{ kind: "launch", stepId: "t1" }]);

    expect(layoutStateModule.createSessionOnPage).toHaveBeenCalledWith(
      "ws-1",
      "p1",
      "/x/wt",
      expect.stringContaining("claude ")
    );
    expect(kanbanStateModule.linkCardSessionAction).toHaveBeenCalledWith("ws-1", {
      path: "/x/a.md",
      sessionId: "sess-9",
      cwd: "/x/wt",
      command: expect.stringContaining("claude "),
    });
    expect(backend.setStepRun).toHaveBeenCalledWith("t1", "running", "sess-9", null);
    expect(backend.setPlanFrontmatterField).toHaveBeenCalledWith("/x/a.md", "status", "In Progress");
  });
});

describe("moveRailCardsAction", () => {
  /// A rail over the one card the mocked tree knows (/x/a.md, "To Do"),
  /// a card it does NOT (/x/gone.md), and a tool step.
  function mixedRail(): Orchestration {
    return {
      ...emptyOrchestration(),
      rails: [
        {
          id: "r1",
          name: "r1",
          position: 0,
          worktreePath: null,
          pageId: null,
          stages: [
            {
              id: "s1",
              position: 0,
              steps: [
                { id: "t1", position: 0, cardPath: "/x/a.md" },
                { id: "t2", position: 1, cardPath: "/x/gone.md" },
              ],
            },
            {
              id: "s2",
              position: 1,
              steps: [{ id: "t3", position: 0, cardPath: "", toolId: "builtin:push" }],
            },
          ],
        },
      ],
    };
  }

  beforeEach(() => {
    orchestrations.set({ "ws-1": mixedRail() });
  });

  it("writes the column to every card the tree resolves, and patches each", async () => {
    vi.mocked(backend.setPlanFrontmatterField).mockImplementation(async (p) => p);
    expect(await moveRailCardsAction("ws-1", "r1", "Done")).toBeNull();
    expect(vi.mocked(backend.setPlanFrontmatterField).mock.calls).toEqual([
      ["/x/a.md", "status", "Done"],
    ]);
    expect(gavinState.patchPlanField).toHaveBeenCalledWith("ws-1", "/x/a.md", "status", "Done");
  });

  it("writes nothing when every card is already in that column", async () => {
    expect(await moveRailCardsAction("ws-1", "r1", "To Do")).toBeNull();
    expect(backend.setPlanFrontmatterField).not.toHaveBeenCalled();
  });

  it("names the file that refused and stops there", async () => {
    vi.mocked(backend.setPlanFrontmatterField).mockRejectedValue(new Error("read-only"));
    expect(await moveRailCardsAction("ws-1", "r1", "Done")).toBe(
      "Couldn't move a.md to Done: read-only"
    );
    expect(gavinState.patchPlanField).not.toHaveBeenCalled();
  });

  it("is a no-op for an unknown rail", async () => {
    expect(await moveRailCardsAction("ws-1", "nope", "Done")).toBeNull();
    expect(backend.setPlanFrontmatterField).not.toHaveBeenCalled();
  });
});

describe("clearDoneStepsAction", () => {
  /// Three sequential stages over the one card the mocked tree knows,
  /// so every step here is a card step the board could also finish.
  function threeStages(): Orchestration {
    return {
      ...emptyOrchestration(),
      rails: [
        {
          id: "r1",
          name: "backend",
          position: 0,
          worktreePath: "/x/wt",
          pageId: "p1",
          stages: [
            { id: "s1", position: 0, steps: [{ id: "t1", position: 0, cardPath: "/x/a.md" }] },
            { id: "s2", position: 1, steps: [{ id: "t2", position: 0, cardPath: "/x/b.md" }] },
            { id: "s3", position: 2, steps: [{ id: "t3", position: 0, cardPath: "/x/c.md" }] },
          ],
        },
      ],
    };
  }

  function done(...stepIds: string[]): Orchestration["stepRuns"] {
    return stepIds.map((stepId) => ({ stepId, state: "done" as const, sessionId: null, reason: null }));
  }

  beforeEach(() => {
    vi.mocked(backend.setOrchestration).mockResolvedValue(undefined);
    vi.mocked(backend.setRailRun).mockResolvedValue(undefined);
    orchestrations.set({ "ws-1": { ...threeStages(), stepRuns: done("t1", "t2") } });
  });

  it("takes the done steps off the rail and drops the stages they emptied", async () => {
    expect(await clearDoneStepsAction("ws-1", "r1")).toBeNull();
    const rails = vi.mocked(backend.setOrchestration).mock.calls[0][1] as Rail[];
    expect(rails[0].stages.map((s) => [s.id, s.position])).toEqual([["s3", 0]]);
    expect(get(orchestrations)["ws-1"].stepRuns).toEqual([]);
  });

  it("writes nothing when the rail has no done steps", async () => {
    orchestrations.set({ "ws-1": threeStages() });
    expect(await clearDoneStepsAction("ws-1", "r1")).toBeNull();
    expect(backend.setOrchestration).not.toHaveBeenCalled();
  });

  it("is a no-op for an unknown rail", async () => {
    expect(await clearDoneStepsAction("ws-1", "nope")).toBeNull();
    expect(backend.setOrchestration).not.toHaveBeenCalled();
  });

  // The daemon refuses a plan write that drops a running step, so the
  // clear leaves it -- and the stage it stands in -- exactly where it is.
  it("leaves a running step on the rail", async () => {
    orchestrations.set({
      "ws-1": {
        ...threeStages(),
        stepRuns: [
          ...done("t1"),
          { stepId: "t2", state: "running", sessionId: "sess-1", reason: null },
        ],
      },
    });
    expect(await clearDoneStepsAction("ws-1", "r1")).toBeNull();
    const rails = vi.mocked(backend.setOrchestration).mock.calls[0][1] as Rail[];
    expect(rails[0].stages.map((s) => s.id)).toEqual(["s2", "s3"]);
  });

  // Cleared out from under a running rail, `currentStageId` would name a
  // stage that no longer exists and the next tick would call the rail
  // complete.
  it("repoints a running rail whose current stage was cleared away", async () => {
    orchestrations.set({
      "ws-1": {
        ...threeStages(),
        stepRuns: done("t1", "t2"),
        railRuns: [{ railId: "r1", state: "running", currentStageId: "s2" }],
      },
    });
    expect(await clearDoneStepsAction("ws-1", "r1")).toBeNull();
    expect(backend.setRailRun).toHaveBeenCalledWith("r1", "running", "s3");
  });

  it("leaves a current stage that survived the clear alone", async () => {
    orchestrations.set({
      "ws-1": {
        ...threeStages(),
        stepRuns: done("t1"),
        railRuns: [{ railId: "r1", state: "running", currentStageId: "s2" }],
      },
    });
    expect(await clearDoneStepsAction("ws-1", "r1")).toBeNull();
    expect(backend.setRailRun).not.toHaveBeenCalled();
  });

  it("reports the failure and rolls the plan back", async () => {
    vi.mocked(backend.setOrchestration).mockRejectedValue(new Error("step t1 is running"));
    expect(await clearDoneStepsAction("ws-1", "r1")).toBe("step t1 is running");
    expect(get(orchestrations)["ws-1"].rails[0].stages.map((s) => s.id)).toEqual(["s1", "s2", "s3"]);
    expect(backend.setRailRun).not.toHaveBeenCalled();
  });
});

// ---- Tool steps -------------------------------------------------------------

/// The same bound rail, but its single step runs a tool. `cardPath` is
/// empty on purpose: a step is a card OR a tool, never both.
function toolRail(toolParams: Record<string, string> = {}): Orchestration {
  return {
    ...emptyOrchestration(),
    rails: [
      {
        id: "r1",
        name: "backend",
        position: 0,
        worktreePath: "/x/wt",
        pageId: "p1",
        stages: [
          {
            id: "s1",
            position: 0,
            steps: [
              { id: "t1", position: 0, cardPath: "", toolId: "builtin:push", toolParams },
            ],
          },
        ],
      },
    ],
  };
}

describe("launching a tool step", () => {
  beforeEach(async () => {
    __resetForTesting();
    toolsResetForTesting();
    vi.clearAllMocks();
    vi.mocked(backend.setStepRun).mockResolvedValue(undefined);
    vi.mocked(backend.setSessionName).mockResolvedValue(undefined);
    vi.mocked(backend.getOrchestration).mockResolvedValue(toolRail());
    await fetchOrchestration("ws-1");
    // An EMPTY library, which still contains the built-ins.
    toolRecords.set({ "ws-1": [] });
  });

  it("runs a command tool's body in the rail's worktree, on the rail's page", async () => {
    vi.mocked(layoutStateModule.createSessionOnPage).mockResolvedValue("sess-9");
    await executeActions("ws-1", [{ kind: "launch", stepId: "t1" }]);
    expect(layoutStateModule.createSessionOnPage).toHaveBeenCalledWith(
      "ws-1",
      "p1",
      "/x/wt",
      expect.stringContaining("git push -u origin HEAD")
    );
    expect(backend.setStepRun).toHaveBeenCalledWith("t1", "running", "sess-9", null);
  });

  // A tool is not a card: no card_sessions binding and no status write.
  it("never binds a card session or writes In Progress", async () => {
    vi.mocked(layoutStateModule.createSessionOnPage).mockResolvedValue("sess-9");
    await executeActions("ws-1", [{ kind: "launch", stepId: "t1" }]);
    expect(kanbanStateModule.linkCardSessionAction).not.toHaveBeenCalled();
    expect(backend.setPlanFrontmatterField).not.toHaveBeenCalled();
  });

  it("names the session after the tool, so a fast command's tab is identifiable", async () => {
    vi.mocked(layoutStateModule.createSessionOnPage).mockResolvedValue("sess-9");
    await executeActions("ws-1", [{ kind: "launch", stepId: "t1" }]);
    expect(backend.setSessionName).toHaveBeenCalledWith("sess-9", "Push branch");
  });

  // Cosmetic only: the agent is already running, so a failed rename must
  // not stall a live step.
  it("still records the run when naming the session fails", async () => {
    vi.mocked(layoutStateModule.createSessionOnPage).mockResolvedValue("sess-9");
    vi.mocked(backend.setSessionName).mockRejectedValue(new Error("nope"));
    await executeActions("ws-1", [{ kind: "launch", stepId: "t1" }]);
    expect(backend.setStepRun).toHaveBeenCalledWith("t1", "running", "sess-9", null);
  });

  it("substitutes the step's parameter overrides", async () => {
    vi.mocked(backend.getOrchestration).mockResolvedValue(toolRail({ remote: "upstream" }));
    __resetForTesting();
    await fetchOrchestration("ws-1");
    toolRecords.set({ "ws-1": [] });
    vi.mocked(layoutStateModule.createSessionOnPage).mockResolvedValue("sess-9");
    await executeActions("ws-1", [{ kind: "launch", stepId: "t1" }]);
    expect(layoutStateModule.createSessionOnPage).toHaveBeenCalledWith(
      "ws-1",
      "p1",
      "/x/wt",
      expect.stringContaining("git push -u upstream HEAD")
    );
  });

  it("stalls when the tool is no longer in the library", async () => {
    vi.mocked(backend.getOrchestration).mockResolvedValue({
      ...toolRail(),
      rails: [
        {
          ...toolRail().rails[0],
          stages: [
            {
              id: "s1",
              position: 0,
              steps: [{ id: "t1", position: 0, cardPath: "", toolId: "gone", toolParams: {} }],
            },
          ],
        },
      ],
    });
    __resetForTesting();
    await fetchOrchestration("ws-1");
    toolRecords.set({ "ws-1": [] });
    await executeActions("ws-1", [{ kind: "launch", stepId: "t1" }]);
    expect(backend.setStepRun).toHaveBeenCalledWith(
      "t1",
      "stalled",
      null,
      "tool is no longer in the library"
    );
  });

  it("stalls when the session cannot be created, naming the tool", async () => {
    vi.mocked(layoutStateModule.createSessionOnPage).mockResolvedValue(null);
    await executeActions("ws-1", [{ kind: "launch", stepId: "t1" }]);
    expect(backend.setStepRun).toHaveBeenCalledWith(
      "t1",
      "stalled",
      null,
      "could not start Push branch"
    );
  });

  // An AGENT tool goes through the same launch command a card step
  // uses, so the agent binary and its quoting have one implementation.
  it("runs an agent tool through the workspace's agent command", async () => {
    vi.mocked(backend.getOrchestration).mockResolvedValue({
      ...toolRail(),
      rails: [
        {
          ...toolRail().rails[0],
          stages: [
            {
              id: "s1",
              position: 0,
              steps: [
                { id: "t1", position: 0, cardPath: "", toolId: "builtin:commit", toolParams: {} },
              ],
            },
          ],
        },
      ],
    });
    __resetForTesting();
    await fetchOrchestration("ws-1");
    toolRecords.set({ "ws-1": [] });
    vi.mocked(layoutStateModule.createSessionOnPage).mockResolvedValue("sess-9");
    await executeActions("ws-1", [{ kind: "launch", stepId: "t1" }]);
    const command = vi.mocked(layoutStateModule.createSessionOnPage).mock.calls[0][3] as string;
    expect(command.startsWith("claude '")).toBe(true);
    expect(command).toContain("Commit the uncommitted work in this checkout");
  });
});

describe("launching a tool step before the library has loaded", () => {
  beforeEach(async () => {
    __resetForTesting();
    toolsResetForTesting();
    vi.clearAllMocks();
    vi.mocked(backend.setStepRun).mockResolvedValue(undefined);
    vi.mocked(backend.getOrchestration).mockResolvedValue(toolRail());
    await fetchOrchestration("ws-1");
    // toolRecords deliberately left UNSET: not fetched yet.
  });

  // Stalling here would turn a cold start into a stalled rail. The step
  // stays pending and the tab re-ticks when the library lands.
  it("writes nothing and leaves the step pending", async () => {
    await executeActions("ws-1", [{ kind: "launch", stepId: "t1" }]);
    expect(backend.setStepRun).not.toHaveBeenCalled();
    expect(layoutStateModule.createSessionOnPage).not.toHaveBeenCalled();
  });

  it("launches once the library lands", async () => {
    await executeActions("ws-1", [{ kind: "launch", stepId: "t1" }]);
    toolRecords.set({ "ws-1": [] });
    vi.mocked(layoutStateModule.createSessionOnPage).mockResolvedValue("sess-9");
    await executeActions("ws-1", [{ kind: "launch", stepId: "t1" }]);
    expect(backend.setStepRun).toHaveBeenCalledWith("t1", "running", "sess-9", null);
  });
});
