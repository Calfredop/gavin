import { describe, it, expect } from "vitest";
import {
  slugStatus,
  mergePlanCards,
  nearestContext,
  isPermanentColumn,
  indexCardViews,
} from "./planBoard";
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

const board: Board = { columns: [col("c1", "To Do"), col("c2", "In Progress")], labels: [], cardSessions: [] };

describe("slugStatus", () => {
  it("normalizes case, spacing, and separators", () => {
    for (const s of ["In Progress", "in-progress", "in_progress", " IN  PROGRESS "]) {
      expect(slugStatus(s)).toBe("in-progress");
    }
    expect(slugStatus("—")).toBe("");
  });
});

describe("isPermanentColumn", () => {
  it("matches the three canonical statuses slug-insensitively", () => {
    for (const n of ["To Do", "to do", "to-do", "TO  DO", "In Progress", "in_progress", "Done", "done"]) {
      expect(isPermanentColumn(n), n).toBe(true);
    }
  });

  it("leaves custom columns alone", () => {
    for (const n of ["Blocked", "Review", "Shipped", "Doing", ""]) {
      expect(isPermanentColumn(n), n).toBe(false);
    }
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

  it("children without status nest under their plan, sorted by order", () => {
    const t = tree([
      ctx("/ws", "root", [
        plan("p.md", "To Do", { kind: "plan", title: "The Plan" }),
        plan("a.md", null, { kind: "task", parent: "p.md", order: 2000 }),
        plan("b.md", null, { kind: "task", parent: "p.md", order: 1000 }),
      ]),
    ]);
    const { columns, autoColumns } = mergePlanCards(board, t);
    const planCard = columns[0].planCards.find((c) => c.fileName === "p.md");
    expect(planCard?.nestedChildren.map((c) => c.fileName)).toEqual(["b.md", "a.md"]);
    expect(planCard?.nestedChildren[0].parentTitle).toBe("The Plan");
    // Nested children appear in NO column and no auto column:
    const everywhere = [
      ...columns.flatMap((c) => c.planCards),
      ...autoColumns.flatMap((a) => a.planCards),
    ].map((c) => c.fileName);
    expect(everywhere).not.toContain("a.md");
    expect(everywhere).not.toContain("b.md");
  });

  it("children with status stay in columns wearing parentTitle", () => {
    const t = tree([
      ctx("/ws", "root", [
        plan("p.md", "To Do", { kind: "plan", title: "The Plan" }),
        plan("a.md", "In Progress", { kind: "task", parent: "p.md" }),
      ]),
    ]);
    const { columns } = mergePlanCards(board, t);
    const child = columns[1].planCards.find((c) => c.fileName === "a.md");
    expect(child?.parentTitle).toBe("The Plan");
    expect(child?.parentBroken).toBe(false);
    expect(columns[0].planCards.find((c) => c.fileName === "p.md")?.nestedChildren).toEqual([]);
  });

  it("broken parents render free-standing with parentBroken", () => {
    const t = tree([
      ctx("/ws", "root", [
        plan("a.md", null, { kind: "task", parent: "missing.md" }),
        plan("b.md", null, { kind: "task", parent: "b.md" }), // self
        plan("n.md", "To Do", { kind: "note" }),
        plan("c.md", null, { kind: "task", parent: "n.md" }), // non-plan target
      ]),
    ]);
    const { columns } = mergePlanCards(board, t);
    const first = columns[0].planCards;
    for (const f of ["a.md", "b.md", "c.md"]) {
      const card = first.find((c) => c.fileName === f);
      expect(card, f).toBeDefined();
      expect(card?.parentBroken, f).toBe(true);
    }
  });

  it("labels and checklist counts pass through", () => {
    const t = tree([
      ctx("/ws", "root", [
        plan("p.md", "To Do", { labels: ["bug", "ui"], checklistDone: 2, checklistTotal: 5 }),
      ]),
    ]);
    const card = mergePlanCards(board, t).columns[0].planCards[0];
    expect(card.labels).toEqual(["bug", "ui"]);
    expect(card.checklistDone).toBe(2);
    expect(card.checklistTotal).toBe(5);
    expect(card.contextFolder).toBe("/ws");
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
    const empty: Board = { columns: [], labels: [], cardSessions: [] };
    const t = tree([ctx("/ws", "root", [plan("a.md", null)])]);
    const { autoColumns } = mergePlanCards(empty, t);
    expect(autoColumns).toHaveLength(1);
    expect(autoColumns[0].planCards.map((p) => p.fileName)).toEqual(["a.md"]);
  });

  it("keeps archived cards OFF the board, in their own bucket", () => {
    // The archived card still says `status: Done` -- that is exactly why
    // it has to be pulled before a column sees it, or it would stand in
    // the Done column as if it had never been filed away.
    const doneCol: Board = { columns: [col("c1", "To Do"), col("c3", "Done")], labels: [], cardSessions: [] };
    const t = tree([
      ctx("/ws", "root", [
        plan("live.md", "Done"),
        plan("filed.md", "Done", { path: "/ws/.gavin-root/plans/archive/filed.md" }),
      ]),
    ]);
    const { columns, archived } = mergePlanCards(doneCol, t);
    expect(columns[1].planCards.map((p) => p.fileName)).toEqual(["live.md"]);
    expect(archived.map((p) => p.fileName)).toEqual(["filed.md"]);
  });

  it("never conjures an auto column for an archived card's status", () => {
    const t = tree([
      ctx("/ws", "root", [
        plan("odd.md", "Shipped", { path: "/ws/.gavin-root/plans/archive/odd.md" }),
      ]),
    ]);
    const { autoColumns, archived } = mergePlanCards(board, t);
    expect(autoColumns).toEqual([]);
    expect(archived.map((p) => p.fileName)).toEqual(["odd.md"]);
  });

  it("an archived plan carries its nested children into the archive with it", () => {
    // The daemon moved both files, so both paths are archived; nesting
    // resolves first and the child rides in inside its parent rather
    // than showing up as a second archived card.
    const t = tree([
      ctx("/ws", "root", [
        plan("big.md", "Done", { path: "/ws/.gavin-root/plans/archive/big.md" }),
        plan("step.md", null, {
          path: "/ws/.gavin-root/plans/archive/step.md",
          kind: "task",
          parent: "big.md",
        }),
      ]),
    ]);
    const { archived } = mergePlanCards(board, t);
    expect(archived.map((p) => p.fileName)).toEqual(["big.md"]);
    expect(archived[0].nestedChildren.map((c) => c.fileName)).toEqual(["step.md"]);
  });

  it("carries the daemon's mtime onto the card view", () => {
    const t = tree([ctx("/ws", "root", [plan("a.md", "To Do", { modifiedAt: 1234 })])]);
    expect(mergePlanCards(board, t).columns[0].planCards[0].modifiedAt).toBe(1234);
    // An older daemon sends nothing; the view says so rather than lying.
    const old = tree([ctx("/ws", "root", [plan("b.md", "To Do")])]);
    expect(mergePlanCards(board, old).columns[0].planCards[0].modifiedAt).toBeNull();
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

describe("indexCardViews", () => {
  // A plan with one nested child (a parented, statusless task) and one
  // free-standing sibling, so the index has to carry all three.
  const nesting = tree([
    ctx("/ws", "root", [
      plan("parent.md", "To Do"),
      plan("child.md", null, { kind: "task", parent: "parent.md" }),
      plan("loose.md", "In Progress", { kind: "task" }),
    ]),
  ]);

  it("indexes every card by path, with the column it sits in", () => {
    const index = indexCardViews(mergePlanCards(board, nesting));
    expect(index.get("/ws/.gavin-root/plans/parent.md")?.columnName).toBe("To Do");
    expect(index.get("/ws/.gavin-root/plans/loose.md")?.columnName).toBe("In Progress");
    expect(index.get("/ws/.gavin-root/plans/parent.md")?.view.title).toBe("parent");
  });

  // Nesting pulls a card out of column flow entirely, so it has no column
  // to name -- and it must still be reachable, since a rail renders it
  // inside its parent and a click has to open it.
  it("includes nested children, with no column of their own", () => {
    const index = indexCardViews(mergePlanCards(board, nesting));
    const child = index.get("/ws/.gavin-root/plans/child.md");
    expect(child?.columnName).toBeNull();
    expect(child?.view.fileName).toBe("child.md");
  });

  it("names an auto column by its status", () => {
    const t = tree([ctx("/ws", "root", [plan("a.md", "Blocked")])]);
    const index = indexCardViews(mergePlanCards(board, t));
    expect(index.get("/ws/.gavin-root/plans/a.md")?.columnName).toBe("Blocked");
  });

  it("indexes archived cards too, with no column", () => {
    // A rail step whose card was archived still has to render as itself
    // rather than as "missing card".
    const t = tree([
      ctx("/ws", "root", [
        plan("filed.md", "Done", { path: "/ws/.gavin-root/plans/archive/filed.md" }),
      ]),
    ]);
    const index = indexCardViews(mergePlanCards(board, t));
    const placed = index.get("/ws/.gavin-root/plans/archive/filed.md");
    expect(placed?.columnName).toBeNull();
    expect(placed?.view.fileName).toBe("filed.md");
  });

  it("is empty for a board with no cards", () => {
    expect(indexCardViews(mergePlanCards(board, tree([])))).toEqual(new Map());
  });
});
