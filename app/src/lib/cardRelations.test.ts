import { describe, it, expect } from "vitest";
import { childCards, parentCard } from "$lib/cardRelations";
import type { CardView } from "$lib/planBoard";

function view(path: string, kind: CardView["kind"], status: string | null, extra: Partial<CardView> = {}): CardView {
  return {
    id: path,
    title: path,
    status,
    priority: null,
    order: null,
    kind,
    parent: null,
    parentTitle: null,
    parentBroken: false,
    labels: [],
    checklistDone: 0,
    checklistTotal: 0,
    contextName: "p",
    contextFolder: "/p",
    fileName: path.split("/").at(-1) ?? path,
    parseWarning: false,
    nestedChildren: [],
    ...extra,
  };
}

describe("childCards", () => {
  it("lists nested children first, then the free-standing ones", () => {
    const nested = view("/p/n1.md", "task", null, { parent: "big.md" });
    const free = view("/p/f1.md", "task", "In Progress", { parent: "big.md" });
    const plan = view("/p/big.md", "plan", "To Do", { nestedChildren: [nested] });
    expect(childCards(plan, [plan, nested, free]).map((c) => c.id)).toEqual(["/p/n1.md", "/p/f1.md"]);
  });

  it("keeps a parent link inside its own context", () => {
    const elsewhere = view("/q/f1.md", "task", "To Do", { parent: "big.md", contextFolder: "/q" });
    const plan = view("/p/big.md", "plan", "To Do");
    expect(childCards(plan, [plan, elsewhere])).toEqual([]);
  });

  it("never lists the card as its own child", () => {
    const selfish = view("/p/big.md", "plan", "To Do", { parent: "big.md" });
    expect(childCards(selfish, [selfish])).toEqual([]);
  });

  it("is empty for a task or a note, whatever points at them", () => {
    const child = view("/p/c.md", "task", "To Do", { parent: "t.md" });
    const task = view("/p/t.md", "task", "To Do");
    expect(childCards(task, [task, child])).toEqual([]);
  });

  it("emits each child once even when allCards repeats it", () => {
    const nested = view("/p/n1.md", "task", null, { parent: "big.md" });
    const free = view("/p/f1.md", "task", "Done", { parent: "big.md" });
    const plan = view("/p/big.md", "plan", "To Do", { nestedChildren: [nested] });
    // A nested child rides in allCards as a top-level entry too, and a
    // surface may index the same card from two columns.
    const out = childCards(plan, [plan, nested, free, free]);
    expect(out.map((c) => c.id)).toEqual(["/p/n1.md", "/p/f1.md"]);
  });
});

describe("parentCard", () => {
  const plan = view("/p/big.md", "plan", "To Do");

  it("resolves the plan a nested child belongs to", () => {
    const child = view("/p/n1.md", "task", null, { parent: "big.md", parentTitle: "/p/big.md" });
    expect(parentCard(child, [plan, child])?.id).toBe("/p/big.md");
  });

  it("is null with no parent, or a broken one", () => {
    expect(parentCard(view("/p/a.md", "task", "To Do"), [plan])).toBeNull();
    const broken = view("/p/b.md", "task", "To Do", { parent: "gone.md", parentBroken: true });
    expect(parentCard(broken, [plan, broken])).toBeNull();
  });

  it("is null when the parent is outside this surface's projection", () => {
    // An archived plan: the page-scoped board's allCards never carries it.
    const child = view("/p/n1.md", "task", "To Do", { parent: "big.md" });
    expect(parentCard(child, [child])).toBeNull();
  });

  it("does not resolve a card to itself", () => {
    const selfish = view("/p/big.md", "plan", "To Do", { parent: "big.md" });
    expect(parentCard(selfish, [selfish])).toBeNull();
  });

  it("matches the parent inside the card's own context only", () => {
    const other = view("/q/big.md", "plan", "To Do", { contextFolder: "/q" });
    const child = view("/p/n1.md", "task", null, { parent: "big.md" });
    expect(parentCard(child, [other, child])).toBeNull();
  });
});
