import { describe, it, expect } from "vitest";
import { filterBoard, cardMatches, AUTO_KEY_PREFIX } from "$lib/boardSearch";
import type { AutoColumn, CardView, DisplayColumn } from "$lib/planBoard";
import type { Column } from "$lib/kanban";

function card(title: string, over: Partial<CardView> = {}): CardView {
  const fileName = `${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.md`;
  return {
    id: `/ws/.gavin-root/plans/${fileName}`,
    title,
    status: "To Do",
    priority: null,
    order: null,
    kind: "task",
    parent: null,
    parentTitle: null,
    parentBroken: false,
    labels: [],
    checklistDone: 0,
    checklistTotal: 0,
    contextName: "root",
    contextFolder: "/ws",
    fileName,
    parseWarning: false,
    nestedChildren: [],
    ...over,
  };
}

function column(id: string, name: string, planCards: CardView[]): DisplayColumn {
  const col: Column = { id, name, position: 0 };
  return { column: col, planCards };
}

function auto(status: string, planCards: CardView[]): AutoColumn {
  return { status, planCards };
}

describe("cardMatches", () => {
  it("matches the title, the filename and the context", () => {
    const c = card("Git tab", { contextName: "auth" });
    expect(cardMatches(c, ["git"])).toBe(true);
    expect(cardMatches(c, ["git-tab.md"])).toBe(true);
    expect(cardMatches(c, ["auth"])).toBe(true);
  });

  it("matches the status, the kind, the labels and the parent title", () => {
    const c = card("Thing", { status: "Blocked", kind: "plan", labels: ["ui", "bug"], parentTitle: "Rework" });
    expect(cardMatches(c, ["blocked"])).toBe(true);
    expect(cardMatches(c, ["plan"])).toBe(true);
    expect(cardMatches(c, ["bug"])).toBe(true);
    expect(cardMatches(c, ["rework"])).toBe(true);
  });

  it("matches a plan through its nested children", () => {
    const parent = card("Rework", { kind: "plan", nestedChildren: [card("Fix the login flow")] });
    expect(cardMatches(parent, ["login"])).toBe(true);
    expect(cardMatches(parent, ["logout"])).toBe(false);
  });
});

describe("filterBoard", () => {
  const merged = {
    columns: [
      column("c1", "To Do", [card("Git tab"), card("Kanban search")]),
      column("c2", "In Progress", [card("Orchestration rails")]),
    ],
    autoColumns: [auto("Blocked", [card("Git worktrees", { status: "Blocked" })])],
  };

  it("passes everything through untouched when the query is blank", () => {
    const out = filterBoard(merged, "   ");
    expect(out.filtering).toBe(false);
    expect(out.columns[0].planCards).toHaveLength(2);
    expect(out.shown).toBe(4);
    expect(out.total).toBe(4);
  });

  it("keeps only matching cards and counts what it hid", () => {
    const out = filterBoard(merged, "git");
    expect(out.filtering).toBe(true);
    expect(out.columns[0].planCards.map((c) => c.title)).toEqual(["Git tab"]);
    expect(out.columns[1].planCards).toEqual([]);
    expect(out.autoColumns[0].planCards.map((c) => c.title)).toEqual(["Git worktrees"]);
    expect(out.shown).toBe(2);
    expect(out.total).toBe(4);
    expect(out.hiddenIn("c1")).toBe(1);
    expect(out.hiddenIn("c2")).toBe(1);
    expect(out.hiddenIn(AUTO_KEY_PREFIX + "Blocked")).toBe(0);
  });

  it("keeps a column's identity even when nothing in it matches", () => {
    const out = filterBoard(merged, "nothing-matches-this");
    expect(out.columns).toHaveLength(2);
    expect(out.autoColumns).toHaveLength(1);
    expect(out.shown).toBe(0);
  });

  it("keeps every child of a plan that matches on its own", () => {
    const plan = card("Rework", { kind: "plan", nestedChildren: [card("Alpha"), card("Beta")] });
    const out = filterBoard({ columns: [column("c1", "To Do", [plan])], autoColumns: [] }, "rework");
    expect(out.columns[0].planCards[0].nestedChildren.map((c) => c.title)).toEqual(["Alpha", "Beta"]);
  });

  it("narrows a plan to the children that match when the plan itself does not", () => {
    const plan = card("Rework", { kind: "plan", nestedChildren: [card("Alpha"), card("Beta")] });
    const out = filterBoard({ columns: [column("c1", "To Do", [plan])], autoColumns: [] }, "beta");
    const kept = out.columns[0].planCards[0];
    expect(kept.nestedChildren.map((c) => c.title)).toEqual(["Beta"]);
    // The original projection must not be mutated -- the drop path still
    // commits against it.
    expect(plan.nestedChildren).toHaveLength(2);
  });
});
