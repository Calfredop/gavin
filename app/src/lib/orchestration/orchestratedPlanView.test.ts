import { describe, it, expect } from "vitest";
import {
  CHILDREN_CHOICES,
  childrenChoiceOf,
  childrenControlShown,
  childrenFieldValue,
  childrenHint,
  childrenMarkTip,
  nestedChildState,
  orchestratedMode,
  nestedProgress,
  nestedProgressText,
  nestedProgressTip,
  nestedRunsOfPlan,
} from "$lib/orchestration/orchestratedPlanView";
import { cardIndex, emptyOrchestration } from "$lib/orchestration/orchestration";
import type { NestedRun, Orchestration } from "$lib/orchestration/orchestration";
import type { GavinTree, PlanFileInfo } from "$lib/core/gavin";

const DIR = "/ws/.gavin-root/plans";
const BIG = `${DIR}/big.md`;

function card(fileName: string, overrides: Partial<PlanFileInfo> = {}): PlanFileInfo {
  return {
    path: `${DIR}/${fileName}`,
    fileName,
    title: fileName,
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

function tree(plan: Partial<PlanFileInfo> = {}): GavinTree {
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
            checklistLinks: [
              { fileName: "one.md", done: true },
              { fileName: "two.md", done: false },
            ],
            ...plan,
          }),
          card("one.md", { parent: "big.md" }),
          card("two.md", { parent: "big.md" }),
          card("three.md", { parent: "big.md" }),
        ],
        docs: [],
        specs: [],
        hasPrd: true,
        configWarning: false,
      },
    ],
  };
}

function orchWith(nestedRuns: NestedRun[], extraSteps: Array<[string, string]> = []): Orchestration {
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
            steps: [["t1", BIG] as [string, string], ...extraSteps].map(([id, cardPath], i) => ({
              id,
              position: i,
              cardPath,
            })),
          },
        ],
      },
    ],
    nestedRuns,
  };
}

const run = (childPath: string, state: NestedRun["state"], stepId = "t1"): NestedRun => ({
  stepId,
  childPath,
  state,
  sessionId: null,
  reason: null,
});

describe("the Children control", () => {
  // ADR 0014: a plan with Nested tasks always runs them as their own
  // sessions, so the control chooses HOW -- no line reads as sequence.
  it("reads no line as sequence and writes the mode it is set to", () => {
    expect(childrenChoiceOf(null)).toBe("sequence");
    expect(childrenChoiceOf("parallel")).toBe("parallel");
    expect(childrenFieldValue("sequence")).toBe("sequence");
    expect(childrenFieldValue("parallel")).toBe("parallel");
    expect(CHILDREN_CHOICES.map((c) => c.value)).toEqual(["sequence", "parallel"]);
  });

  it("is offered on a plan with nested tasks, or one that already carries the line", () => {
    expect(childrenControlShown({ kind: "plan", children: null, nestedChildren: [{}] })).toBe(true);
    expect(childrenControlShown({ kind: "plan", children: "sequence", nestedChildren: [] })).toBe(true);
    expect(childrenControlShown({ kind: "plan", children: null, nestedChildren: [] })).toBe(false);
    expect(childrenControlShown({ kind: "task", children: null, nestedChildren: [{}] })).toBe(false);
  });

  it("says what Run will do under each choice", () => {
    expect(childrenHint("sequence")).toContain("one after another");
    expect(childrenHint("parallel")).toContain("at once");
  });
});

describe("the plan card's orchestrated mark", () => {
  it("is worn by every plan with Nested tasks, line or not", () => {
    expect(orchestratedMode({ kind: "plan", children: null, nestedChildren: [{}] })).toBe("sequence");
    expect(orchestratedMode({ kind: "plan", children: "parallel", nestedChildren: [{}] })).toBe("parallel");
    expect(orchestratedMode({ kind: "plan", children: null, nestedChildren: [] })).toBeNull();
    expect(orchestratedMode({ kind: "task", children: null, nestedChildren: [{}] })).toBeNull();
    expect(childrenMarkTip("sequence")).toContain("one at a time");
  });
});

describe("nestedChildState", () => {
  const plan = { children: "sequence" as const, checklistLinks: [{ fileName: "one.md", done: true }] };

  it("reads the run of a child under a plan with no line, which runs it all the same", () => {
    const noLine = { children: null, checklistLinks: [{ fileName: "one.md", done: true }] };
    expect(nestedChildState(noLine, { id: `${DIR}/one.md`, fileName: "one.md" }, [])).toBe("done");
    const two = { id: `${DIR}/two.md`, fileName: "two.md" };
    expect(nestedChildState(noLine, two, [run(two.id, "running")])).toBe("running");
  });

  it("is done by the tick, whatever the run rows say", () => {
    expect(nestedChildState(plan, { id: `${DIR}/one.md`, fileName: "one.md" }, [run(`${DIR}/one.md`, "stalled")])).toBe(
      "done"
    );
  });

  it("reads the run row of an unticked child, a finished-but-unticked run being pending again", () => {
    const two = { id: `${DIR}/two.md`, fileName: "two.md" };
    expect(nestedChildState(plan, two, [])).toBe("pending");
    expect(nestedChildState(plan, two, [run(two.id, "running")])).toBe("running");
    expect(nestedChildState(plan, two, [run(two.id, "stalled")])).toBe("stalled");
    expect(nestedChildState(plan, two, [run(two.id, "skipped")])).toBe("skipped");
    expect(nestedChildState(plan, two, [run(two.id, "done")])).toBe("pending");
    // A run going now outranks a stalled one under another step.
    expect(nestedChildState(plan, two, [run(two.id, "stalled", "t2"), run(two.id, "running")])).toBe("running");
  });
});

describe("nestedRunsOfPlan", () => {
  it("keeps the rows under this plan's steps only", () => {
    const o = orchWith([run(`${DIR}/one.md`, "running"), run(`${DIR}/x.md`, "running", "t9")]);
    expect(nestedRunsOfPlan(o, BIG).map((r) => r.childPath)).toEqual([`${DIR}/one.md`]);
    expect(nestedRunsOfPlan(undefined, BIG)).toEqual([]);
  });
});

describe("the n/m nested chip", () => {
  const step = { id: "t1", position: 0, cardPath: BIG };

  it("counts the ticked children the step runs", () => {
    const progress = nestedProgress(step, orchWith([]), cardIndex(tree()));
    expect(progress).toEqual({ done: 1, total: 3 });
    expect(nestedProgressText(progress!)).toBe("1/3 nested");
    expect(nestedProgressTip(progress!)).toContain("2 still to run");
  });

  it("leaves out a child placed as a step of its own", () => {
    expect(nestedProgress(step, orchWith([], [["t2", `${DIR}/three.md`]]), cardIndex(tree()))).toEqual({
      done: 1,
      total: 2,
    });
  });

  it("counts a plan without the line the same way", () => {
    expect(nestedProgress(step, orchWith([]), cardIndex(tree({ children: null })))).toEqual({ done: 1, total: 3 });
  });

  it("says the plan's session is next once every child is ticked", () => {
    expect(nestedProgressTip({ done: 2, total: 2 })).toContain("plan's own session runs next");
  });
});
