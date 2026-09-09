import { describe, it, expect } from "vitest";
import { boardSummary, planSummary, prdExcerpt, orchestrationSummary } from "$lib/hub/homeSummary";
import type { Board } from "$lib/board/kanban";
import type { GavinContext, GavinTree, PlanFileInfo } from "$lib/gavin";
import type { Orchestration, Rail, StepRun, StepState } from "$lib/orchestration/orchestration";

function plan(fileName: string, status: string | null): PlanFileInfo {
  return {
    path: `/ws/.gavin-root/plans/${fileName}`,
    fileName,
    title: fileName,
    status,
    priority: null,
    order: null,
    kind: "plan" as const, parent: null, labels: [], checklistDone: 0, checklistTotal: 0,
    parseWarning: false,
  };
}

function ctx(folderPath: string, plans: PlanFileInfo[]): GavinContext {
  return {
    folderPath,
    kind: "context",
    name: folderPath.split("/").at(-1) ?? folderPath,
    plans,
    docs: [],
    specs: [],
    hasPrd: false,
    configWarning: false,
  };
}

function tree(contexts: GavinContext[]): GavinTree {
  return { rootPath: "/ws", rootMissing: false, contexts };
}

const board: Board = {
  columns: [
    { id: "c1", name: "To Do", position: 0 },
    { id: "c2", name: "Done", position: 1 },
  ],
  labels: [],
  cardSessions: [],
};

describe("boardSummary", () => {
  it("counts plan cards per column", () => {
    const s = boardSummary(board, tree([ctx("/ws/a", [plan("p.md", "To Do"), plan("q.md", "Done")])]));
    expect(s.columns).toEqual([
      { name: "To Do", planCount: 1 },
      { name: "Done", planCount: 1 },
    ]);
    expect(s.totalCards).toBe(2);
  });

  it("reports auto columns for statuses matching no column", () => {
    const s = boardSummary(board, tree([ctx("/ws/a", [plan("p.md", "Shipped")])]));
    expect(s.autoColumns).toEqual([{ status: "Shipped", count: 1 }]);
  });

  it("handles an absent board or tree", () => {
    expect(boardSummary(undefined, undefined).columns).toEqual([]);
    expect(boardSummary(undefined, undefined).totalCards).toBe(0);
    expect(boardSummary(board, undefined).totalCards).toBe(0);
  });
});

describe("planSummary", () => {
  it("totals plans and contexts and tallies by status", () => {
    const s = planSummary(
      tree([ctx("/ws/a", [plan("p.md", "To Do"), plan("q.md", "To Do")]), ctx("/ws/b", [plan("r.md", null)])])
    );
    expect(s.total).toBe(3);
    expect(s.contexts).toBe(2);
    expect(s.byStatus).toEqual([
      { status: "(no status)", count: 1 },
      { status: "To Do", count: 2 },
    ]);
  });

  it("is zeroed for an absent tree", () => {
    expect(planSummary(undefined)).toEqual({ total: 0, contexts: 0, byStatus: [] });
  });
});

describe("prdExcerpt", () => {
  it("counts the limit in lines that say something, not in blank ones", () => {
    expect(prdExcerpt("# Title\n\n\nFirst\nSecond\nThird\n", 2)).toEqual([
      "# Title",
      "",
      "First",
    ]);
  });

  it("collapses a run of blank lines to one paragraph break", () => {
    expect(prdExcerpt("One\n\n\n\nTwo\n", 10)).toEqual(["One", "", "Two"]);
  });

  // A blank first or last row would spend one of the panel's few lines
  // drawing nothing.
  it("keeps no blank line at either end", () => {
    expect(prdExcerpt("\n\n# Title\n\nBody\n\n\n", 10)).toEqual(["# Title", "", "Body"]);
  });

  it("returns everything when the file is shorter than the limit", () => {
    expect(prdExcerpt("# Title\nOnly\n", 10)).toEqual(["# Title", "Only"]);
  });

  it("handles empty content", () => {
    expect(prdExcerpt("", 5)).toEqual([]);
    expect(prdExcerpt("\n\n\n", 5)).toEqual([]);
  });
});

// --- orchestrationSummary ---------------------------------------------
// Fixtures shaped after orchestration.test.ts's, so a rail here reads
// the same as a rail there.

function orail(id: string, stages: Array<string[]>, overrides: Partial<Rail> = {}): Rail {
  return {
    id,
    name: id,
    position: 0,
    worktreePath: null,
    pageId: null,
    stages: stages.map((steps, si) => ({
      id: `${id}-s${si}`,
      position: si,
      steps: steps.map((stepId, pi) => ({
        id: stepId,
        position: pi,
        cardPath: `/ws/.gavin-root/plans/${stepId}.md`,
      })),
    })),
    ...overrides,
  };
}

