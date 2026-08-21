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
} from "./orchestration";
import type { Conflict } from "./orchestration";
import type { WorktreeInfo } from "./git";
import type { Action, Orchestration, Rail } from "./orchestration";
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
