import { describe, it, expect } from "vitest";
import type { TurnReading, TurnVerdictEntry } from "$lib/agents/turnVerdict";
import {
  emptyOrchestration,
  doneColumn,
  firstColumnOf,
  cardIndex,
  effectiveWorktree,
  stepStateOf,
  railStateOf,
  firstUnfinishedStageId,
  isStepFinished,
  runnableIdleRails,
  finishedRails,
  startRailVerdict,
  startRailTargetWorkspace,
  railRunsDiffer,
  nextActions,
  addRail,
  renameRail,
  bindRail,
  deleteRail,
  deleteRails,
  addStage,
  addStep,
  removeStep,
  stageMode,
  isGroup,
  stageLabel,
  stageLabelById,
  findStage,
  setStageMode,
  renameStage,
  moveStageToIndex,
  removeStage,
  detectConflicts,
  numberConflicts,
  numbersForStep,
  numbersForRail,
  conflictsForRail,
  severityForStep,
  moveStepToNewStage,
  moveStepIntoStage,
  splitStageIntoSequence,
  groupUnplacedByStatus,
  availableCards,
  nestedChildCounts,
  nestedChildrenOf,
  unfinishedCards,
  unplacedCount,
  addCardAsStage,
  describeConflict,
  isToolStep,
  stepParams,
  addToolStep,
  addToolAsStage,
  insertStageWithSteps,
  setStepParams,
  conflictStepIds,
  findCardPlacement,
  cardRailBadge,
  sendCardToRail,
  findStep,
  pageToSpawnForRail,
  railCardPaths,
  railCardsToMove,
  railMoveAllEntries,
  finishedRailDoneCards,
  conflictSummaryLines,
  railDoneStepIds,
  removeSteps,
  effectiveStatus,
  planIndex,
  dropImpossibleSteps,
  isStageRunning,
  runningStageId,
  stepAttentions,
  STALE_AFTER_MS,
  railAttention,
  railsWantingAttention,
  attentionTip,
  failedStepReason,
} from "$lib/orchestration/orchestration";
import { unreviewedStallReason } from "$lib/cards/cardReview";
import type { CardEntry, Conflict, StepAttention, ToolSummary, UnplacedGroup } from "$lib/orchestration/orchestration";
import { BUILTIN_TOOLS } from "$lib/orchestration/orchestrationTools";
import { prKey } from "$lib/git/pullRequest";
import type { WorktreeInfo } from "$lib/git/git";
import type { Action, Orchestration, Rail, RailState, Stage, StageMode, Step, StepState } from "$lib/orchestration/orchestration";
import type { Board } from "$lib/board/kanban";
import type { SessionStatus } from "$lib/core/notifications";
import type { GavinTree, PlanFileInfo } from "$lib/core/gavin";

function board(names: string[]): Board {
  return {
    columns: names.map((name, i) => ({ id: `c${i}`, name, position: i })),
    labels: [],
    cardSessions: [],
  };
}

function plan(fileName: string, overrides: Partial<PlanFileInfo> = {}): PlanFileInfo {
  return {
    path: `/ws/.gavin-root/plans/${fileName}`,
    fileName,
    title: fileName.replace(/\.md$/, ""),
    status: null,
    priority: null,
    order: null,
    kind: "task",
    parent: null,
    labels: [],
    checklistDone: 0,
    checklistTotal: 0,
    parseWarning: false,
    ...overrides,
  };
}

function tree(plans: PlanFileInfo[]): GavinTree {
  return {
    rootPath: "/ws",
    rootMissing: false,
    contexts: [
      {
        folderPath: "/ws/.gavin-root",
        kind: "root",
        name: "ws",
        plans,
        docs: [],
        specs: [],
        hasPrd: true,
        configWarning: false,
      },
    ],
  };
}

function rail(id: string, stages: Array<Array<[string, string]>>): Rail {
  return {
    id,
    name: id,
    position: 0,
    worktreePath: null,
    pageId: null,
    stages: stages.map((steps, si) => ({
      id: `${id}-s${si}`,
      position: si,
      steps: steps.map(([stepId, cardPath], pi) => ({ id: stepId, position: pi, cardPath })),
    })),
  };
}

describe("doneColumn", () => {
  it("is the column with the highest position", () => {
    expect(doneColumn(board(["To Do", "In Progress", "Done"]))?.name).toBe("Done");
  });

  it("ignores array order and uses position", () => {
    const b = board(["To Do", "Done"]);
    b.columns = [b.columns[1], b.columns[0]];
    expect(doneColumn(b)?.name).toBe("Done");
  });

  it("is null for a board with no columns", () => {
    expect(doneColumn(board([]))).toBeNull();
  });
});

describe("firstColumnOf", () => {
  it("is the column with the lowest position, whatever the array order", () => {
    const b = board(["To Do", "In Progress", "Done"]);
    b.columns = [b.columns[2], b.columns[0], b.columns[1]];
    expect(firstColumnOf(b.columns)?.name).toBe("To Do");
  });

  it("is null for a board with no columns", () => {
    expect(firstColumnOf([])).toBeNull();
  });
});

describe("cardIndex", () => {
  it("maps every card path to its plan and context folder", () => {
    const idx = cardIndex(tree([plan("a.md")]));
    expect(idx.get("/ws/.gavin-root/plans/a.md")?.contextFolder).toBe("/ws/.gavin-root");
  });

  it("is empty for a missing or missing-root tree", () => {
    expect(cardIndex(undefined).size).toBe(0);
    expect(cardIndex({ ...tree([plan("a.md")]), rootMissing: true }).size).toBe(0);
  });
});

describe("effectiveWorktree", () => {
  it("is the rail's worktree when bound", () => {
    const r = { ...rail("r1", [[["t1", "/ws/.gavin-root/plans/a.md"]]]), worktreePath: "/x/wt" };
    expect(effectiveWorktree(r, { plan: plan("a.md"), contextFolder: "/ws/.gavin-root" })).toBe("/x/wt");
  });

  it("falls back to the card's context folder when unbound", () => {
    const r = rail("r1", [[["t1", "/ws/.gavin-root/plans/a.md"]]]);
    expect(effectiveWorktree(r, { plan: plan("a.md"), contextFolder: "/ws/.gavin-root" })).toBe(
      "/ws/.gavin-root"
    );
  });

  it("is null when unbound and the card is unknown", () => {
    expect(effectiveWorktree(rail("r1", []), undefined)).toBeNull();
  });
});

describe("state accessors", () => {
  const orch: Orchestration = {
    rails: [rail("r1", [[["t1", "/x/a.md"]]])],
    conflictNotes: [],
    railRuns: [{ railId: "r1", state: "running", currentStageId: "r1-s0" }],
    stepRuns: [{ stepId: "t1", state: "done", sessionId: "s1", reason: null }],
  };

  it("reads a recorded state", () => {
    expect(stepStateOf(orch, "t1")).toBe("done");
    expect(railStateOf(orch, "r1")).toBe("running");
  });

  it("defaults absence to pending and idle", () => {
    expect(stepStateOf(orch, "nope")).toBe("pending");
    expect(railStateOf(orch, "nope")).toBe("idle");
  });
});

describe("firstUnfinishedStageId", () => {
  it("skips stages whose every step is already done", () => {
    const r = rail("r1", [[["t1", "/x/a.md"]], [["t2", "/x/b.md"]]]);
    const orch: Orchestration = {
      rails: [r],
      conflictNotes: [],
      railRuns: [],
      stepRuns: [{ stepId: "t1", state: "done", sessionId: null, reason: null }],
    };
    expect(firstUnfinishedStageId(r, orch)).toBe("r1-s1");
  });

  it("is null when every stage is done", () => {
    const r = rail("r1", [[["t1", "/x/a.md"]]]);
    const orch: Orchestration = {
      rails: [r],
      conflictNotes: [],
      railRuns: [],
      stepRuns: [{ stepId: "t1", state: "done", sessionId: null, reason: null }],
    };
    expect(firstUnfinishedStageId(r, orch)).toBeNull();
  });

  it("is null for a rail with no stages", () => {
    expect(firstUnfinishedStageId(rail("r1", []), emptyOrchestration())).toBeNull();
  });
});

describe("runnableIdleRails", () => {
  // Three rails with one step each, so the only thing separating them in
  // each case is their run state.
  function three(): Rail[] {
    return [
      { ...rail("r1", [[["t1", "/x/a.md"]]]), position: 2 },
      { ...rail("r2", [[["t2", "/x/b.md"]]]), position: 0 },
      { ...rail("r3", [[["t3", "/x/c.md"]]]), position: 1 },
    ];
  }

  function withRuns(rails: Rail[], railRuns: Orchestration["railRuns"], stepRuns: Orchestration["stepRuns"] = []): Orchestration {
    return { rails, conflictNotes: [], railRuns, stepRuns };
  }

  it("takes every idle rail, in screen order", () => {
    const o = withRuns(three(), []);
    expect(runnableIdleRails(o).map((r) => r.id)).toEqual(["r2", "r3", "r1"]);
  });

  it("leaves a running rail alone", () => {
    // Not a no-op: startRail re-points currentStageId at the FIRST
    // unfinished stage, so re-arming a rail mid-run rewinds it.
    const o = withRuns(three(), [{ railId: "r3", state: "running", currentStageId: "r3-s0" }]);
    expect(runnableIdleRails(o).map((r) => r.id)).toEqual(["r2", "r1"]);
  });

  it("leaves a paused rail alone", () => {
    const o = withRuns(three(), [{ railId: "r2", state: "paused", currentStageId: "r2-s0" }]);
    expect(runnableIdleRails(o).map((r) => r.id)).toEqual(["r3", "r1"]);
  });

  it("drops an idle rail with no stages at all", () => {
    const o = withRuns([rail("empty", []), ...three()], []);
    expect(runnableIdleRails(o).map((r) => r.id)).not.toContain("empty");
  });

  it("drops an idle rail whose every step is already done", () => {
    const o = withRuns(three(), [], [{ stepId: "t2", state: "done", sessionId: null, reason: null }]);
    expect(runnableIdleRails(o).map((r) => r.id)).toEqual(["r3", "r1"]);
  });

  it("is empty for a plan with no rails", () => {
    expect(runnableIdleRails(emptyOrchestration())).toEqual([]);
  });
});

describe("finishedRails", () => {
  // Three rails with one step each, so the only thing separating them is
  // what their run rows say -- the same shape runnableIdleRails' suite
  // uses, because these two answer opposite halves of one question.
  function three(): Rail[] {
    return [
      { ...rail("r1", [[["t1", "/x/a.md"]]]), position: 2 },
      { ...rail("r2", [[["t2", "/x/b.md"]]]), position: 0 },
      { ...rail("r3", [[["t3", "/x/c.md"]]]), position: 1 },
    ];
  }

  function withRuns(
    rails: Rail[],
    railRuns: Orchestration["railRuns"],
    stepRuns: Orchestration["stepRuns"] = []
  ): Orchestration {
    return { rails, conflictNotes: [], railRuns, stepRuns };
  }

  const done = (stepId: string): Orchestration["stepRuns"][number] => ({
    stepId,
    state: "done",
    sessionId: null,
    reason: null,
  });

  it("takes the idle rails whose every step is done, in screen order", () => {
    const o = withRuns(three(), [], [done("t1"), done("t2")]);
    expect(finishedRails(o).map((r) => r.id)).toEqual(["r2", "r1"]);
  });

  it("leaves a rail with anything unfinished on it", () => {
    const o = withRuns(three(), [], [done("t2")]);
    expect(finishedRails(o).map((r) => r.id)).toEqual(["r2"]);
  });

  it("counts a skipped step as finished", () => {
    // A skip is the human sending the rail past that step: there is
    // nothing left to run, and reading it the other way would leave the
    // rail unclearable for good.
    const o = withRuns(
      three(),
      [],
      [{ stepId: "t2", state: "skipped", sessionId: null, reason: null }]
    );
    expect(finishedRails(o).map((r) => r.id)).toEqual(["r2"]);
  });

  it("does not count a stalled step as finished", () => {
    const o = withRuns(
      three(),
      [],
      [{ stepId: "t2", state: "stalled", sessionId: null, reason: "broke" }]
    );
    expect(finishedRails(o)).toEqual([]);
  });

  it("never takes an empty rail, however vacuously done it looks", () => {
    // An empty rail is unstarted, not finished, and firstUnfinishedStageId
    // says null for it -- which is why this needs its own condition.
    const o = withRuns([rail("empty", []), rail("hollow", [[]])], []);
    expect(finishedRails(o)).toEqual([]);
  });

  it("leaves a running rail alone even with every step done", () => {
    const o = withRuns(
      three(),
      [{ railId: "r2", state: "running", currentStageId: "r2-s0" }],
      [done("t2")]
    );
    expect(finishedRails(o)).toEqual([]);
  });

  it("leaves a paused rail alone even with every step done", () => {
    const o = withRuns(
      three(),
      [{ railId: "r2", state: "paused", currentStageId: "r2-s0" }],
      [done("t2")]
    );
    expect(finishedRails(o)).toEqual([]);
  });

  it("shares no rail with runnableIdleRails", () => {
    // The two exclusions have to stay complementary: a rail offered to
    // "Run all" and swept by "Clear done" in the same breath would be a
    // race between two buttons on one toolbar.
    const o = withRuns(three(), [], [done("t2")]);
    const runnable = new Set(runnableIdleRails(o).map((r) => r.id));
    expect(finishedRails(o).every((r) => !runnable.has(r.id))).toBe(true);
  });

  it("is empty for a plan with no rails", () => {
    expect(finishedRails(emptyOrchestration())).toEqual([]);
  });
});

describe("deleteRails", () => {
  function two(): Orchestration {
    return {
      rails: [
        { ...rail("r1", [[["t1", "/x/a.md"]]]), position: 0 },
        { ...rail("r2", [[["t2", "/x/b.md"]]]), position: 1 },
        { ...rail("r3", [[["t3", "/x/c.md"]]]), position: 2 },
      ],
      conflictNotes: [],
      railRuns: [{ railId: "r1", state: "idle", currentStageId: null }],
      stepRuns: [
        { stepId: "t1", state: "done", sessionId: null, reason: null },
        { stepId: "t3", state: "done", sessionId: null, reason: null },
      ],
    };
  }

  it("removes every named rail in one pass", () => {
    expect(deleteRails(two(), ["r1", "r3"]).rails.map((r) => r.id)).toEqual(["r2"]);
  });

  it("renumbers the survivors from zero", () => {
    // Once, over the list that is left -- removing one at a time would
    // renumber positions the next removal only invalidates again.
    expect(deleteRails(two(), ["r1"]).rails.map((r) => r.position)).toEqual([0, 1]);
  });

  it("sweeps the run rows of the rails and steps it removed", () => {
    const after = deleteRails(two(), ["r1", "r3"]);
    expect(after.railRuns).toEqual([]);
    expect(after.stepRuns).toEqual([]);
  });

  it("keeps the run rows of the rails it did not touch", () => {
    const after = deleteRails(two(), ["r2"]);
    expect(after.railRuns.map((r) => r.railId)).toEqual(["r1"]);
    expect(after.stepRuns.map((r) => r.stepId)).toEqual(["t1", "t3"]);
  });

  it("ignores an id no rail carries", () => {
    expect(deleteRails(two(), ["nope"]).rails.map((r) => r.id)).toEqual(["r1", "r2", "r3"]);
  });

  it("hands back the very same plan for an empty list", () => {
    const o = two();
    expect(deleteRails(o, [])).toBe(o);
  });

  it("agrees with deleteRail on a single id", () => {
    expect(deleteRails(two(), ["r2"])).toEqual(deleteRail(two(), "r2"));
  });
});

describe("startRailVerdict", () => {
  // Two rails, one step each. The step doing the starting lives on r1;
  // r2 is what "Start rail" names.
  function two(
    railRuns: Orchestration["railRuns"] = [],
    stepRuns: Orchestration["stepRuns"] = []
  ): Orchestration {
    return {
      rails: [
        { ...rail("r1", [[["t1", "/x/a.md"]]]), name: "Build" },
        { ...rail("r2", [[["t2", "/x/b.md"]]]), name: "Deploy" },
      ],
      conflictNotes: [],
      railRuns,
      stepRuns,
    };
  }

  it("starts an idle rail with something left to run", () => {
    expect(startRailVerdict(two(), "r1", "Deploy")).toEqual({ kind: "start", railId: "r2" });
  });

  // The name comes out of a text field a human typed into.
  it("matches the name ignoring case and surrounding space", () => {
    expect(startRailVerdict(two(), "r1", "  deploy ")).toEqual({ kind: "start", railId: "r2" });
  });

  it("refuses an empty name by naming the field", () => {
    const v = startRailVerdict(two(), "r1", "   ");
    expect(v.kind).toBe("refuse");
    expect(v).toMatchObject({ reason: expect.stringContaining("Rail parameter") });
  });

  it("refuses a name no rail carries", () => {
    expect(startRailVerdict(two(), "r1", "Docs")).toMatchObject({
      kind: "refuse",
      reason: expect.stringContaining("Docs"),
    });
  });

  // Nothing makes rail names unique, so this is reachable by rename.
  it("refuses a name two rails share rather than picking one", () => {
    const o = two();
    o.rails[0].name = "Deploy";
    expect(startRailVerdict(o, "r1", "Deploy")).toMatchObject({ kind: "refuse" });
  });

  // Arming the rail this step runs on re-points it at the stage holding
  // this very step: a loop with no exit.
  it("refuses to start the rail the step is on", () => {
    expect(startRailVerdict(two(), "r1", "Build")).toEqual({
      kind: "refuse",
      reason: "a rail cannot start itself",
    });
  });

  // startRail rewinds a rail already under way (see runnableIdleRails),
  // which is the one outcome worse than doing nothing.
  it("does nothing to a rail that is already running", () => {
    const o = two([{ railId: "r2", state: "running", currentStageId: "r2-s0" }]);
    expect(startRailVerdict(o, "r1", "Deploy")).toEqual({ kind: "noop", railId: "r2" });
  });

  it("does nothing to a rail with nothing left to run", () => {
    const o = two([], [{ stepId: "t2", state: "done", sessionId: null, reason: null }]);
    expect(startRailVerdict(o, "r1", "Deploy")).toEqual({ kind: "noop", railId: "r2" });
  });

  // A pause is a human's decision or a stalled step's consequence.
  // Resuming would re-launch the very step that failed.
  it("refuses a paused rail rather than resuming it", () => {
    const o = two([{ railId: "r2", state: "paused", currentStageId: "r2-s0" }]);
    expect(startRailVerdict(o, "r1", "Deploy")).toMatchObject({
      kind: "refuse",
      reason: expect.stringContaining("paused"),
    });
  });
});

describe("startRailTargetWorkspace", () => {
  it("is this rail's own workspace when the parameter is blank", () => {
    expect(startRailTargetWorkspace([{ id: "ws-1" }, { id: "ws-2" }], "ws-1", "")).toEqual({
      kind: "ok",
      workspaceId: "ws-1",
    });
  });

  // Surrounding whitespace from a stray edit is not a real value.
  it("treats a whitespace-only parameter as blank too", () => {
    expect(startRailTargetWorkspace([{ id: "ws-1" }], "ws-1", "   ")).toEqual({
      kind: "ok",
      workspaceId: "ws-1",
    });
  });

  it("targets the named workspace when it still exists", () => {
    expect(startRailTargetWorkspace([{ id: "ws-1" }, { id: "ws-2" }], "ws-1", "ws-2")).toEqual({
      kind: "ok",
      workspaceId: "ws-2",
    });
  });

  // The value is an ID from the step's own picker, not typed text -- so
  // the only way it can go bad is the workspace it named being removed
  // since the step was configured.
  it("refuses a workspace id that no longer exists", () => {
    expect(startRailTargetWorkspace([{ id: "ws-1" }], "ws-1", "ws-gone")).toMatchObject({
      kind: "refuse",
      reason: expect.stringContaining("no longer exists"),
    });
  });
});

// The question the daemon's push handler asks before it decides whether
// to keep this app's run state or go back and re-read. Until
// `gavin_start_rail` there was no such thing as the daemon knowing more
// about run state than the app did.
describe("railRunsDiffer", () => {
  function orch(railRuns: Orchestration["railRuns"]): Orchestration {
    return { rails: [rail("r1", [[["t1", "/x/a.md"]]])], conflictNotes: [], railRuns, stepRuns: [] };
  }

  it("sees a rail the push says is running that this app calls idle", () => {
    const local = orch([]);
    const incoming = orch([{ railId: "r1", state: "running", currentStageId: "r1-s0" }]);
    expect(railRunsDiffer(local, incoming)).toBe(true);
  });

  // Both directions, because the answer is only ever "go and ask the
  // daemon", and a local row the daemon has dropped is as much a reason
  // to ask as one it has added.
  it("sees a rail the push says is idle that this app calls running", () => {
    const local = orch([{ railId: "r1", state: "running", currentStageId: "r1-s0" }]);
    expect(railRunsDiffer(local, orch([]))).toBe(true);
  });

  it("sees a rail that moved to another stage", () => {
    const local = orch([{ railId: "r1", state: "running", currentStageId: "r1-s0" }]);
    const incoming = orch([{ railId: "r1", state: "running", currentStageId: "r1-s1" }]);
    expect(railRunsDiffer(local, incoming)).toBe(true);
  });

  // The ordinary push -- an agent rewriting the plan -- must not cost a
  // re-read, or the daemon's lagging copy gets a chance to overwrite an
  // optimistic local write on every write an agent makes.
  it("says nothing changed when the two agree", () => {
    const runs = [{ railId: "r1", state: "running" as const, currentStageId: "r1-s0" }];
    expect(railRunsDiffer(orch(runs), orch([...runs]))).toBe(false);
    expect(railRunsDiffer(orch([]), orch([]))).toBe(false);
  });

  // Run state for a rail the push has already deleted is not news: the
  // handler drops those rows itself.
  it("ignores a rail the incoming plan no longer has", () => {
    const local = orch([{ railId: "gone", state: "running", currentStageId: "s9" }]);
    expect(railRunsDiffer(local, orch([]))).toBe(false);
  });
});

describe("isStageRunning", () => {
  const r = rail("r1", [[["t1", "/x/a.md"]], [["t2", "/x/b.md"]]]);

  function withRun(state: RailState, currentStageId: string | null): Orchestration {
    return {
      rails: [r],
      conflictNotes: [],
      railRuns: [{ railId: "r1", state, currentStageId }],
      stepRuns: [],
    };
  }

  it("is true only for the stage a running rail is actually on", () => {
    const orch = withRun("running", "r1-s0");
    expect(isStageRunning(orch, "r1-s0")).toBe(true);
    expect(isStageRunning(orch, "r1-s1")).toBe(false);
    expect(runningStageId(orch, "r1")).toBe("r1-s0");
  });

  // O1: nothing spawns on an unarmed rail, so a paused or idle rail has
  // no running stage at all -- not even the one it is parked on.
  it("is false for every stage of a rail that is not running", () => {
    for (const state of ["paused", "idle"] as RailState[]) {
      expect(isStageRunning(withRun(state, "r1-s0"), "r1-s0")).toBe(false);
      expect(runningStageId(withRun(state, "r1-s0"), "r1")).toBeNull();
    }
    expect(isStageRunning({ ...withRun("running", "r1-s0"), railRuns: [] }, "r1-s0")).toBe(false);
  });

  it("is false for a stage no rail owns and for a rail parked on nothing", () => {
    expect(isStageRunning(withRun("running", "r1-s0"), "nope")).toBe(false);
    expect(isStageRunning(withRun("running", null), "r1-s0")).toBe(false);
  });
});


const BOARD = board(["To Do", "In Progress", "Done"]);

function running(rail: Rail, stageId: string, stepRuns: Orchestration["stepRuns"] = []): Orchestration {
  return {
    rails: [rail],
    conflictNotes: [],
    railRuns: [{ railId: rail.id, state: "running", currentStageId: stageId }],
    stepRuns,
  };
}

