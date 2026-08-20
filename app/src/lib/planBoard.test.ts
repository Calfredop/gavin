import { describe, it, expect } from "vitest";
import { slugStatus, mergePlanCards, nearestContext } from "./planBoard";
import type { Board, Column } from "./kanban";
import type { GavinContext, GavinTree, PlanFileInfo } from "./gavin";

function col(id: string, name: string): Column {
  return { id, name, position: 0 };
}

function plan(fileName: string, status: string | null, overrides: Partial<PlanFileInfo> = {}): PlanFileInfo {
  return {
    path: `/ws/.gavin-root/plans/${fileName}`,
    fileName,
    title: fileName.replace(/\.md$/, ""),
    status,
    priority: null,
    order: null,
    kind: "plan",
    parent: null,
    labels: [],
    checklistDone: 0,
    checklistTotal: 0,
    parseWarning: false,
    ...overrides,
  };
}

function ctx(folderPath: string, name: string, plans: PlanFileInfo[]): GavinContext {
  return { folderPath, kind: "context", name, plans, docs: [], specs: [], hasPrd: false, configWarning: false };
}

function tree(contexts: GavinContext[]): GavinTree {
  return { rootPath: "/ws", rootMissing: false, contexts };
}

const board: Board = { columns: [col("c1", "To Do"), col("c2", "In Progress")], labels: [] };

describe("slugStatus", () => {
  it("normalizes case, spacing, and separators", () => {
    for (const s of ["In Progress", "in-progress", "in_progress", " IN  PROGRESS "]) {
      expect(slugStatus(s)).toBe("in-progress");
    }
    expect(slugStatus("—")).toBe("");
  });
});

describe("mergePlanCards", () => {
  it("matches plans to columns by slug", () => {
    const t = tree([ctx("/ws", "root", [plan("a.md", "in_progress"), plan("b.md", "To Do")])]);
    const { columns, autoColumns } = mergePlanCards(board, t);
    expect(columns[0].planCards.map((p) => p.fileName)).toEqual(["b.md"]);
    expect(columns[1].planCards.map((p) => p.fileName)).toEqual(["a.md"]);
    expect(autoColumns).toEqual([]);
  });

  it("sends missing and empty-slug statuses to the first column", () => {
    const t = tree([ctx("/ws", "root", [plan("a.md", null), plan("b.md", "—")])]);
    const { columns } = mergePlanCards(board, t);
    expect(columns[0].planCards.map((p) => p.fileName)).toEqual(["a.md", "b.md"]);
  });

  it("sorts plan cards by order, unordered last by folder/filename", () => {
    const t = tree([
      ctx("/ws", "root", [
        plan("a.md", "To Do", { order: 2000 }),
        plan("b.md", "To Do", { order: 1000 }),
        plan("c.md", "To Do"),
      ]),
    ]);
    const { columns } = mergePlanCards(board, t);
    expect(columns[0].planCards.map((p) => p.fileName)).toEqual(["b.md", "a.md", "c.md"]);
    expect(columns[0].planCards.map((p) => p.order)).toEqual([1000, 2000, null]);
  });

  it("order ties fall back to folder then filename", () => {
    const t = tree([
      ctx("/ws/zeta", "zeta", [plan("z.md", "To Do", { order: 1000, path: "/ws/zeta/z.md" })]),
      ctx("/ws/alpha", "alpha", [plan("a.md", "To Do", { order: 1000, path: "/ws/alpha/a.md" })]),
    ]);
    const { columns } = mergePlanCards(board, t);
    expect(columns[0].planCards.map((p) => p.fileName)).toEqual(["a.md", "z.md"]);
  });

  it("groups unmatched statuses into auto columns after the real ones", () => {
    const t = tree([ctx("/ws", "root", [plan("a.md", "Blocked"), plan("b.md", "blocked"), plan("c.md", "Review")])]);
    const { autoColumns } = mergePlanCards(board, t);
    expect(autoColumns.map((a) => a.status)).toEqual(["Blocked", "Review"]);
    expect(autoColumns[0].planCards).toHaveLength(2);
  });

  it("sorts plan cards by context folder then file name", () => {
    const t = tree([
      ctx("/ws/zeta", "zeta", [plan("z.md", "To Do"), plan("a.md", "To Do")]),
      ctx("/ws/alpha", "alpha", [plan("m.md", "To Do")]),
    ]);
    const { columns } = mergePlanCards(board, t);
    expect(columns[0].planCards.map((p) => `${p.contextName}/${p.fileName}`)).toEqual([
      "alpha/m.md",
      "zeta/a.md",
      "zeta/z.md",
    ]);
  });

  it("context filter keeps only that context's plans and drops free-form cards", () => {
    const t = tree([
      ctx("/ws", "root", [plan("r.md", "To Do")]),
      ctx("/ws/auth", "auth", [plan("a.md", "To Do")]),
    ]);
    const { columns } = mergePlanCards(board, t, { contextFolder: "/ws/auth" });
    expect(columns[0].planCards.map((p) => p.fileName)).toEqual(["a.md"]);
  });

  it("yields zero plan cards for an absent or root_missing tree", () => {
    expect(mergePlanCards(board, undefined).columns[0].planCards).toEqual([]);
    const missing: GavinTree = { rootPath: "/ws", rootMissing: true, contexts: [] };
    expect(mergePlanCards(board, missing).autoColumns).toEqual([]);
  });

  it("puts statusless plans into a '(no status)' auto column when the board has zero columns", () => {
    const empty: Board = { columns: [], labels: [] };
    const t = tree([ctx("/ws", "root", [plan("a.md", null)])]);
    const { autoColumns } = mergePlanCards(empty, t);
    expect(autoColumns).toHaveLength(1);
    expect(autoColumns[0].planCards.map((p) => p.fileName)).toEqual(["a.md"]);
  });
});

describe("nearestContext", () => {
  const t = tree([ctx("/ws", "root", []), ctx("/ws/auth", "auth", []), ctx("/ws/auth/deep", "deep", [])]);
  it("picks the deepest ancestor, including exact matches", () => {
    expect(nearestContext(t, "/ws/auth/deep/src")?.name).toBe("deep");
    expect(nearestContext(t, "/ws/auth")?.name).toBe("auth");
    expect(nearestContext(t, "/ws/other")?.name).toBe("root");
  });
  it("is path-segment aware", () => {
    expect(nearestContext(t, "/ws/auth2")?.name).toBe("root");
  });
  it("returns null without a tree, cwd, or match", () => {
    expect(nearestContext(undefined, "/ws")).toBeNull();
    expect(nearestContext(t, undefined)).toBeNull();
    expect(nearestContext(t, "/elsewhere")).toBeNull();
  });
});
