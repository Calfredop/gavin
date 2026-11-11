// Orchestrated plans (v80, ADR 0012, ADR 0014): a plan with Nested tasks
// runs each as its own session before the plan's own -- one at a time
// unless its `children:` line says `parallel`. The rules
// live in orchestration.ts beside the scheduler they extend; this file is
// theirs alone, so the two thousand lines of nextActions tests above them
// stay about every other step.
import { describe, it, expect } from "vitest";
import {
  CHILD_ENDED_UNTICKED,
  childTicked,
  childrenModeOf,
  detectConflicts,
  emptyOrchestration,
  failedStepReason,
  nestedStallReason,
  nextActions,
  orchestratedChildren,
  orchestratedChildrenLeft,
  orchestratedRunTarget,
  placedCardPaths,
  pressGoesToRail,
  runsAsOrchestratedPlan,
  cardIndex,
  stepAttentions,
  STALE_AFTER_MS,
} from "$lib/orchestration/orchestration";
import type { Action, NestedRun, Orchestration, Rail, StepState } from "$lib/orchestration/orchestration";
import type { Board } from "$lib/board/kanban";
import type { SessionStatus } from "$lib/core/notifications";
import type { ChecklistLink, GavinTree, PlanFileInfo } from "$lib/core/gavin";

const DIR = "/ws/.gavin-root/plans";
const BIG = `${DIR}/big.md`;
const ONE = `${DIR}/one.md`;
const TWO = `${DIR}/two.md`;

function board(): Board {
  return {
    columns: ["To Do", "In Progress", "Done"].map((name, i) => ({ id: `c${i}`, name, position: i })),
    labels: [],
    cardSessions: [],
  };
}