describe("nextActions", () => {
  it("returns nothing for a rail that is not running", () => {
    const r = rail("r1", [[["t1", "/ws/.gavin-root/plans/a.md"]]]);
    const orch: Orchestration = { rails: [r], conflictNotes: [], railRuns: [], stepRuns: [] };
    expect(nextActions(orch, BOARD, tree([plan("a.md")]), [], new Set())).toEqual([]);
  });

  it("launches a pending step of the current stage", () => {
    const r = rail("r1", [[["t1", "/ws/.gavin-root/plans/a.md"]]]);
    expect(nextActions(running(r, "r1-s0"), BOARD, tree([plan("a.md")]), [], new Set())).toEqual([
      { kind: "launch", stepId: "t1" },
    ]);
  });

  // A failed step used to be invisible to every rule: rule 1 wanted
  // pending or running, rule 2 wanted pending, rule 3 wanted running. A
  // rail armed on the stage holding it produced no actions at all and
  // sat there looking busy. Re-running the rail retries it WHEN THE RUN
  // REACHES IT, which is the same thing the per-step Retry button does,
  // one rung up.
  it("retries a stalled step when the run reaches its stage", () => {
    const r = rail("r1", [[["t1", "/ws/.gavin-root/plans/a.md"]]]);
    const orch = running(r, "r1-s0", [
      { stepId: "t1", state: "stalled", sessionId: null, reason: "agent exited before the card reached Done" },
    ]);
    expect(nextActions(orch, BOARD, tree([plan("a.md")]), [], new Set())).toEqual([
      { kind: "launch", stepId: "t1" },
    ]);
  });

  // The reason is re-derived, never replayed: a retry re-reads the card
  // and re-checks the worktree, so the step stalls again on its own
  // merits -- and rule 5 pauses the rail, which is what keeps a retry to
  // one attempt per Run rather than a spin.
  it("re-stalls a retried step whose blocker is still there, with a fresh reason", () => {
    const r = rail("r1", [[["t1", "/ws/.gavin-root/plans/gone.md"]]]);
    const orch = running(r, "r1-s0", [
      { stepId: "t1", state: "stalled", sessionId: null, reason: "worktree /x/wt is gone" },
    ]);
    expect(nextActions(orch, BOARD, tree([plan("a.md")]), [], new Set())).toEqual([
      { kind: "stall", stepId: "t1", reason: "card file is missing" },
    ]);
  });

  // Rule 1 still runs first: a card finished by hand while the step sat
  // stalled is done, not something to run again.
  it("counts a stalled step whose card has since reached the done column as done", () => {
    const r = rail("r1", [[["t1", "/ws/.gavin-root/plans/a.md"]]]);
    const orch = running(r, "r1-s0", [
      { stepId: "t1", state: "stalled", sessionId: null, reason: "agent exited before the card reached Done" },
    ]);
    expect(nextActions(orch, BOARD, tree([plan("a.md", { status: "Done" })]), [], new Set())).toEqual([
      { kind: "markDone", stepId: "t1" },
      { kind: "complete", railId: "r1" },
    ]);
  });

  it("retries a stalled TOOL step too", () => {
    const r = toolRail("r1", [[["t1", "builtin:push"]]]);
    const orch = running(r, "r1-s0", [
      { stepId: "t1", state: "stalled", sessionId: null, reason: "push exited with code 1" },
    ]);
    expect(nextActions(orch, BOARD, tree([]), [], new Set(), TOOLS)).toEqual([
      { kind: "launch", stepId: "t1" },
    ]);
  });

  it("retries every stalled step of a parallel stage at once", () => {
    const r = rail("r1", [[
      ["t1", "/ws/.gavin-root/plans/a.md"],
      ["t2", "/ws/.gavin-root/plans/b.md"],
    ]]);
    const orch = running(r, "r1-s0", [
      { stepId: "t1", state: "stalled", sessionId: null, reason: "agent exited before the card reached Done" },
    ]);
    expect(nextActions(orch, BOARD, tree([plan("a.md"), plan("b.md")]), [], new Set())).toEqual([
      { kind: "launch", stepId: "t1" },
      { kind: "launch", stepId: "t2" },
    ]);
  });

  // Only a RUNNING rail retries. A stalled step on an idle or paused
  // rail keeps its reason on the chip until a human presses Play or
  // Retry -- reconciliation writes the truth about dead sessions, it
  // does not restart work nobody asked for.
  it("leaves a stalled step alone on a rail that is not running", () => {
    const r = rail("r1", [[["t1", "/ws/.gavin-root/plans/a.md"]]]);
    const orch: Orchestration = {
      rails: [r],
      conflictNotes: [],
      railRuns: [{ railId: "r1", state: "paused", currentStageId: "r1-s0" }],
      stepRuns: [{ stepId: "t1", state: "stalled", sessionId: null, reason: "boom" }],
    };
    expect(nextActions(orch, BOARD, tree([plan("a.md")]), [], new Set())).toEqual([]);
  });

  it("launches every step of a parallel stage at once", () => {
    const r = rail("r1", [[
      ["t1", "/ws/.gavin-root/plans/a.md"],
      ["t2", "/ws/.gavin-root/plans/b.md"],
    ]]);
    const actions = nextActions(
      running(r, "r1-s0"),
      BOARD,
      tree([plan("a.md"), plan("b.md")]),
      [],
      new Set()
    );
    expect(actions).toEqual([
      { kind: "launch", stepId: "t1" },
      { kind: "launch", stepId: "t2" },
    ]);
  });

  it("marks a step done when its card reaches the done column", () => {
    const r = rail("r1", [[["t1", "/ws/.gavin-root/plans/a.md"]]]);
    const orch = running(r, "r1-s0", [{ stepId: "t1", state: "running", sessionId: "s1", reason: null }]);
    const actions = nextActions(
      orch,
      BOARD,
      tree([plan("a.md", { status: "Done" })]),
      [],
      new Set(["s1"])
    );
    expect(actions).toContainEqual({ kind: "markDone", stepId: "t1" });
  });

  it("matches the done column by slug, not by exact spelling", () => {
    const r = rail("r1", [[["t1", "/ws/.gavin-root/plans/a.md"]]]);
    const orch = running(r, "r1-s0", [{ stepId: "t1", state: "running", sessionId: "s1", reason: null }]);
    const actions = nextActions(
      orch,
      BOARD,
      tree([plan("a.md", { status: "  done  " })]),
      [],
      new Set(["s1"])
    );
    expect(actions).toContainEqual({ kind: "markDone", stepId: "t1" });
  });

  // A nested task -- a task with a `parent` and no status of its own --
  // is drawn INSIDE its parent's card, so the column the human sees it
  // in is the parent's. The scheduler used to read only the card's own
  // status, so every nested task under a Done plan looked unfinished
  // and a Start re-ran finished work.
  function nested(fileName: string, parent: string): PlanFileInfo {
    return plan(fileName, {
      path: `/ws/.gavin-root/plans/done/${fileName}`,
      kind: "task",
      parent,
      status: null,
    });
  }

  it("counts a nested task under a done parent as done, not something to launch", () => {
    const r = rail("r1", [[["t1", "/ws/.gavin-root/plans/done/child.md"]]]);
    const t = tree([plan("big.md", { kind: "plan", status: "Done" }), nested("child.md", "big.md")]);
    expect(nextActions(running(r, "r1-s0"), BOARD, t, [], new Set())).toEqual([
      { kind: "markDone", stepId: "t1" },
      { kind: "complete", railId: "r1" },
    ]);
  });

  it("launches a nested task whose parent has not reached the done column", () => {
    const r = rail("r1", [[["t1", "/ws/.gavin-root/plans/done/child.md"]]]);
    const t = tree([
      plan("big.md", { kind: "plan", status: "In Progress" }),
      nested("child.md", "big.md"),
    ]);
    expect(nextActions(running(r, "r1-s0"), BOARD, t, [], new Set())).toEqual([
      { kind: "launch", stepId: "t1" },
    ]);
  });

  it("reads a task's OWN status when it has one, however done its parent is", () => {
    const r = rail("r1", [[["t1", "/ws/.gavin-root/plans/a.md"]]]);
    const t = tree([
      plan("big.md", { kind: "plan", status: "Done" }),
      plan("a.md", { kind: "task", parent: "big.md", status: "To Do" }),
    ]);
    expect(nextActions(running(r, "r1-s0"), BOARD, t, [], new Set())).toEqual([
      { kind: "launch", stepId: "t1" },
    ]);
  });

  it("inherits nothing through a parent that resolves to no plan", () => {
    const r = rail("r1", [[["t1", "/ws/.gavin-root/plans/done/child.md"]]]);
    const t = tree([nested("child.md", "gone.md")]);
    expect(nextActions(running(r, "r1-s0"), BOARD, t, [], new Set())).toEqual([
      { kind: "launch", stepId: "t1" },
    ]);
  });

  it("inherits nothing through a parent that is a task rather than a plan", () => {
    const r = rail("r1", [[["t1", "/ws/.gavin-root/plans/done/child.md"]]]);
    const t = tree([plan("big.md", { kind: "task", status: "Done" }), nested("child.md", "big.md")]);
    expect(nextActions(running(r, "r1-s0"), BOARD, t, [], new Set())).toEqual([
      { kind: "launch", stepId: "t1" },
    ]);
  });

  it("counts a dead nested step under a done parent as done, not stalled", () => {
    const r = rail("r1", [[["t1", "/ws/.gavin-root/plans/done/child.md"]]]);
    const orch = running(r, "r1-s0", [
      { stepId: "t1", state: "running", sessionId: "s1", reason: null },
    ]);
    const t = tree([plan("big.md", { kind: "plan", status: "Done" }), nested("child.md", "big.md")]);
    expect(nextActions(orch, BOARD, t, [], new Set())).toEqual([
      { kind: "markDone", stepId: "t1" },
      { kind: "complete", railId: "r1" },
    ]);
  });

  it("reconciles a dead nested step under a done parent on an idle rail as done", () => {
    const r = rail("r1", [[["t1", "/ws/.gavin-root/plans/done/child.md"]]]);
    const orch: Orchestration = {
      rails: [r],
      conflictNotes: [],
      railRuns: [],
      stepRuns: [{ stepId: "t1", state: "running", sessionId: "s1", reason: null }],
    };
    const t = tree([plan("big.md", { kind: "plan", status: "Done" }), nested("child.md", "big.md")]);
    expect(nextActions(orch, BOARD, t, [], new Set())).toEqual([{ kind: "markDone", stepId: "t1" }]);
  });

  it("collapses a run of already-done stages when the done ones are nested tasks", () => {
    const r = rail("r1", [
      [["t1", "/ws/.gavin-root/plans/done/one.md"]],
      [["t2", "/ws/.gavin-root/plans/done/two.md"], ["t3", "/ws/.gavin-root/plans/done/three.md"]],
      [["t4", "/ws/.gavin-root/plans/c.md"]],
    ]);
    const t = tree([
      plan("big.md", { kind: "plan", status: "Done" }),
      nested("one.md", "big.md"),
      nested("two.md", "big.md"),
      nested("three.md", "big.md"),
      plan("c.md"),
    ]);
    expect(nextActions(running(r, "r1-s0"), BOARD, t, [], new Set())).toEqual([
      { kind: "markDone", stepId: "t1" },
      { kind: "advance", railId: "r1", stageId: "r1-s1" },
      { kind: "markDone", stepId: "t2" },
      { kind: "markDone", stepId: "t3" },
      { kind: "advance", railId: "r1", stageId: "r1-s2" },
      { kind: "launch", stepId: "t4" },
    ]);
  });

  it("advances to the next stage once every step of this one is done", () => {
    const r = rail("r1", [[["t1", "/ws/.gavin-root/plans/a.md"]], [["t2", "/ws/.gavin-root/plans/b.md"]]]);
    const orch = running(r, "r1-s0", [{ stepId: "t1", state: "done", sessionId: null, reason: null }]);
    const actions = nextActions(orch, BOARD, tree([plan("a.md"), plan("b.md")]), [], new Set());
    expect(actions).toEqual([
      { kind: "advance", railId: "r1", stageId: "r1-s1" },
      { kind: "launch", stepId: "t2" },
    ]);
  });

  it("collapses a run of already-done stages in a single tick", () => {
    const r = rail("r1", [
      [["t1", "/ws/.gavin-root/plans/a.md"]],
      [["t2", "/ws/.gavin-root/plans/b.md"]],
      [["t3", "/ws/.gavin-root/plans/c.md"]],
    ]);
    const t = tree([
      plan("a.md", { status: "Done" }),
      plan("b.md", { status: "Done" }),
      plan("c.md"),
    ]);
    const actions = nextActions(running(r, "r1-s0"), BOARD, t, [], new Set());
    expect(actions).toEqual([
      { kind: "markDone", stepId: "t1" },
      { kind: "advance", railId: "r1", stageId: "r1-s1" },
      { kind: "markDone", stepId: "t2" },
      { kind: "advance", railId: "r1", stageId: "r1-s2" },
      { kind: "launch", stepId: "t3" },
    ]);
  });

  it("completes the rail after its last stage", () => {
    const r = rail("r1", [[["t1", "/ws/.gavin-root/plans/a.md"]]]);
    const orch = running(r, "r1-s0", [{ stepId: "t1", state: "done", sessionId: null, reason: null }]);
    expect(nextActions(orch, BOARD, tree([plan("a.md")]), [], new Set())).toEqual([
      { kind: "complete", railId: "r1" },
    ]);
  });

  it("treats an empty stage as complete and moves past it", () => {
    const r = rail("r1", [[], [["t1", "/ws/.gavin-root/plans/a.md"]]]);
    expect(nextActions(running(r, "r1-s0"), BOARD, tree([plan("a.md")]), [], new Set())).toEqual([
      { kind: "advance", railId: "r1", stageId: "r1-s1" },
      { kind: "launch", stepId: "t1" },
    ]);
  });

  it("stalls a step whose card file is missing", () => {
    const r = rail("r1", [[["t1", "/ws/.gavin-root/plans/gone.md"]]]);
    expect(nextActions(running(r, "r1-s0"), BOARD, tree([]), [], new Set())).toEqual([
      { kind: "stall", stepId: "t1", reason: "card file is missing" },
    ]);
  });

  it("stalls a step pointing at a note", () => {
    const r = rail("r1", [[["t1", "/ws/.gavin-root/plans/a.md"]]]);
    const actions = nextActions(
      running(r, "r1-s0"),
      BOARD,
      tree([plan("a.md", { kind: "note" })]),
      [],
      new Set()
    );
    expect(actions).toEqual([{ kind: "stall", stepId: "t1", reason: "notes are not runnable" }]);
  });

  it("stalls when the rail's bound worktree is gone", () => {
    const r = { ...rail("r1", [[["t1", "/ws/.gavin-root/plans/a.md"]]]), worktreePath: "/x/gone" };
    const worktrees = [
      { path: "/ws", head: "abc", branch: "main", isMain: true, locked: false, prunable: false },
    ];
    expect(nextActions(running(r, "r1-s0"), BOARD, tree([plan("a.md")]), worktrees, new Set())).toEqual([
      { kind: "stall", stepId: "t1", reason: "worktree /x/gone is gone" },
    ]);
  });

  it("does not stall on a missing worktree when the worktree list is unknown", () => {
    const r = { ...rail("r1", [[["t1", "/ws/.gavin-root/plans/a.md"]]]), worktreePath: "/x/maybe" };
    expect(nextActions(running(r, "r1-s0"), BOARD, tree([plan("a.md")]), null, new Set())).toEqual([
      { kind: "launch", stepId: "t1" },
    ]);
  });

  // ---- The branch precondition (spec O15) ----------------------------------
  // A rail's branch is checked BEFORE any step rule runs, and yields at
  // most one switchBranch for the whole rail.

  const ON_MAIN: WorktreeInfo[] = [
    { path: "/ws", head: "abc", branch: "main", isMain: true, locked: false, prunable: false },
    { path: "/x/wt-a", head: "def", branch: "wt-a", isMain: false, locked: false, prunable: false },
  ];

  it("switches the ROOT checkout for a branch-bound rail with no worktree", () => {
    // The point of O15: a branch without a folder of its own.
    const r = { ...rail("r1", [[["t1", "/ws/.gavin-root/plans/a.md"]]]), branch: "feature/api" };
    expect(nextActions(running(r, "r1-s0"), BOARD, tree([plan("a.md")]), ON_MAIN, new Set())).toEqual([
      { kind: "switchBranch", railId: "r1", path: "/ws", branch: "feature/api" },
    ]);
  });

  it("switches the rail's own worktree when it is bound to one", () => {
    const r = {
      ...rail("r1", [[["t1", "/ws/.gavin-root/plans/a.md"]]]),
      worktreePath: "/x/wt-a",
      branch: "feature/api",
    };
    expect(nextActions(running(r, "r1-s0"), BOARD, tree([plan("a.md")]), ON_MAIN, new Set())).toEqual([
      { kind: "switchBranch", railId: "r1", path: "/x/wt-a", branch: "feature/api" },
    ]);
  });

  it("launches without switching once the checkout is already on the branch", () => {
    const r = { ...rail("r1", [[["t1", "/ws/.gavin-root/plans/a.md"]]]), branch: "main" };
    expect(nextActions(running(r, "r1-s0"), BOARD, tree([plan("a.md")]), ON_MAIN, new Set())).toEqual([
      { kind: "launch", stepId: "t1" },
    ]);
  });

  it("never switches out from under a running step of that rail", () => {
    // A human who switched the branch mid-run keeps it: rewriting the
    // files under a working agent is worse than a rail on the wrong branch.
    const r = { ...rail("r1", [[["t1", "/ws/.gavin-root/plans/a.md"]]]), branch: "feature/api" };
    const orch = running(r, "r1-s0", [
      { stepId: "t1", state: "running", sessionId: "s1", reason: null },
    ]);
    expect(
      nextActions(orch, BOARD, tree([plan("a.md")]), ON_MAIN, new Set(["s1"]))
    ).toEqual([]);
  });

  it("does not switch while the worktree list is unknown", () => {
    // Cold start: unknown must never read as "on the wrong branch".
    const r = { ...rail("r1", [[["t1", "/ws/.gavin-root/plans/a.md"]]]), branch: "feature/api" };
    expect(nextActions(running(r, "r1-s0"), BOARD, tree([plan("a.md")]), null, new Set())).toEqual([
      { kind: "launch", stepId: "t1" },
    ]);
  });

  it("does not switch a rail whose checkout is not in the worktree list", () => {
    // worktree-missing already stalls this rail; a switch would just fail.
    const r = {
      ...rail("r1", [[["t1", "/ws/.gavin-root/plans/a.md"]]]),
      worktreePath: "/x/gone",
      branch: "feature/api",
    };
    expect(nextActions(running(r, "r1-s0"), BOARD, tree([plan("a.md")]), ON_MAIN, new Set())).toEqual([
      { kind: "stall", stepId: "t1", reason: "worktree /x/gone is gone" },
    ]);
  });

  it("emits one switch for the whole rail, not one per pending step", () => {
    const r = {
      ...rail("r1", [[
        ["t1", "/ws/.gavin-root/plans/a.md"],
        ["t2", "/ws/.gavin-root/plans/b.md"],
      ]]),
      branch: "feature/api",
    };
    expect(
      nextActions(running(r, "r1-s0"), BOARD, tree([plan("a.md"), plan("b.md")]), ON_MAIN, new Set())
    ).toEqual([{ kind: "switchBranch", railId: "r1", path: "/ws", branch: "feature/api" }]);
  });

  it("leaves a rail with no branch bound entirely alone", () => {
    const r = rail("r1", [[["t1", "/ws/.gavin-root/plans/a.md"]]]);
    expect(nextActions(running(r, "r1-s0"), BOARD, tree([plan("a.md")]), ON_MAIN, new Set())).toEqual([
      { kind: "launch", stepId: "t1" },
    ]);
  });

  it("stalls a running step whose session is gone and whose card is not done", () => {
    const r = rail("r1", [[["t1", "/ws/.gavin-root/plans/a.md"]]]);
    const orch = running(r, "r1-s0", [{ stepId: "t1", state: "running", sessionId: "s1", reason: null }]);
    expect(nextActions(orch, BOARD, tree([plan("a.md")]), [], new Set())).toEqual([
      { kind: "stall", stepId: "t1", reason: "agent exited before the card reached Done" },
    ]);
  });

  it("prefers markDone over stall when the session is gone but the card IS done", () => {
    const r = rail("r1", [[["t1", "/ws/.gavin-root/plans/a.md"]]]);
    const orch = running(r, "r1-s0", [{ stepId: "t1", state: "running", sessionId: "s1", reason: null }]);
    const actions = nextActions(orch, BOARD, tree([plan("a.md", { status: "Done" })]), [], new Set());
    expect(actions).toEqual([
      { kind: "markDone", stepId: "t1" },
      { kind: "complete", railId: "r1" },
    ]);
  });

  it("stops at the first stall and does not advance past it", () => {
    const r = rail("r1", [
      [["t1", "/ws/.gavin-root/plans/gone.md"], ["t2", "/ws/.gavin-root/plans/a.md"]],
      [["t3", "/ws/.gavin-root/plans/b.md"]],
    ]);
    const actions = nextActions(
      running(r, "r1-s0"),
      BOARD,
      tree([plan("a.md"), plan("b.md")]),
      [],
      new Set()
    );
    expect(actions).toEqual([
      { kind: "stall", stepId: "t1", reason: "card file is missing" },
      { kind: "launch", stepId: "t2" },
    ]);
    expect(actions.some((a: Action) => a.kind === "advance")).toBe(false);
  });

  it("never advances when the board has no done column", () => {
    const r = rail("r1", [[["t1", "/ws/.gavin-root/plans/a.md"]]]);
    const orch = running(r, "r1-s0", [{ stepId: "t1", state: "running", sessionId: "s1", reason: null }]);
    const actions = nextActions(
      orch,
      board([]),
      tree([plan("a.md", { status: "Done" })]),
      [],
      new Set(["s1"])
    );
    expect(actions).toEqual([]);
  });

  // ---- A rail that is not running still reconciles dead sessions ------
  // Spec §4.4: reconciliation is about what the sessions say, not about
  // whether the rail is advancing. A step left `running` on an idle or
  // paused rail is a row the daemon refuses to delete, so without this
  // the rail can never be edited or removed.

  function notRunning(
    rail: Rail,
    stepRuns: Orchestration["stepRuns"],
    state: "idle" | "paused" = "paused"
  ): Orchestration {
    return {
      rails: [rail],
      conflictNotes: [],
      railRuns: [{ railId: rail.id, state, currentStageId: null }],
      stepRuns,
    };
  }

  it("stalls a step left running on a paused rail once its session is gone", () => {
    const r = rail("r1", [[["t1", "/ws/.gavin-root/plans/a.md"]]]);
    const orch = notRunning(r, [{ stepId: "t1", state: "running", sessionId: "s1", reason: null }]);
    expect(nextActions(orch, BOARD, tree([plan("a.md")]), [], new Set())).toEqual([
      { kind: "stall", stepId: "t1", reason: "agent exited before the card reached Done" },
    ]);
  });

  it("counts a dead step whose card reached the done column as done, not stalled", () => {
    const r = rail("r1", [[["t1", "/ws/.gavin-root/plans/a.md"]]]);
    const orch = notRunning(r, [{ stepId: "t1", state: "running", sessionId: "s1", reason: null }], "idle");
    expect(nextActions(orch, BOARD, tree([plan("a.md", { status: "Done" })]), [], new Set())).toEqual([
      { kind: "markDone", stepId: "t1" },
    ]);
  });

  it("reconciles a running row that never recorded a session id", () => {
    const r = rail("r1", [[["t1", "/ws/.gavin-root/plans/a.md"]]]);
    const orch = notRunning(r, [{ stepId: "t1", state: "running", sessionId: null, reason: null }]);
    expect(nextActions(orch, BOARD, tree([plan("a.md")]), [], new Set())).toEqual([
      { kind: "stall", stepId: "t1", reason: "agent exited before the card reached Done" },
    ]);
  });

  it("leaves a step alone while its session is still live", () => {
    const r = rail("r1", [[["t1", "/ws/.gavin-root/plans/a.md"]]]);
    const orch = notRunning(r, [{ stepId: "t1", state: "running", sessionId: "s1", reason: null }]);
    expect(nextActions(orch, BOARD, tree([plan("a.md")]), [], new Set(["s1"]))).toEqual([]);
  });

  it("neither launches nor advances while reconciling", () => {
    const r = rail("r1", [
      [["t1", "/ws/.gavin-root/plans/a.md"]],
      [["t2", "/ws/.gavin-root/plans/b.md"]],
    ]);
    const orch = notRunning(r, [{ stepId: "t1", state: "running", sessionId: "s1", reason: null }]);
    const actions = nextActions(orch, BOARD, tree([plan("a.md", { status: "Done" }), plan("b.md")]), [], new Set());
    expect(actions).toEqual([{ kind: "markDone", stepId: "t1" }]);
  });
  // ---- An INTERRUPTED session (spec §4.5, extended) -------------------
  // The daemon puts a killed session back as a bare shell under its
  // ORIGINAL id, so the step's session is in `liveSessionIds` and every
  // rule above reads it as an agent still working. Without rule 3c the
  // rail waits on a shell forever.

  const INTERRUPTED_REASON = "interrupted — the daemon restarted, so this step's agent is gone";

  it("stalls a running step whose session was interrupted, even though it is still live", () => {
    const r = rail("r1", [[["t1", "/ws/.gavin-root/plans/a.md"]]]);
    const orch = running(r, "r1-s0", [{ stepId: "t1", state: "running", sessionId: "s1", reason: null }]);
    expect(
      nextActions(orch, BOARD, tree([plan("a.md")]), [], new Set(["s1"]), null, new Map(), new Map(), new Set(["s1"]))
    ).toEqual([{ kind: "stall", stepId: "t1", reason: INTERRUPTED_REASON }]);
  });

  it("marks an interrupted step done when its card reached the done column first", () => {
    // The agent finished the card and THEN the daemon died. Re-running
    // finished work is the whole thing this change exists to stop.
    const r = rail("r1", [[["t1", "/ws/.gavin-root/plans/a.md"]]]);
    const orch = running(r, "r1-s0", [{ stepId: "t1", state: "running", sessionId: "s1", reason: null }]);
    expect(
      nextActions(
        orch,
        BOARD,
        tree([plan("a.md", { status: "Done" })]),
        [],
        new Set(["s1"]),
        null,
        new Map(),
        new Map(),
        new Set(["s1"])
      )
    ).toEqual([{ kind: "markDone", stepId: "t1" }, { kind: "complete", railId: "r1" }]);
  });

  it("stalls an interrupted AGENT tool step instead of calling its idle shell a finished turn", () => {
    // agentTurnEnded reads `idle` as "the turn is over" -- and a bare
    // shell sitting at a prompt is idle. Rule 3c is checked first
    // precisely so an interrupted agent tool is not marked DONE.
    const r = toolRail("r1", [[["t1", "builtin:commit"]]]);
    const orch = running(r, "r1-s0", [{ stepId: "t1", state: "running", sessionId: "s1", reason: null }]);
    expect(
      nextActions(
        orch,
        BOARD,
        tree([]),
        [],
        new Set(["s1"]),
        TOOLS,
        new Map(),
        new Map([["s1", "idle" as SessionStatus]]),
        new Set(["s1"])
      )
    ).toEqual([{ kind: "stall", stepId: "t1", reason: INTERRUPTED_REASON }]);
  });

  it("stalls an interrupted step on a rail that is not running, so the rail stays editable", () => {
    const r = rail("r1", [[["t1", "/ws/.gavin-root/plans/a.md"]]]);
    const orch = notRunning(r, [{ stepId: "t1", state: "running", sessionId: "s1", reason: null }]);
    expect(
      nextActions(orch, BOARD, tree([plan("a.md")]), [], new Set(["s1"]), null, new Map(), new Map(), new Set(["s1"]))
    ).toEqual([{ kind: "stall", stepId: "t1", reason: INTERRUPTED_REASON }]);
  });

  it("says nothing about a step whose session is live and was never interrupted", () => {
    const r = rail("r1", [[["t1", "/ws/.gavin-root/plans/a.md"]]]);
    const orch = running(r, "r1-s0", [{ stepId: "t1", state: "running", sessionId: "s1", reason: null }]);
    expect(
      nextActions(
        orch,
        BOARD,
        tree([plan("a.md")]),
        [],
        new Set(["s1"]),
        null,
        new Map(),
        new Map(),
        new Set(["some-other-session"])
      )
    ).toEqual([]);
  });


  // ---- A FAILED session (rule 3d) -------------------------------------
  //
  // The agent's API connection died, its token expired, its usage ran
  // out, or the machine slept through the conversation. The PROCESS is
  // still alive at its prompt -- so the session is in `liveSessionIds`
  // -- and it goes quiet, which is `idle`, which rule 3b called a
  // finished turn and marked the step DONE. The rail then advanced to
  // the next stage against a checkout where the previous step did
  // nothing. That is the defect this rule exists for.

  const BROKE = "API Error: Connection dropped (ECONNRESET)";
  const FAILED_REASON = `the agent stopped because something broke — ${BROKE}`;
  const failed = (id = "s1") => new Map([[id, BROKE]]);

  it("stalls an AGENT TOOL step whose agent broke, instead of calling its silence a finished turn", () => {
    const r = toolRail("r1", [[["t1", "builtin:commit"]]]);
    const orch = running(r, "r1-s0", [{ stepId: "t1", state: "running", sessionId: "s1", reason: null }]);
    expect(
      nextActions(
        orch,
        BOARD,
        tree([]),
        [],
        new Set(["s1"]),
        TOOLS,
        new Map(),
        // The daemon says `failed`, not `idle` -- but even a caller that
        // only had `idle` would be corrected by the reason map, which is
        // what rule 3d actually keys on.
        new Map([["s1", "failed" as SessionStatus]]),
        new Set(),
        failed()
      )
    ).toEqual([{ kind: "stall", stepId: "t1", reason: FAILED_REASON }]);
  });

  it("stalls a CARD step whose agent broke rather than leaving it running for good", () => {
    const r = rail("r1", [[["t1", "/ws/.gavin-root/plans/a.md"]]]);
    const orch = running(r, "r1-s0", [{ stepId: "t1", state: "running", sessionId: "s1", reason: null }]);
    expect(
      nextActions(
        orch,
        BOARD,
        tree([plan("a.md")]),
        [],
        new Set(["s1"]),
        null,
        new Map(),
        new Map(),
        new Set(),
        failed()
      )
    ).toEqual([{ kind: "stall", stepId: "t1", reason: FAILED_REASON }]);
  });

  // The stall reason is what the human reads on the chip and in the rail
  // header, and it is the difference between "wait ten minutes and press
  // Resume" and "run /login first".
  it("carries the agent's own line into the stall", () => {
    const r = rail("r1", [[["t1", "/ws/.gavin-root/plans/a.md"]]]);
    const orch = running(r, "r1-s0", [{ stepId: "t1", state: "running", sessionId: "s1", reason: null }]);
    const [action] = nextActions(
      orch,
      BOARD,
      tree([plan("a.md")]),
      [],
      new Set(["s1"]),
      null,
      new Map(),
      new Map(),
      new Set(),
      new Map([["s1", "API Error: 401 OAuth token has expired. Please run /login"]])
    );
    expect(action).toEqual({
      kind: "stall",
      stepId: "t1",
      reason:
        "the agent stopped because something broke — API Error: 401 OAuth token has expired. Please run /login",
    });
  });

  it("marks a failed step done when its card reached the done column first", () => {
    // The agent finished the card and THEN its connection died. Finished
    // work is finished, exactly as it is for an interrupted session.
    const r = rail("r1", [[["t1", "/ws/.gavin-root/plans/a.md"]]]);
    const orch = running(r, "r1-s0", [{ stepId: "t1", state: "running", sessionId: "s1", reason: null }]);
    expect(
      nextActions(
        orch,
        BOARD,
        tree([plan("a.md", { status: "Done" })]),
        [],
        new Set(["s1"]),
        null,
        new Map(),
        new Map(),
        new Set(),
        failed()
      )
    ).toEqual([{ kind: "markDone", stepId: "t1" }, { kind: "complete", railId: "r1" }]);
  });

  it("stalls a failed step on a rail that is not running, so the rail stays editable", () => {
    const r = rail("r1", [[["t1", "/ws/.gavin-root/plans/a.md"]]]);
    const orch = notRunning(r, [{ stepId: "t1", state: "running", sessionId: "s1", reason: null }]);
    expect(
      nextActions(
        orch,
        BOARD,
        tree([plan("a.md")]),
        [],
        new Set(["s1"]),
        null,
        new Map(),
        new Map(),
        new Set(),
        failed()
      )
    ).toEqual([{ kind: "stall", stepId: "t1", reason: FAILED_REASON }]);
  });

  // A session can be both only if the daemon restarted and then the bare
  // shell's replacement broke. The failure is the newer fact, and the
  // one with a resumable conversation behind it.
  it("prefers the failure reason over the interrupted one when a session is both", () => {
    const r = rail("r1", [[["t1", "/ws/.gavin-root/plans/a.md"]]]);
    const orch = running(r, "r1-s0", [{ stepId: "t1", state: "running", sessionId: "s1", reason: null }]);
    expect(
      nextActions(
        orch,
        BOARD,
        tree([plan("a.md")]),
        [],
        new Set(["s1"]),
        null,
        new Map(),
        new Map(),
        new Set(["s1"]),
        failed()
      )
    ).toEqual([{ kind: "stall", stepId: "t1", reason: FAILED_REASON }]);
  });

  // The pre-v21 caller passes no map at all, and a rail then behaves
  // exactly as it did before any of this existed.
  it("says nothing about a session that did not break", () => {
    const r = toolRail("r1", [[["t1", "builtin:commit"]]]);
    const orch = running(r, "r1-s0", [{ stepId: "t1", state: "running", sessionId: "s1", reason: null }]);
    const idle = new Map([["s1", "idle" as SessionStatus]]);
    const worked = new Set(["s1"]);
    expect(
      nextActions(orch, BOARD, tree([]), [], new Set(["s1"]), TOOLS, new Map(), idle, new Set(), new Map(), {}, 0, worked)
    ).toEqual([{ kind: "markDone", stepId: "t1" }, { kind: "complete", railId: "r1" }]);
    expect(
      nextActions(orch, BOARD, tree([]), [], new Set(["s1"]), TOOLS, new Map(), idle, new Set(), failed("someone-else"), {}, 0, worked)
    ).toEqual([{ kind: "markDone", stepId: "t1" }, { kind: "complete", railId: "r1" }]);
  });

  it("judges a dead tool step on a paused rail by its exit code", () => {
    const r = toolRail("r1", [[["t1", "builtin:push"]]]);
    const orch = notRunning(r, [{ stepId: "t1", state: "running", sessionId: "s1", reason: null }]);
    expect(
      nextActions(orch, BOARD, tree([]), [], new Set(), TOOLS, new Map([["s1", 0]]))
    ).toEqual([{ kind: "markDone", stepId: "t1" }]);
    expect(nextActions(orch, BOARD, tree([]), [], new Set(), TOOLS)).toEqual([
      {
        kind: "stall",
        stepId: "t1",
        reason: "Push branch's session ended while gavin was not watching",
      },
    ]);
  });

  // The same verdict with the step's tab kept open after the exit
  // (retainTabOnExit): the id is still in the layout, and still over.
  it("judges a kept-open tool step on a paused rail by its exit code", () => {
    const r = toolRail("r1", [[["t1", "builtin:push"]]]);
    const orch = notRunning(r, [{ stepId: "t1", state: "running", sessionId: "s1", reason: null }]);
    expect(
      nextActions(orch, BOARD, tree([]), [], new Set(["s1"]), TOOLS, new Map([["s1", 0]]))
    ).toEqual([{ kind: "markDone", stepId: "t1" }]);
  });

  it("schedules each running rail independently", () => {
    const a = rail("r1", [[["t1", "/ws/.gavin-root/plans/a.md"]]]);
    const b = rail("r2", [[["t2", "/ws/.gavin-root/plans/b.md"]]]);
    const orch: Orchestration = {
      rails: [a, b],
      conflictNotes: [],
      railRuns: [
        { railId: "r1", state: "running", currentStageId: "r1-s0" },
        { railId: "r2", state: "paused", currentStageId: "r2-s0" },
      ],
      stepRuns: [],
    };
    expect(nextActions(orch, BOARD, tree([plan("a.md"), plan("b.md")]), [], new Set())).toEqual([
      { kind: "launch", stepId: "t1" },
    ]);
  });
});

