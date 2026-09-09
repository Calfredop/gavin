import { describe, it, expect } from "vitest";
import {
  ANY,
  NO_FACETS,
  NO_RAIL,
  cardPasses,
  contextFacets,
  facetsActive,
  filterBoardByFacets,
  filterCards,
  pruneFacets,
  underContext,
  type BoardFacets,
} from "$lib/board/boardFilters";
import { AUTO_KEY_PREFIX } from "$lib/board/boardSearch";
import { railIndex } from "$lib/board/planFilter";
import type { RailIndex } from "$lib/board/planFilter";
import type { AutoColumn, CardView, DisplayColumn } from "$lib/planBoard";
import type { GavinContext, GavinTree } from "$lib/gavin";
import { emptyOrchestration } from "$lib/orchestration/orchestration";
import type { Orchestration, Rail } from "$lib/orchestration/orchestration";

function card(name: string, over: Partial<CardView> = {}): CardView {
  const fileName = `${name}.md`;
  const contextFolder = over.contextFolder ?? "/ws";
  return {
    id: `${contextFolder}/.gavin-root/plans/${fileName}`,
    title: name,
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
    contextFolder,
    fileName,
    parseWarning: false,
    nestedChildren: [],
    ...over,
  };
}

function column(id: string, planCards: CardView[]): DisplayColumn {
  return { column: { id, name: id, position: 0 }, planCards };
}

function auto(status: string, planCards: CardView[]): AutoColumn {
  return { status, planCards };
}

function context(over: Partial<GavinContext> = {}): GavinContext {
  return {
    folderPath: "/ws",
    kind: "context",
    name: "ctx",
    plans: [],
    docs: [],
    specs: [],
    hasPrd: false,
    configWarning: false,
    ...over,
  };
}

function tree(contexts: GavinContext[], over: Partial<GavinTree> = {}): GavinTree {
  return { rootPath: "/ws", rootMissing: false, contexts, ...over };
}

function rail(id: string, name: string, cardPaths: string[], position = 0): Rail {
  return {
    id,
    name,
    position,
    worktreePath: null,
    pageId: null,
    stages: [
      {
        id: `${id}-stage`,
        position: 0,
        steps: cardPaths.map((cardPath, i) => ({ id: `${id}-${i}`, position: i, cardPath })),
      },
    ],
  };
}

function orch(rails: Rail[]): Orchestration {
  return { ...emptyOrchestration(), rails };
}

const EMPTY_RAILS: RailIndex = railIndex(null);

describe("facetsActive", () => {
  it("is false for the unset state and true for each facet alone", () => {
    expect(facetsActive(NO_FACETS)).toBe(false);
    expect(facetsActive({ ...NO_FACETS, context: "/ws/app" })).toBe(true);
    expect(facetsActive({ ...NO_FACETS, kind: "plan" })).toBe(true);
    expect(facetsActive({ ...NO_FACETS, rail: NO_RAIL })).toBe(true);
  });
});

describe("underContext", () => {
  it("takes the folder itself and its subfolders", () => {
    expect(underContext("/ws/app", "/ws/app")).toBe(true);
    expect(underContext("/ws/app/ui", "/ws/app")).toBe(true);
  });

  it("is path-segment aware", () => {
    expect(underContext("/ws/app2", "/ws/app")).toBe(false);
    expect(underContext("/ws", "/ws/app")).toBe(false);
  });

  it("tolerates a trailing slash on the selected folder", () => {
    expect(underContext("/ws/app/ui", "/ws/app/")).toBe(true);
  });
});

describe("contextFacets", () => {
  it("offers the root as ANY, then inside contexts by path, then outside ones", () => {
    const t = tree([
      context({ folderPath: "/ws/app", name: "app" }),
      context({ folderPath: "/ws", kind: "root", name: "ws" }),
      context({ folderPath: "/elsewhere/lib", name: "lib", outside: true }),
      context({ folderPath: "/ws/app/ui", name: "ui" }),
    ]);
    expect(contextFacets(t).map((c) => [c.value, c.label])).toEqual([
      [ANY, "All contexts"],
      ["/ws/app", "app"],
      ["/ws/app/ui", "app/ui"],
      ["/elsewhere/lib", "lib (outside)"],
    ]);
  });

  it("is just the all-contexts option with no tree", () => {
    expect(contextFacets(undefined)).toEqual([{ value: ANY, label: "All contexts", folderPath: "" }]);
    expect(contextFacets(tree([], { rootMissing: true }))).toHaveLength(1);
  });
});

