import { describe, it, expect } from "vitest";
import { boardSummary, planSummary, prdExcerpt } from "./homeSummary";
import type { Board } from "./kanban";
import type { GavinContext, GavinTree, PlanFileInfo } from "./gavin";

function plan(fileName: string, status: string | null): PlanFileInfo {
  return {
    path: `/ws/.gavin-root/plans/${fileName}`,
    fileName,
    title: fileName,
    status,
    priority: null,
    order: null,
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
    {
      id: "c1",
      name: "To Do",
      position: 0,
      cards: [
        { id: "f1", title: "free", description: "", labelIds: [], priority: "none", position: 0 },
      ],
    },
    { id: "c2", name: "Done", position: 1, cards: [] },
  ],
  labels: [],
};

describe("boardSummary", () => {
  it("counts free-form and plan cards per column", () => {
    const s = boardSummary(board, tree([ctx("/ws/a", [plan("p.md", "To Do"), plan("q.md", "Done")])]));
    expect(s.columns).toEqual([
      { name: "To Do", freeFormCount: 1, planCount: 1 },
      { name: "Done", freeFormCount: 0, planCount: 1 },
    ]);
    expect(s.totalCards).toBe(3);
  });

  it("reports auto columns for statuses matching no column", () => {
    const s = boardSummary(board, tree([ctx("/ws/a", [plan("p.md", "Shipped")])]));
    expect(s.autoColumns).toEqual([{ status: "Shipped", count: 1 }]);
  });

  it("handles an absent board or tree", () => {
    expect(boardSummary(undefined, undefined).columns).toEqual([]);
    expect(boardSummary(undefined, undefined).totalCards).toBe(0);
    expect(boardSummary(board, undefined).totalCards).toBe(1);
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
  it("takes the first non-empty lines up to the limit", () => {
    expect(prdExcerpt("# Title\n\n\nFirst\nSecond\nThird\n", 2)).toEqual(["# Title", "First"]);
  });

  it("returns everything when the file is shorter than the limit", () => {
    expect(prdExcerpt("# Title\nOnly\n", 10)).toEqual(["# Title", "Only"]);
  });

  it("handles empty content", () => {
    expect(prdExcerpt("", 5)).toEqual([]);
  });
});