describe("nextActions on a sequence group", () => {
  function sequential(): Orchestration {
    let o = addRail(emptyOrchestration(), "r1", "backend");
    o = addStep(addStage(o, "r1", "s1"), "s1", "t1", "/ws/.gavin-root/plans/a.md", 0);
    o = addStep(o, "s1", "t2", "/ws/.gavin-root/plans/b.md", 1);
    o = setStageMode(o, "s1", "sequence");
    return { ...o, railRuns: [{ railId: "r1", state: "running", currentStageId: "s1" }] };
  }

  const t = () => tree([plan("a.md"), plan("b.md")]);
  const b = () => board(["To Do", "Done"]);

  it("launches only the first member", () => {
    const actions = nextActions(sequential(), b(), t(), [], new Set());
    expect(actions).toEqual([{ kind: "launch", stepId: "t1" }]);
  });

  it("launches all members when the same stage is parallel", () => {
    // The contrast is the whole feature: same stage, same steps, one
    // field apart.
    const o = setStageMode(sequential(), "s1", "parallel");
    expect(nextActions(o, b(), t(), [], new Set())).toEqual([
      { kind: "launch", stepId: "t1" },
      { kind: "launch", stepId: "t2" },
    ]);
  });

  it("does not launch the second while the first runs", () => {
    const o = { ...sequential(), stepRuns: [{ stepId: "t1", state: "running" as StepState, sessionId: "sess-1", reason: null }] };
    expect(nextActions(o, b(), t(), [], new Set(["sess-1"]))).toEqual([]);
  });

  it("launches the next as soon as the first is done", () => {
    const o = { ...sequential(), stepRuns: [{ stepId: "t1", state: "done" as StepState, sessionId: null, reason: null }] };
    expect(nextActions(o, b(), t(), [], new Set())).toEqual([{ kind: "launch", stepId: "t2" }]);
  });

  it("cascades within one tick when a member completes on this pass", () => {
    // Rule 1 marks t1 done because its card reached the done column; the
    // next member must not wait for an unrelated change to tick the
    // workspace again.
    const o = sequential();
    const actions = nextActions(o, b(), tree([plan("a.md", { status: "Done" }), plan("b.md")]), [], new Set());
    expect(actions).toEqual([
      { kind: "markDone", stepId: "t1" },
      { kind: "launch", stepId: "t2" },
    ]);
  });

  it("advances the rail only when every member is done", () => {
    let o = sequential();
    o = addStep(addStage(o, "r1", "s2"), "s2", "t3", "/ws/.gavin-root/plans/c.md", 0);
    o = { ...o, stepRuns: [
      { stepId: "t1", state: "done", sessionId: null, reason: null },
      { stepId: "t2", state: "done", sessionId: null, reason: null },
    ] };
    const actions = nextActions(o, b(), tree([plan("a.md"), plan("b.md"), plan("c.md")]), [], new Set());
    expect(actions).toContainEqual({ kind: "advance", railId: "r1", stageId: "s2" });
  });

  it("still pauses the rail when a member stalls", () => {
    // A stalled member must read as a stall, not as "just not done yet".
    // A bound rail whose worktree is not in the known list is the
    // cheapest blocker launchBlocker recognises.
    const base = sequential();
    const o = { ...base, rails: base.rails.map((r) => ({ ...r, worktreePath: "/gone" })) };
    const actions = nextActions(o, b(), t(), [], new Set());
    expect(actions.filter((a) => a.kind === "stall")).toHaveLength(1);
    expect(actions.some((a) => a.kind === "launch")).toBe(false);
  });
});

// A step the human sent the rail PAST. Terminal like `done` and it means
// the opposite: the rail has nothing left to do here, and nothing here
// got done. Every rule that asks "may the rail move on" has to accept it;
// every tally that asks "what got finished" must not.
describe("skip and proceed", () => {
  it("counts done and skipped as finished, and nothing else", () => {
    expect(isStepFinished("done")).toBe(true);
    expect(isStepFinished("skipped")).toBe(true);
    expect(isStepFinished("pending")).toBe(false);
    expect(isStepFinished("running")).toBe(false);
    expect(isStepFinished("stalled")).toBe(false);
  });

  it("lets Start arm past a fully skipped stage", () => {
    const r = rail("r1", [[["t1", "/x/a.md"]], [["t2", "/x/b.md"]]]);
    const orch: Orchestration = {
      rails: [r],
      conflictNotes: [],
      railRuns: [],
      stepRuns: [{ stepId: "t1", state: "skipped", sessionId: null, reason: null }],
    };
    // Not "r1-s0": a rail that rewound onto the step the human had just
    // stepped over would undo the skip on the next press of Play.
    expect(firstUnfinishedStageId(r, orch)).toBe("r1-s1");
  });

  it("advances the rail off a skipped step's stage", () => {
    const r = rail("r1", [[["t1", "/ws/.gavin-root/plans/a.md"]], [["t2", "/ws/.gavin-root/plans/b.md"]]]);
    const orch = running(r, "r1-s0", [
      { stepId: "t1", state: "skipped", sessionId: "sess-1", reason: null },
    ]);
    expect(nextActions(orch, BOARD, tree([plan("a.md"), plan("b.md")]), [], new Set())).toEqual([
      { kind: "advance", railId: "r1", stageId: "r1-s1" },
      { kind: "launch", stepId: "t2" },
    ]);
  });

  it("completes a rail whose last stage was skipped", () => {
    const r = rail("r1", [[["t1", "/ws/.gavin-root/plans/a.md"]]]);
    const orch = running(r, "r1-s0", [
      { stepId: "t1", state: "skipped", sessionId: null, reason: null },
    ]);
    expect(nextActions(orch, BOARD, tree([plan("a.md")]), [], new Set())).toEqual([
      { kind: "complete", railId: "r1" },
    ]);
  });

  // Rule 2 wants `pending` or `stalled`; a skipped step is neither, so
  // the run must walk over it rather than start it.
  it("never relaunches a skipped step", () => {
    const r = rail("r1", [[["t1", "/ws/.gavin-root/plans/a.md"]]]);
    const orch = running(r, "r1-s0", [
      { stepId: "t1", state: "skipped", sessionId: null, reason: null },
    ]);
    const actions = nextActions(orch, BOARD, tree([plan("a.md")]), [], new Set());
    expect(actions.some((a) => a.kind === "launch")).toBe(false);
  });

  // Rule 1 turns a card sitting in the done column into a `markDone`.
  // Over a SKIPPED step that would rewrite the human's decision as an
  // achievement -- and a card can reach Done by any route, including a
  // human dragging it there minutes later.
  it("does not re-file a skipped step as done when its card reaches the done column", () => {
    const r = rail("r1", [[["t1", "/ws/.gavin-root/plans/a.md"]]]);
    const orch = running(r, "r1-s0", [
      { stepId: "t1", state: "skipped", sessionId: null, reason: null },
    ]);
    const actions = nextActions(orch, BOARD, tree([plan("a.md", { status: "Done" })]), [], new Set());
    expect(actions.some((a) => a.kind === "markDone")).toBe(false);
    expect(actions).toEqual([{ kind: "complete", railId: "r1" }]);
  });

  it("lets the next member of a sequence group go", () => {
    let o = addRail(emptyOrchestration(), "r1", "backend");
    o = addStep(addStage(o, "r1", "s1"), "s1", "t1", "/ws/.gavin-root/plans/a.md", 0);
    o = addStep(o, "s1", "t2", "/ws/.gavin-root/plans/b.md", 1);
    o = setStageMode(o, "s1", "sequence");
    o = {
      ...o,
      railRuns: [{ railId: "r1", state: "running", currentStageId: "s1" }],
      stepRuns: [{ stepId: "t1", state: "skipped", sessionId: null, reason: null }],
    };
    expect(nextActions(o, board(["To Do", "Done"]), tree([plan("a.md"), plan("b.md")]), [], new Set())).toEqual([
      { kind: "launch", stepId: "t2" },
    ]);
  });

  // A conflict is a claim about work the rails have STILL to do. A
  // skipped step will never touch the checkout again, so it drops out of
  // the detector exactly as a done one does.
  it("drops out of conflict detection", () => {
    let o = addRail(emptyOrchestration(), "r1", "backend");
    o = addStep(addStage(o, "r1", "s1"), "s1", "t1", "/ws/.gavin-root/plans/a.md", 0);
    o = addStep(o, "s1", "t2", "/ws/.gavin-root/plans/a.md", 1);
    const t = tree([plan("a.md")]);
    // The rail is unbound, which is a conflict of its own and says
    // nothing about steps -- the duplicate-card one is the subject here.
    const dupes = (orch: Orchestration) =>
      detectConflicts(orch, t, [], []).filter((c) => c.kind === "duplicate-card");
    expect(dupes(o)).toHaveLength(1);
    const skipped: Orchestration = {
      ...o,
      stepRuns: [{ stepId: "t2", state: "skipped", sessionId: null, reason: null }],
    };
    expect(dupes(skipped)).toEqual([]);
  });

  // "Clear done steps" says done, and a skip is the only record that the
  // human sent the rail past this step. Sweeping it under that label
  // would erase the decision and call it done in the same gesture.
  it("is left on the rail by Clear done", () => {
    const r = rail("r1", [[["t1", "/ws/.gavin-root/plans/a.md"], ["t2", "/ws/.gavin-root/plans/b.md"]]]);
    const orch: Orchestration = {
      rails: [r],
      conflictNotes: [],
      railRuns: [],
      stepRuns: [
        { stepId: "t1", state: "done", sessionId: null, reason: null },
        { stepId: "t2", state: "skipped", sessionId: null, reason: null },
      ],
    };
    const cards = cardIndex(tree([plan("a.md"), plan("b.md")]));
    expect(railDoneStepIds(r, orch, cards, "Done")).toEqual(["t1"]);
  });
});

describe("plan mutators", () => {
  it("adds a rail at the end and numbers positions from zero", () => {
    let o = addRail(emptyOrchestration(), "r1", "backend");
    o = addRail(o, "r2", "ui");
    expect(o.rails.map((r) => [r.id, r.position])).toEqual([
      ["r1", 0],
      ["r2", 1],
    ]);
  });

  it("renames and binds a rail without touching the others", () => {
    let o = addRail(addRail(emptyOrchestration(), "r1", "backend"), "r2", "ui");
    o = renameRail(o, "r1", "server");
    o = bindRail(o, "r1", { worktreePath: "/x/wt", pageId: "p1" });
    expect(o.rails[0]).toMatchObject({ name: "server", worktreePath: "/x/wt", pageId: "p1" });
    expect(o.rails[1]).toMatchObject({ name: "ui", worktreePath: null, pageId: null });
  });

  it("binds only the keys given", () => {
    let o = bindRail(addRail(emptyOrchestration(), "r1", "backend"), "r1", { worktreePath: "/x/wt" });
    o = bindRail(o, "r1", { pageId: "p1" });
    expect(o.rails[0]).toMatchObject({ worktreePath: "/x/wt", pageId: "p1" });
  });

  it("deletes a rail, renumbers the rest, and drops notes that named its steps", () => {
    let o = addRail(addRail(emptyOrchestration(), "r1", "backend"), "r2", "ui");
    o = addStep(addStage(o, "r1", "s1"), "s1", "t1", "/x/a.md", 0);
    o = { ...o, conflictNotes: [{ id: "n1", stepIds: ["t1"], note: "careful" }] };
    o = deleteRail(o, "r1");
    expect(o.rails.map((r) => [r.id, r.position])).toEqual([["r2", 0]]);
    expect(o.conflictNotes).toEqual([]);
  });

  it("adds stages in order and steps within a stage in order", () => {
    let o = addRail(emptyOrchestration(), "r1", "backend");
    o = addStage(o, "r1", "s1");
    o = addStage(o, "r1", "s2");
    o = addStep(o, "s1", "t1", "/x/a.md", 0);
    o = addStep(o, "s1", "t2", "/x/b.md", 1);
    expect(o.rails[0].stages.map((s) => [s.id, s.position])).toEqual([
      ["s1", 0],
      ["s2", 1],
    ]);
    expect(o.rails[0].stages[0].steps.map((t) => [t.id, t.position])).toEqual([
      ["t1", 0],
      ["t2", 1],
    ]);
  });

  it("removes a step, renumbers its siblings, and drops a stage left empty", () => {
    let o = addStep(addStage(addRail(emptyOrchestration(), "r1", "backend"), "r1", "s1"), "s1", "t1", "/x/a.md", 0);
    o = addStep(o, "s1", "t2", "/x/b.md", 1);
    o = removeStep(o, "t1");
    expect(o.rails[0].stages[0].steps.map((t) => [t.id, t.position])).toEqual([["t2", 0]]);
    o = removeStep(o, "t2");
    expect(o.rails[0].stages).toEqual([]);
  });

  it("drops run state and notes for a removed step", () => {
    let o = addStep(addStage(addRail(emptyOrchestration(), "r1", "backend"), "r1", "s1"), "s1", "t1", "/x/a.md", 0);
    o = {
      ...o,
      stepRuns: [{ stepId: "t1", state: "done", sessionId: null, reason: null }],
      conflictNotes: [{ id: "n1", stepIds: ["t1"], note: "careful" }],
    };
    o = removeStep(o, "t1");
    expect(o.stepRuns).toEqual([]);
    expect(o.conflictNotes).toEqual([]);
  });
});

const WT: WorktreeInfo[] = [
  { path: "/x/main", head: "a", branch: "main", isMain: true, locked: false, prunable: false },
  { path: "/x/wt-a", head: "b", branch: "a", isMain: false, locked: false, prunable: false },
];

const BRANCHES = ["main", "a", "docs/rework", "feature/api"];

function bound(id: string, worktreePath: string | null, stages: Array<Array<[string, string]>>): Rail {
  return { ...rail(id, stages), worktreePath };
}

function orchOf(rails: Rail[], overrides: Partial<Orchestration> = {}): Orchestration {
  return { ...emptyOrchestration(), rails, ...overrides };
}

const CARDS = tree([plan("a.md"), plan("b.md"), plan("c.md")]);
const A = "/ws/.gavin-root/plans/a.md";
const B = "/ws/.gavin-root/plans/b.md";
const C = "/ws/.gavin-root/plans/c.md";

describe("detectConflicts — same worktree", () => {
  it("flags a parallel stage: two agents in one checkout", () => {
    const o = orchOf([bound("r1", "/x/wt-a", [[["t1", A], ["t2", B]]])]);
    expect(detectConflicts(o, CARDS, WT)).toEqual([
      {
        kind: "same-worktree",
        scope: "stage",
        stageId: "r1-s0",
        severity: "potential",
        stepIds: ["t1", "t2"],
        worktreePath: "/x/wt-a",
      },
    ]);
  });

  it("still flags a parallel stage on an UNBOUND rail — it shares the root checkout", () => {
    const o = orchOf([bound("r1", null, [[["t1", A], ["t2", B]]])]);
    expect(detectConflicts(o, CARDS, WT)).toContainEqual(
      expect.objectContaining({ kind: "same-worktree", scope: "stage", worktreePath: "/ws" })
    );
  });

  it("does NOT flag different stages of one rail — they are strictly sequential", () => {
    const o = orchOf([bound("r1", "/x/wt-a", [[["t1", A]], [["t2", B]]])]);
    expect(detectConflicts(o, CARDS, WT)).toEqual([]);
  });

  it("flags two rails sharing a worktree, whatever stage each is on", () => {
    const o = orchOf([
      bound("r1", "/x/wt-a", [[["t1", A]], [["t2", B]]]),
      bound("r2", "/x/wt-a", [[["t3", C]]]),
    ]);
    const found = detectConflicts(o, CARDS, WT);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      kind: "same-worktree",
      scope: "rails",
      stageId: null,
      worktreePath: "/x/wt-a",
    });
    expect(found[0].kind === "same-worktree" && [...found[0].stepIds].sort()).toEqual(["t1", "t2", "t3"]);
  });

  it("says nothing when every rail is on its own worktree", () => {
    const o = orchOf([
      bound("r1", "/x/wt-a", [[["t1", A]], [["t2", B]]]),
      bound("r2", "/x/main", [[["t3", C]]]),
    ]);
    expect(detectConflicts(o, CARDS, WT)).toEqual([]);
  });

  it("collides two unbound rails on the ROOT checkout, not on their cards' folders", () => {
    const o = orchOf([bound("r1", null, [[["t1", A]]]), bound("r2", null, [[["t2", B]]])]);
    const found = detectConflicts(o, CARDS, WT);
    // /ws, the tree's rootPath -- NOT /ws/.gavin-root, which is merely a
    // subdirectory of that same working tree (spec O13).
    expect(found.some((c) => c.kind === "same-worktree" && c.worktreePath === "/ws")).toBe(true);
    expect(found.some((c) => c.kind === "same-worktree" && c.worktreePath === "/ws/.gavin-root")).toBe(false);
  });

  it("ignores done steps", () => {
    const o = orchOf([bound("r1", "/x/wt-a", [[["t1", A], ["t2", B]]])], {
      stepRuns: [{ stepId: "t1", state: "done", sessionId: null, reason: null }],
    });
    expect(detectConflicts(o, CARDS, WT)).toEqual([]);
  });

  it("is live when two of the group are actually running", () => {
    const o = orchOf([bound("r1", "/x/wt-a", [[["t1", A], ["t2", B]]])], {
      stepRuns: [
        { stepId: "t1", state: "running", sessionId: "s1", reason: null },
        { stepId: "t2", state: "running", sessionId: "s2", reason: null },
      ],
    });
    expect(detectConflicts(o, CARDS, WT)[0].severity).toBe("live");
  });

  it("is only potential when a single step of the group is running", () => {
    const o = orchOf([bound("r1", "/x/wt-a", [[["t1", A], ["t2", B]]])], {
      stepRuns: [{ stepId: "t1", state: "running", sessionId: "s1", reason: null }],
    });
    expect(detectConflicts(o, CARDS, WT)[0].severity).toBe("potential");
  });

  it("does not call a sequence group a same-worktree conflict", () => {
    // Its members share the rail's checkout IN TURN, which is what a rail
    // is for -- reporting that as a collision is noise.
    let o = addRail(emptyOrchestration(), "r1", "backend");
    o = { ...o, rails: o.rails.map((r) => ({ ...r, worktreePath: "/wt/a" })) };
    o = addStep(addStage(o, "r1", "s1"), "s1", "t1", "/ws/.gavin-root/plans/a.md", 0);
    o = addStep(o, "s1", "t2", "/ws/.gavin-root/plans/b.md", 1);
    o = setStageMode(o, "s1", "sequence");
    const found = detectConflicts(o, tree([plan("a.md"), plan("b.md")]), [{ path: "/wt/a" } as WorktreeInfo]);
    expect(found.filter((c) => c.kind === "same-worktree" && c.scope === "stage")).toEqual([]);
  });

  it("still calls a parallel group one", () => {
    let o = addRail(emptyOrchestration(), "r1", "backend");
    o = { ...o, rails: o.rails.map((r) => ({ ...r, worktreePath: "/wt/a" })) };
    o = addStep(addStage(o, "r1", "s1"), "s1", "t1", "/ws/.gavin-root/plans/a.md", 0);
    o = addStep(o, "s1", "t2", "/ws/.gavin-root/plans/b.md", 1);
    o = setStageMode(o, "s1", "parallel");
    const found = detectConflicts(o, tree([plan("a.md"), plan("b.md")]), [{ path: "/wt/a" } as WorktreeInfo]);
    expect(found.filter((c) => c.kind === "same-worktree" && c.scope === "stage")).toHaveLength(1);
  });
});

