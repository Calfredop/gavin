import { describe, it, expect } from "vitest";
import {
  emptyOrchestration,
  doneColumn,
  cardIndex,
  effectiveWorktree,
  stepStateOf,
  railStateOf,
  firstUnfinishedStageId,
  nextActions,
  addRail,
  renameRail,
  bindRail,
  deleteRail,
  addStage,
  addStep,
  removeStep,
  detectConflicts,
  numberConflicts,
  numbersForStep,
  numbersForRail,
  severityForStep,
  moveStepToNewStage,
  moveStepIntoStage,
  splitStageIntoSequence,
  groupUnplacedByStatus,
  availableCards,
  unplacedCount,
  addCardAsStage,
  describeConflict,
  isToolStep,
  stepParams,
  addToolStep,
  addToolAsStage,
  setStepParams,
  conflictStepIds,
  findCardPlacement,
  cardRailBadge,
  sendCardToRail,
  findStep,
  railCardPaths,
  railCardsToMove,
  railDoneStepIds,
  removeSteps,
  effectiveStatus,
  planIndex,
  dropImpossibleSteps,
  isStageRunning,
  runningStageId,
} from "./orchestration";
import type { CardEntry, Conflict, ToolSummary, UnplacedGroup } from "./orchestration";
import type { WorktreeInfo } from "./git";
import type { Action, Orchestration, Rail, RailState, Step, StepState } from "./orchestration";
import type { Board } from "./kanban";
import type { GavinTree, PlanFileInfo } from "./gavin";

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
    expect(actions).toContainEqual({ kind: "stall", stepId: "t1", reason: "card file is missing" });
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
    o = addStep(addStage(o, "r1", "s1"), "s1", "t1", "/x/a.md");
    o = { ...o, conflictNotes: [{ id: "n1", stepIds: ["t1"], note: "careful" }] };
    o = deleteRail(o, "r1");
    expect(o.rails.map((r) => [r.id, r.position])).toEqual([["r2", 0]]);
    expect(o.conflictNotes).toEqual([]);
  });

  it("adds stages in order and steps within a stage in order", () => {
    let o = addRail(emptyOrchestration(), "r1", "backend");
    o = addStage(o, "r1", "s1");
    o = addStage(o, "r1", "s2");
    o = addStep(o, "s1", "t1", "/x/a.md");
    o = addStep(o, "s1", "t2", "/x/b.md");
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
    let o = addStep(addStage(addRail(emptyOrchestration(), "r1", "backend"), "r1", "s1"), "s1", "t1", "/x/a.md");
    o = addStep(o, "s1", "t2", "/x/b.md");
    o = removeStep(o, "t1");
    expect(o.rails[0].stages[0].steps.map((t) => [t.id, t.position])).toEqual([["t2", 0]]);
    o = removeStep(o, "t2");
    expect(o.rails[0].stages).toEqual([]);
  });

  it("drops run state and notes for a removed step", () => {
    let o = addStep(addStage(addRail(emptyOrchestration(), "r1", "backend"), "r1", "s1"), "s1", "t1", "/x/a.md");
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
});

function built(): Orchestration {
  // r1: [t1] [t2, t3]   r2: [t4]
  let o = addRail(addRail(emptyOrchestration(), "r1", "backend"), "r2", "ui");
  o = addStage(o, "r1", "s1");
  o = addStep(o, "s1", "t1", "/x/a.md");
  o = addStage(o, "r1", "s2");
  o = addStep(o, "s2", "t2", "/x/b.md");
  o = addStep(o, "s2", "t3", "/x/c.md");
  o = addStage(o, "r2", "s3");
  o = addStep(o, "s3", "t4", "/x/d.md");
  return o;
}

const stageMap = (o: Orchestration) =>
  o.rails.map((r) => [r.id, r.stages.map((s) => s.steps.map((t) => t.id))]);

describe("moveStepIntoStage", () => {
  it("makes a step parallel with an existing stage's steps", () => {
    const o = moveStepIntoStage(built(), "t1", "s2");
    expect(stageMap(o)).toEqual([
      ["r1", [["t2", "t3", "t1"]]],
      ["r2", [["t4"]]],
    ]);
  });

  it("moves across rails, which changes the step's effective worktree", () => {
    const o = moveStepIntoStage(built(), "t4", "s1");
    expect(stageMap(o)).toEqual([
      ["r1", [["t1", "t4"], ["t2", "t3"]]],
      ["r2", []],
    ]);
  });

  it("is a no-op when the step is already in that stage", () => {
    const before = built();
    expect(stageMap(moveStepIntoStage(before, "t2", "s2"))).toEqual(stageMap(before));
  });

  it("renumbers positions after the move", () => {
    const o = moveStepIntoStage(built(), "t1", "s2");
    expect(o.rails[0].stages[0].steps.map((t) => t.position)).toEqual([0, 1, 2]);
    expect(o.rails[0].stages.map((s) => s.position)).toEqual([0]);
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
  { id: "builtin:push", name: "Push branch" },
  { id: "builtin:notify", name: "Send a notification" },
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
  it("addToolStep joins an existing stage — the parallel drop", () => {
    const o = orchOf([rail("r1", [[["t1", A]]])]);
    const after = addToolStep(o, "r1-s0", "t2", "builtin:push");
    expect(after.rails[0].stages).toHaveLength(1);
    expect(after.rails[0].stages[0].steps.map((s) => s.toolId ?? s.cardPath)).toEqual([
      A,
      "builtin:push",
    ]);
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
    const after = moveStepIntoStage(o, "t2", "r1-s0");
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
    let o = addStep(addStage(addRail(emptyOrchestration(), "r1", "backend"), "r1", "s1"), "s1", "t1", "/x/a.md");
    o = addStep(o, "s1", "t2", "/x/b.md");
    o = addStep(o, "s1", "t3", "/x/c.md");
    o = removeSteps(o, ["t1", "t3"]);
    expect(o.rails[0].stages[0].steps.map((t) => [t.id, t.position])).toEqual([["t2", 0]]);
  });

  it("drops every stage it empties and renumbers the rest", () => {
    let o = addStep(addStage(addRail(emptyOrchestration(), "r1", "backend"), "r1", "s1"), "s1", "t1", "/x/a.md");
    o = addStep(addStage(o, "r1", "s2"), "s2", "t2", "/x/b.md");
    o = addStep(addStage(o, "r1", "s3"), "s3", "t3", "/x/c.md");
    o = removeSteps(o, ["t1", "t2"]);
    expect(o.rails[0].stages.map((s) => [s.id, s.position])).toEqual([["s3", 0]]);
  });

  it("drops run state and notes for every step it removed", () => {
    let o = addStep(addStage(addRail(emptyOrchestration(), "r1", "backend"), "r1", "s1"), "s1", "t1", "/x/a.md");
    o = addStep(o, "s1", "t2", "/x/b.md");
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
    const o = addStep(addStage(addRail(emptyOrchestration(), "r1", "backend"), "r1", "s1"), "s1", "t1", "/x/a.md");
    expect(removeSteps(o, [])).toEqual(o);
  });
});