describe("cardPasses", () => {
  const rails = railIndex(orch([rail("r1", "Rail one", ["/ws/.gavin-root/plans/a.md"])]));

  it("passes everything when no facet is set", () => {
    expect(cardPasses(card("a"), NO_FACETS, EMPTY_RAILS)).toBe(true);
  });

  it("scopes to a context and its subfolders", () => {
    const facets: BoardFacets = { ...NO_FACETS, context: "/ws/app" };
    expect(cardPasses(card("a", { contextFolder: "/ws/app" }), facets, EMPTY_RAILS)).toBe(true);
    expect(cardPasses(card("a", { contextFolder: "/ws/app/ui" }), facets, EMPTY_RAILS)).toBe(true);
    expect(cardPasses(card("a", { contextFolder: "/ws" }), facets, EMPTY_RAILS)).toBe(false);
  });

  it("matches the card kind exactly", () => {
    const facets: BoardFacets = { ...NO_FACETS, kind: "plan" };
    expect(cardPasses(card("a", { kind: "plan" }), facets, EMPTY_RAILS)).toBe(true);
    expect(cardPasses(card("a", { kind: "task" }), facets, EMPTY_RAILS)).toBe(false);
  });

  it("matches the rail carrying the card, and NO_RAIL the unplaced ones", () => {
    const onRail = card("a");
    const unplaced = card("b");
    expect(cardPasses(onRail, { ...NO_FACETS, rail: "r1" }, rails)).toBe(true);
    expect(cardPasses(unplaced, { ...NO_FACETS, rail: "r1" }, rails)).toBe(false);
    expect(cardPasses(unplaced, { ...NO_FACETS, rail: NO_RAIL }, rails)).toBe(true);
    expect(cardPasses(onRail, { ...NO_FACETS, rail: NO_RAIL }, rails)).toBe(false);
  });

  it("ANDs the three facets", () => {
    const facets: BoardFacets = { context: "/ws", kind: "task", rail: "r1" };
    expect(cardPasses(card("a"), facets, rails)).toBe(true);
    expect(cardPasses(card("a", { kind: "plan" }), facets, rails)).toBe(false);
  });
});