describe("detectConflicts — the other kinds", () => {
  it("flags the same card placed on two steps", () => {
    const o = orchOf([bound("r1", "/x/wt-a", [[["t1", A]], [["t2", A]]])]);
    expect(detectConflicts(o, CARDS, WT)).toContainEqual({
      kind: "duplicate-card",
      severity: "potential",
      stepIds: ["t1", "t2"],
      cardPath: A,
    });
  });

  // Two card files, one piece of work: the plan's agent works its nested
  // children (its rail step draws them inside the card), so the child's
  // own step re-runs work the rail is already scheduled to do. Only ever
  // reached deliberately -- availableCards does not offer a nested child
  // -- which is why it is said out loud rather than refused.
  const NESTED = tree([
    plan("parent.md", { kind: "plan", status: "To Do" }),
    plan("child.md", { kind: "task", status: null, parent: "parent.md" }),
    plan("free.md", { kind: "task", status: "To Do", parent: "parent.md" }),
  ]);
  const PARENT = "/ws/.gavin-root/plans/parent.md";
  const CHILD = "/ws/.gavin-root/plans/child.md";
  const FREE = "/ws/.gavin-root/plans/free.md";

  it("flags a nested child on a rail while its plan is on one too", () => {
    const o = orchOf([bound("r1", "/x/wt-a", [[["t1", PARENT]], [["t2", CHILD]]])]);
    expect(detectConflicts(o, NESTED, WT)).toContainEqual({
      kind: "nested-with-parent",
      severity: "potential",
      stepIds: ["t2", "t1"],
      cardPath: CHILD,
      parentPath: PARENT,
    });
  });

  it("flags it across two rails, not just within one", () => {
    const o = orchOf([
      bound("r1", "/x/wt-a", [[["t1", PARENT]]]),
      bound("r2", "/x/main", [[["t2", CHILD]]]),
    ]);
    expect(detectConflicts(o, NESTED, WT)).toContainEqual(
      expect.objectContaining({ kind: "nested-with-parent", stepIds: ["t2", "t1"] })
    );
  });

  it("says nothing about a nested child whose plan is on no rail", () => {
    const o = orchOf([bound("r1", "/x/wt-a", [[["t1", CHILD]]])]);
    expect(detectConflicts(o, NESTED, WT).some((c) => c.kind === "nested-with-parent")).toBe(false);
  });

  it("says nothing about a plan on a rail whose children are not", () => {
    const o = orchOf([bound("r1", "/x/wt-a", [[["t1", PARENT]]])]);
    expect(detectConflicts(o, NESTED, WT).some((c) => c.kind === "nested-with-parent")).toBe(false);
  });

  // A status of its own makes the child free-standing: its own card, in
  // its own column, and its own work. The plan being on a rail says
  // nothing about it.
  it("says nothing about a parented card that carries its own status", () => {
    const o = orchOf([bound("r1", "/x/wt-a", [[["t1", PARENT]], [["t2", FREE]]])]);
    expect(detectConflicts(o, NESTED, WT).some((c) => c.kind === "nested-with-parent")).toBe(false);
  });

  // Every conflict here is about work still ahead -- a finished step
  // cannot collide with anything (placedSteps drops the done ones).
  it("says nothing once the child's step is done", () => {
    const o = orchOf([bound("r1", "/x/wt-a", [[["t1", PARENT]], [["t2", CHILD]]])], {
      stepRuns: [{ stepId: "t2", state: "done", sessionId: null, reason: null }],
    });
    expect(detectConflicts(o, NESTED, WT).some((c) => c.kind === "nested-with-parent")).toBe(false);
  });

  it("names both cards in its line", () => {
    const o = orchOf([bound("r1", "/x/wt-a", [[["t1", PARENT]], [["t2", CHILD]]])]);
    const c = detectConflicts(o, NESTED, WT).find((x) => x.kind === "nested-with-parent") as Conflict;
    const line = describeConflict(c, cardIndex(NESTED), o);
    expect(line).toContain("“child”");
    expect(line).toContain("“parent”");
  });

  it("flags a rail whose bound worktree is gone", () => {
    const o = orchOf([bound("r1", "/x/vanished", [[["t1", A]]])]);
    expect(detectConflicts(o, CARDS, WT)).toContainEqual({
      kind: "worktree-missing",
      severity: "potential",
      railId: "r1",
      worktreePath: "/x/vanished",
    });
  });

  it("suppresses worktree-missing while the worktree list is unknown", () => {
    const o = orchOf([bound("r1", "/x/vanished", [[["t1", A]]])]);
    expect(detectConflicts(o, CARDS, null).some((c) => c.kind === "worktree-missing")).toBe(false);
  });

  it("flags a rail whose bound branch no longer exists", () => {
    const o = orchOf([{ ...bound("r1", null, [[["t1", A]]]), branch: "feature/gone" }]);
    expect(detectConflicts(o, CARDS, WT, BRANCHES)).toContainEqual({
      kind: "branch-missing",
      severity: "potential",
      railId: "r1",
      branch: "feature/gone",
    });
  });

  it("stays quiet about a branch that does exist", () => {
    const o = orchOf([{ ...bound("r1", "/x/wt-a", [[["t1", A]]]), branch: "main" }]);
    expect(detectConflicts(o, CARDS, WT, BRANCHES).some((c) => c.kind === "branch-missing")).toBe(
      false
    );
  });

  it("suppresses branch-missing while the branch list is unknown", () => {
    // Same cold-start principle as worktree-missing: unloaded is not gone.
    const o = orchOf([{ ...bound("r1", "/x/wt-a", [[["t1", A]]]), branch: "feature/gone" }]);
    expect(detectConflicts(o, CARDS, WT, null).some((c) => c.kind === "branch-missing")).toBe(false);
  });

  it("names both branches when two rails fight over one checkout", () => {
    // No conflict kind of its own: sharing a checkout is already the
    // criterion (O13). The branches only sharpen what the box says.
    const o = orchOf([
      { ...bound("r1", "/x/wt-a", [[["t1", A]]]), branch: "feature/api" },
      { ...bound("r2", "/x/wt-a", [[["t2", B]]]), branch: "docs/rework" },
    ]);
    const found = detectConflicts(o, CARDS, WT, BRANCHES).filter((c) => c.kind === "same-worktree");
    expect(found).toHaveLength(1);
    const line = describeConflict(found[0], cardIndex(CARDS), o, []);
    expect(line).toContain("feature/api");
    expect(line).toContain("docs/rework");
  });

  it("flags an unbound rail that has steps", () => {
    const o = orchOf([bound("r1", null, [[["t1", A]]])]);
    expect(detectConflicts(o, CARDS, WT)).toContainEqual({
      kind: "rail-unbound",
      severity: "potential",
      railId: "r1",
    });
  });

  it("does not flag an unbound rail with no steps — that is just unfinished setup", () => {
    const o = orchOf([bound("r1", null, [])]);
    expect(detectConflicts(o, CARDS, WT)).toEqual([]);
  });

  it("surfaces the agent's declared notes", () => {
    const o = orchOf([bound("r1", "/x/wt-a", [[["t1", A]], [["t2", B]]])], {
      conflictNotes: [{ id: "n1", stepIds: ["t1", "t2"], note: "both rewrite GitDiff.svelte" }],
    });
    expect(detectConflicts(o, CARDS, WT)).toContainEqual({
      kind: "declared",
      severity: "potential",
      id: "n1",
      stepIds: ["t1", "t2"],
      note: "both rewrite GitDiff.svelte",
    });
  });
});

describe("numberConflicts", () => {
  it("puts live first, then orders by kind, and numbers from one", () => {
    const conflicts: Conflict[] = [
      { kind: "rail-unbound", severity: "potential", railId: "r9" },
      { kind: "declared", severity: "potential", id: "n1", stepIds: ["t1"], note: "x" },
      {
        kind: "same-worktree",
        scope: "stage",
        stageId: "s1",
        severity: "live",
        stepIds: ["t1", "t2"],
        worktreePath: "/x/wt-a",
      },
      { kind: "duplicate-card", severity: "potential", stepIds: ["t3", "t4"], cardPath: A },
    ];
    expect(numberConflicts(conflicts).map((n) => [n.n, n.conflict.kind])).toEqual([
      [1, "same-worktree"],
      [2, "duplicate-card"],
      [3, "rail-unbound"],
      [4, "declared"],
    ]);
  });

  it("is stable for two conflicts of the same kind and severity", () => {
    const conflicts: Conflict[] = [
      { kind: "duplicate-card", severity: "potential", stepIds: ["t9"], cardPath: B },
      { kind: "duplicate-card", severity: "potential", stepIds: ["t1"], cardPath: A },
    ];
    expect(numberConflicts(conflicts).map((n) => n.conflict)).toEqual([
      { kind: "duplicate-card", severity: "potential", stepIds: ["t1"], cardPath: A },
      { kind: "duplicate-card", severity: "potential", stepIds: ["t9"], cardPath: B },
    ]);
  });
});

describe("conflict lookups", () => {
  const numbered = numberConflicts([
    {
      kind: "same-worktree",
      scope: "stage",
      stageId: "s1",
      severity: "live",
      stepIds: ["t1", "t2"],
      worktreePath: "/x/wt-a",
    },
    { kind: "duplicate-card", severity: "potential", stepIds: ["t2", "t3"], cardPath: A },
    { kind: "rail-unbound", severity: "potential", railId: "r2" },
  ]);

  it("collects every badge a step belongs to", () => {
    expect(numbersForStep(numbered, "t2")).toEqual([1, 2]);
    expect(numbersForStep(numbered, "t7")).toEqual([]);
  });

  it("collects rail-level badges separately", () => {
    expect(numbersForRail(numbered, "r2")).toEqual([3]);
  });

  it("takes the highest severity when a step is in several conflicts", () => {
    expect(severityForStep(numbered, "t2")).toBe("live");
    expect(severityForStep(numbered, "t3")).toBe("potential");
    expect(severityForStep(numbered, "t7")).toBeNull();
  });

  it("gathers a rail's own conflicts AND every one naming a step it holds", () => {
    // r2 owns t2 and t3 but is also unbound: all three numbers concern it.
    const r2 = { ...rail("r2", [[["t2", A]], [["t3", B]]]), name: "ui" };
    expect(conflictsForRail(numbered, r2).map((x) => x.n)).toEqual([1, 2, 3]);
  });

  it("leaves out conflicts about steps on other rails", () => {
    expect(conflictsForRail(numbered, rail("r9", [[["t7", A]]])).map((x) => x.n)).toEqual([]);
  });
});

function built(): Orchestration {
  // r1: [t1] [t2, t3]   r2: [t4]
  let o = addRail(addRail(emptyOrchestration(), "r1", "backend"), "r2", "ui");
  o = addStage(o, "r1", "s1");
  o = addStep(o, "s1", "t1", "/x/a.md", 0);
  o = addStage(o, "r1", "s2");
  o = addStep(o, "s2", "t2", "/x/b.md", 0);
  o = addStep(o, "s2", "t3", "/x/c.md", 1);
  o = addStage(o, "r2", "s3");
  o = addStep(o, "s3", "t4", "/x/d.md", 0);
  return o;
}

const stageMap = (o: Orchestration) =>
  o.rails.map((r) => [r.id, r.stages.map((s) => s.steps.map((t) => t.id))]);

describe("moveStepIntoStage", () => {
  it("joins the tail of a stage that already holds two steps", () => {
    const o = moveStepIntoStage(built(), "t1", "s2", 2);
    expect(stageMap(o)).toEqual([
      ["r1", [["t2", "t3", "t1"]]],
      ["r2", [["t4"]]],
    ]);
  });

  it("moves across rails, which changes the step's effective worktree", () => {
    const o = moveStepIntoStage(built(), "t4", "s1", 1);
    expect(stageMap(o)).toEqual([
      ["r1", [["t1", "t4"], ["t2", "t3"]]],
      ["r2", []],
    ]);
  });

  it("is a no-op when the step is re-dropped in its own slot", () => {
    const before = built();
    expect(stageMap(moveStepIntoStage(before, "t2", "s2", 0))).toEqual(stageMap(before));
  });

  it("renumbers positions after the move", () => {
    const o = moveStepIntoStage(built(), "t1", "s2", 2);
    expect(o.rails[0].stages[0].steps.map((t) => t.position)).toEqual([0, 1, 2]);
    expect(o.rails[0].stages.map((s) => s.position)).toEqual([0]);
  });
});

describe("stageMode", () => {
  it("reads an absent mode as parallel", () => {
    // Every stage written before groups existed omits it, and those ran
    // their steps at once.
    expect(stageMode({ id: "s1", position: 0, steps: [] })).toBe("parallel");
  });

  it("reads an unknown mode as parallel", () => {
    expect(stageMode({ id: "s1", position: 0, mode: "lockstep" as StageMode, steps: [] })).toBe("parallel");
  });

  it("reads sequence as sequence", () => {
    expect(stageMode({ id: "s1", position: 0, mode: "sequence", steps: [] })).toBe("sequence");
  });
});

describe("isGroup", () => {
  it("is false for a single-step stage whatever its mode", () => {
    const one = { id: "s1", position: 0, mode: "sequence" as StageMode, steps: [{ id: "t1", position: 0, cardPath: "/x/a.md" }] };
    expect(isGroup(one)).toBe(false);
  });

  it("is true for two steps", () => {
    const two = {
      id: "s1",
      position: 0,
      steps: [
        { id: "t1", position: 0, cardPath: "/x/a.md" },
        { id: "t2", position: 1, cardPath: "/x/b.md" },
      ],
    };
    expect(isGroup(two)).toBe(true);
  });
});

describe("a group's label", () => {
  const stage = (over: Partial<Stage> = {}): Stage => ({
    id: "s1",
    position: 0,
    steps: [],
    ...over,
  });

  it("is the name the human gave it", () => {
    expect(stageLabel(stage({ name: "Step 2" }), 4)).toBe("Step 2");
  });

  it("falls back to the positional label when unnamed", () => {
    expect(stageLabel(stage(), 1)).toBe("stage 2");
    expect(stageLabel(stage({ name: null }), 0)).toBe("stage 1");
  });

  it("treats a blank name as no name", () => {
    // Renaming to "" stores null, but a hand-edited row can still carry
    // a blank -- and a label is the one thing that must never render
    // empty.
    expect(stageLabel(stage({ name: "   " }), 2)).toBe("stage 3");
  });

  it("numbers a stage by its rail position, not its id order", () => {
    // What the ghost has is a stage id; what the human is reading is the
    // header's number, which comes from the rail's position order.
    let o = addRail(emptyOrchestration(), "r1", "backend");
    o = addStage(addStage(o, "r1", "late"), "r1", "early");
    o = {
      ...o,
      rails: o.rails.map((r) => ({
        ...r,
        stages: r.stages.map((s) => ({ ...s, position: s.id === "early" ? 0 : 1 })),
      })),
    };
    expect(stageLabelById(o, "early")).toBe("stage 1");
    expect(stageLabelById(o, "late")).toBe("stage 2");
  });

  it("prefers the name over the number, and numbers per rail", () => {
    let o = addRail(addRail(emptyOrchestration(), "r1", "backend"), "r2", "frontend");
    o = addStage(addStage(o, "r1", "a"), "r1", "b");
    o = addStage(o, "r2", "c");
    o = renameStage(o, "b", "Migrations");
    expect(stageLabelById(o, "b")).toBe("Migrations");
    // First stage of the SECOND rail: numbering restarts, the way the
    // header draws it.
    expect(stageLabelById(o, "c")).toBe("stage 1");
  });

  it("is null for a stage no rail holds", () => {
    expect(stageLabelById(emptyOrchestration(), "gone")).toBe(null);
  });
});

describe("forming a group", () => {
  function twoStages(): Orchestration {
    let o = addRail(emptyOrchestration(), "r1", "backend");
    o = addStep(addStage(o, "r1", "s1"), "s1", "t1", "/x/a.md", 0);
    o = addStep(addStage(o, "r1", "s2"), "s2", "t2", "/x/b.md", 0);
    return o;
  }

  it("makes the target sequential when it held one step", () => {
    // The whole point of the change: dropping a card onto another means
    // "these two, in this order", not "these two at once".
    const o = moveStepIntoStage(twoStages(), "t2", "s1", 1);
    const stage = findStage(o, "s1") as Stage;
    expect(stageMode(stage)).toBe("sequence");
    expect(stage.steps.map((s) => s.id)).toEqual(["t1", "t2"]);
  });

  it("makes an OLD single-step stage sequential too", () => {
    // A stage stored before groups reads as parallel. Its mode describes
    // nothing observable while it holds one step, so the gesture means
    // the same thing whenever the target was written.
    let o = twoStages();
    o = { ...o, rails: o.rails.map((r) => ({ ...r, stages: r.stages.map((s) => (s.id === "s1" ? { ...s, mode: "parallel" as StageMode } : s)) })) };
    expect(stageMode(findStage(moveStepIntoStage(o, "t2", "s1", 1), "s1") as Stage)).toBe("sequence");
  });

  it("keeps the mode of a stage that is already a group", () => {
    let o = twoStages();
    o = moveStepIntoStage(o, "t2", "s1", 1); // s1 is now a sequence group
    o = setStageMode(o, "s1", "parallel");
    o = addStep(addStage(o, "r1", "s3"), "s3", "t3", "/x/c.md", 0);
    o = moveStepIntoStage(o, "t3", "s1", 2);
    expect(stageMode(findStage(o, "s1") as Stage)).toBe("parallel");
  });

  it("does NOT flip a parallel group to sequence when a member is reordered inside it", () => {
    // The trap: detaching the member first leaves the stage momentarily
    // holding one step, which reads exactly like the stage a drop is
    // about to group. The decision has to be made before the detach.
    let o = twoStages();
    o = moveStepIntoStage(o, "t2", "s1", 1);
    o = setStageMode(o, "s1", "parallel");
    o = moveStepIntoStage(o, "t2", "s1", 0);
    expect(stageMode(findStage(o, "s1") as Stage)).toBe("parallel");
    expect((findStage(o, "s1") as Stage).steps.map((t) => t.id)).toEqual(["t2", "t1"]);
  });

  it("inserts at the given index and renumbers", () => {
    const o = moveStepIntoStage(twoStages(), "t2", "s1", 0);
    const stage = findStage(o, "s1") as Stage;
    expect(stage.steps.map((s) => s.id)).toEqual(["t2", "t1"]);
    expect(stage.steps.map((s) => s.position)).toEqual([0, 1]);
  });

  it("clamps an index past the end", () => {
    const o = moveStepIntoStage(twoStages(), "t2", "s1", 99);
    expect((findStage(o, "s1") as Stage).steps.map((s) => s.id)).toEqual(["t1", "t2"]);
  });
});

describe("setStageMode / renameStage", () => {
  function group(): Orchestration {
    let o = addRail(emptyOrchestration(), "r1", "backend");
    o = addStep(addStage(o, "r1", "s1"), "s1", "t1", "/x/a.md", 0);
    o = addStep(o, "s1", "t2", "/x/b.md", 1);
    return o;
  }

  it("flips the mode", () => {
    expect(stageMode(findStage(setStageMode(group(), "s1", "parallel"), "s1") as Stage)).toBe("parallel");
  });

  it("leaves other stages alone", () => {
    let o = addStep(addStage(group(), "r1", "s2"), "s2", "t3", "/x/c.md", 0);
    o = setStageMode(o, "s1", "parallel");
    expect(stageMode(findStage(o, "s2") as Stage)).toBe("sequence");
  });

  it("names and un-names", () => {
    const named = renameStage(group(), "s1", "Merge and push");
    expect((findStage(named, "s1") as Stage).name).toBe("Merge and push");
    expect((findStage(renameStage(named, "s1", null), "s1") as Stage).name).toBeNull();
  });

  it("trims a name to null when it is only whitespace", () => {
    // An empty name falls back to the positional label; storing "  "
    // would render as a blank header instead.
    expect((findStage(renameStage(group(), "s1", "   "), "s1") as Stage).name).toBeNull();
  });
});

describe("moveStageToIndex", () => {
  function threeStages(): Orchestration {
    let o = addRail(addRail(emptyOrchestration(), "r1", "backend"), "r2", "frontend");
    o = addStep(addStage(o, "r1", "s1"), "s1", "t1", "/x/a.md", 0);
    o = addStep(addStage(o, "r1", "s2"), "s2", "t2", "/x/b.md", 0);
    o = addStep(addStage(o, "r1", "s3"), "s3", "t3", "/x/c.md", 0);
    return o;
  }

  it("reorders within the rail and renumbers", () => {
    const o = moveStageToIndex(threeStages(), "s3", "r1", 0);
    const rail = o.rails.find((r) => r.id === "r1") as Rail;
    expect(rail.stages.map((s) => s.id)).toEqual(["s3", "s1", "s2"]);
    expect(rail.stages.map((s) => s.position)).toEqual([0, 1, 2]);
  });

  it("moves the whole stage to another rail with every step", () => {
    let o = threeStages();
    o = moveStepIntoStage(o, "t2", "s1", 1); // s1 is a group of t1, t2
    o = moveStageToIndex(o, "s1", "r2", 0);
    const r2 = o.rails.find((r) => r.id === "r2") as Rail;
    expect(r2.stages[0].steps.map((s) => s.id)).toEqual(["t1", "t2"]);
    expect((o.rails.find((r) => r.id === "r1") as Rail).stages.map((s) => s.id)).toEqual(["s3"]);
  });

  it("keeps run state: the ids survive the move", () => {
    // Run state is keyed by step id, so a move must never mint new ones.
    let o = threeStages();
    o = { ...o, stepRuns: [{ stepId: "t1", state: "done", sessionId: null, reason: null }] };
    o = moveStageToIndex(o, "s1", "r2", 0);
    expect(stepStateOf(o, "t1")).toBe("done");
  });

  it("is a no-op for an unknown stage or rail", () => {
    expect(moveStageToIndex(threeStages(), "nope", "r1", 0)).toEqual(threeStages());
    expect(moveStageToIndex(threeStages(), "s1", "nope", 0)).toEqual(threeStages());
  });
});

describe("removeStage", () => {
  it("takes the stage and every step it held", () => {
    let o = addRail(emptyOrchestration(), "r1", "backend");
    o = addStep(addStage(o, "r1", "s1"), "s1", "t1", "/x/a.md", 0);
    o = addStep(o, "s1", "t2", "/x/b.md", 1);
    o = { ...o, stepRuns: [{ stepId: "t1", state: "done", sessionId: null, reason: null }] };
    const after = removeStage(o, "s1");
    expect(after.rails[0].stages).toEqual([]);
    // sweepOrphans: run state for steps that no longer exist must go too.
    expect(after.stepRuns).toEqual([]);
  });
});

describe("new single-step stages", () => {
  it("are written sequence, so the next drop means what it says", () => {
    const o = addCardAsStage(addRail(emptyOrchestration(), "r1", "backend"), "r1", 0, "t1", "/x/a.md");
    expect(o.rails[0].stages[0].mode).toBe("sequence");
  });
});

describe("moveStepToNewStage", () => {
  it("inserts a fresh single-step stage at the index", () => {
    const o = moveStepToNewStage(built(), "t3", "r1", 0);
    expect(stageMap(o)).toEqual([
      ["r1", [["t3"], ["t1"], ["t2"]]],
      ["r2", [["t4"]]],
    ]);
  });

  it("appends at an index past the end", () => {
    const o = moveStepToNewStage(built(), "t1", "r1", 99);
    expect(stageMap(o)).toEqual([
      ["r1", [["t2", "t3"], ["t1"]]],
      ["r2", [["t4"]]],
    ]);
  });

  it("moves a step to another rail as its own stage", () => {
    const o = moveStepToNewStage(built(), "t1", "r2", 0);
    expect(stageMap(o)).toEqual([
      ["r1", [["t2", "t3"]]],
      ["r2", [["t1"], ["t4"]]],
    ]);
  });

  it("drops the stage the step vacated when it becomes empty", () => {
    const o = moveStepToNewStage(built(), "t1", "r2", 0);
    expect(o.rails[0].stages).toHaveLength(1);
  });

  it("keeps run state and notes for the moved step — the id survives", () => {
    let o = built();
    o = {
      ...o,
      stepRuns: [{ stepId: "t1", state: "running", sessionId: "s9", reason: null }],
      conflictNotes: [{ id: "n1", stepIds: ["t1", "t2"], note: "careful" }],
    };
    const moved = moveStepToNewStage(o, "t1", "r2", 0);
    expect(moved.stepRuns).toEqual([{ stepId: "t1", state: "running", sessionId: "s9", reason: null }]);
    expect(moved.conflictNotes).toHaveLength(1);
  });

  it("is a no-op for an unknown step or rail", () => {
    const before = built();
    expect(stageMap(moveStepToNewStage(before, "nope", "r1", 0))).toEqual(stageMap(before));
    expect(stageMap(moveStepToNewStage(before, "t1", "nope", 0))).toEqual(stageMap(before));
  });
});

describe("splitStageIntoSequence", () => {
  it("turns a parallel stage into consecutive single-step stages, in order", () => {
    const o = splitStageIntoSequence(built(), "s2");
    expect(stageMap(o)).toEqual([
      ["r1", [["t1"], ["t2"], ["t3"]]],
      ["r2", [["t4"]]],
    ]);
  });

  it("keeps the original stage id on the FIRST slice", () => {
    // A running rail's currentStageId points at this stage; reusing the
    // id is what stops the split from orphaning it.
    const o = splitStageIntoSequence(built(), "s2");
    expect(o.rails[0].stages.map((s) => s.id)).toEqual(["s1", "s2", expect.any(String)]);
  });

  it("renumbers every stage after the split", () => {
    const o = splitStageIntoSequence(built(), "s2");
    expect(o.rails[0].stages.map((s) => s.position)).toEqual([0, 1, 2]);
  });

  it("preserves step ids, so run state and notes survive", () => {
    let o = built();
    o = {
      ...o,
      stepRuns: [{ stepId: "t3", state: "running", sessionId: "s9", reason: null }],
      conflictNotes: [{ id: "n1", stepIds: ["t2", "t3"], note: "careful" }],
    };
    const split = splitStageIntoSequence(o, "s2");
    expect(split.stepRuns).toEqual([{ stepId: "t3", state: "running", sessionId: "s9", reason: null }]);
    expect(split.conflictNotes).toHaveLength(1);
  });

  it("is a no-op for a single-step stage or an unknown stage", () => {
    const before = built();
    expect(stageMap(splitStageIntoSequence(before, "s1"))).toEqual(stageMap(before));
    expect(stageMap(splitStageIntoSequence(before, "nope"))).toEqual(stageMap(before));
  });

  it("clears the name on every slice", () => {
    // A name describes a group; ungrouping says there is no longer one.
    let o = addRail(emptyOrchestration(), "r1", "backend");
    o = addStep(addStage(o, "r1", "s1"), "s1", "t1", "/x/a.md", 0);
    o = addStep(o, "s1", "t2", "/x/b.md", 1);
    o = renameStage(o, "s1", "Merge and push");
    const after = splitStageIntoSequence(o, "s1");
    expect(after.rails[0].stages).toHaveLength(2);
    expect(after.rails[0].stages.every((s) => s.name == null)).toBe(true);
  });
});

