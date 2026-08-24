import { describe, it, expect, vi, beforeEach } from "vitest";
import { get, writable, type Writable } from "svelte/store";

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
  // A REAL store: tick() derives the set of LIVE session ids from it, so
  // a test that needs a running step's session to still exist has to be
  // able to put a page holding it in here.
  layoutState: writable({ workspaces: [] as unknown[] }),
  resolvedAgentFor: vi.fn(() => ({ command: "claude", file: "CLAUDE.md", profile: "claude-code" })),
  createSessionOnPage: vi.fn(),
  setSessionName: vi.fn().mockResolvedValue(undefined),
  // tick() reads this through get(), so it has to be a real store.
  sessionExits: { subscribe: (fn: (v: unknown) => void) => (fn(new Map()), () => {}) },
}));
// A REAL store, left empty by default: tick() bails early without a
// board, so the rail-control tests exercise arming without also running
// the scheduler. The drop-onto-a-running-stage tests set a board into it
// precisely because they need the scheduler to run.
vi.mock("./kanbanState", () => ({
  kanbanState: writable<Record<string, unknown>>({}),
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
                {
                  path: "/x/b.md",
                  fileName: "b.md",
                  title: "Ship the UI",
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
  addStepToStageAction,
  addToolToStageAction,
  moveStepIntoStageAction,
  addCardAsStageAction,
  tick,
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
import { emptyOrchestration, addStep } from "./orchestration";
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

  it("a launch names the tab from the card title, so a rail tab is never a bare session id", async () => {
    // Same reason as the tool step below: the tab has to say what it is
    // running before the agent has drawn a frame -- and the agent's own
    // gavin_name_session is the first thing to break when the gavin
    // tools are unreachable.
    vi.mocked(backend.readFileForViewer).mockResolvedValue({
      content: "---\ntitle: Wire the API\n---\ndo the thing",
      truncated: false,
      exists: true,
    });
    vi.mocked(backend.setPlanFrontmatterField).mockImplementation(async (p) => p);
    vi.mocked(layoutStateModule.createSessionOnPage).mockResolvedValue("sess-9");

    await executeActions("ws-1", [{ kind: "launch", stepId: "t1" }]);

    expect(layoutStateModule.setSessionName).toHaveBeenCalledWith("sess-9", "Wire the API");
  });

  it("a launch whose naming fails still records the run", async () => {
    vi.mocked(backend.readFileForViewer).mockResolvedValue({
      content: "---\ntitle: Wire the API\n---\ndo the thing",
      truncated: false,
      exists: true,
    });
    vi.mocked(backend.setPlanFrontmatterField).mockImplementation(async (p) => p);
    vi.mocked(layoutStateModule.createSessionOnPage).mockResolvedValue("sess-9");
    vi.mocked(layoutStateModule.setSessionName).mockRejectedValueOnce(new Error("nope"));

    await executeActions("ws-1", [{ kind: "launch", stepId: "t1" }]);

    expect(backend.setStepRun).toHaveBeenCalledWith("t1", "running", "sess-9", null);
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
    vi.mocked(layoutStateModule.setSessionName).mockResolvedValue(undefined);
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
    // Through the STORE, not backend.setSessionName directly: the backend
    // command only persists to config and pushes nothing back, so a tab
    // named that way keeps its cwd label until the app restarts.
    expect(layoutStateModule.setSessionName).toHaveBeenCalledWith("sess-9", "Push branch");
  });

  // Cosmetic only: the agent is already running, so a failed rename must
  // not stall a live step.
  it("still records the run when naming the session fails", async () => {
    vi.mocked(layoutStateModule.createSessionOnPage).mockResolvedValue("sess-9");
    vi.mocked(layoutStateModule.setSessionName).mockRejectedValue(new Error("nope"));
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

// ---- Dropping onto a stage that is already running --------------------------
// A step that lands on the stage a rail is CURRENTLY on belongs to a beat
// already in flight. It used to sit `pending` until some unrelated change
// ticked the workspace, which made the drop look inert.

/// The two stores tick() reads that the rest of this file leaves empty:
/// without a board it bails before the scheduler, and without a live page
/// the running sibling's session reads as dead and stalls the rail.
const boardStore = kanbanStateModule.kanbanState as unknown as Writable<Record<string, unknown>>;
const layoutStore = layoutStateModule.layoutState as unknown as Writable<{ workspaces: unknown[] }>;

function armWorkspace(): void {
  boardStore.set({
    "ws-1": {
      columns: [
        { id: "c0", name: "To Do", position: 0 },
        { id: "c1", name: "Done", position: 1 },
      ],
      labels: [],
      cardSessions: [],
    },
  });
  layoutStore.set({
    // sess-9 is what createSessionOnPage is mocked to return: a step
    // this tick launches has to read as LIVE on the next one, or rule 3
    // would call its session dead and stall the rail.
    workspaces: [{ pages: [{ layout: { type: "leaf", tabs: ["sess-1", "sess-9"] } }] }],
  });
}

/// A rail mid-run: stage s1 is the stage it is ON, its one step is
/// running, and stage s2 is still ahead. Exactly what the human is
/// looking at when they drag a second card onto s1.
function midRunRail(): Orchestration {
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
        ],
      },
    ],
    railRuns: [{ railId: "r1", state: "running", currentStageId: "s1" }],
    stepRuns: [{ stepId: "t1", state: "running", sessionId: "sess-1", reason: null }],
  };
}

describe("dropping onto a running stage", () => {
  beforeEach(async () => {
    __resetForTesting();
    toolsResetForTesting();
    vi.clearAllMocks();
    armWorkspace();
    vi.mocked(backend.setOrchestration).mockResolvedValue(undefined);
    vi.mocked(backend.setRailRun).mockResolvedValue(undefined);
    vi.mocked(backend.setStepRun).mockResolvedValue(undefined);
    vi.mocked(backend.setPlanFrontmatterField).mockImplementation(async (p) => p);
    vi.mocked(backend.readFileForViewer).mockResolvedValue({
      content: "---\ntitle: Ship the UI\n---\ndo the thing",
      truncated: false,
      exists: true,
    });
    vi.mocked(layoutStateModule.createSessionOnPage).mockResolvedValue("sess-9");
    vi.mocked(layoutStateModule.setSessionName).mockResolvedValue(undefined);
    vi.mocked(backend.getOrchestration).mockResolvedValue(midRunRail());
    await fetchOrchestration("ws-1");
  });

  it("starts a card dropped onto the stage the rail is running", async () => {
    expect(await addStepToStageAction("ws-1", "s1", "/x/b.md")).toBeNull();
    expect(layoutStateModule.createSessionOnPage).toHaveBeenCalledWith(
      "ws-1",
      "p1",
      "/x/wt",
      expect.stringContaining("claude ")
    );
    const dropped = get(orchestrations)["ws-1"].rails[0].stages[0].steps[1];
    expect(get(orchestrations)["ws-1"].stepRuns).toContainEqual({
      stepId: dropped.id,
      state: "running",
      sessionId: "sess-9",
      reason: null,
    });
  });

  // The sibling was already running when the drop landed; re-running the
  // scheduler must not spawn a second session for it.
  it("leaves the step already running on that stage alone", async () => {
    await addStepToStageAction("ws-1", "s1", "/x/b.md");
    expect(layoutStateModule.createSessionOnPage).toHaveBeenCalledTimes(1);
    expect(backend.setStepRun).not.toHaveBeenCalledWith("t1", expect.anything(), expect.anything(), expect.anything());
  });

  it("starts a tool dropped onto that stage the same way", async () => {
    toolRecords.set({ "ws-1": [] });
    expect(await addToolToStageAction("ws-1", "s1", "builtin:push")).toBeNull();
    expect(layoutStateModule.createSessionOnPage).toHaveBeenCalledWith(
      "ws-1",
      "p1",
      "/x/wt",
      expect.stringContaining("git push -u origin HEAD")
    );
  });

  // Same gesture, same rule: a queued step dragged onto the live stage is
  // now part of the beat in flight.
  it("starts a step moved onto that stage from a later one", async () => {
    expect(await moveStepIntoStageAction("ws-1", "t2", "s1")).toBeNull();
    expect(backend.setStepRun).toHaveBeenCalledWith("t2", "running", "sess-9", null);
  });

  // Every OTHER drop target stays queued -- a new stage is a later beat.
  it("does not start a card dropped into a gap as its own stage", async () => {
    expect(await addCardAsStageAction("ws-1", "r1", 1, "/x/b.md")).toBeNull();
    expect(layoutStateModule.createSessionOnPage).not.toHaveBeenCalled();
  });

  it("does not start a card dropped onto a stage the rail has not reached", async () => {
    await addStepToStageAction("ws-1", "s2", "/x/b.md");
    expect(layoutStateModule.createSessionOnPage).not.toHaveBeenCalled();
  });

  // O1: nothing spawns on an unarmed rail, however live the stage looked
  // when the rail was last running.
  it("does not start a card dropped onto the stage a PAUSED rail is parked on", async () => {
    await setRailRunAction("ws-1", "r1", "paused", "s1");
    vi.mocked(layoutStateModule.createSessionOnPage).mockClear();
    await addStepToStageAction("ws-1", "s1", "/x/b.md");
    expect(layoutStateModule.createSessionOnPage).not.toHaveBeenCalled();
  });

  // A save that failed has rolled the plan back, so there is no step to
  // start and the scheduler must not be handed the rolled-back plan.
  it("starts nothing when the drop failed to save", async () => {
    vi.mocked(backend.setOrchestration).mockRejectedValue(new Error("nope"));
    expect(await addStepToStageAction("ws-1", "s1", "/x/b.md")).toContain("nope");
    expect(layoutStateModule.createSessionOnPage).not.toHaveBeenCalled();
  });
});

describe("a tick requested while one is in flight", () => {
  beforeEach(async () => {
    __resetForTesting();
    toolsResetForTesting();
    vi.clearAllMocks();
    armWorkspace();
    vi.mocked(backend.setOrchestration).mockResolvedValue(undefined);
    vi.mocked(backend.setRailRun).mockResolvedValue(undefined);
    vi.mocked(backend.setStepRun).mockResolvedValue(undefined);
    vi.mocked(backend.setPlanFrontmatterField).mockImplementation(async (p) => p);
    vi.mocked(backend.readFileForViewer).mockResolvedValue({
      content: "---\ntitle: Wire the API\n---\ndo the thing",
      truncated: false,
      exists: true,
    });
    vi.mocked(layoutStateModule.setSessionName).mockResolvedValue(undefined);
    vi.mocked(layoutStateModule.createSessionOnPage).mockResolvedValue("sess-9");
    // The same rail, armed at s1 with NOTHING running yet, so one tick
    // launches its step -- and a drop can land mid-launch.
    vi.mocked(backend.getOrchestration).mockResolvedValue({ ...midRunRail(), stepRuns: [] });
    await fetchOrchestration("ws-1");
  });

  // The pass in flight read the plan before the new step existed, so
  // simply returning would leave it pending until some unrelated event
  // ticked the workspace again -- the very stall this card is about,
  // reached by a narrower door.
  it("is replayed once the pass in flight drains", async () => {
    vi.mocked(layoutStateModule.createSessionOnPage).mockImplementationOnce(async () => {
      orchestrations.update((m) => ({ ...m, "ws-1": addStep(m["ws-1"], "s1", "late", "/x/b.md") }));
      void tick("ws-1");
      return "sess-9";
    });

    await tick("ws-1");

    expect(layoutStateModule.createSessionOnPage).toHaveBeenCalledTimes(2);
    expect(backend.setStepRun).toHaveBeenCalledWith("late", "running", "sess-9", null);
  });
});