describe("filterBoardByFacets", () => {
  const plan = card("plan", { kind: "plan" });
  const task = card("task", { kind: "task" });
  const away = card("away", { kind: "task", contextFolder: "/ws/app" });
  const merged = { columns: [column("todo", [plan, task]), column("done", [])], autoColumns: [auto("Blocked", [away])] };

  it("returns the projection untouched when no facet is set", () => {
    const out = filterBoardByFacets(merged, NO_FACETS, EMPTY_RAILS);
    expect(out.columns[0].planCards).toBe(merged.columns[0].planCards);
    expect(out.shown).toBe(3);
    expect(out.total).toBe(3);
    expect(out.hiddenIn("todo")).toBe(0);
  });

  it("narrows every column and the auto columns alike", () => {
    const out = filterBoardByFacets(merged, { ...NO_FACETS, context: "/ws/app" }, EMPTY_RAILS);
    expect(out.columns[0].planCards).toEqual([]);
    expect(out.autoColumns[0].planCards.map((c) => c.title)).toEqual(["away"]);
    expect(out.shown).toBe(1);
    expect(out.total).toBe(3);
  });

  it("counts what each column lost, so its destructive actions can refuse", () => {
    const out = filterBoardByFacets(merged, { ...NO_FACETS, kind: "plan" }, EMPTY_RAILS);
    expect(out.hiddenIn("todo")).toBe(1);
    expect(out.hiddenIn("done")).toBe(0);
    expect(out.hiddenIn(AUTO_KEY_PREFIX + "Blocked")).toBe(1);
    expect(out.hiddenIn("nosuchcolumn")).toBe(0);
  });

  it("never mutates the projection it is given", () => {
    filterBoardByFacets(merged, { ...NO_FACETS, kind: "plan" }, EMPTY_RAILS);
    expect(merged.columns[0].planCards).toHaveLength(2);
    expect(merged.autoColumns[0].planCards).toHaveLength(1);
  });

  it("keeps a passing card's children whole", () => {
    const child = card("child", { kind: "task" });
    const parent = card("parent", { kind: "plan", nestedChildren: [child] });
    const out = filterBoardByFacets({ columns: [column("todo", [parent])], autoColumns: [] }, { ...NO_FACETS, kind: "plan" }, EMPTY_RAILS);
    expect(out.columns[0].planCards[0].nestedChildren.map((c) => c.title)).toEqual(["child"]);
  });

  it("keeps a failing card as a home for the children that pass", () => {
    const hit = card("hit", { kind: "task" });
    const miss = card("miss", { kind: "note" });
    const parent = card("parent", { kind: "plan", nestedChildren: [miss, hit] });
    const out = filterBoardByFacets({ columns: [column("todo", [parent])], autoColumns: [] }, { ...NO_FACETS, kind: "task" }, EMPTY_RAILS);
    expect(out.columns[0].planCards).toHaveLength(1);
    expect(out.columns[0].planCards[0].nestedChildren.map((c) => c.title)).toEqual(["hit"]);
    // The home does not count as a shown card of its own kind, but it is
    // the top-level card the column renders, so it counts once.
    expect(out.shown).toBe(1);
  });

  it("drops a card whose children all fail too", () => {
    const parent = card("parent", { kind: "plan", nestedChildren: [card("child", { kind: "note" })] });
    const out = filterBoardByFacets({ columns: [column("todo", [parent])], autoColumns: [] }, { ...NO_FACETS, kind: "task" }, EMPTY_RAILS);
    expect(out.columns[0].planCards).toEqual([]);
    expect(out.shown).toBe(0);
  });

  it("reaches a nested task on a rail whose parent plan is on none", () => {
    const child = card("child", { kind: "task" });
    const parent = card("parent", { kind: "plan", nestedChildren: [child] });
    const rails = railIndex(orch([rail("r1", "Rail one", [child.id])]));
    const out = filterBoardByFacets({ columns: [column("todo", [parent])], autoColumns: [] }, { ...NO_FACETS, rail: "r1" }, rails);
    expect(out.columns[0].planCards[0].nestedChildren.map((c) => c.title)).toEqual(["child"]);
  });
});

describe("filterCards", () => {
  it("is the same lens over a flat list, and the identity when unset", () => {
    const cards = [card("a", { kind: "plan" }), card("b", { kind: "note" })];
    expect(filterCards(cards, NO_FACETS, EMPTY_RAILS)).toBe(cards);
    expect(filterCards(cards, { ...NO_FACETS, kind: "note" }, EMPTY_RAILS).map((c) => c.title)).toEqual(["b"]);
  });
});

describe("pruneFacets", () => {
  const contexts = contextFacets(tree([context({ folderPath: "/ws", kind: "root" }), context({ folderPath: "/ws/app" })]));
  const rails = railIndex(orch([rail("r1", "Rail one", [])]));

  it("leaves a live selection alone, identity included", () => {
    const facets: BoardFacets = { context: "/ws/app", kind: "plan", rail: "r1" };
    expect(pruneFacets(facets, contexts, rails)).toBe(facets);
  });

  it("resets a context that is no longer in the tree", () => {
    expect(pruneFacets({ ...NO_FACETS, context: "/ws/gone" }, contexts, rails).context).toBe(ANY);
  });

  it("resets a rail that was deleted, but never NO_RAIL", () => {
    expect(pruneFacets({ ...NO_FACETS, rail: "r9" }, contexts, rails).rail).toBe(ANY);
    expect(pruneFacets({ ...NO_FACETS, rail: NO_RAIL }, contexts, rails).rail).toBe(NO_RAIL);
  });

  it("keeps the kind facet, which has no vocabulary to lose", () => {
    expect(pruneFacets({ context: "/ws/gone", kind: "note", rail: ANY }, contexts, rails).kind).toBe("note");
  });

  it("leaves a facet alone while its vocabulary has not loaded", () => {
    const facets: BoardFacets = { context: "/ws/gone", kind: ANY, rail: "r9" };
    expect(pruneFacets(facets, null, null)).toBe(facets);
    expect(pruneFacets(facets, null, rails)).toEqual({ context: "/ws/gone", kind: ANY, rail: ANY });
    expect(pruneFacets(facets, contexts, null)).toEqual({ context: ANY, kind: ANY, rail: "r9" });
  });
});