describe("groupUnplacedByStatus", () => {
  const B3 = board(["To Do", "In Progress", "Done"]);
  const entry = (fileName: string, status: string | null) => ({
    plan: plan(fileName, { status }),
    contextFolder: "/ws/.gavin-root",
  });

  it("orders groups by the board's column position, not by first sight", () => {
    const groups = groupUnplacedByStatus(
      [entry("a.md", "Done"), entry("b.md", "To Do"), entry("c.md", "In Progress")],
      B3
    );
    expect(groups.map((g) => g.status)).toEqual(["To Do", "In Progress", "Done"]);
  });

  it("marks only the done column, so the drawer knows what to collapse", () => {
    const groups = groupUnplacedByStatus([entry("a.md", "Done"), entry("b.md", "To Do")], B3);
    expect(groups.map((g) => [g.status, g.isDone])).toEqual([
      ["To Do", false],
      ["Done", true],
    ]);
  });

  it("drops columns with no unplaced cards", () => {
    const groups = groupUnplacedByStatus([entry("a.md", "Done")], B3);
    expect(groups.map((g) => g.status)).toEqual(["Done"]);
  });

  it("puts a card with no status in the first column, as the board does", () => {
    const groups = groupUnplacedByStatus([entry("a.md", null)], B3);
    expect(groups.map((g) => [g.status, g.cards.length])).toEqual([["To Do", 1]]);
  });

  it("matches columns by slug, not exact spelling", () => {
    const groups = groupUnplacedByStatus([entry("a.md", "  in progress  ")], B3);
    expect(groups.map((g) => g.status)).toEqual(["In Progress"]);
  });

  it("gives an unknown status its own group after the known ones", () => {
    const groups = groupUnplacedByStatus([entry("a.md", "Blocked"), entry("b.md", "To Do")], B3);
    expect(groups.map((g) => g.status)).toEqual(["To Do", "Blocked"]);
    expect(groups[1].isDone).toBe(false);
  });

  it("folds two spellings of one unknown status together", () => {
    const groups = groupUnplacedByStatus([entry("a.md", "Blocked"), entry("b.md", "blocked")], B3);
    expect(groups).toHaveLength(1);
    expect(groups[0].cards).toHaveLength(2);
  });

  it("falls back to one no-status group when the board has no columns", () => {
    const groups = groupUnplacedByStatus([entry("a.md", null), entry("b.md", "Done")], board([]));
    expect(groups.map((g) => g.status)).toEqual(["(no status)", "Done"]);
  });

  it("is empty for no cards", () => {
    expect(groupUnplacedByStatus([], B3)).toEqual([]);
  });
});

describe("availableCards", () => {
  const at = (path: string, over: Partial<PlanFileInfo> = {}): CardEntry => ({
    plan: { ...plan(path.split("/").pop() as string, over), path },
    contextFolder: "/ws/.gavin-root",
  });
  const index = (entries: CardEntry[]) => new Map(entries.map((e) => [e.plan.path, e]));

  const todo = at("/ws/.gavin-root/plans/todo.md");
  const onRail = at("/ws/.gavin-root/plans/on-rail.md");
  const note = at("/ws/.gavin-root/plans/reminder.md", { kind: "note" });
  const filed = at("/ws/.gavin-root/plans/archive/filed.md");

  it("offers every runnable card that is not already on a rail", () => {
    const out = availableCards(index([todo, onRail]), new Set([onRail.plan.path]));
    expect(out.map((e) => e.plan.path)).toEqual([todo.plan.path]);
  });

  it("never offers a note -- a note is not runnable", () => {
    const out = availableCards(index([todo, note]), new Set());
    expect(out.map((e) => e.plan.path)).toEqual([todo.plan.path]);
  });

  // The archive is off the board by definition (mergePlanCards pulls it
  // out before any column sees it), so it must be off the rails too --
  // otherwise filed-away work is offered back as if it were waiting.
  it("never offers an archived card", () => {
    const out = availableCards(index([todo, filed]), new Set());
    expect(out.map((e) => e.plan.path)).toEqual([todo.plan.path]);
  });

  it("keeps a card whose path merely mentions archive elsewhere", () => {
    const roadmap = at("/ws/archive-rework/.gavin/plans/roadmap.md");
    const out = availableCards(index([roadmap]), new Set());
    expect(out.map((e) => e.plan.path)).toEqual([roadmap.plan.path]);
  });

  // A nested child has no card of its own on the board -- it is drawn
  // inside its parent's, and a card step on a rail draws it there too. So
  // the PLAN is the unit of placement, and listing the children beside it
  // offered the same work over again: one row for the plan and one per
  // child, all of them still there after the plan had been dragged onto a
  // rail, with nothing in the row to say the two were related.
  const parent = at("/ws/.gavin-root/plans/parent.md", { kind: "plan", status: "To Do" });
  const nested = (fileName: string, over: Partial<PlanFileInfo> = {}) =>
    at(`/ws/.gavin-root/plans/${fileName}`, { kind: "task", status: null, parent: "parent.md", ...over });

  it("never offers a nested child -- its plan is the unit of placement", () => {
    const out = availableCards(index([parent, nested("child.md")]), new Set());
    expect(out.map((e) => e.plan.path)).toEqual([parent.plan.path]);
  });

  it("leaves the plan on offer once its child is off the list", () => {
    const out = availableCards(index([todo, parent, nested("a.md"), nested("b.md")]), new Set());
    expect(out.map((e) => e.plan.fileName)).toEqual(["todo.md", "parent.md"]);
  });

  // A status of its own is what makes a child FREE-STANDING: the board
  // draws it in its own column, so it is its own work and its own step,
  // and the plan being on a rail says nothing about it.
  it("still offers a parented card that carries its own status", () => {
    const free = nested("free.md", { status: "To Do" });
    const out = availableCards(index([parent, free]), new Set());
    expect(out.map((e) => e.plan.fileName)).toEqual(["parent.md", "free.md"]);
  });

  // The board resolves a parent on (contextFolder, fileName) and marks
  // the card broken when that resolves to nothing -- it is drawn in its
  // own column, so it has to be placeable from here too.
  it("offers a card whose parent resolves to nothing", () => {
    const orphan = at("/ws/.gavin-root/plans/orphan.md", {
      kind: "task",
      status: null,
      parent: "gone.md",
    });
    const out = availableCards(index([orphan]), new Set());
    expect(out.map((e) => e.plan.fileName)).toEqual(["orphan.md"]);
  });

  it("offers a card whose parent is a task rather than a plan", () => {
    const notAPlan = at("/ws/.gavin-root/plans/parent.md", { kind: "task", status: "To Do" });
    const out = availableCards(index([notAPlan, nested("child.md")]), new Set());
    expect(out.map((e) => e.plan.fileName)).toEqual(["parent.md", "child.md"]);
  });

  // Deliberate placement is the escape hatch this exclusion leaves open
  // (the child's own card menu), and a step already on a rail must keep
  // reading as placed -- otherwise the drawer would offer back the very
  // card it is looking at on a rail.
  it("does not offer a nested child that is already on a rail", () => {
    const child = nested("child.md");
    const out = availableCards(index([parent, child]), new Set([child.plan.path]));
    expect(out.map((e) => e.plan.path)).toEqual([parent.plan.path]);
  });
});

describe("nestedChildrenOf", () => {
  const index = (plans: PlanFileInfo[]) => cardIndex(tree(plans));

  it("lists the children the plan carries, and nobody else's", () => {
    const idx = index([
      plan("big.md", { kind: "plan", status: "To Do" }),
      plan("other.md", { kind: "plan", status: "To Do" }),
      plan("one.md", { kind: "task", status: null, parent: "big.md" }),
      plan("two.md", { kind: "task", status: null, parent: "big.md" }),
      plan("elsewhere.md", { kind: "task", status: null, parent: "other.md" }),
      // Free-standing: it has a status of its own, so it is a card on the
      // board and files itself.
      plan("free.md", { kind: "task", status: "To Do", parent: "big.md" }),
    ]);
    expect(nestedChildrenOf("/ws/.gavin-root/plans/big.md", idx).map((e) => e.plan.fileName)).toEqual([
      "one.md",
      "two.md",
    ]);
  });

  it("is empty for a plan carrying nothing, and for a path the tree lost", () => {
    const idx = index([plan("big.md", { kind: "plan", status: "To Do" })]);
    expect(nestedChildrenOf("/ws/.gavin-root/plans/big.md", idx)).toEqual([]);
    expect(nestedChildrenOf("/ws/.gavin-root/plans/gone.md", idx)).toEqual([]);
  });
});

describe("nestedChildCounts", () => {
  const index = (plans: PlanFileInfo[]) => cardIndex(tree(plans));

  // availableCards leaves a nested child off the panel entirely, so the
  // plan's row is the only place left that can say the child exists.
  it("counts the nested children of each plan", () => {
    const counts = nestedChildCounts(
      index([
        plan("big.md", { kind: "plan", status: "To Do" }),
        plan("one.md", { kind: "task", status: null, parent: "big.md" }),
        plan("two.md", { kind: "task", status: null, parent: "big.md" }),
      ])
    );
    expect(counts.get("/ws/.gavin-root/plans/big.md")).toBe(2);
  });

  it("leaves out a plan with no nested children at all", () => {
    const counts = nestedChildCounts(index([plan("big.md", { kind: "plan", status: "To Do" })]));
    expect(counts.has("/ws/.gavin-root/plans/big.md")).toBe(false);
  });

  it("does not count a child that carries its own status", () => {
    const counts = nestedChildCounts(
      index([
        plan("big.md", { kind: "plan", status: "To Do" }),
        plan("free.md", { kind: "task", status: "To Do", parent: "big.md" }),
      ])
    );
    expect(counts.has("/ws/.gavin-root/plans/big.md")).toBe(false);
  });
});

describe("unfinishedCards", () => {
  const B3 = board(["To Do", "In Progress", "Done"]);
  const at = (fileName: string, over: Partial<PlanFileInfo> = {}) => plan(fileName, over);
  const index = (plans: PlanFileInfo[]) => cardIndex(tree(plans));
  const run = (plans: PlanFileInfo[], b: Board = B3) => {
    const cards = index(plans);
    return unfinishedCards([...cards.values()], planIndex(cards), b).map((e) => e.plan.fileName);
  };

  // The whole point of the picker's list: what is left to DO. A finished
  // card is not, and a workspace with any history has far more of them
  // than of the two or three cards actually waiting.
  it("leaves out a card sitting in the board's done column", () => {
    expect(run([at("a.md", { status: "To Do" }), at("b.md", { status: "Done" })])).toEqual(["a.md"]);
  });

  it("matches the done column by slug, not by spelling", () => {
    expect(run([at("a.md", { status: "done" })])).toEqual([]);
  });

  it("keeps a status the board has no column for", () => {
    expect(run([at("a.md", { status: "Blocked" })])).toEqual(["a.md"]);
  });

  it("keeps a card with no status at all", () => {
    expect(run([at("a.md", { status: null })])).toEqual(["a.md"]);
  });

  // A nested task has no status of its own -- it wears its parent's, on
  // the board and on disk alike. Read raw, every task under a Done plan
  // would be offered back as work still waiting for a rail.
  it("reads a nested task through its parent", () => {
    const parent = at("parent.md", { kind: "plan", status: "Done" });
    const nested = at("child.md", { kind: "task", status: null, parent: "parent.md" });
    expect(run([parent, nested])).toEqual([]);
  });

  it("keeps a nested task whose parent is unfinished", () => {
    const parent = at("parent.md", { kind: "plan", status: "In Progress" });
    const nested = at("child.md", { kind: "task", status: null, parent: "parent.md" });
    expect(run([parent, nested])).toEqual(["parent.md", "child.md"]);
  });

  // No columns means nothing can ever complete (doneColumn says so), so
  // there is no finished work to take out -- not "everything is finished".
  it("keeps everything when the board has no columns", () => {
    expect(run([at("a.md", { status: "Done" })], board([]))).toEqual(["a.md"]);
  });
});

describe("unplacedCount", () => {
  const group = (status: string, isDone: boolean, n: number): UnplacedGroup => ({
    status,
    slug: status.toLowerCase().replace(/ /g, "-"),
    isDone,
    cards: Array.from({ length: n }, (_, i) => ({
      plan: plan(`${i}-${status}.md`, { status }),
      contextFolder: "/ws/.gavin-root",
    })),
  });

  it("counts the cards still waiting for a rail", () => {
    expect(unplacedCount([group("To Do", false, 3), group("In Progress", false, 2)])).toBe(5);
  });

  // The headline number answers "how much is left to place". Finished
  // work is not left to place, so the done group is listed but uncounted.
  it("leaves the done group out", () => {
    expect(unplacedCount([group("To Do", false, 3), group("Done", true, 12)])).toBe(3);
  });

  it("is zero when only done cards are unplaced", () => {
    expect(unplacedCount([group("Done", true, 12)])).toBe(0);
  });

  it("is zero for no groups", () => {
    expect(unplacedCount([])).toBe(0);
  });
});

describe("addCardAsStage", () => {
  it("inserts a new single-step stage at the index", () => {
    const o = addCardAsStage(built(), "r1", 1, "new", "/x/z.md");
    expect(stageMap(o)).toEqual([
      ["r1", [["t1"], ["new"], ["t2", "t3"]]],
      ["r2", [["t4"]]],
    ]);
  });

  it("clamps an index past the end to an append", () => {
    const o = addCardAsStage(built(), "r1", 99, "new", "/x/z.md");
    expect(stageMap(o)[0][1]).toEqual([["t1"], ["t2", "t3"], ["new"]]);
  });

  it("renumbers stages after the insert", () => {
    const o = addCardAsStage(built(), "r1", 0, "new", "/x/z.md");
    expect(o.rails[0].stages.map((s) => s.position)).toEqual([0, 1, 2]);
  });

  it("adds to an empty rail", () => {
    let o = addRail(emptyOrchestration(), "r1", "backend");
    o = addCardAsStage(o, "r1", 0, "new", "/x/z.md");
    expect(stageMap(o)).toEqual([["r1", [["new"]]]]);
  });

  it("is a no-op for an unknown rail", () => {
    const before = built();
    expect(stageMap(addCardAsStage(before, "nope", 0, "new", "/x/z.md"))).toEqual(stageMap(before));
  });
});

describe("findStep", () => {
  it("finds a step on any rail, in any stage", () => {
    expect(findStep(built(), "t3")?.cardPath).toBe("/x/c.md");
    expect(findStep(built(), "t4")?.cardPath).toBe("/x/d.md");
  });

  it("is null for an id that is on no rail", () => {
    expect(findStep(built(), "nope")).toBeNull();
  });
});

describe("findCardPlacement", () => {
  it("locates a card's step, its rail, and where the stage sits", () => {
    expect(findCardPlacement(built(), "/x/c.md")).toEqual({
      railId: "r1",
      stageId: "s2",
      stepId: "t3",
      stageNumber: 2,
      stageCount: 2,
    });
  });

  it("is null for a card on no rail", () => {
    expect(findCardPlacement(built(), "/x/z.md")).toBeNull();
  });

  // A tool step's cardPath is "", which must never match a card.
  it("never matches a tool step", () => {
    const o = { ...emptyOrchestration(), rails: [toolRail("r1", [[["t1", "builtin:push"]]])] };
    expect(findCardPlacement(o, "")).toBeNull();
  });
});

describe("cardRailBadge", () => {
  it("names the rail a card sits on and where in its run order", () => {
    expect(cardRailBadge(built(), "/x/c.md")).toEqual({
      railId: "r1",
      railName: "backend",
      stageNumber: 2,
      stageCount: 2,
    });
    expect(cardRailBadge(built(), "/x/d.md")).toEqual({
      railId: "r2",
      railName: "ui",
      stageNumber: 1,
      stageCount: 1,
    });
  });

  it("is null for a card on no rail", () => {
    expect(cardRailBadge(built(), "/x/z.md")).toBeNull();
  });

  // The board renders long before the Orchestration tab is ever opened;
  // an unloaded plan must read as "no rail", never as a crash.
  it("is null when the workspace has no orchestration loaded", () => {
    expect(cardRailBadge(null, "/x/c.md")).toBeNull();
    expect(cardRailBadge(undefined, "/x/c.md")).toBeNull();
  });

  it("never matches a tool step", () => {
    const o = { ...emptyOrchestration(), rails: [toolRail("r1", [[["t1", "builtin:push"]]])] };
    expect(cardRailBadge(o, "")).toBeNull();
  });
});

describe("sendCardToRail", () => {
  it("appends an unplaced card as the rail's own trailing stage", () => {
    const o = sendCardToRail(built(), "r1", "/x/z.md", "new");
    expect(stageMap(o)).toEqual([
      ["r1", [["t1"], ["t2", "t3"], ["new"]]],
      ["r2", [["t4"]]],
    ]);
  });

  it("adds to an empty rail", () => {
    let o = addRail(emptyOrchestration(), "r1", "backend");
    o = sendCardToRail(o, "r1", "/x/z.md", "new");
    expect(stageMap(o)).toEqual([["r1", [["new"]]]]);
  });

  // The step id rides along, so the run state keyed by it survives the
  // move -- sending a card somewhere is not a reason to forget it ran.
  it("moves a card already on another rail, keeping its step id", () => {
    const o = sendCardToRail(built(), "r2", "/x/a.md", "unused");
    expect(stageMap(o)).toEqual([
      ["r1", [["t2", "t3"]]],
      ["r2", [["t4"], ["t1"]]],
    ]);
  });

  it("leaves a card already on that rail exactly alone", () => {
    const before = built();
    const o = sendCardToRail(before, "r1", "/x/a.md", "new");
    expect(o).toBe(before);
  });

  it("is a no-op for an unknown rail", () => {
    const before = built();
    expect(stageMap(sendCardToRail(before, "nope", "/x/z.md", "new"))).toEqual(stageMap(before));
  });
});

describe("railCardPaths", () => {
  it("lists the rail's cards in run order", () => {
    expect(railCardPaths(rail("r1", [[["t1", "/x/a.md"]], [["t2", "/x/b.md"], ["t3", "/x/c.md"]]]))).toEqual([
      "/x/a.md",
      "/x/b.md",
      "/x/c.md",
    ]);
  });

  it("reads stages and steps by position, not array order", () => {
    const r = rail("r1", [[["t1", "/x/a.md"]], [["t2", "/x/b.md"], ["t3", "/x/c.md"]]]);
    r.stages = [r.stages[1], r.stages[0]];
    r.stages[0].steps = [r.stages[0].steps[1], r.stages[0].steps[0]];
    expect(railCardPaths(r)).toEqual(["/x/a.md", "/x/b.md", "/x/c.md"]);
  });

  // The FILE is what a caller writes, so a card on two steps is one card.
  it("counts a duplicated card once", () => {
    expect(railCardPaths(rail("r1", [[["t1", "/x/a.md"]], [["t2", "/x/a.md"]]]))).toEqual(["/x/a.md"]);
  });

  it("leaves tool steps out", () => {
    const r = rail("r1", [[["t1", "/x/a.md"]]]);
    r.stages.push({ id: "r1-s1", position: 1, steps: [{ id: "t2", position: 0, cardPath: "", toolId: "builtin:push" }] });
    expect(railCardPaths(r)).toEqual(["/x/a.md"]);
  });

  it("is empty for a rail with no stages", () => {
    expect(railCardPaths(rail("r1", []))).toEqual([]);
  });
});

describe("railCardsToMove", () => {
  const r = rail("r1", [[["t1", "/x/a.md"]], [["t2", "/x/b.md"], ["t3", "/x/c.md"]]]);
  const index = (statuses: Array<string | null>) =>
    cardIndex(
      tree([
        plan("a.md", { path: "/x/a.md", status: statuses[0] }),
        plan("b.md", { path: "/x/b.md", status: statuses[1] }),
        plan("c.md", { path: "/x/c.md", status: statuses[2] }),
      ])
    );

  it("skips the cards already in that column", () => {
    expect(railCardsToMove(r, index(["To Do", "Done", "In Progress"]), "Done")).toEqual([
      "/x/a.md",
      "/x/c.md",
    ]);
  });

  it("compares statuses by slug, not spelling", () => {
    expect(railCardsToMove(r, index(["in progress", "In Progress", "IN-PROGRESS"]), "In Progress")).toEqual([]);
  });

  // Matching a card's own menu: no status is never "already there".
  it("moves a card with no status at all", () => {
    expect(railCardsToMove(r, index([null, "To Do", "To Do"]), "To Do")).toEqual(["/x/a.md"]);
  });

  // A card deleted out from under the plan has no file to write.
  it("drops a card the tree has no entry for", () => {
    expect(railCardsToMove(r, cardIndex(tree([plan("a.md", { path: "/x/a.md" })])), "Done")).toEqual([
      "/x/a.md",
    ]);
  });

  it("is empty for a rail carrying no cards", () => {
    expect(railCardsToMove(rail("r1", []), index(["To Do", "To Do", "To Do"]), "Done")).toEqual([]);
  });
});

// ---- Tool steps -------------------------------------------------------------
// A step is a card step or a tool step (tools spec T1). These cover the
// second shape everywhere it behaves differently: completion by exit
// code, its own launch blocker, and its exemption from duplicate-card.

const TOOLS: ToolSummary[] = [
  { id: "builtin:push", name: "Push branch", kind: "command" },
  { id: "builtin:notify", name: "Send a notification", kind: "script" },
  { id: "builtin:commit", name: "Commit changes", kind: "agent" },
];

/// A rail whose stages hold tool steps: [stepId, toolId] per step.
function toolRail(id: string, stages: Array<Array<[string, string]>>): Rail {
  return {
    id,
    name: id,
    position: 0,
    worktreePath: null,
    pageId: null,
    stages: stages.map((steps, si) => ({
      id: `${id}-s${si}`,
      position: si,
      steps: steps.map(([stepId, toolId], pi) => ({
        id: stepId,
        position: pi,
        cardPath: "",
        toolId,
        toolParams: {},
      })),
    })),
  };
}

describe("isToolStep / stepParams", () => {
  it("tells the two shapes apart", () => {
    expect(isToolStep({ id: "t1", position: 0, cardPath: A })).toBe(false);
    expect(isToolStep({ id: "t1", position: 0, cardPath: "", toolId: "builtin:push" })).toBe(true);
  });

  // Steps authored before tools existed carry neither field.
  it("reads absent overrides as none, not undefined", () => {
    expect(stepParams({ id: "t1", position: 0, cardPath: A })).toEqual({});
  });
});

