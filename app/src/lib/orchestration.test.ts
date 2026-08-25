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
  stageMode,
  isGroup,
  findStage,
  setStageMode,
  renameStage,
  moveStageToIndex,
  removeStage,
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
  railDoneStepIds,
  removeSteps,
  effectiveStatus,
  planIndex,
  dropImpossibleSteps,
  isStageRunning,
  runningStageId,
  stepAttentions,
  railAttention,
  railsWantingAttention,
  attentionTip,
} from "./orchestration";
import type { CardEntry, Conflict, StepAttention, ToolSummary, UnplacedGroup } from "./orchestration";
import { BUILTIN_TOOLS } from "./orchestrationTools";
import type { WorktreeInfo } from "./git";
import type { Action, Orchestration, Rail, RailState, Stage, StageMode, Step, StepState } from "./orchestration";
import type { Board } from "./kanban";
import type { SessionStatus } from "./notifications";
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
  { id: "builtin:notify", name: "Send a notification", kind: "command" },
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
      armed(runs), BOARD, CARDS, [], live, TOOLS, new Map(), new Map([["s1", "idle" as const]])
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
      nextActions(orch, BOARD, CARDS, [], live, TOOLS, new Map(), new Map([["s1", "idle" as const]]))
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
          new Map(), new Map([["s1", "idle" as const]])
        );
        expect(actions).toContainEqual({ kind: "markDone", stepId: "t1" });
      });
    } else {
      // Its session really does exit, and the code is the whole verdict.
      it(`${tool.id} finishes when its session exits 0`, () => {
        const actions = nextActions(
          armed(tool.id), BOARD, CARDS, [], new Set(), summary, new Map([["s1", 0]])
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

  it("collects the rails with any marked step", () => {
    const orch: Orchestration = {
      ...emptyOrchestration(),
      rails: [rail("r1", [[["t1", A]]]), rail("r2", [[["t2", B]]])],
    };
    expect(railsWantingAttention(orch, marks({ t2: "asking" }))).toEqual(new Set(["r2"]));
    expect(railsWantingAttention(orch, marks({}))).toEqual(new Set());
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
});