function orch(rails: Rail[], runs: Partial<Orchestration> = {}): Orchestration {
  return { rails, conflictNotes: [], railRuns: [], stepRuns: [], ...runs };
}

function step(stepId: string, state: StepState): StepRun {
  return { stepId, state, sessionId: null, reason: null };
}

describe("orchestrationSummary", () => {
  it("is zeroed when the workspace has no orchestration loaded yet", () => {
    expect(orchestrationSummary(undefined, undefined, null, null)).toEqual({
      rails: [],
      railsRunning: 0,
      stepsRunning: 0,
      stepsStalled: 0,
      conflicts: 0,
      liveConflicts: 0,
    });
  });

  it("counts a rail's stages and the ones whose every step is done", () => {
    const s = orchestrationSummary(
      orch([orail("backend", [["t1"], ["t2", "t3"], ["t4"]])], {
        stepRuns: [step("t1", "done"), step("t2", "done"), step("t3", "running")],
      }),
      undefined,
      null,
      null
    );
    expect(s.rails).toHaveLength(1);
    expect(s.rails[0].stagesTotal).toBe(3);
    expect(s.rails[0].stagesDone).toBe(1);
  });

  // Finished, not achieved. A stage the human skipped past is one the
  // rail is done with, and a recap that still counted it would under-
  // report how far the rail has actually got.
  it("counts a stage the human skipped past among the ones behind the rail", () => {
    const s = orchestrationSummary(
      orch([orail("backend", [["t1"], ["t2"], ["t3"]])], {
        stepRuns: [step("t1", "done"), step("t2", "skipped")],
      }),
      undefined,
      null,
      null
    );
    expect(s.rails[0].stagesDone).toBe(2);
  });

  it("reports the rail's current stage as a 1-based index", () => {
    const s = orchestrationSummary(
      orch([orail("backend", [["t1"], ["t2"], ["t3"]])], {
        railRuns: [{ railId: "backend", state: "running", currentStageId: "backend-s1" }],
      }),
      undefined,
      null,
      null
    );
    expect(s.rails[0].state).toBe("running");
    expect(s.rails[0].currentStage).toBe(2);
  });

  it("has no current stage for an idle rail", () => {
    const s = orchestrationSummary(orch([orail("docs", [["t1"]])]), undefined, null, null);
    expect(s.rails[0].state).toBe("idle");
    expect(s.rails[0].currentStage).toBeNull();
  });

  it("orders rails by position, not array order", () => {
    const s = orchestrationSummary(
      orch([orail("second", [], { position: 1 }), orail("first", [], { position: 0 })]),
      undefined,
      null,
      null
    );
    expect(s.rails.map((r) => r.name)).toEqual(["first", "second"]);
  });

  it("tallies running rails and running/stalled steps across the whole plan", () => {
    const s = orchestrationSummary(
      orch([orail("a", [["t1", "t2"]]), orail("b", [["t3"]]), orail("c", [["t4"]])], {
        railRuns: [
          { railId: "a", state: "running", currentStageId: "a-s0" },
          { railId: "b", state: "paused", currentStageId: "b-s0" },
        ],
        stepRuns: [step("t1", "running"), step("t2", "stalled"), step("t3", "running")],
      }),
      undefined,
      null,
      null
    );
    expect(s.railsRunning).toBe(1);
    expect(s.stepsRunning).toBe(2);
    expect(s.stepsStalled).toBe(1);
    expect(s.rails.find((r) => r.name === "a")?.stepsStalled).toBe(1);
  });

  it("counts the same conflicts the tab's box does", () => {
    // Two unbound rails carrying steps: one `rail-unbound` each.
    const s = orchestrationSummary(
      orch([orail("a", [["t1"]]), orail("b", [["t2"]])]),
      undefined,
      null,
      null
    );
    expect(s.conflicts).toBe(2);
    expect(s.liveConflicts).toBe(0);
  });

  it("separates live conflicts from potential ones", () => {
    // Two steps running in one stage share the rail's checkout: live.
    const s = orchestrationSummary(
      orch([orail("a", [["t1", "t2"]], { worktreePath: "/wt/a" })], {
        stepRuns: [step("t1", "running"), step("t2", "running")],
      }),
      undefined,
      [{ path: "/wt/a", head: "abc", branch: "main", isMain: false, locked: false, prunable: false }],
      null
    );
    expect(s.conflicts).toBe(1);
    expect(s.liveConflicts).toBe(1);
  });

  it("does not count an empty rail as unbound", () => {
    const s = orchestrationSummary(orch([orail("a", [])]), undefined, null, null);
    expect(s.conflicts).toBe(0);
    expect(s.rails[0].stagesTotal).toBe(0);
    expect(s.rails[0].stagesDone).toBe(0);
  });
});