describe("nextActions — tool steps", () => {
  const armed = (stepRuns: Orchestration["stepRuns"] = []) =>
    running(toolRail("r1", [[["t1", "builtin:push"]]]), "r1-s0", stepRuns);

  it("launches a pending tool step", () => {
    expect(nextActions(armed(), BOARD, CARDS, [], new Set(), TOOLS)).toEqual([
      { kind: "launch", stepId: "t1" },
    ]);
  });

  // Rule 1 is about a CARD reaching the done column; a tool step has no
  // card, so a done column full of matching statuses must not touch it.
  it("never marks a tool step done from a card status", () => {
    const doneTree = tree([plan("a.md", { status: "Done" })]);
    expect(nextActions(armed(), BOARD, doneTree, [], new Set(), TOOLS)).toEqual([
      { kind: "launch", stepId: "t1" },
    ]);
  });

  it("stalls a pending tool step whose tool was deleted", () => {
    const actions = nextActions(armed(), BOARD, CARDS, [], new Set(), []);
    expect(actions).toEqual([
      { kind: "stall", stepId: "t1", reason: "tool is no longer in the library" },
    ]);
  });

  // Null, not [] -- an unloaded library must not read as "every tool was
  // deleted" and stall every tool step on a cold start.
  it("launches a tool step while the library is still loading", () => {
    expect(nextActions(armed(), BOARD, CARDS, [], new Set(), null)).toEqual([
      { kind: "launch", stepId: "t1" },
    ]);
  });

  it("stalls a tool step on a rail whose worktree is gone", () => {
    const r = { ...toolRail("r1", [[["t1", "builtin:push"]]]), worktreePath: "/x/gone" };
    const actions = nextActions(running(r, "r1-s0"), BOARD, CARDS, WT, new Set(), TOOLS);
    expect(actions).toEqual([
      { kind: "stall", stepId: "t1", reason: "worktree /x/gone is gone" },
    ]);
  });

  it("marks a tool step done when its session exited 0", () => {
    const runs: Orchestration["stepRuns"] = [
      { stepId: "t1", state: "running", sessionId: "s1", reason: null },
    ];
    const actions = nextActions(
      armed(runs),
      BOARD,
      CARDS,
      [],
      new Set(),
      TOOLS,
      new Map([["s1", 0]])
    );
    expect(actions).toEqual([{ kind: "markDone", stepId: "t1" }, { kind: "complete", railId: "r1" }]);
  });

  it("stalls a tool step whose session exited non-zero, naming the tool and the code", () => {
    const runs: Orchestration["stepRuns"] = [
      { stepId: "t1", state: "running", sessionId: "s1", reason: null },
    ];
    const actions = nextActions(
      armed(runs),
      BOARD,
      CARDS,
      [],
      new Set(),
      TOOLS,
      new Map([["s1", 128]])
    );
    expect(actions).toEqual([
      { kind: "stall", stepId: "t1", reason: "Push branch exited with code 128" },
    ]);
  });

  // The app was closed when the session ended, so nobody witnessed the
  // outcome. Advancing the rail on that assumption is the failure this
  // avoids.
  it("stalls a tool step whose exit code nobody witnessed", () => {
    const runs: Orchestration["stepRuns"] = [
      { stepId: "t1", state: "running", sessionId: "s1", reason: null },
    ];
    const actions = nextActions(armed(runs), BOARD, CARDS, [], new Set(), TOOLS, new Map());
    expect(actions).toEqual([
      {
        kind: "stall",
        stepId: "t1",
        reason: "Push branch's session ended while gavin was not watching",
      },
    ]);
  });

  it("leaves a tool step alone while its session is still live", () => {
    const runs: Orchestration["stepRuns"] = [
      { stepId: "t1", state: "running", sessionId: "s1", reason: null },
    ];
    expect(nextActions(armed(runs), BOARD, CARDS, [], new Set(["s1"]), TOOLS)).toEqual([]);
  });

  // A shell tool's tab outlives its PTY (retainTabOnExit), so its session
  // id stays in the layout -- the live set -- after the exit. The exit code
  // is the verdict all the same; reading the retained tab as a running
  // session held every command and script step `running` for good.
  it("judges a tool step by its exit code while its tab is kept open", () => {
    const runs: Orchestration["stepRuns"] = [
      { stepId: "t1", state: "running", sessionId: "s1", reason: null },
    ];
    const retained = new Set(["s1"]);
    expect(
      nextActions(armed(runs), BOARD, CARDS, [], retained, TOOLS, new Map([["s1", 0]]))
    ).toEqual([{ kind: "markDone", stepId: "t1" }, { kind: "complete", railId: "r1" }]);
    expect(
      nextActions(armed(runs), BOARD, CARDS, [], retained, TOOLS, new Map([["s1", 128]]))
    ).toEqual([{ kind: "stall", stepId: "t1", reason: "Push branch exited with code 128" }]);
  });

// An AGENT tool's session never exits: an interactive agent finishes its
// turn and sits at its prompt forever, which is the whole reason
// buildHeadlessCommand exists for the runs that must end. So T5's "exits
// 0" can never fire for one, and its completion signal is the daemon's
// own -- the session going idle.
describe("nextActions — an agent tool step's turn", () => {
  const armed = (stepRuns: Orchestration["stepRuns"] = []) =>
    running(toolRail("r1", [[["t1", "builtin:commit"]]]), "r1-s0", stepRuns);
  const runs: Orchestration["stepRuns"] = [
    { stepId: "t1", state: "running", sessionId: "s1", reason: null },
  ];
  const live = new Set(["s1"]);
  /// A rail the human paused (or never started) around a step the app
  /// still has as `running` -- the reconciliation case.
  const paused = (rail: Rail): Orchestration => ({
    rails: [rail],
    conflictNotes: [],
    railRuns: [{ railId: rail.id, state: "paused", currentStageId: null }],
    stepRuns: runs,
  });

  it("marks it done when its live session goes idle", () => {
    const actions = nextActions(
      armed(runs), BOARD, CARDS, [], live, TOOLS, new Map(), new Map([["s1", "idle" as const]]),
      new Set(), new Map(), {}, 0, new Set(["s1"])
    );
    expect(actions).toEqual([{ kind: "markDone", stepId: "t1" }, { kind: "complete", railId: "r1" }]);
  });

  it("leaves it running while the agent is still working", () => {
    expect(
      nextActions(armed(runs), BOARD, CARDS, [], live, TOOLS, new Map(), new Map([["s1", "working" as const]]))
    ).toEqual([]);
  });

  // The agent is asking the human something, not finishing. The daemon
  // pins TERM_PROGRAM so this is reported rather than looking like
  // silence, and refuses to let a quiet period downgrade it -- advancing
  // the rail past a question would answer it by walking away.
  it("leaves it running while the agent waits for input", () => {
    expect(
      nextActions(armed(runs), BOARD, CARDS, [], live, TOOLS, new Map(), new Map([["s1", "waiting_for_input" as const]]))
    ).toEqual([]);
  });

  // A session that has reported nothing yet is not a finished one: the
  // daemon registers every new session idle, so believing an absent
  // status would mark a step done the instant it launched.
  it("leaves it running while its session has reported no status at all", () => {
    expect(nextActions(armed(runs), BOARD, CARDS, [], live, TOOLS, new Map(), new Map())).toEqual([]);
  });

  // The daemon DOES push that first idle — OSC 133 at the prompt, or
  // the quiet timer before the agent has printed anything. Completing
  // on it is what marked every agent-prompt tool done the instant the
  // rail reached it, instead of waiting for the turn that actually
  // ends the work (the same reason a card step waits for the done
  // column rather than for idle).
  it("leaves it running through the shell's first idle, before the agent has worked", () => {
    expect(
      nextActions(
        armed(runs),
        BOARD,
        CARDS,
        [],
        live,
        TOOLS,
        new Map(),
        new Map([["s1", "idle" as const]]),
        new Set(),
        new Map(),
        {},
        0,
        new Set()
      )
    ).toEqual([]);
  });

  // A command tool's verdict is its exit code (T5) and nothing else: a
  // quiet `npm run dev` is a server that started, not a step that
  // finished.
  it("never completes a COMMAND tool step from an idle session", () => {
    const cmd = running(toolRail("r1", [[["t1", "builtin:push"]]]), "r1-s0", runs);
    expect(
      nextActions(cmd, BOARD, CARDS, [], live, TOOLS, new Map(), new Map([["s1", "idle" as const]]))
    ).toEqual([]);
  });

  // A CARD step is done when its card reaches the done column (rule 1),
  // never when its agent stops talking -- an agent that quit early left
  // the work unfinished, which is exactly what rule 1 is there to catch.
  it("never completes a CARD step from an idle session", () => {
    const r = rail("r1", [[["t1", "/ws/.gavin-root/plans/a.md"]]]);
    expect(
      nextActions(running(r, "r1-s0", runs), BOARD, CARDS, [], live, TOOLS, new Map(), new Map([["s1", "idle" as const]]))
    ).toEqual([]);
  });

  // The reconciliation pass, for the same reason it already writes the
  // truth about dead sessions: a step left `running` on an idle or
  // paused rail gets no tick that would correct it, and the daemon
  // refuses every plan write that drops a `running` step -- so a
  // finished agent tool step wedges the rail shut, uneditable and
  // undeletable, which is precisely the bug this rule is here for.
  it("marks it done on a rail that is not running", () => {
    const orch = paused(toolRail("r1", [[["t1", "builtin:commit"]]]));
    expect(
      nextActions(orch, BOARD, CARDS, [], live, TOOLS, new Map(), new Map([["s1", "idle" as const]]),
        new Set(), new Map(), {}, 0, new Set(["s1"]))
    ).toEqual([{ kind: "markDone", stepId: "t1" }]);
  });

  it("leaves it alone on a rail that is not running while it still works", () => {
    const orch = paused(toolRail("r1", [[["t1", "builtin:commit"]]]));
    expect(
      nextActions(orch, BOARD, CARDS, [], live, TOOLS, new Map(), new Map([["s1", "working" as const]]))
    ).toEqual([]);
  });

  // A tool the library no longer has cannot be known to be an agent, so
  // the idle rule must not fire on a guess -- the step keeps running
  // until its session ends, and the deleted-tool stall owns it there.
  it("does not complete a step whose tool has been deleted", () => {
    expect(
      nextActions(armed(runs), BOARD, CARDS, [], live, [], new Map(), new Map([["s1", "idle" as const]]))
    ).toEqual([]);
  });
});

  it("falls back to a generic label when the tool is gone by the time it exits", () => {
    const runs: Orchestration["stepRuns"] = [
      { stepId: "t1", state: "running", sessionId: "s1", reason: null },
    ];
    const actions = nextActions(armed(runs), BOARD, CARDS, [], new Set(), [], new Map([["s1", 1]]));
    expect(actions).toEqual([
      { kind: "stall", stepId: "t1", reason: "the tool exited with code 1" },
    ]);
  });

  it("advances past a finished tool stage to the next one in the same tick", () => {
    const r = toolRail("r1", [[["t1", "builtin:push"]], [["t2", "builtin:notify"]]]);
    const runs: Orchestration["stepRuns"] = [
      { stepId: "t1", state: "running", sessionId: "s1", reason: null },
    ];
    const actions = nextActions(
      running(r, "r1-s0", runs),
      BOARD,
      CARDS,
      [],
      new Set(),
      TOOLS,
      new Map([["s1", 0]])
    );
    expect(actions).toEqual([
      { kind: "markDone", stepId: "t1" },
      { kind: "advance", railId: "r1", stageId: "r1-s1" },
      { kind: "launch", stepId: "t2" },
    ]);
  });

  // A card step's rule is unchanged: session exit without the card
  // reaching the done column is a stall, whatever the exit code was.
  it("does not use the exit code for a card step", () => {
    const runs: Orchestration["stepRuns"] = [
      { stepId: "t1", state: "running", sessionId: "s1", reason: null },
    ];
    const actions = nextActions(
      running(rail("r1", [[["t1", A]]]), "r1-s0", runs),
      BOARD,
      CARDS,
      [],
      new Set(),
      TOOLS,
      new Map([["s1", 0]])
    );
    expect(actions[0]).toMatchObject({ kind: "stall", stepId: "t1" });
  });
});

describe("tool step mutators", () => {
  it("addToolStep joins a single-step stage, forming a sequence group", () => {
    const o = orchOf([rail("r1", [[["t1", A]]])]);
    const after = addToolStep(o, "r1-s0", "t2", "builtin:push", 1);
    expect(after.rails[0].stages).toHaveLength(1);
    expect(after.rails[0].stages[0].steps.map((s) => s.toolId ?? s.cardPath)).toEqual([
      A,
      "builtin:push",
    ]);
    expect(stageMode(after.rails[0].stages[0])).toBe("sequence");
  });

  it("addToolAsStage inserts its own stage at the index — the sequential drop", () => {
    const o = orchOf([rail("r1", [[["t1", A]], [["t2", B]]])]);
    const after = addToolAsStage(o, "r1", 1, "t3", "builtin:push");
    expect(after.rails[0].stages).toHaveLength(3);
    expect(after.rails[0].stages[1].steps[0].toolId).toBe("builtin:push");
    expect(after.rails[0].stages.map((s) => s.position)).toEqual([0, 1, 2]);
  });

  it("addToolAsStage clamps an index past the end into an append", () => {
    const o = orchOf([rail("r1", [[["t1", A]]])]);
    const after = addToolAsStage(o, "r1", 99, "t3", "builtin:push");
    expect(after.rails[0].stages[1].steps[0].toolId).toBe("builtin:push");
  });

  it("addToolAsStage ignores an unknown rail", () => {
    const o = orchOf([rail("r1", [[["t1", A]]])]);
    expect(addToolAsStage(o, "nope", 0, "t3", "builtin:push")).toBe(o);
  });

  it("a tool step is built with an empty cardPath — never both", () => {
    const after = addToolAsStage(orchOf([rail("r1", [])]), "r1", 0, "t1", "builtin:push");
    expect(after.rails[0].stages[0].steps[0].cardPath).toBe("");
  });

  it("setStepParams replaces the overrides wholesale", () => {
    const o = orchOf([toolRail("r1", [[["t1", "builtin:push"]]])]);
    const after = setStepParams(o, "t1", { remote: "upstream" });
    expect(after.rails[0].stages[0].steps[0].toolParams).toEqual({ remote: "upstream" });
    const cleared = setStepParams(after, "t1", {});
    expect(cleared.rails[0].stages[0].steps[0].toolParams).toEqual({});
  });

  it("setStepParams leaves other steps alone", () => {
    const o = orchOf([toolRail("r1", [[["t1", "builtin:push"], ["t2", "builtin:notify"]]])]);
    const after = setStepParams(o, "t1", { remote: "upstream" });
    expect(after.rails[0].stages[0].steps[1].toolParams).toEqual({});
  });

  it("a tool step moves between stages like any other", () => {
    const o = orchOf([toolRail("r1", [[["t1", "builtin:push"]], [["t2", "builtin:notify"]]])]);
    const after = moveStepIntoStage(o, "t2", "r1-s0", 1);
    expect(after.rails[0].stages).toHaveLength(1);
    expect(after.rails[0].stages[0].steps.map((s) => s.toolId)).toEqual([
      "builtin:push",
      "builtin:notify",
    ]);
  });

  it("removing a tool step keeps its overrides off the plan entirely", () => {
    const o = setStepParams(
      orchOf([toolRail("r1", [[["t1", "builtin:push"]]])]),
      "t1",
      { remote: "upstream" }
    );
    const after = removeStep(o, "t1");
    expect(after.rails[0].stages).toEqual([]);
  });
});

describe("insertStageWithSteps", () => {
  it("places a whole group at the index and renumbers", () => {
    const o = addRail(emptyOrchestration(), "r1", "backend");
    const stage: Stage = {
      id: "s-new",
      position: 0,
      mode: "sequence",
      name: "Merge and push",
      steps: [
        { id: "t1", position: 0, cardPath: "", toolId: "builtin:merge-into", toolParams: {} },
        { id: "t2", position: 1, cardPath: "", toolId: "builtin:push", toolParams: {} },
      ],
    };
    const after = insertStageWithSteps(o, "r1", 0, stage);
    expect(after.rails[0].stages[0].name).toBe("Merge and push");
    expect(after.rails[0].stages[0].steps).toHaveLength(2);
  });

  it("clamps an index past the end into an append", () => {
    const o = orchOf([rail("r1", [[["t1", A]]])]);
    const stage: Stage = { id: "s-new", position: 0, mode: "parallel", steps: [{ id: "t2", position: 0, cardPath: B }] };
    const after = insertStageWithSteps(o, "r1", 99, stage);
    expect(after.rails[0].stages).toHaveLength(2);
    expect(after.rails[0].stages[1].id).toBe("s-new");
    expect(after.rails[0].stages.map((s) => s.position)).toEqual([0, 1]);
  });

  it("ignores an unknown rail", () => {
    const o = orchOf([rail("r1", [[["t1", A]]])]);
    const stage: Stage = { id: "s-new", position: 0, mode: "parallel", steps: [] };
    expect(insertStageWithSteps(o, "nope", 0, stage)).toBe(o);
  });
});

describe("detectConflicts — tool steps", () => {
  it("does not report two steps running the same tool as a duplicate", () => {
    const r = { ...toolRail("r1", [[["t1", "builtin:push"]], [["t2", "builtin:push"]]]), worktreePath: "/x/wt-a" };
    const found = detectConflicts(orchOf([r]), CARDS, WT);
    expect(found.filter((c) => c.kind === "duplicate-card")).toEqual([]);
  });

  it("still reports two steps on the same CARD as a duplicate", () => {
    const r = bound("r1", "/x/wt-a", [[["t1", A]], [["t2", A]]]);
    const found = detectConflicts(orchOf([r]), CARDS, WT);
    expect(found.filter((c) => c.kind === "duplicate-card")).toHaveLength(1);
  });

  // A bash tool writing to the checkout is exactly the hazard the
  // same-worktree rule exists for, so a tool step must join those groups.
  it("puts a tool step in the same-worktree group beside a card step", () => {
    const r = {
      ...bound("r1", "/x/wt-a", [[["t1", A]]]),
      stages: [
        {
          id: "r1-s0",
          position: 0,
          steps: [
            { id: "t1", position: 0, cardPath: A },
            { id: "t2", position: 1, cardPath: "", toolId: "builtin:push", toolParams: {} },
          ],
        },
      ],
    };
    const found = detectConflicts(orchOf([r]), CARDS, WT);
    const stageConflict = found.find((c) => c.kind === "same-worktree" && c.scope === "stage");
    expect(stageConflict && conflictStepIds(stageConflict)).toEqual(["t1", "t2"]);
  });
});

describe("describeConflict — tool steps", () => {
  const both: Orchestration = orchOf([
    {
      ...bound("r1", "/x/wt-a", [[["t1", A]]]),
      stages: [
        {
          id: "r1-s0",
          position: 0,
          steps: [
            { id: "t1", position: 0, cardPath: A },
            { id: "t2", position: 1, cardPath: "", toolId: "builtin:push", toolParams: {} },
          ],
        },
      ],
    },
  ]);

  it("names a tool step by its tool name", () => {
    const c = detectConflicts(both, CARDS, WT).find(
      (x) => x.kind === "same-worktree" && x.scope === "stage"
    ) as Conflict;
    expect(describeConflict(c, cardIndex(CARDS), both, TOOLS)).toContain("Push branch");
  });

  // A conflict about a tool that has since been deleted must still be
  // describable, exactly as one about a missing card is.
  it("falls back to the tool id when the tool is gone", () => {
    const c = detectConflicts(both, CARDS, WT).find(
      (x) => x.kind === "same-worktree" && x.scope === "stage"
    ) as Conflict;
    expect(describeConflict(c, cardIndex(CARDS), both, [])).toContain("builtin:push");
  });
});

describe("pageToSpawnForRail", () => {
  function railNamed(name: string, pageId: string | null): Rail {
    return { id: "r1", name, position: 0, worktreePath: null, pageId, stages: [] };
  }

  it("names the page after the rail when it has no page", () => {
    expect(pageToSpawnForRail(railNamed("backend", null), [])).toBe("backend");
  });

  it("spawns nothing when the rail's page still exists", () => {
    const pages = [{ id: "p1", name: "backend" }];
    expect(pageToSpawnForRail(railNamed("backend", "p1"), pages)).toBeNull();
  });

  it("spawns again when the bound page is gone", () => {
    const pages = [{ id: "p9", name: "Agents" }];
    expect(pageToSpawnForRail(railNamed("backend", "p1"), pages)).toBe("backend");
  });

  it("suffixes a name the workspace already uses", () => {
    const pages = [
      { id: "p1", name: "backend" },
      { id: "p2", name: "backend 2" },
    ];
    expect(pageToSpawnForRail(railNamed("backend", null), pages)).toBe("backend 3");
  });

  it("falls back to a generic name for a blank rail name", () => {
    expect(pageToSpawnForRail(railNamed("  ", null), [])).toBe("Rail");
  });
});

describe("dropImpossibleSteps", () => {
  // A step with neither a card path nor a tool id is what a pre-v11
  // daemon leaves behind when the app hands it a tool step: those
  // columns did not exist yet, so the tool is dropped on the way in and
  // the step comes back empty. The current daemon REFUSES to store one,
  // so a plan still holding it cannot be saved at all -- which is why
  // the app has to drop it on the way out of the wire.
  function withSteps(steps: Step[][]): Orchestration {
    return {
      ...emptyOrchestration(),
      rails: [
        {
          id: "r1",
          name: "r1",
          position: 0,
          worktreePath: null,
          pageId: null,
          stages: steps.map((s, i) => ({ id: `st${i}`, position: i, steps: s })),
        },
      ],
    };
  }
  const ghost = (id: string): Step => ({ id, position: 0, cardPath: "", toolId: null });
  const card = (id: string): Step => ({ id, position: 0, cardPath: "/ws/a.md", toolId: null });
  const tool = (id: string): Step => ({ id, position: 0, cardPath: "", toolId: "builtin:push" });

  it("drops a step with neither a card path nor a tool id", () => {
    const out = dropImpossibleSteps(withSteps([[card("t1"), ghost("t2")]]));
    expect(out.rails[0].stages[0].steps.map((s) => s.id)).toEqual(["t1"]);
  });

  it("keeps card steps and tool steps", () => {
    const out = dropImpossibleSteps(withSteps([[card("t1"), tool("t2")]]));
    expect(out.rails[0].stages[0].steps.map((s) => s.id)).toEqual(["t1", "t2"]);
  });

  it("drops the stage a ghost step leaves empty and renumbers the rest", () => {
    const out = dropImpossibleSteps(withSteps([[ghost("t1")], [card("t2")]]));
    expect(out.rails[0].stages.map((s) => [s.id, s.position])).toEqual([["st1", 0]]);
  });

  // It runs on EVERY read from the wire, so a healthy plan has to come
  // back byte-identical -- silently renumbering one would reorder stages
  // the human arranged.
  it("leaves a well-formed plan exactly as it was", () => {
    const orch = withSteps([[card("t1")], [tool("t2"), card("t3")]]);
    orch.rails[0].stages[1].steps[1].position = 1;
    expect(dropImpossibleSteps(orch).rails).toEqual(orch.rails);
  });

  it("sweeps run state naming a dropped step", () => {
    const orch = withSteps([[card("t1"), ghost("t2")]]);
    orch.stepRuns = [{ stepId: "t2", state: "running", sessionId: null, reason: null }];
    expect(dropImpossibleSteps(orch).stepRuns).toEqual([]);
  });
});

describe("railDoneStepIds", () => {
  const r = rail("r1", [[["t1", "/x/a.md"]], [["t2", "/x/b.md"], ["t3", "/x/c.md"]]]);
  const index = (statuses: Array<string | null>) =>
    cardIndex(
      tree([
        plan("a.md", { path: "/x/a.md", status: statuses[0] }),
        plan("b.md", { path: "/x/b.md", status: statuses[1] }),
        plan("c.md", { path: "/x/c.md", status: statuses[2] }),
      ])
    );
  const runs = (states: Array<[string, StepState]>): Orchestration =>
    orchOf([r], {
      stepRuns: states.map(([stepId, state]) => ({ stepId, state, sessionId: null, reason: null })),
    });

  it("lists the steps the scheduler marked done, in run order", () => {
    const o = runs([
      ["t3", "done"],
      ["t1", "done"],
      ["t2", "running"],
    ]);
    expect(railDoneStepIds(r, o, index([null, null, null]), "Done")).toEqual(["t1", "t3"]);
  });

  // A rail that was never started has no run state at all, and its cards
  // can still be finished -- the board is what says so.
  it("counts a pending card step whose card sits in the done column", () => {
    const o = runs([]);
    expect(railDoneStepIds(r, o, index(["Done", "To Do", "done"]), "Done")).toEqual(["t1", "t3"]);
  });

  it("compares the card's status by slug, not spelling", () => {
    expect(railDoneStepIds(r, runs([]), index(["DONE", null, null]), "Done")).toEqual(["t1"]);
  });

  // The daemon refuses a plan write that drops a running step, so one is
  // never offered up -- whatever its card says.
  it("never lists a running step", () => {
    const o = runs([["t1", "running"]]);
    expect(railDoneStepIds(r, o, index(["Done", null, null]), "Done")).toEqual([]);
  });

  it("leaves stalled and pending steps alone", () => {
    const o = runs([
      ["t1", "stalled"],
      ["t2", "pending"],
    ]);
    expect(railDoneStepIds(r, o, index([null, null, null]), "Done")).toEqual([]);
  });

  // The bug this guards: Reset and Retry write an explicit `pending`
  // row, and nothing moves the card back out of Done when they do. Read
  // through stepStateOf, a restarted step is indistinguishable from one
  // that never ran, so Clear done swept away exactly the work the human
  // had just queued up to run again.
  it("leaves a step restarted over a Done card alone", () => {
    const o = runs([["t1", "pending"]]);
    expect(railDoneStepIds(r, o, index(["Done", null, null]), "Done")).toEqual([]);
  });

  // Same rule for a stall: rule 2 retries it when the run reaches its
  // stage, so it is work still ahead whatever its card says.
  it("leaves a stalled step alone even when its card sits in the done column", () => {
    const o = runs([["t1", "stalled"]]);
    expect(railDoneStepIds(r, o, index(["Done", null, null]), "Done")).toEqual([]);
  });

  // Reset writes a pending row for EVERY step, which is the whole point:
  // a rail the human has just re-armed has nothing finished on it, so
  // the clear is a no-op and its button goes flat.
  it("has nothing to clear on a rail whose run state was just reset", () => {
    const o = runs([
      ["t1", "pending"],
      ["t2", "pending"],
      ["t3", "pending"],
    ]);
    expect(railDoneStepIds(r, o, index(["Done", "Done", "Done"]), "Done")).toEqual([]);
  });

  // The fallback survives where it was meant to: a step the rail has
  // never reached has no run row at all, so a card finished by hand
  // still comes off. Only the steps the rail HAS a verdict on are read
  // from run state alone.
  it("still counts a never-reached step whose card was finished by hand", () => {
    const o = runs([["t1", "done"]]);
    expect(railDoneStepIds(r, o, index([null, "Done", null]), "Done")).toEqual(["t1", "t2"]);
  });

  // A tool step has no card, so only its run state can finish it.
  it("takes a tool step only on its run state", () => {
    const t = toolRail("r1", [[["t1", "builtin:push"]]]);
    expect(railDoneStepIds(t, orchOf([t]), index([null, null, null]), "Done")).toEqual([]);
    const done = orchOf([t], {
      stepRuns: [{ stepId: "t1", state: "done", sessionId: null, reason: null }],
    });
    expect(railDoneStepIds(t, done, index([null, null, null]), "Done")).toEqual(["t1"]);
  });

  // No columns means nothing can complete (spec O6): only run state is
  // left to go on.
  it("falls back to run state alone on a board with no columns", () => {
    const o = runs([["t2", "done"]]);
    expect(railDoneStepIds(r, o, index(["Done", null, null]), null)).toEqual(["t2"]);
  });

  it("ignores the other rails' steps", () => {
    const other = rail("r2", [[["t9", "/x/a.md"]]]);
    const o = orchOf([r, other], {
      stepRuns: [{ stepId: "t9", state: "done", sessionId: null, reason: null }],
    });
    expect(railDoneStepIds(r, o, index([null, null, null]), "Done")).toEqual([]);
  });

  // The same "done" the scheduler skips on: a nested task is drawn in
  // its parent's card, so a Done parent clears it too. Two spellings of
  // done would let Clear done leave behind exactly the steps a Start
  // then walks straight past.
  it("counts a nested task whose parent sits in the done column", () => {
    const nestedIndex = cardIndex(
      tree([
        plan("big.md", { path: "/x/big.md", kind: "plan", status: "Done" }),
        plan("a.md", { path: "/x/a.md", kind: "task", parent: "big.md", status: null }),
        plan("b.md", { path: "/x/b.md", status: null }),
        plan("c.md", { path: "/x/c.md", status: null }),
      ])
    );
    expect(railDoneStepIds(r, runs([]), nestedIndex, "Done")).toEqual(["t1"]);
  });
});

describe("effectiveStatus", () => {
  const index = (plans: PlanFileInfo[]) => planIndex(cardIndex(tree(plans)));
  const entryFor = (plans: PlanFileInfo[], fileName: string): CardEntry =>
    cardIndex(tree(plans)).get(`/ws/.gavin-root/plans/${fileName}`) as CardEntry;

  it("is the card's own status when it has one", () => {
    const plans = [plan("a.md", { status: "To Do" })];
    expect(effectiveStatus(entryFor(plans, "a.md"), index(plans))).toBe("To Do");
  });

  it("is the parent's status for a nested task", () => {
    const plans = [
      plan("big.md", { kind: "plan", status: "Done" }),
      plan("a.md", { kind: "task", parent: "big.md", status: null }),
    ];
    expect(effectiveStatus(entryFor(plans, "a.md"), index(plans))).toBe("Done");
  });

  // A status of its own takes the card OUT of its parent's card and back
  // into a column of its own, so the parent stops speaking for it.
  it("prefers the card's own status over the parent's", () => {
    const plans = [
      plan("big.md", { kind: "plan", status: "Done" }),
      plan("a.md", { kind: "task", parent: "big.md", status: "To Do" }),
    ];
    expect(effectiveStatus(entryFor(plans, "a.md"), index(plans))).toBe("To Do");
  });

  it("inherits nothing from a parent that resolves to no plan", () => {
    const plans = [plan("a.md", { kind: "task", parent: "gone.md", status: null })];
    expect(effectiveStatus(entryFor(plans, "a.md"), index(plans))).toBeNull();
  });

  it("inherits nothing from a parent that is a task rather than a plan", () => {
    const plans = [
      plan("big.md", { kind: "task", status: "Done" }),
      plan("a.md", { kind: "task", parent: "big.md", status: null }),
    ];
    expect(effectiveStatus(entryFor(plans, "a.md"), index(plans))).toBeNull();
  });

  it("inherits nothing from itself", () => {
    const plans = [plan("a.md", { kind: "task", parent: "a.md", status: null })];
    expect(effectiveStatus(entryFor(plans, "a.md"), index(plans))).toBeNull();
  });

  // Nesting is per context (the same link `parent:` resolves on), so a
  // plan of the same file name in ANOTHER context says nothing here.
  it("resolves the parent in the card's own context only", () => {
    const t: GavinTree = {
      rootPath: "/ws",
      rootMissing: false,
      contexts: [
        tree([plan("a.md", { kind: "task", parent: "big.md", status: null })]).contexts[0],
        {
          ...tree([plan("big.md", { kind: "plan", status: "Done" })]).contexts[0],
          folderPath: "/ws/lib/.gavin",
        },
      ],
    };
    const cards = cardIndex(t);
    const entry = cards.get("/ws/.gavin-root/plans/a.md") as CardEntry;
    expect(effectiveStatus(entry, planIndex(cards))).toBeNull();
  });
});