function card(fileName: string, overrides: Partial<PlanFileInfo> = {}): PlanFileInfo {
  return {
    path: `${DIR}/${fileName}`,
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

/// The plan and its two Nested tasks. `ticked` names the children whose
/// line is ticked; every child has a line unless `noLines`.
function tree(
  plan: Partial<PlanFileInfo> = {},
  ticked: string[] = [],
  extra: PlanFileInfo[] = []
): GavinTree {
  const links: ChecklistLink[] = ["one.md", "two.md"].map((fileName) => ({
    fileName,
    done: ticked.includes(fileName),
  }));
  return {
    rootPath: "/ws",
    rootMissing: false,
    contexts: [
      {
        folderPath: "/ws/.gavin-root",
        kind: "root",
        name: "ws",
        plans: [
          card("big.md", {
            kind: "plan",
            status: "In Progress",
            children: "sequence",
            checklistLinks: links,
            ...plan,
          }),
          card("one.md", { parent: "big.md" }),
          card("two.md", { parent: "big.md" }),
          ...extra,
        ],
        docs: [],
        specs: [],
        hasPrd: true,
        configWarning: false,
      },
    ],
  };
}

function rail(id: string, steps: Array<[string, string]>): Rail {
  return {
    id,
    name: id,
    position: 0,
    worktreePath: null,
    pageId: null,
    stages: [{ id: `${id}-s0`, position: 0, steps: steps.map(([sid, path], i) => ({ id: sid, position: i, cardPath: path })) }],
  };
}

/// One running rail holding the plan as step `t1`, in state `step`.
function orch(
  step: StepState,
  opts: {
    sessionId?: string | null;
    nested?: NestedRun[];
    rails?: Rail[];
    railState?: "running" | "paused" | "idle";
  } = {}
): Orchestration {
  return {
    ...emptyOrchestration(),
    rails: [rail("r1", [["t1", BIG]]), ...(opts.rails ?? [])],
    railRuns: [{ railId: "r1", state: opts.railState ?? "running", currentStageId: "r1-s0" }],
    stepRuns: [{ stepId: "t1", state: step, sessionId: opts.sessionId ?? null, reason: null }],
    nestedRuns: opts.nested ?? [],
  };
}

function nested(childPath: string, state: NestedRun["state"], sessionId: string | null): NestedRun {
  return { stepId: "t1", childPath, state, sessionId, reason: null };
}

function decide(
  o: Orchestration,
  t: GavinTree,
  live: string[] = [],
  failures: Record<string, string> = {},
  interrupted: string[] = []
): Action[] {
  return nextActions(
    o,
    board(),
    t,
    null,
    new Set(live),
    [],
    new Map(),
    new Map(),
    new Set(interrupted),
    new Map(Object.entries(failures))
  );
}

/// The plan alone, its Nested tasks gone.
function childless(plan: Partial<PlanFileInfo> = {}): GavinTree {
  const t = tree(plan);
  return { ...t, contexts: [{ ...t.contexts[0], plans: [t.contexts[0].plans[0]] }] };
}

describe("childrenModeOf", () => {
  it("is the line when the plan has one, and sequence for a plan with Nested tasks and no line", () => {
    expect(childrenModeOf({ kind: "plan", children: "parallel" }, 2)).toBe("parallel");
    expect(childrenModeOf({ kind: "plan", children: null }, 2)).toBe("sequence");
    expect(childrenModeOf({ kind: "plan" }, 1)).toBe("sequence");
  });

  it("is null for a plan with nothing nested and no line, and for every task", () => {
    expect(childrenModeOf({ kind: "plan", children: null }, 0)).toBeNull();
    expect(childrenModeOf({ kind: "task", children: "sequence" }, 2)).toBeNull();
  });

  it("keeps a line on a plan whose children have all gone, which then has nothing to run", () => {
    expect(childrenModeOf({ kind: "plan", children: "sequence" }, 0)).toBe("sequence");
  });
});

describe("an Orchestrated plan's step reached by its rail", () => {
  it("launches a plan with nothing nested and no line exactly as it always did", () => {
    expect(decide(orch("pending"), childless({ children: null }))).toEqual([{ kind: "launch", stepId: "t1" }]);
  });

  it("begins the children phase of a plan with Nested tasks and no `children:` line", () => {
    expect(decide(orch("pending"), tree({ children: null }))).toEqual([
      { kind: "beginChildren", stepId: "t1", fresh: true },
    ]);
  });

  it("begins its children phase, forgetting the last pass, when it starts from pending", () => {
    expect(decide(orch("pending"), tree())).toEqual([{ kind: "beginChildren", stepId: "t1", fresh: true }]);
  });

  it("begins it keeping the stalled child's run when it is a stalled step being retried", () => {
    expect(decide(orch("stalled"), tree())).toEqual([{ kind: "beginChildren", stepId: "t1", fresh: false }]);
  });

  it("launches the plan's own session straight away when every child is already ticked", () => {
    expect(decide(orch("pending"), tree({}, ["one.md", "two.md"]))).toEqual([{ kind: "launch", stepId: "t1" }]);
  });

  it("is done on sight when the plan reached the done column, children or not", () => {
    const actions = decide(orch("pending"), tree({ status: "Done" }));
    expect(actions).toContainEqual({ kind: "markDone", stepId: "t1" });
    expect(actions.some((a) => a.kind === "beginChildren" || a.kind === "launchChild")).toBe(false);
  });
});

describe("the children phase", () => {
  it("launches only the first unticked child in tree order under `sequence`", () => {
    expect(decide(orch("running"), tree())).toEqual([
      { kind: "launchChild", stepId: "t1", childPath: ONE, resume: false },
    ]);
  });

  it("never relaunches a ticked child", () => {
    const actions = decide(orch("running"), tree({}, ["one.md"]));
    expect(actions).toEqual([{ kind: "launchChild", stepId: "t1", childPath: TWO, resume: false }]);
  });

  it("launches every unticked child at once under `parallel`", () => {
    expect(decide(orch("running"), tree({ children: "parallel" }))).toEqual([
      { kind: "launchChild", stepId: "t1", childPath: ONE, resume: false },
      { kind: "launchChild", stepId: "t1", childPath: TWO, resume: false },
    ]);
  });

  it("skips a child placed as a step of its own on any rail", () => {
    const o = orch("running", { rails: [rail("r2", [["t9", TWO]])] });
    const actions = decide(o, tree({ children: "parallel" }));
    expect(actions.filter((a) => a.kind === "launchChild")).toEqual([
      { kind: "launchChild", stepId: "t1", childPath: ONE, resume: false },
    ]);
    // And with the other one ticked, there is nothing left but the plan.
    expect(decide(o, tree({ children: "parallel" }, ["one.md"])).filter((a) => "stepId" in a && a.stepId === "t1")).toEqual([
      { kind: "launch", stepId: "t1" },
    ]);
  });

  it("waits on a running child with a live session, and holds the next one in a sequence", () => {
    expect(decide(orch("running", { nested: [nested(ONE, "running", "s1")] }), tree(), ["s1"])).toEqual([]);
  });

  it("stalls the step, naming the child, when the child's session ended without its tick", () => {
    const actions = decide(orch("running", { nested: [nested(ONE, "running", "s1")] }), tree());
    expect(actions).toEqual([{ kind: "stallChild", stepId: "t1", childPath: ONE, reason: CHILD_ENDED_UNTICKED }]);
  });

  it("stalls on a child whose agent broke, with the agent's own sentence", () => {
    const o = orch("running", { nested: [nested(ONE, "running", "s1")] });
    expect(decide(o, tree(), ["s1"], { s1: "API Error: 529" })).toEqual([
      { kind: "stallChild", stepId: "t1", childPath: ONE, reason: failedStepReason("API Error: 529") },
    ]);
  });

  it("stalls on a child the daemon restart interrupted", () => {
    const o = orch("running", { nested: [nested(ONE, "running", "s1")] });
    const [action] = decide(o, tree(), ["s1"], {}, ["s1"]);
    expect(action).toMatchObject({ kind: "stallChild", childPath: ONE });
    expect((action as { reason: string }).reason).toContain("interrupted");
  });

  it("reopens a stalled child once the step runs again", () => {
    const o = orch("running", { nested: [nested(ONE, "stalled", "s1")] });
    expect(decide(o, tree())).toEqual([{ kind: "launchChild", stepId: "t1", childPath: ONE, resume: true }]);
  });

  it("launches again a child whose run finished but whose line was unticked since", () => {
    const o = orch("running", { nested: [nested(ONE, "done", "s1")] });
    expect(decide(o, tree())).toEqual([{ kind: "launchChild", stepId: "t1", childPath: ONE, resume: false }]);
  });

  it("files each ticked child's run done and then launches the plan's own session", () => {
    const o = orch("running", { nested: [nested(ONE, "done", "s1"), nested(TWO, "running", "s2")] });
    expect(decide(o, tree({}, ["one.md", "two.md"]), ["s2"])).toEqual([
      { kind: "childDone", stepId: "t1", childPath: TWO },
      { kind: "launch", stepId: "t1" },
    ]);
  });

  it("leaves a step whose plan session is running to the ordinary rules", () => {
    const o = orch("running", { sessionId: "p1" });
    expect(decide(o, tree({}, ["one.md", "two.md"]), ["p1"])).toEqual([]);
    // ...and a plan session that died stalls the step as any card's does.
    expect(decide(o, tree({}, ["one.md", "two.md"]))).toEqual([
      expect.objectContaining({ kind: "stall", stepId: "t1" }),
    ]);
  });

  it("runs on, one at a time, when a plan's `children:` line is taken away mid-phase", () => {
    expect(decide(orch("running"), tree({ children: null }))).toEqual([
      { kind: "launchChild", stepId: "t1", childPath: ONE, resume: false },
    ]);
  });

  it("gives a plan whose Nested tasks all left mid-phase its own session", () => {
    expect(decide(orch("running"), childless({ children: null }))).toEqual([{ kind: "launch", stepId: "t1" }]);
  });

  it("never names a Nested task as a step of its own -- the child stays nested throughout", () => {
    const scenarios: Array<[Orchestration, GavinTree, string[]]> = [
      [orch("pending"), tree(), []],
      [orch("running"), tree({ children: "parallel" }), []],
      [orch("running", { nested: [nested(ONE, "running", "s1")] }), tree(), []],
      [orch("running", { nested: [nested(ONE, "stalled", "s1")] }), tree(), []],
      [orch("running"), tree({}, ["one.md", "two.md"]), []],
    ];
    for (const [o, t, live] of scenarios) {
      for (const action of decide(o, t, live)) {
        if ("stepId" in action) expect(action.stepId).toBe("t1");
        if (action.kind === "markDone" || action.kind === "launch") expect(action.stepId).not.toBe(ONE);
      }
    }
  });
});

describe("the children phase on a rail that is not advancing", () => {
  it("stalls a dead child and launches nothing", () => {
    const o = orch("running", { railState: "paused", nested: [nested(ONE, "running", "s1")] });
    expect(decide(o, tree({ children: "parallel" }))).toEqual([
      { kind: "stallChild", stepId: "t1", childPath: ONE, reason: CHILD_ENDED_UNTICKED },
    ]);
  });

  it("leaves a live child working and never launches the plan", () => {
    const o = orch("running", { railState: "paused", nested: [nested(ONE, "running", "s1")] });
    expect(decide(o, tree(), ["s1"])).toEqual([]);
    expect(decide(orch("running", { railState: "paused" }), tree({}, ["one.md", "two.md"]))).toEqual([]);
  });
});

describe("childTicked", () => {
  it("is every line naming the child ticked, and no line at all is not finished", () => {
    const one = card("one.md", { parent: "big.md" });
    const plan = (links: ChecklistLink[]) => card("big.md", { kind: "plan", checklistLinks: links });
    expect(childTicked(plan([{ fileName: "one.md", done: true }]), one)).toBe(true);
    expect(childTicked(plan([]), one)).toBe(false);
    expect(childTicked(plan([{ fileName: "one.md", done: true }, { fileName: "one.md", done: false }]), one)).toBe(
      false
    );
  });
});

describe("orchestratedChildren", () => {
  it("is null for a plan with nothing nested and no line, and for a task", () => {
    const step = { id: "t1", position: 0, cardPath: BIG };
    expect(orchestratedChildren(step, cardIndex(childless({ children: null })), new Set())).toBeNull();
    expect(orchestratedChildren({ ...step, cardPath: ONE }, cardIndex(tree()), new Set())).toBeNull();
  });

  it("runs a plan's Nested tasks in sequence when it carries no line", () => {
    const step = { id: "t1", position: 0, cardPath: BIG };
    const pc = orchestratedChildren(step, cardIndex(tree({ children: null })), new Set());
    expect(pc?.mode).toBe("sequence");
    expect(pc?.children.map((c) => c.plan.path)).toEqual([ONE, TWO]);
  });

  it("lists the plan's nested tasks in tree order, leaving out a placed one and a free-standing one", () => {
    const free = card("three.md", { parent: "big.md", status: "To Do" });
    const step = { id: "t1", position: 0, cardPath: BIG };
    const pc = orchestratedChildren(step, cardIndex(tree({}, [], [free])), new Set([TWO]));
    expect(pc?.mode).toBe("sequence");
    expect(pc?.children.map((c) => c.plan.path)).toEqual([ONE]);
  });

  it("collects placed card paths from every rail", () => {
    const o = orch("running", { rails: [rail("r2", [["t9", TWO]])] });
    expect(placedCardPaths(o)).toEqual(new Set([BIG, TWO]));
  });
});

describe("nested-with-parent under an Orchestrated plan", () => {
  it("is live, line or not, because the plan would otherwise run the child too", () => {
    const o = { ...emptyOrchestration(), rails: [rail("r1", [["t1", BIG]]), rail("r2", [["t2", ONE]])] };
    const nestedConflict = (t: GavinTree) => detectConflicts(o, t, null).find((c) => c.kind === "nested-with-parent");
    expect(nestedConflict(tree())?.severity).toBe("live");
    expect(nestedConflict(tree({ children: null }))?.severity).toBe("live");
  });
});

describe("the shared checkout of parallel children", () => {
  const steps = (o: Orchestration, t: GavinTree) =>
    detectConflicts(o, t, null).filter((c) => c.kind === "same-worktree" && c.scope === "children");

  it("is warned about while two or more are left to run, and live once two run", () => {
    expect(steps(orch("pending"), tree({ children: "parallel" }))).toEqual([
      {
        kind: "same-worktree",
        scope: "children",
        stageId: null,
        severity: "potential",
        stepIds: ["t1"],
        worktreePath: "/ws",
      },
    ]);
    const running = orch("running", { nested: [nested(ONE, "running", "s1"), nested(TWO, "running", "s2")] });
    expect(steps(running, tree({ children: "parallel" }))[0]?.severity).toBe("live");
  });

  it("is not raised for a sequence, nor once only one child is left", () => {
    expect(steps(orch("pending"), tree())).toEqual([]);
    expect(steps(orch("pending"), tree({ children: "parallel" }, ["one.md"]))).toEqual([]);
  });
});

describe("stepAttentions in the children phase", () => {
  function marks(statuses: Record<string, SessionStatus>, since: Record<string, number> = {}, now = 1_000) {
    const o = orch("running", { nested: [nested(ONE, "running", "s1")] });
    return stepAttentions(
      o,
      board(),
      tree(),
      [],
      new Map(Object.entries(statuses)),
      new Set(),
      new Map(Object.entries(since)),
      now
    ).get("t1");
  }

  it("wears its running child's mark, since the step has no session of its own", () => {
    expect(marks({ s1: "working" })).toBeUndefined();
    expect(marks({ s1: "waiting_for_input" })).toBe("asking");
    expect(marks({ s1: "failed" })).toBe("failed");
  });

  it("says a child whose turn ended without its tick has stopped, and goes stale with time", () => {
    expect(marks({ s1: "idle" }, { s1: 0 }, 1_000)).toBe("turn-ended");
    expect(marks({ s1: "idle" }, { s1: 0 }, STALE_AFTER_MS + 1)).toBe("stale");
  });
});

describe("the board's Run on an Orchestrated plan", () => {
  it("runs as one whenever it has children to run, line or not", () => {
    const cards = cardIndex(tree());
    expect(runsAsOrchestratedPlan(cards.get(BIG)!, cards)).toBe(true);
    const noLine = cardIndex(tree({ children: null }));
    expect(runsAsOrchestratedPlan(noLine.get(BIG)!, noLine)).toBe(true);
    const alone = cardIndex(childless());
    expect(runsAsOrchestratedPlan(alone.get(BIG)!, alone)).toBe(false);
    expect(runsAsOrchestratedPlan(cards.get(ONE)!, cards)).toBe(false);
  });

  it("leaves the plan to its rail while a Nested task's line is unticked", () => {
    const fresh = cardIndex(tree({ children: null }));
    expect(orchestratedChildrenLeft(fresh.get(BIG)!, fresh)).toBe(true);
    const half = cardIndex(tree({}, ["one.md"]));
    expect(orchestratedChildrenLeft(half.get(BIG)!, half)).toBe(true);
    const all = cardIndex(tree({}, ["one.md", "two.md"]));
    expect(orchestratedChildrenLeft(all.get(BIG)!, all)).toBe(false);
    const alone = cardIndex(childless());
    expect(orchestratedChildrenLeft(alone.get(BIG)!, alone)).toBe(false);
  });

  it("takes Run to the rail whenever the plan orchestrates, and Resume only while a child is left", () => {
    const go = (t: GavinTree, whileChildrenLeft: boolean, orchestrationBlocked = false) => {
      const cards = cardIndex(t);
      return pressGoesToRail(cards.get(BIG)!, cards, { whileChildrenLeft, orchestrationBlocked });
    };
    expect(go(tree({ children: null }), false)).toBe(true);
    expect(go(tree({ children: null }), true)).toBe(true);
    expect(go(tree({}, ["one.md", "two.md"]), false)).toBe(true);
    expect(go(tree({}, ["one.md", "two.md"]), true)).toBe(false);
    expect(go(childless(), false)).toBe(false);
  });

  it("runs a plan with no line as one session on a daemon too old to orchestrate", () => {
    const go = (t: GavinTree) => {
      const cards = cardIndex(t);
      return pressGoesToRail(cards.get(BIG)!, cards, { whileChildrenLeft: false, orchestrationBlocked: true });
    };
    expect(go(tree({ children: null }))).toBe(false);
    // The line was written for the rail, whose own gate says why it cannot.
    expect(go(tree({ children: "sequence" }))).toBe(true);
  });

  it("makes a rail named after the plan when none runs it", () => {
    expect(orchestratedRunTarget(emptyOrchestration(), BIG, "Big plan", false)).toEqual({
      kind: "create",
      name: "Big plan",
    });
  });

  it("reuses the rail named after it, re-arming a finished step only while the plan is not done", () => {
    const o: Orchestration = {
      ...emptyOrchestration(),
      rails: [{ ...rail("r1", [["t1", BIG]]), name: "Big plan" }],
      stepRuns: [{ stepId: "t1", state: "done", sessionId: null, reason: null }],
    };
    expect(orchestratedRunTarget(o, BIG, " big PLAN ", false)).toEqual({
      kind: "start",
      railId: "r1",
      rerunStepId: "t1",
    });
    expect(orchestratedRunTarget(o, BIG, "Big plan", true)).toEqual({ kind: "start", railId: "r1", rerunStepId: null });
  });

  it("refuses when another rail runs the plan, naming it", () => {
    const o = { ...emptyOrchestration(), rails: [{ ...rail("r1", [["t1", BIG]]), name: "Release" }] };
    const target = orchestratedRunTarget(o, BIG, "Big plan", false);
    expect(target.kind).toBe("refuse");
    expect((target as { reason: string }).reason).toContain("“Release”");
  });
});

describe("nestedStallReason", () => {
  it("names the child", () => {
    expect(nestedStallReason("one.md", "it broke")).toBe("nested task `one.md` stalled: it broke");
  });
});
