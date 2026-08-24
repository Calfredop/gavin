import { describe, it, expect } from "vitest";
import { railDeleteConfirm, railClearDoneConfirm } from "./railConfirm";
import type { CardEntry, Orchestration, Rail } from "./orchestration";
import type { PlanFileInfo } from "./gavin";

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

function cardIndexOf(plans: PlanFileInfo[]): Map<string, CardEntry> {
  return new Map(plans.map((p) => [p.path, { plan: p, contextFolder: "/ws/.gavin-root" }]));
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

function orchOf(r: Rail, over: Partial<Orchestration> = {}): Orchestration {
  return { rails: [r], conflictNotes: [], railRuns: [], stepRuns: [], ...over };
}

describe("railDeleteConfirm", () => {
  const r = rail("r1", [
    [["t1", "/ws/.gavin-root/plans/a.md"]],
    [
      ["t2", "/ws/.gavin-root/plans/b.md"],
      ["t3", "/ws/.gavin-root/plans/a.md"],
    ],
  ]);

  it("names the rail and counts its stages and steps", () => {
    const c = railDeleteConfirm(r, orchOf(r));
    expect(c.title).toBe('Delete rail "r1"?');
    expect(c.lines[0]).toBe("Removes 2 stages and 3 steps from the plan.");
    expect(c.confirmLabel).toBe("Delete rail");
  });

  it("counts each card once, however many steps point at it", () => {
    expect(railDeleteConfirm(r, orchOf(r)).lines).toContain(
      "2 cards stay — a step is only a reference."
    );
  });

  it("says an empty rail is empty, rather than counting to zero", () => {
    const empty = rail("r1", []);
    const c = railDeleteConfirm(empty, orchOf(empty));
    expect(c.lines).toEqual(["This rail is empty — only the rail itself goes."]);
  });

  it("says nothing about cards on a rail that carries only tool steps", () => {
    const tools = rail("r1", [[["t1", ""]]]);
    tools.stages[0].steps[0].toolId = "tool-1";
    const c = railDeleteConfirm(tools, orchOf(tools));
    expect(c.lines).toEqual(["Removes 1 stage and 1 step from the plan."]);
  });

  it("singularizes a one-stage, one-step, one-card rail", () => {
    const one = rail("r1", [[["t1", "/ws/.gavin-root/plans/a.md"]]]);
    const c = railDeleteConfirm(one, orchOf(one));
    expect(c.lines[0]).toBe("Removes 1 stage and 1 step from the plan.");
    expect(c.lines[1]).toBe("1 card stays — a step is only a reference.");
  });

  it("mentions the run state only when the rail has one", () => {
    expect(railDeleteConfirm(r, orchOf(r)).lines.some((l) => l.includes("run state"))).toBe(false);
    const paused = orchOf(r, { railRuns: [{ railId: "r1", state: "paused", currentStageId: null }] });
    expect(railDeleteConfirm(r, paused).lines).toContain("Its run state (paused) goes with it.");
  });

  it("warns that a running step refuses the delete", () => {
    const running = orchOf(r, {
      railRuns: [{ railId: "r1", state: "running", currentStageId: "r1-s0" }],
      stepRuns: [{ stepId: "t1", state: "running", sessionId: "s1", reason: null }],
    });
    expect(railDeleteConfirm(r, running).lines).toContain(
      "1 step is still running — a live one refuses the delete, so pause the rail first."
    );
  });

  it("promises the bound worktree itself is left alone", () => {
    const bound = { ...r, worktreePath: "/x/wt" };
    expect(railDeleteConfirm(bound, orchOf(bound)).lines).toContain(
      "The worktree /x/wt is left as it is — only the rail's binding to it goes."
    );
  });
});

describe("railClearDoneConfirm", () => {
  const r = rail("r1", [
    [["t1", "/ws/.gavin-root/plans/a.md"]],
    [["t2", "/ws/.gavin-root/plans/b.md"]],
  ]);
  const cards = cardIndexOf([plan("a.md"), plan("b.md")]);

  it("counts the steps a clear would take off, by run state", () => {
    const orch = orchOf(r, {
      stepRuns: [{ stepId: "t1", state: "done", sessionId: null, reason: null }],
    });
    const c = railClearDoneConfirm(r, orch, cards, "Done");
    expect(c.title).toBe('Clear done steps from "r1"?');
    expect(c.lines[0]).toBe("Takes 1 done step off this rail.");
    expect(c.confirmLabel).toBe("Clear 1 step");
  });

  it("counts a step whose card is already in the done column", () => {
    const done = cardIndexOf([plan("a.md", { status: "Done" }), plan("b.md", { status: "Done" })]);
    const c = railClearDoneConfirm(r, orchOf(r), done, "Done");
    expect(c.lines[0]).toBe("Takes 2 done steps off this rail.");
    expect(c.confirmLabel).toBe("Clear 2 steps");
  });

  it("always promises the cards themselves survive", () => {
    expect(railClearDoneConfirm(r, orchOf(r), cards, "Done").lines).toContain(
      "The cards stay — only the steps that pointed at them leave."
    );
  });

  it("tells a running rail where its run picks up", () => {
    const idle = railClearDoneConfirm(r, orchOf(r), cards, "Done");
    expect(idle.lines.some((l) => l.includes("first unfinished stage"))).toBe(false);
    const running = orchOf(r, {
      railRuns: [{ railId: "r1", state: "running", currentStageId: "r1-s0" }],
    });
    expect(railClearDoneConfirm(r, running, cards, "Done").lines).toContain(
      "The run picks up from the first unfinished stage that is left."
    );
  });
});