describe("removeSteps", () => {
  it("removes several steps at once and renumbers the survivors", () => {
    let o = addStep(addStage(addRail(emptyOrchestration(), "r1", "backend"), "r1", "s1"), "s1", "t1", "/x/a.md", 0);
    o = addStep(o, "s1", "t2", "/x/b.md", 1);
    o = addStep(o, "s1", "t3", "/x/c.md", 2);
    o = removeSteps(o, ["t1", "t3"]);
    expect(o.rails[0].stages[0].steps.map((t) => [t.id, t.position])).toEqual([["t2", 0]]);
  });

  it("drops every stage it empties and renumbers the rest", () => {
    let o = addStep(addStage(addRail(emptyOrchestration(), "r1", "backend"), "r1", "s1"), "s1", "t1", "/x/a.md", 0);
    o = addStep(addStage(o, "r1", "s2"), "s2", "t2", "/x/b.md", 0);
    o = addStep(addStage(o, "r1", "s3"), "s3", "t3", "/x/c.md", 0);
    o = removeSteps(o, ["t1", "t2"]);
    expect(o.rails[0].stages.map((s) => [s.id, s.position])).toEqual([["s3", 0]]);
  });

  it("drops run state and notes for every step it removed", () => {
    let o = addStep(addStage(addRail(emptyOrchestration(), "r1", "backend"), "r1", "s1"), "s1", "t1", "/x/a.md", 0);
    o = addStep(o, "s1", "t2", "/x/b.md", 1);
    o = {
      ...o,
      stepRuns: [
        { stepId: "t1", state: "done", sessionId: null, reason: null },
        { stepId: "t2", state: "pending", sessionId: null, reason: null },
      ],
      conflictNotes: [{ id: "n1", stepIds: ["t1", "t2"], note: "careful" }],
    };
    o = removeSteps(o, ["t1"]);
    expect(o.stepRuns.map((r) => r.stepId)).toEqual(["t2"]);
    expect(o.conflictNotes).toEqual([]);
  });

  it("is the identity for an empty list", () => {
    const o = addStep(addStage(addRail(emptyOrchestration(), "r1", "backend"), "r1", "s1"), "s1", "t1", "/x/a.md", 0);
    expect(removeSteps(o, [])).toEqual(o);
  });
});

// ---- Every built-in tool can actually finish -------------------------------
// Over the REAL library, not a fixture: the bug was that four of the ten
// built-ins could never complete at all, and hand-written tool fixtures
// are exactly what hid it. A new built-in is covered here the day it is
// added, and a tool whose kind changes has to state how it finishes.
describe("every built-in tool can finish", () => {
  const runs: Orchestration["stepRuns"] = [
    { stepId: "t1", state: "running", sessionId: "s1", reason: null },
  ];
  const armed = (toolId: string) =>
    running(toolRail("r1", [[["t1", toolId]]]), "r1-s0", runs);

  for (const tool of BUILTIN_TOOLS) {
    const summary: ToolSummary[] = [{ id: tool.id, name: tool.name, kind: tool.kind }];

    if (tool.kind === "agent") {
      // Its session never exits, so the signal is the turn ending.
      it(`${tool.id} finishes when its turn ends, with its session still live`, () => {
        const actions = nextActions(
          armed(tool.id), BOARD, CARDS, [], new Set(["s1"]), summary,
          new Map(), new Map([["s1", "idle" as const]]),
          new Set(), new Map(), {}, 0, new Set(["s1"])
        );
        expect(actions).toContainEqual({ kind: "markDone", stepId: "t1" });
      });
    } else if (tool.kind === "until") {
      // Exit 0 is still the pass. A non-zero one is NOT a stall about the
      // code: it is a verdict on the rail, and on a rail where this step
      // is the only one there is nothing behind it to send the rail back
      // to. The loop proper is covered in orchestrationLoop.test.ts.
      it(`${tool.id} finishes when its check exits 0`, () => {
        const actions = nextActions(
          armed(tool.id), BOARD, CARDS, [], new Set(), summary, new Map([["s1", 0]])
        );
        expect(actions).toContainEqual({ kind: "markDone", stepId: "t1" });
      });

      // Its tab outlives the check (retainTabOnExit), so in the app the
      // session is still in the live set when the code lands.
      it(`${tool.id} finishes when its check exits 0 with its tab kept open`, () => {
        const actions = nextActions(
          armed(tool.id), BOARD, CARDS, [], new Set(["s1"]), summary, new Map([["s1", 0]])
        );
        expect(actions).toContainEqual({ kind: "markDone", stepId: "t1" });
      });

      it(`${tool.id} stalls when its check fails with nothing before it`, () => {
        const actions = nextActions(
          armed(tool.id), BOARD, CARDS, [], new Set(), summary, new Map([["s1", 3]])
        );
        expect(actions).toContainEqual({
          kind: "stall",
          stepId: "t1",
          reason: "nothing runs before this step, so the check has nothing to send the rail back to",
        });
      });
    } else if (tool.kind === "review") {
      // It never finishes on its own, and that IS its contract: the
      // scheduler emits nothing for it, ever, and the wait ends when a
      // human presses Skip or Mark done (orchestrationState's skipStep /
      // markStepDone, covered there). This arm is the one place that
      // says so out loud -- without it a review tool would fall into the
      // exit-code arm below and read as a step gavin can finish.
      it(`${tool.id} waits: the scheduler emits nothing for it`, () => {
        const actions = nextActions(
          armed(tool.id), BOARD, CARDS, [], new Set(), summary, new Map([["s1", 0]])
        );
        expect(actions).toEqual([]);
      });

      // A non-zero exit code is not a verdict on it either. It has no
      // session at all, so a code belonging to some other session must
      // never stall it -- which is exactly what the session rules below
      // would do if rule 3g did not come first.
      it(`${tool.id} is not stalled by an exit code it never produced`, () => {
        const actions = nextActions(
          armed(tool.id), BOARD, CARDS, [], new Set(), summary, new Map([["s1", 3]])
        );
        expect(actions).toEqual([]);
      });
    } else if (tool.kind === "critique") {
      // Complete-then-advance when every reviewer finishes — not a
      // human Skip, and not a single agentTurnEnded on stepRuns.sessionId.
      const critiqueArmed = (): Orchestration => {
        const orch = armed(tool.id);
        return {
          ...orch,
          stepRuns: [{ stepId: "t1", state: "running", sessionId: null, reason: null }],
        };
      };
      const sessions = new Map([["t1", ["r1", "r2"] as const]]);

      it(`${tool.id} finishes when every reviewer turn has ended`, () => {
        const actions = nextActions(
          critiqueArmed(),
          BOARD,
          CARDS,
          [],
          new Set(["r1", "r2"]),
          summary,
          new Map(),
          new Map([
            ["r1", "idle" as const],
            ["r2", "idle" as const],
          ]),
          new Set(),
          new Map(),
          {},
          0,
          new Set(["r1", "r2"]),
          sessions
        );
        expect(actions).toContainEqual({ kind: "markDone", stepId: "t1" });
      });

      it(`${tool.id} waits while any reviewer is still working`, () => {
        const actions = nextActions(
          critiqueArmed(),
          BOARD,
          CARDS,
          [],
          new Set(["r1", "r2"]),
          summary,
          new Map(),
          new Map([
            ["r1", "idle" as const],
            ["r2", "working" as const],
          ]),
          new Set(),
          new Map(),
          {},
          0,
          new Set(["r1", "r2"]),
          sessions
        );
        expect(actions).toEqual([]);
      });

      it(`${tool.id} finishes when reviewers have exited the layout`, () => {
        const actions = nextActions(
          critiqueArmed(),
          BOARD,
          CARDS,
          [],
          new Set(),
          summary,
          new Map(),
          new Map(),
          new Set(),
          new Map(),
          {},
          0,
          new Set(),
          sessions
        );
        expect(actions).toContainEqual({ kind: "markDone", stepId: "t1" });
      });
    } else if (tool.kind === "pr") {
      // It has no session at all: gavin waits on GitHub itself, so the
      // verdict comes off the poll's report rather than off an exit code.
      // A rail with no branch has no pull request, so this arm binds one.
      // The wait proper is covered in pullRequest.test.ts.
      const bound = (): Orchestration => {
        const orch = armed(tool.id);
        return { ...orch, rails: [{ ...orch.rails[0], branch: "feat/x" }] };
      };
      const reports = (checks: Array<{ name: string; state: "success" | "failure" }>) => ({
        [prKey("/ws", "feat/x")]: {
          state: "ready" as const,
          number: 9,
          url: "https://example.test/pr/9",
          title: "t",
          prState: "OPEN",
          isDraft: false,
          reviewDecision: "",
          mergeable: "MERGEABLE",
          createdAt: 0,
          checks: checks.map((c) => ({ ...c, url: "" })),
          observedAt: 1000,
          cached: false,
        },
      });

      it(`${tool.id} finishes when the pull request's checks pass`, () => {
        const actions = nextActions(
          bound(), BOARD, CARDS, [], new Set(), summary, new Map(), new Map(),
          new Set(), new Map(), reports([{ name: "build", state: "success" }]), 1000
        );
        expect(actions).toContainEqual({ kind: "markDone", stepId: "t1" });
      });

      it(`${tool.id} stalls when a check fails with nothing before it`, () => {
        const actions = nextActions(
          bound(), BOARD, CARDS, [], new Set(), summary, new Map(), new Map(),
          new Set(), new Map(), reports([{ name: "build", state: "failure" }]), 1000
        );
        expect(actions.some((a) => a.kind === "stall" && a.stepId === "t1")).toBe(true);
      });

      /// The refusal that keeps a wait step from waiting on nothing: an
      /// unbound rail has no branch, so there is no pull request for it.
      it(`${tool.id} refuses to launch on a rail with no branch`, () => {
        const orch = running(toolRail("r1", [[["t1", tool.id]]]), "r1-s0");
        const actions = nextActions(orch, BOARD, CARDS, [], new Set(), summary);
        expect(actions).toContainEqual({
          kind: "stall",
          stepId: "t1",
          reason: "this rail binds no branch, so there is no pull request to wait for",
        });
      });
    } else {
      // Its session really does exit, and the code is the whole verdict.
      it(`${tool.id} finishes when its session exits 0`, () => {
        const actions = nextActions(
          armed(tool.id), BOARD, CARDS, [], new Set(), summary, new Map([["s1", 0]])
        );
        expect(actions).toContainEqual({ kind: "markDone", stepId: "t1" });
      });

      // Its tab outlives the PTY (retainTabOnExit), so in the app the
      // session is still in the live set when the code lands.
      it(`${tool.id} finishes when its session exits 0 with its tab kept open`, () => {
        const actions = nextActions(
          armed(tool.id), BOARD, CARDS, [], new Set(["s1"]), summary, new Map([["s1", 0]])
        );
        expect(actions).toContainEqual({ kind: "markDone", stepId: "t1" });
      });

      it(`${tool.id} stalls with the code when its session exits non-zero`, () => {
        const actions = nextActions(
          armed(tool.id), BOARD, CARDS, [], new Set(), summary, new Map([["s1", 3]])
        );
        expect(actions).toContainEqual({
          kind: "stall",
          stepId: "t1",
          reason: `${tool.name} exited with code 3`,
        });
      });
    }
  }
});

// A `pr` step waits on GitHub rather than on a session, which makes it
// the one running step no session rule can speak for. These are the
// answers the poll's report produces -- the wait itself, the pass, the
// loop backwards, and the two ways it gives up.
describe("nextActions — a pr step", () => {
  const PR_TOOL: ToolSummary[] = [
    { id: "builtin:await-pr", name: "Wait for the pull request", kind: "pr", params: [{ name: "max", default: "3" }] },
    { id: "builtin:run-tests", name: "Run tests", kind: "command" },
  ];

  function report(over: Record<string, unknown> = {}) {
    return {
      [prKey("/ws", "feat/x")]: {
        state: "ready" as const,
        number: 9,
        url: "https://example.test/pr/9",
        title: "t",
        prState: "OPEN",
        isDraft: false,
        reviewDecision: "",
        mergeable: "MERGEABLE",
        createdAt: 0,
        checks: [] as Array<{ name: string; state: string; url: string }>,
        observedAt: 1000,
        cached: false,
        ...over,
      },
    } as Parameters<typeof nextActions>[10];
  }

  /// A rail bound to feat/x whose second step waits on the PR, with the
  /// wait already running -- which is the state every rule below reads.
  function waiting(stepRuns: Orchestration["stepRuns"]): Orchestration {
    const r = toolRail("r1", [[["work", "builtin:run-tests"]], [["wait", "builtin:await-pr"]]]);
    const orch = running({ ...r, branch: "feat/x" }, "r1-s1", stepRuns);
    return orch;
  }

  const WAIT_RUNNING: Orchestration["stepRuns"] = [
    { stepId: "work", state: "done", sessionId: "s0", reason: null },
    // No session id, which is the whole point: gavin does the waiting.
    { stepId: "wait", state: "running", sessionId: null, reason: null },
  ];

  const act = (orch: Orchestration, reports: Parameters<typeof nextActions>[10]) =>
    nextActions(orch, BOARD, CARDS, [], new Set(), PR_TOOL, new Map(), new Map(), new Set(), new Map(), reports, 1000);

  it("emits nothing at all while the checks are still running", () => {
    const actions = act(waiting(WAIT_RUNNING), report({ checks: [{ name: "b", state: "pending", url: "" }] }));
    expect(actions).toEqual([]);
  });

  /// Not asked yet is not "no pull request": the poll may not have
  /// answered, and passing here would advance the rail on nothing.
  it("waits when the poll has said nothing yet", () => {
    expect(act(waiting(WAIT_RUNNING), {})).toEqual([]);
  });

  it("marks the step done when the checks pass", () => {
    const actions = act(waiting(WAIT_RUNNING), report({ checks: [{ name: "b", state: "success", url: "" }] }));
    expect(actions).toContainEqual({ kind: "markDone", stepId: "wait" });
  });

  /// The rule this whole card exists for: a failing check does not stall
  /// the rail, it sends it back over the work that broke.
  it("sends the rail backwards over the previous step when a check fails", () => {
    const actions = act(waiting(WAIT_RUNNING), report({ checks: [{ name: "b", state: "failure", url: "" }] }));
    expect(actions).toContainEqual({
      kind: "loopBack",
      stepId: "wait",
      previousStepId: "work",
      attempt: 1,
      max: 3,
    });
  });

  it("gives up once the budget is spent, quoting what failed", () => {
    const runs: Orchestration["stepRuns"] = [
      { stepId: "work", state: "done", sessionId: "s0", reason: null },
      { stepId: "wait", state: "running", sessionId: null, reason: null, resumeAttempts: 3 },
    ];
    const actions = act(waiting(runs), report({ checks: [{ name: "build", state: "failure", url: "" }] }));
    const exhausted = actions.find((a) => a.kind === "loopExhausted");
    expect(exhausted).toMatchObject({ stepId: "wait", max: 3 });
    // The note travels with the action: this verdict came from reading
    // GitHub, so there is no log on disk for the executor to find.
    expect(exhausted?.kind === "loopExhausted" && exhausted.note).toContain("build");
  });

  it("stalls on a pull request that was closed without merging", () => {
    const actions = act(waiting(WAIT_RUNNING), report({ prState: "CLOSED" }));
    expect(actions.some((a) => a.kind === "stall" && a.stepId === "wait")).toBe(true);
  });

  /// Before the library lands there are no kinds to read, so a running
  /// tool step with no session cannot be told from any other -- and
  /// reporting a session that ended while gavin was not watching about a
  /// step that never had one would be a lie on a cold start.
  it("says nothing about a session-less step while the library is still loading", () => {
    const r = toolRail("r1", [[["wait", "builtin:await-pr"]]]);
    const orch: Orchestration = {
      rails: [{ ...r, branch: "feat/x" }],
      conflictNotes: [],
      railRuns: [{ railId: "r1", state: "paused", currentStageId: "r1-s0" }],
      stepRuns: [{ stepId: "wait", state: "running", sessionId: null, reason: null }],
    };
    // `null` tools, not `[]`: the library has not loaded.
    expect(nextActions(orch, BOARD, CARDS, [], new Set(), null)).toEqual([]);
  });

  /// A rail that is not running never consults the poll, so a wait step
  /// left `running` under one is waiting on nothing that will ever look
  /// -- and a running step is what wedges a rail shut.
  it("stalls a waiting step when its rail has stopped", () => {
    const r = toolRail("r1", [[["wait", "builtin:await-pr"]]]);
    const orch: Orchestration = {
      rails: [{ ...r, branch: "feat/x" }],
      conflictNotes: [],
      railRuns: [{ railId: "r1", state: "paused", currentStageId: "r1-s0" }],
      stepRuns: [{ stepId: "wait", state: "running", sessionId: null, reason: null }],
    };
    expect(act(orch, report())).toEqual([
      {
        kind: "stall",
        stepId: "wait",
        reason: "the rail stopped while this step was waiting on the pull request",
      },
    ]);
  });
});

// A `review` step is the `pr` step with a PERSON in place of GitHub: it
// launches nothing, holds no session and is never finished by anything
// the scheduler can decide. Which makes it the one step where "the
// scheduler emitted nothing" is the assertion rather than the absence of
// one -- every session rule below rule 3g would otherwise speak for a
// session that does not exist.
describe("nextActions — a review step", () => {
  const REVIEW_TOOLS: ToolSummary[] = [
    { id: "builtin:manual-review", name: "Manual review", kind: "review" },
    { id: "builtin:run-tests", name: "Run tests", kind: "command" },
  ];

  /// Work, then a gate, then a push: the shape a review step is actually
  /// dropped into.
  const gated = (stepRuns: Orchestration["stepRuns"], railState: RailState = "running") => {
    const r = toolRail("r1", [
      [["work", "builtin:run-tests"]],
      [["gate", "builtin:manual-review"]],
      [["after", "builtin:run-tests"]],
    ]);
    return {
      rails: [r],
      conflictNotes: [],
      railRuns: [{ railId: "r1", state: railState, currentStageId: "r1-s1" }],
      stepRuns,
    } as Orchestration;
  };

  const WAITING: Orchestration["stepRuns"] = [
    { stepId: "work", state: "done", sessionId: "s0", reason: null },
    // No session id: gavin launches nothing for a review step.
    { stepId: "gate", state: "running", sessionId: null, reason: null },
  ];

  const act = (orch: Orchestration, exits = new Map<string, number>()) =>
    nextActions(orch, BOARD, CARDS, [], new Set(["s0"]), REVIEW_TOOLS, exits);

  it("launches like any other step -- the hold is what the launch DOES", () => {
    const orch = gated([{ stepId: "work", state: "done", sessionId: "s0", reason: null }]);
    expect(act(orch)).toEqual([{ kind: "launch", stepId: "gate" }]);
  });

  // The whole feature in one assertion: the rail is running, the stage
  // is reached, and nothing happens until a person acts.
  it("then waits forever: no action, no advance, no stall", () => {
    expect(act(gated(WAITING))).toEqual([]);
  });

  // Skip is the human's move (skipStep), and the rail carries on from
  // the stage after it. Asserted through the SIMULATED state rather than
  // by calling skipStep, which is orchestrationState's job: what matters
  // here is that a `skipped` gate does not hold the rail.
  it("lets the rail advance once the human has skipped it", () => {
    const orch = gated([
      { stepId: "work", state: "done", sessionId: "s0", reason: null },
      { stepId: "gate", state: "skipped", sessionId: null, reason: null },
    ]);
    expect(act(orch)).toContainEqual({ kind: "advance", railId: "r1", stageId: "r1-s2" });
  });

  it("lets the rail advance once the human has marked it done", () => {
    const orch = gated([
      { stepId: "work", state: "done", sessionId: "s0", reason: null },
      { stepId: "gate", state: "done", sessionId: null, reason: null },
    ]);
    expect(act(orch)).toContainEqual({ kind: "advance", railId: "r1", stageId: "r1-s2" });
  });

  // The difference from a `pr` step, and it is deliberate. A wait on
  // GitHub is only consulted on a running rail, so one left behind on a
  // paused rail is stalled to say so; a wait on a PERSON is not -- Skip
  // works from a paused rail and puts it back to running as it goes, so
  // the step is still waiting on exactly what it was waiting on.
  it("is left alone on a paused rail, not stalled like a pull-request wait", () => {
    expect(act(gated(WAITING, "paused"))).toEqual([]);
  });

  // It has no session, so no session's exit code is a verdict on it.
  // Without rule 3g coming first, the dead-session rule would read the
  // absence of one as a session that ended unwatched and stall the gate.
  it("is not stalled by a session that ended somewhere else", () => {
    expect(act(gated(WAITING), new Map([["s0", 1]]))).toEqual([]);
  });

  // Cold start: with no library loaded the kind is unknown, and an
  // unknown tool step with no session must be left alone rather than
  // reported as a session that died -- the rule launchBlocker and the
  // reconciliation pass both already follow.
  it("is left alone while the tool library is still loading", () => {
    const orch = gated(WAITING);
    expect(nextActions(orch, BOARD, CARDS, [], new Set(["s0"]), null)).toEqual([]);
  });
});

// A `running` step says nothing about WHY it is running. Every other
// surface in the app already reads a session's status -- the tab dot,
// the sidebar badge, the board card, the OS notification -- and the rail
// was the one place showing a live agent with nothing to say about it.
// These are the three ways a running step is waiting on a human rather
// than on itself.
describe("stepAttentions", () => {
  const A = "/ws/.gavin-root/plans/a.md";
  const cardRail = rail("r1", [[["t1", A]]]);
  const runs = (state: StepState = "running"): Orchestration["stepRuns"] => [
    { stepId: "t1", state, sessionId: "s1", reason: null },
  ];
  const statuses = (s: SessionStatus) => new Map([["s1", s]]);
  const attn = (
    orch: Orchestration,
    s: Map<string, SessionStatus>,
    tree_: GavinTree = CARDS,
    tools: ToolSummary[] | null = TOOLS
  ) => stepAttentions(orch, BOARD, tree_, tools, s);

  it("marks a step whose agent is asking the human something", () => {
    const orch = running(cardRail, "r1-s0", runs());
    expect(attn(orch, statuses("waiting_for_input")).get("t1")).toBe("asking");
  });

  // The bug this card was filed for: the agent answered, or got
  // confused, or decided the work was not for it, and sat back down at
  // its prompt without ever setting the card's status.
  it("marks a card step whose agent's turn ended with the card short of Done", () => {
    const orch = running(cardRail, "r1-s0", runs());
    expect(attn(orch, statuses("idle")).get("t1")).toBe("turn-ended");
  });

  // Would be a lie: the card IS finished. Rule 1 marks the step done on
  // this same tick, so a mark here would also flash on for one frame
  // before the chip went green.
  it("says nothing when the card reached the done column", () => {
    const done = tree([plan("a.md", { status: "Done" })]);
    const orch = running(cardRail, "r1-s0", runs());
    expect(attn(orch, statuses("idle"), done).get("t1")).toBeUndefined();
  });

  // A nested task's status is its parent's (effectiveStatus), so a task
  // under a Done plan is finished and gets no mark either.
  it("reads a nested task's done-ness through its parent", () => {
    const nested = tree([
      plan("parent.md", { kind: "plan", status: "Done" }),
      plan("a.md", { status: null, parent: "parent.md" }),
    ]);
    const orch = running(cardRail, "r1-s0", runs());
    expect(attn(orch, statuses("idle"), nested).get("t1")).toBeUndefined();
  });

  it("says nothing while the agent is still working", () => {
    const orch = running(cardRail, "r1-s0", runs());
    expect(attn(orch, statuses("working")).get("t1")).toBeUndefined();
  });

  // The daemon registers every new session idle, so an absent status is
  // "nothing reported yet" -- believing it would mark a step the instant
  // it launched.
  it("says nothing about a session that has reported no status at all", () => {
    const orch = running(cardRail, "r1-s0", runs());
    expect(attn(orch, new Map()).get("t1")).toBeUndefined();
  });

  // agentTurnEnded marks it done on this same tick, from both the
  // running-rail rule and the reconciliation pass -- so the mark would
  // only ever flicker.
  it("says nothing about an idle AGENT tool step, which is about to be done", () => {
    const orch = running(toolRail("r1", [[["t1", "builtin:commit"]]]), "r1-s0", runs());
    expect(attn(orch, statuses("idle")).get("t1")).toBeUndefined();
  });

  // A command tool's verdict is its exit code (T5): a quiet `npm run
  // dev` is a server that started, not an agent that stopped talking.
  it("says nothing about an idle COMMAND tool step", () => {
    const orch = running(toolRail("r1", [[["t1", "builtin:push"]]]), "r1-s0", runs());
    expect(attn(orch, statuses("idle")).get("t1")).toBeUndefined();
  });

  // ...but a command tool that somehow reports waiting_for_input is a
  // prompt on screen nobody is looking at, which is worth saying.
  it("still marks a COMMAND tool step that is waiting for input", () => {
    const orch = running(toolRail("r1", [[["t1", "builtin:push"]]]), "r1-s0", runs());
    expect(attn(orch, statuses("waiting_for_input")).get("t1")).toBe("asking");
  });

  // An unloaded library must not read as "every tool was deleted" -- the
  // same reason launchBlocker and agentTurnEnded take null here. Without
  // knowing the kind, an idle tool step cannot be told from an agent's
  // about-to-complete turn, so it says nothing rather than guessing.
  it("says nothing about an idle tool step while the library is still loading", () => {
    const orch = running(toolRail("r1", [[["t1", "builtin:commit"]]]), "r1-s0", runs());
    expect(attn(orch, statuses("idle"), CARDS, null).get("t1")).toBeUndefined();
  });

  it.each(["pending", "done", "stalled"] as StepState[])(
    "says nothing about a %s step -- only a running one can be waiting",
    (state) => {
      const orch = running(cardRail, "r1-s0", runs(state));
      expect(attn(orch, statuses("idle")).get("t1")).toBeUndefined();
    }
  );

  it("says nothing about a running step that has no session", () => {
    const orch = running(cardRail, "r1-s0", [
      { stepId: "t1", state: "running", sessionId: null, reason: null },
    ]);
    expect(attn(orch, statuses("idle")).size).toBe(0);
  });

  // The mark describes the STEP, not the rail. A paused rail holding a
  // step stuck `running` is exactly the wedge worth seeing: the daemon
  // refuses every plan write that drops a running step, so it is why the
  // rail cannot be edited or deleted.
  it("marks a step on a rail that is not running", () => {
    const orch: Orchestration = {
      rails: [cardRail],
      conflictNotes: [],
      railRuns: [{ railId: "r1", state: "paused", currentStageId: null }],
      stepRuns: runs(),
    };
    expect(attn(orch, statuses("idle")).get("t1")).toBe("turn-ended");
  });

  it("returns an empty map for an orchestration with no rails", () => {
    expect(attn(emptyOrchestration(), statuses("idle")).size).toBe(0);
  });

  // ---- a review gate ----------------------------------------------------
  // The one mark read off the PLAN rather than off a session status. A
  // `review` step has no session at all, so every other test in this
  // file would leave the one step guaranteed to want a human as the one
  // step with nothing to say -- a rail stopped on purpose looking
  // exactly like a rail that was busy.
  describe("a review gate", () => {
    const REVIEW: ToolSummary[] = [
      ...TOOLS,
      { id: "builtin:manual-review", name: "Manual review", kind: "review" },
    ];
    const gate = toolRail("r1", [[["t1", "builtin:manual-review"]]]);
    const waiting = (state: StepState = "running"): Orchestration =>
      running(gate, "r1-s0", [{ stepId: "t1", state, sessionId: null, reason: null }]);

    it("marks a running review step, with no session to read", () => {
      expect(attn(waiting(), new Map(), CARDS, REVIEW).get("t1")).toBe("review");
    });

    it.each(["pending", "done", "skipped", "stalled"] as StepState[])(
      "says nothing about a %s review step",
      (state) => {
        expect(attn(waiting(state), new Map(), CARDS, REVIEW).get("t1")).toBeUndefined();
      }
    );

    // The cold-start rule the whole file follows: an unloaded library
    // must not read as "no step is a review", and it must not read as
    // "every step is" either.
    it("says nothing while the tool library is still loading", () => {
      expect(attn(waiting(), new Map(), CARDS, null).get("t1")).toBeUndefined();
    });

    // ATTENTION_RANK's second line: the gate is as certain as a break --
    // neither ends by itself -- but only one of them is a fault, and the
    // human should be sent to the fault first.
    it("is outranked by a step that actually broke", () => {
      const orch = running(
        toolRail("r1", [[["t1", "builtin:manual-review"], ["t2", "builtin:commit"]]]),
        "r1-s0",
        [
          { stepId: "t1", state: "running", sessionId: null, reason: null },
          { stepId: "t2", state: "running", sessionId: "s1", reason: null },
        ]
      );
      const marks = stepAttentions(orch, BOARD, CARDS, REVIEW, statuses("failed"));
      expect(marks.get("t1")).toBe("review");
      expect(railAttention(orch.rails[0], marks)).toBe("failed");
    });

    // ...and outranks a turn that merely ended, which might still
    // resolve itself with a status write already in flight.
    it("outranks a turn that merely ended", () => {
      const orch = running(
        toolRail("r1", [[["t1", "builtin:manual-review"]]]),
        "r1-s0",
        [{ stepId: "t1", state: "running", sessionId: null, reason: null }]
      );
      const cards = rail("r2", [[["t2", A]]]);
      const both: Orchestration = {
        ...orch,
        rails: [{ ...orch.rails[0], stages: [...orch.rails[0].stages, ...cards.stages] }],
        stepRuns: [
          ...orch.stepRuns,
          { stepId: "t2", state: "running", sessionId: "s1", reason: null },
        ],
      };
      const marks = stepAttentions(both, BOARD, CARDS, REVIEW, statuses("idle"));
      expect(marks.get("t2")).toBe("turn-ended");
      expect(railAttention(both.rails[0], marks)).toBe("review");
    });

    // The tooltip has to name the button that ends the wait: unlike
    // every other mark here, nothing is going to resolve it on its own.
    it("says what ends the wait", () => {
      expect(attentionTip("review", "Done")).toContain("Skip");
    });
  });

  // AG-01. The one mark on a step that never ran: a card whose body
  // nobody has read is refused BEFORE a session exists, so there is no
  // status to read and nothing that will move on its own.
  describe("a card nobody has read (`unreviewed`)", () => {
    const REVIEW_LIBRARY: ToolSummary[] = [
      ...TOOLS,
      { id: "builtin:manual-review", name: "Manual review", kind: "review" },
    ];
    const stalledOnReview = (reason: string): Orchestration =>
      running(cardRail, "r1-s0", [{ stepId: "t1", state: "stalled", sessionId: null, reason }]);

    it("marks a step stalled by the review gate", () => {
      const orch = stalledOnReview(unreviewedStallReason("Fix a typo"));
      expect(attn(orch, new Map()).get("t1")).toBe("unreviewed");
    });

    it("leaves every other stall unmarked — those already say why on the chip", () => {
      expect(attn(stalledOnReview("card file is missing"), new Map()).get("t1")).toBeUndefined();
      expect(attn(stalledOnReview("could not start the agent"), new Map()).get("t1")).toBeUndefined();
    });

    // A rail is one row on the hub, so it shows one mark. Under
    // `review`, the gate somebody ASKED for -- nothing here is broken,
    // and of the two waits this is the longer errand.
    it("is outranked by the manual review gate on the same rail", () => {
      const both = running(
        toolRail("r1", [[["t1", "builtin:manual-review"]]]),
        "r1-s0",
        [{ stepId: "t1", state: "running", sessionId: null, reason: null }]
      );
      const cards = rail("r2", [[["t2", A]]]);
      const orch: Orchestration = {
        ...both,
        rails: [{ ...both.rails[0], stages: [...both.rails[0].stages, ...cards.stages] }],
        stepRuns: [
          ...both.stepRuns,
          {
            stepId: "t2",
            state: "stalled",
            sessionId: null,
            reason: unreviewedStallReason("Fix a typo"),
          },
        ],
      };
      const marks = stepAttentions(orch, BOARD, CARDS, REVIEW_LIBRARY, new Map());
      expect(marks.get("t2")).toBe("unreviewed");
      expect(railAttention(orch.rails[0], marks)).toBe("review");
    });

    // Nothing on the rail ends this wait, so the tip has to send the
    // reader to the card and back.
    it("says where the answer is given", () => {
      const tip = attentionTip("unreviewed", "Done");
      expect(tip).toContain("card");
      expect(tip).toContain("Retry");
    });
  });

  // "turn-ended" is true of a broken agent and useless: it means "the
  // agent stopped talking". The human needs to know it BROKE.
  it("marks a step whose agent broke as failed, not as a turn that ended", () => {
    const orch = running(cardRail, "r1-s0", runs());
    expect(attn(orch, statuses("failed")).get("t1")).toBe("failed");
  });

  // Unlike `turn-ended`, which skips tool steps because their own rules
  // speak for them: here the rule (3d) and the mark say the same thing,
  // and the human is about to be shown a paused rail that owes them a
  // reason.
  it("marks a failed TOOL step too", () => {
    const orch = running(toolRail("r1", [[["t1", "builtin:commit"]]]), "r1-s0", runs());
    expect(attn(orch, statuses("failed")).get("t1")).toBe("failed");
  });

  // `unknown` is a status written by a NEWER daemon. Not a mark: gavin
  // has no idea what it means, and inventing an attention for it would
  // be the same guess the old "anything I do not recognise is idle"
  // default made, pointed the other way.
  it("says nothing about a status this build cannot read", () => {
    const orch = running(cardRail, "r1-s0", runs());
    expect(attn(orch, statuses("unknown")).get("t1")).toBeUndefined();
  });

  // ---- the decoy card ---------------------------------------------------
  // The failure this family was extended for. A rail step hands its
  // agent a worktree cwd and an absolute card path in the main checkout;
  // the agent writes the worktree's own copy, and everything downstream
  // stays silent -- the board never moves, so from the rail's side the
  // agent simply has not finished yet.
  describe("a decoy write", () => {
    const decoy = (ids: string[] = ["t1"]) => new Set(ids);

    // The reproduction, as the code sees it: the agent is still working
    // (or has only just gone quiet), the card is untouched, and before
    // this every surface in the app had exactly nothing to say.
    it("used to be invisible: a working agent over an unmoved card gets no mark on its own", () => {
      const orch = running(cardRail, "r1-s0", runs());
      expect(attn(orch, statuses("working")).get("t1")).toBeUndefined();
    });

    // ...and the whole point of not reading a session status for this
    // one: the write is already on disk, so an agent that is still busy
    // is no less unable to reach the board.
    it("marks the step while the agent is still working", () => {
      const orch = running(cardRail, "r1-s0", runs());
      expect(stepAttentions(orch, BOARD, CARDS, TOOLS, statuses("working"), decoy()).get("t1")).toBe(
        "decoy-edit"
      );
    });

    it("outranks a turn that merely ended", () => {
      const orch = running(cardRail, "r1-s0", runs());
      expect(stepAttentions(orch, BOARD, CARDS, TOOLS, statuses("idle"), decoy()).get("t1")).toBe(
        "decoy-edit"
      );
    });

    // The agent's own words about what broke are the more actionable
    // fact, and rule 3d has already stalled the step with them.
    it("still yields to an agent that broke", () => {
      const orch = running(cardRail, "r1-s0", runs());
      expect(stepAttentions(orch, BOARD, CARDS, TOOLS, statuses("failed"), decoy()).get("t1")).toBe(
        "failed"
      );
    });

    it("marks only the step whose card was written", () => {
      const two = rail("r1", [[["t1", A], ["t2", "/ws/.gavin-root/plans/b.md"]]]);
      const orch = running(two, "r1-s0", [
        { stepId: "t1", state: "running", sessionId: "s1", reason: null },
        { stepId: "t2", state: "running", sessionId: "s2", reason: null },
      ]);
      const marks = stepAttentions(orch, BOARD, CARDS, TOOLS, statuses("working"), decoy(["t2"]));
      expect(marks.get("t1")).toBeUndefined();
      expect(marks.get("t2")).toBe("decoy-edit");
    });

    // "Not looked at" must never read as "looked at and clean" -- which
    // is why the default is an empty set producing no mark rather than a
    // reassuring one, and why a step that is not running is never marked
    // whatever the sweep found.
    it("says nothing about a step that is not running", () => {
      const orch = running(cardRail, "r1-s0", runs("done"));
      expect(stepAttentions(orch, BOARD, CARDS, TOOLS, statuses("idle"), decoy()).size).toBe(0);
    });
  });

  // ---- a turn that ended a long time ago --------------------------------
  describe("staleness", () => {
    const since = (ms: number) => new Map([["s1", ms]]);
    const NOW = 1_000_000_000;

    it("is turn-ended until the wait passes the threshold", () => {
      const orch = running(cardRail, "r1-s0", runs());
      const young = stepAttentions(
        orch,
        BOARD,
        CARDS,
        TOOLS,
        statuses("idle"),
        new Set(),
        since(NOW - STALE_AFTER_MS + 1),
        NOW
      );
      expect(young.get("t1")).toBe("turn-ended");
    });

    it("becomes stale once nothing has happened for the threshold", () => {
      const orch = running(cardRail, "r1-s0", runs());
      const old = stepAttentions(
        orch,
        BOARD,
        CARDS,
        TOOLS,
        statuses("idle"),
        new Set(),
        since(NOW - STALE_AFTER_MS),
        NOW
      );
      expect(old.get("t1")).toBe("stale");
    });

    // An unmeasured wait is not a long one. Every session is unstamped
    // for a moment after the app attaches, and marking those stale would
    // accuse every rail in the fleet on every restart.
    it("never goes stale without a stamp", () => {
      const orch = running(cardRail, "r1-s0", runs());
      expect(
        stepAttentions(orch, BOARD, CARDS, TOOLS, statuses("idle"), new Set(), new Map(), NOW).get(
          "t1"
        )
      ).toBe("turn-ended");
    });

    // Staleness is an aged turn-ended and nothing else: a card that
    // reached Done is finished however long ago its agent stopped.
    it("says nothing about an old wait whose card did reach Done", () => {
      const done = tree([plan("a.md", { status: "Done" })]);
      const orch = running(cardRail, "r1-s0", runs());
      expect(
        stepAttentions(orch, BOARD, done, TOOLS, statuses("idle"), new Set(), since(0), NOW).size
      ).toBe(0);
    });

    // A busy agent re-stamps its session on every status change, so a
    // long build never ages into this; only genuine quiet does.
    it("says nothing about an agent that is still working, however long for", () => {
      const orch = running(cardRail, "r1-s0", runs());
      expect(
        stepAttentions(orch, BOARD, CARDS, TOOLS, statuses("working"), new Set(), since(0), NOW).size
      ).toBe(0);
    });
  });
});

describe("railAttention / railsWantingAttention", () => {
  const A = "/ws/.gavin-root/plans/a.md";
  const B = "/ws/.gavin-root/plans/b.md";
  const marks = (m: Record<string, StepAttention>) => new Map(Object.entries(m));

  // "asking" outranks "turn-ended": one is a question with a human on
  // the other end of it, the other is work that quietly stopped.
  it("is the rail's most urgent step mark", () => {
    const r = rail("r1", [[["t1", A], ["t2", B]]]);
    expect(railAttention(r, marks({ t1: "turn-ended", t2: "asking" }))).toBe("asking");
    expect(railAttention(r, marks({ t1: "turn-ended" }))).toBe("turn-ended");
    expect(railAttention(r, marks({}))).toBeNull();
  });

  // "failed" outranks both: a question and a quiet agent are states a
  // rail can legitimately be in, and a broken one is not.
  it("puts a broken agent above a question and above a quiet one", () => {
    const r = rail("r1", [[["t1", A], ["t2", B]]]);
    expect(railAttention(r, marks({ t1: "failed", t2: "asking" }))).toBe("failed");
    expect(railAttention(r, marks({ t1: "turn-ended", t2: "failed" }))).toBe("failed");
  });

  // The rank's one rule: a mark meaning "this will not finish by itself"
  // outranks one meaning "it still might". A rail header showing
  // "needs you" for a question, while another of its steps is wedged on
  // a decoy write, points the human at the wrong step.
  it("puts a decoy write and a long-dead turn above a live question", () => {
    const r = rail("r1", [[["t1", A], ["t2", B]]]);
    expect(railAttention(r, marks({ t1: "decoy-edit", t2: "asking" }))).toBe("decoy-edit");
    expect(railAttention(r, marks({ t1: "stale", t2: "asking" }))).toBe("stale");
    expect(railAttention(r, marks({ t1: "stale", t2: "decoy-edit" }))).toBe("decoy-edit");
    expect(railAttention(r, marks({ t1: "turn-ended", t2: "stale" }))).toBe("stale");
  });

  it("collects the rails with any marked step", () => {
    const orch: Orchestration = {
      ...emptyOrchestration(),
      rails: [rail("r1", [[["t1", A]]]), rail("r2", [[["t2", B]]])],
    };
    expect(railsWantingAttention(orch, marks({ t2: "asking" }))).toEqual(new Set(["r2"]));
    expect(railsWantingAttention(orch, marks({}))).toEqual(new Set());
  });
});

describe("failedStepReason", () => {
  it("carries the agent's own sentence, which is what the human acts on", () => {
    expect(failedStepReason("API Error: 529 Overloaded.")).toBe(
      "the agent stopped because something broke — API Error: 529 Overloaded."
    );
  });

  it("still says something true when the reason was lost", () => {
    expect(failedStepReason(undefined)).toBe(
      "the agent stopped because something broke, not because it finished"
    );
    expect(failedStepReason("  ")).toBe(
      "the agent stopped because something broke, not because it finished"
    );
  });
});

describe("attentionTip", () => {
  it("names the board's own done column rather than a generic word", () => {
    expect(attentionTip("turn-ended", "Shipped")).toBe(
      "the agent's turn ended but the card is not in Shipped"
    );
  });

  it("does not mention a column for a question, which has nothing to do with one", () => {
    expect(attentionTip("asking", "Done")).toBe("the agent is asking you something");
  });

  // The mark lasts one tick -- rule 3d stalls the step on the same pass
  // -- so the tip says WHAT happened and the stall reason
  // (failedStepReason) carries the agent's own line.
  it("says a failure broke rather than that a turn ended", () => {
    expect(attentionTip("failed", "Done")).toBe(
      "the agent stopped because something broke, not because it finished"
    );
  });
});

describe("railMoveAllEntries", () => {
  const r = rail("r1", [[["t1", "/x/a.md"]], [["t2", "/x/b.md"], ["t3", "/x/c.md"]]]);
  const cards = cardIndex(
    tree([
      plan("a.md", { path: "/x/a.md", status: "To Do" }),
      plan("b.md", { path: "/x/b.md", status: "Done" }),
      plan("c.md", { path: "/x/c.md", status: "To Do" }),
    ])
  );
  const columns = [
    { name: "Done", position: 2 },
    { name: "To Do", position: 0 },
    { name: "In Progress", position: 1 },
  ];

  // The menu is the board's own left-to-right order, whatever order the
  // columns arrived in.
  it("lists the columns by position, not by array order", () => {
    expect(railMoveAllEntries(r, cards, columns).map((e) => e.columnName)).toEqual([
      "To Do",
      "In Progress",
      "Done",
    ]);
  });

  it("counts only the cards the pick would actually rewrite", () => {
    const byName = new Map(railMoveAllEntries(r, cards, columns).map((e) => [e.columnName, e]));
    expect(byName.get("Done")?.label).toBe("Move 2 cards to Done");
    expect(byName.get("To Do")?.label).toBe("Move 1 card to To Do");
    expect(byName.get("In Progress")?.label).toBe("Move 3 cards to In Progress");
  });

  // A column every card is already in is marked and dead, exactly as a
  // card's own current column is in its menu.
  it("is dead for a column every card already sits in", () => {
    const settled = cardIndex(
      tree([
        plan("a.md", { path: "/x/a.md", status: "Done" }),
        plan("b.md", { path: "/x/b.md", status: "Done" }),
        plan("c.md", { path: "/x/c.md", status: "Done" }),
      ])
    );
    const entry = railMoveAllEntries(r, settled, columns).find((e) => e.columnName === "Done");
    expect(entry).toEqual({ columnName: "Done", count: 0, label: "All cards are in Done", dead: true });
  });
});

describe("finishedRailDoneCards", () => {
  const rails = [rail("r1", [[["t1", "/x/a.md"], ["t2", "/x/b.md"]]]), rail("r2", [[["t3", "/x/a.md"]]])];
  const view = (status: string | null) => ({ status });
  const resolve = (map: Record<string, string | null>) => (path: string) =>
    path in map ? view(map[path]) : undefined;

  it("takes the cards the board itself calls Done, deduplicated across rails", () => {
    const got = finishedRailDoneCards(rails, resolve({ "/x/a.md": "Done", "/x/b.md": "To Do" }), "Done");
    expect(got).toEqual([view("Done")]);
  });

  it("compares by slug, not by spelling", () => {
    expect(finishedRailDoneCards(rails, resolve({ "/x/a.md": "done" }), "Done")).toHaveLength(1);
  });

  // The board draws a statusless card in the first column, but the file
  // does not say so -- archiving on the strength of where it was drawn
  // would file a card nobody finished.
  it("never archives a card with no status", () => {
    expect(finishedRailDoneCards(rails, resolve({ "/x/a.md": null }), "Done")).toEqual([]);
  });

  // Nothing to archive, and a missing card must not stop the rails
  // leaving.
  it("skips a card whose file is gone", () => {
    expect(finishedRailDoneCards(rails, resolve({}), "Done")).toEqual([]);
  });

  // No board, or a board with no done column: archive nothing rather
  // than everything.
  it("archives nothing when there is no done column", () => {
    expect(finishedRailDoneCards(rails, resolve({ "/x/a.md": "Done" }), null)).toEqual([]);
  });
});

describe("conflictSummaryLines", () => {
  const orch: Orchestration = orchOf([
    {
      ...bound("r1", "/x/wt-a", [[["t1", A]]]),
      stages: [
        {
          id: "r1-s0",
          position: 0,
          steps: [
            { id: "t1", position: 0, cardPath: A },
            { id: "t2", position: 1, cardPath: "", toolId: "builtin:push", toolParams: {} },
          ],
        },
      ],
    },
  ]);

  // The numbers are the badges' numbers: the human reading "1." on a
  // chip and the agent reading "1." in its brief are looking at one list.
  it("numbers each line to match the badge on the rail", () => {
    const numbered = numberConflicts(detectConflicts(orch, CARDS, WT));
    const lines = conflictSummaryLines(numbered, cardIndex(CARDS), orch, TOOLS);
    expect(lines).toHaveLength(numbered.length);
    lines.forEach((line, i) => expect(line.startsWith(`${i + 1}. `)).toBe(true));
  });

  // The header's Organize hands over every conflict and a rail's
  // Reorganize hands over conflictsForRail's subset -- one spelling, so
  // the two briefs cannot disagree about what a conflict is called.
  it("says the same thing describeConflict says, minus the number", () => {
    const numbered = numberConflicts(detectConflicts(orch, CARDS, WT));
    const line = conflictSummaryLines(numbered, cardIndex(CARDS), orch, TOOLS)[0];
    expect(line).toBe(`1. ${describeConflict(numbered[0].conflict, cardIndex(CARDS), orch, TOOLS)}`);
  });

  it("is empty when there is nothing to report", () => {
    expect(conflictSummaryLines([], cardIndex(CARDS), orch, TOOLS)).toEqual([]);
  });
});

// The TypeSafe turn verdict: a second opinion on what an agent's quiet
// turn came to, and the one input that can take a completion BACK. Every
// rule above is today's answer and is unchanged; an absent map is the
// scheduler that shipped before any of this existed.
describe("nextActions — an agent tool step's turn, second-guessed", () => {
  const agentRail = toolRail("r1", [[["t1", "builtin:commit"]]]);
  const runs: Orchestration["stepRuns"] = [
    { stepId: "t1", state: "running", sessionId: "s1", reason: null },
  ];
  const live = new Set(["s1"]);
  const idle = new Map([["s1", "idle" as const]]);
  const worked = new Set(["s1"]);
  const read = (reading: TurnReading | null): TurnVerdictEntry => ({ state: "read", reading });
  const verdict = (entry: TurnVerdictEntry) => new Map([["s1", entry]]);
  const actions = (orch: Orchestration, verdicts: ReadonlyMap<string, TurnVerdictEntry>) =>
    nextActions(
      orch, BOARD, CARDS, [], live, TOOLS, new Map(), idle, new Set(), new Map(), {}, 0, worked,
      new Map(), verdicts
    );
  const done = [{ kind: "markDone", stepId: "t1" }, { kind: "complete", railId: "r1" }];

  it("completes exactly as before when no verdict was taken", () => {
    expect(actions(running(agentRail, "r1-s0", runs), new Map())).toEqual(done);
  });

  it("holds the step while the verdict is pending", () => {
    // "Waits for the verdict (or its timeout)". Without this the request
    // and the rail's next step race, and the rail wins every time.
    expect(actions(running(agentRail, "r1-s0", runs), verdict({ state: "pending" }))).toEqual([]);
  });

  it("holds the step on a turn read as asking, working or failed", () => {
    // The prose question, the retry countdown, and the cut-off turn: all
    // three are `idle` to the daemon and none is a finished turn.
    for (const reading of [
      { kind: "asking" } as const,
      { kind: "working" } as const,
      { kind: "failed", cause: "network" } as const,
    ]) {
      expect(actions(running(agentRail, "r1-s0", runs), verdict(read(reading)))).toEqual([]);
    }
  });

  it("completes on finished, and on a verdict with no opinion", () => {
    // Null is today's answer -- a timeout, a refused key, a low
    // confidence -- and today's answer is that the turn ended.
    expect(actions(running(agentRail, "r1-s0", runs), verdict(read({ kind: "finished" })))).toEqual(done);
    expect(actions(running(agentRail, "r1-s0", runs), verdict(read(null)))).toEqual(done);
  });

  it("stalls a blocked turn with the agent's own sentence", () => {
    // The agent gave up and said why. Nothing broke and nothing was
    // killed, so the recovery is to read what it said -- not to resume,
    // which would walk it into the same wall.
    const blocked = read({ kind: "blocked", said: "the migration file is missing" });
    expect(actions(running(agentRail, "r1-s0", runs), verdict(blocked))).toEqual([
      {
        kind: "stall",
        stepId: "t1",
        reason: "the agent stopped without finishing — the migration file is missing",
      },
    ]);
  });

  it("the reconciliation pass honours the verdict too", () => {
    // A step left `running` on a paused rail is corrected by the same
    // rule, and the rule reads the same map.
    const paused: Orchestration = {
      rails: [agentRail],
      conflictNotes: [],
      railRuns: [{ railId: "r1", state: "paused", currentStageId: null }],
      stepRuns: runs,
    };
    expect(actions(paused, verdict({ state: "pending" }))).toEqual([]);
    expect(actions(paused, verdict(read({ kind: "asking" })))).toEqual([]);
    expect(actions(paused, verdict(read({ kind: "finished" })))).toEqual([{ kind: "markDone", stepId: "t1" }]);
  });

  it("never stalls a CARD step on a verdict: its column is its rule", () => {
    // A card step is done when its card reaches the done column and
    // stalls when its session dies -- rule 1 and rule 3 own it, and a
    // second opinion on its agent's prose has no rule to change.
    const cardRail = rail("r1", [[["t1", A]]]);
    const blocked = read({ kind: "blocked", said: "no" });
    expect(actions(running(cardRail, "r1-s0", runs), verdict(blocked))).toEqual([]);
    expect(actions(running(cardRail, "r1-s0", runs), verdict(read({ kind: "asking" })))).toEqual([]);
  });
});

describe("stepAttentions — the turn verdict", () => {
  const cardRail = rail("r1", [[["t1", A]]]);
  const agentRail = toolRail("r1", [[["t1", "builtin:commit"]]]);
  const runs: Orchestration["stepRuns"] = [
    { stepId: "t1", state: "running", sessionId: "s1", reason: null },
  ];
  const statuses = (s: SessionStatus) => new Map([["s1", s]]);
  const read = (reading: TurnReading | null): TurnVerdictEntry => ({ state: "read", reading });
  const attn = (orch: Orchestration, s: Map<string, SessionStatus>, entry?: TurnVerdictEntry) =>
    stepAttentions(
      orch, BOARD, CARDS, TOOLS, s, new Set(), new Map(), 0,
      entry ? new Map([["s1", entry]]) : new Map()
    );

  it("marks an idle card step `asking` when the verdict read a question", () => {
    // Today's mark is `turn-ended`: "stopped without finishing", about an
    // agent that is waiting for an answer. Both say the rail is not
    // moving; only this one tells the human it is their move.
    const orch = running(cardRail, "r1-s0", runs);
    expect(attn(orch, statuses("idle")).get("t1")).toBe("turn-ended");
    expect(attn(orch, statuses("idle"), read({ kind: "asking" })).get("t1")).toBe("asking");
  });

  it("marks an idle agent tool step `asking` too, which no other mark covers", () => {
    // `turn-ended` skips tool steps because agentTurnEnded marks them
    // done on the same tick -- and now declines to, which would leave
    // the step running with no mark at all.
    const orch = running(agentRail, "r1-s0", runs);
    expect(attn(orch, statuses("idle")).get("t1")).toBeUndefined();
    expect(attn(orch, statuses("idle"), read({ kind: "asking" })).get("t1")).toBe("asking");
  });

  it("leaves the mark alone while the verdict is pending or read as anything else", () => {
    const orch = running(cardRail, "r1-s0", runs);
    expect(attn(orch, statuses("idle"), { state: "pending" }).get("t1")).toBe("turn-ended");
    expect(attn(orch, statuses("idle"), read(null)).get("t1")).toBe("turn-ended");
    expect(attn(orch, statuses("idle"), read({ kind: "finished" })).get("t1")).toBe("turn-ended");
    expect(attn(running(agentRail, "r1-s0", runs), statuses("idle"), { state: "pending" }).get("t1")).toBeUndefined();
  });

  it("a failed session still outranks the verdict", () => {
    const orch = running(cardRail, "r1-s0", runs);
    expect(attn(orch, statuses("failed"), read({ kind: "asking" })).get("t1")).toBe("failed");
  });

  it("only speaks about an IDLE session: a stale entry on a working one is ignored", () => {
    const orch = running(cardRail, "r1-s0", runs);
    expect(attn(orch, statuses("working"), read({ kind: "asking" })).get("t1")).toBeUndefined();
  });
});
