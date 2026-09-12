import { describe, it, expect } from "vitest";
import {
  ANY,
  ALL_CONTEXTS_LABEL,
  ANY_KIND_LABEL,
  KIND_FACETS,
  NO_FACETS,
  NO_RAIL,
  cardPasses,
  contextFacets,
  emptyExclude,
  emptyFacets,
  facetMenuEntries,
  facetSummary,
  facetsActive,
  facetsEqual,
  filterBoardByFacets,
  filterCards,
  labelFacets,
  pruneFacets,
  railFacets,
  toggleFacet,
  toggleFacetExclude,
  underContext,
  type BoardFacets,
  type FacetExclude,
} from "$lib/board/boardFilters";
import { AUTO_KEY_PREFIX } from "$lib/board/boardSearch";
import { isMenuItem } from "$lib/core/contextMenu";
import { railIndex } from "$lib/board/planFilter";
import type { RailIndex } from "$lib/board/planFilter";
import type { AutoColumn, CardView, DisplayColumn } from "$lib/core/planBoard";
import type { GavinContext, GavinTree } from "$lib/core/gavin";
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

function facets(over: Partial<BoardFacets> = {}): BoardFacets {
  return { ...emptyFacets(), ...over };
}

function excluded(over: Partial<FacetExclude> = {}): FacetExclude {
  return { ...emptyExclude(), ...over };
}

describe("facetsActive", () => {
  it("is false for the unset state and true for each facet alone", () => {
    expect(facetsActive(NO_FACETS)).toBe(false);
    expect(facetsActive(facets({ context: ["/ws/app"] }))).toBe(true);
    expect(facetsActive(facets({ kind: ["plan"] }))).toBe(true);
    expect(facetsActive(facets({ rail: [NO_RAIL] }))).toBe(true);
    expect(facetsActive(facets({ label: ["windows"] }))).toBe(true);
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
  it("offers inside contexts by path, then outside ones, and never the root", () => {
    const t = tree([
      context({ folderPath: "/ws/app", name: "app" }),
      context({ folderPath: "/ws", kind: "root", name: "ws" }),
      context({ folderPath: "/elsewhere/lib", name: "lib", outside: true }),
      context({ folderPath: "/ws/app/ui", name: "ui" }),
    ]);
    expect(contextFacets(t).map((c) => [c.value, c.label])).toEqual([
      ["/ws/app", "app"],
      ["/ws/app/ui", "app/ui"],
      ["/elsewhere/lib", "lib (outside)"],
    ]);
  });

  it("is empty with no tree — empty selection already means every card", () => {
    expect(contextFacets(undefined)).toEqual([]);
    expect(contextFacets(tree([], { rootMissing: true }))).toEqual([]);
  });
});

describe("cardPasses", () => {
  const rails = railIndex(orch([rail("r1", "Rail one", ["/ws/.gavin-root/plans/a.md"])]));

  it("passes everything when no facet is set", () => {
    expect(cardPasses(card("a"), NO_FACETS, EMPTY_RAILS)).toBe(true);
  });

  it("scopes to a context and its subfolders", () => {
    const selected = facets({ context: ["/ws/app"] });
    expect(cardPasses(card("a", { contextFolder: "/ws/app" }), selected, EMPTY_RAILS)).toBe(true);
    expect(cardPasses(card("a", { contextFolder: "/ws/app/ui" }), selected, EMPTY_RAILS)).toBe(true);
    expect(cardPasses(card("a", { contextFolder: "/ws" }), selected, EMPTY_RAILS)).toBe(false);
  });

  it("matches the card kind exactly", () => {
    const selected = facets({ kind: ["plan"] });
    expect(cardPasses(card("a", { kind: "plan" }), selected, EMPTY_RAILS)).toBe(true);
    expect(cardPasses(card("a", { kind: "task" }), selected, EMPTY_RAILS)).toBe(false);
  });

  it("matches the rail carrying the card, and NO_RAIL the unplaced ones", () => {
    const onRail = card("a");
    const unplaced = card("b");
    expect(cardPasses(onRail, facets({ rail: ["r1"] }), rails)).toBe(true);
    expect(cardPasses(unplaced, facets({ rail: ["r1"] }), rails)).toBe(false);
    expect(cardPasses(unplaced, facets({ rail: [NO_RAIL] }), rails)).toBe(true);
    expect(cardPasses(onRail, facets({ rail: [NO_RAIL] }), rails)).toBe(false);
  });

  it("ORs several values inside one facet", () => {
    expect(cardPasses(card("a", { kind: "plan" }), facets({ kind: ["plan", "note"] }), EMPTY_RAILS)).toBe(true);
    expect(cardPasses(card("a", { kind: "note" }), facets({ kind: ["plan", "note"] }), EMPTY_RAILS)).toBe(true);
    expect(cardPasses(card("a", { kind: "task" }), facets({ kind: ["plan", "note"] }), EMPTY_RAILS)).toBe(false);
  });

  it("ORs several contexts, still path-segment aware", () => {
    const selected = facets({ context: ["/ws/app", "/ws/lib"] });
    expect(cardPasses(card("a", { contextFolder: "/ws/app" }), selected, EMPTY_RAILS)).toBe(true);
    expect(cardPasses(card("a", { contextFolder: "/ws/lib" }), selected, EMPTY_RAILS)).toBe(true);
    expect(cardPasses(card("a", { contextFolder: "/ws" }), selected, EMPTY_RAILS)).toBe(false);
  });

  it("ORs a rail with NO_RAIL", () => {
    const onRail = card("a");
    const unplaced = card("b");
    const selected = facets({ rail: ["r1", NO_RAIL] });
    expect(cardPasses(onRail, selected, rails)).toBe(true);
    expect(cardPasses(unplaced, selected, rails)).toBe(true);
  });

  it("ANDs the facets", () => {
    const selected = facets({ context: ["/ws"], kind: ["task"], rail: ["r1"] });
    expect(cardPasses(card("a"), selected, rails)).toBe(true);
    expect(cardPasses(card("a", { kind: "plan" }), selected, rails)).toBe(false);
  });

  it("inverts one kind so that kind drops", () => {
    const selected = facets({ kind: ["plan"], exclude: excluded({ kind: ["plan"] }) });
    expect(cardPasses(card("a", { kind: "plan" }), selected, EMPTY_RAILS)).toBe(false);
    expect(cardPasses(card("a", { kind: "task" }), selected, EMPTY_RAILS)).toBe(true);
    expect(cardPasses(card("a", { kind: "note" }), selected, EMPTY_RAILS)).toBe(true);
  });

  it("inverts several kinds with no include — none of them may match", () => {
    const selected = facets({ kind: ["plan", "note"], exclude: excluded({ kind: ["plan", "note"] }) });
    expect(cardPasses(card("a", { kind: "plan" }), selected, EMPTY_RAILS)).toBe(false);
    expect(cardPasses(card("a", { kind: "note" }), selected, EMPTY_RAILS)).toBe(false);
    expect(cardPasses(card("a", { kind: "task" }), selected, EMPTY_RAILS)).toBe(true);
  });

  it("can include one kind and invert another", () => {
    const selected = facets({ kind: ["plan", "note"], exclude: excluded({ kind: ["note"] }) });
    expect(cardPasses(card("a", { kind: "plan" }), selected, EMPTY_RAILS)).toBe(true);
    expect(cardPasses(card("a", { kind: "note" }), selected, EMPTY_RAILS)).toBe(false);
    expect(cardPasses(card("a", { kind: "task" }), selected, EMPTY_RAILS)).toBe(false);
  });

  it("inverts a context facet, still path-segment aware", () => {
    const selected = facets({ context: ["/ws/app"], exclude: excluded({ context: ["/ws/app"] }) });
    expect(cardPasses(card("a", { contextFolder: "/ws/app" }), selected, EMPTY_RAILS)).toBe(false);
    expect(cardPasses(card("a", { contextFolder: "/ws/app/ui" }), selected, EMPTY_RAILS)).toBe(false);
    expect(cardPasses(card("a", { contextFolder: "/ws" }), selected, EMPTY_RAILS)).toBe(true);
    expect(cardPasses(card("a", { contextFolder: "/ws/app2" }), selected, EMPTY_RAILS)).toBe(true);
  });

  it("inverts a rail facet, including On no rail", () => {
    const onRail = card("a");
    const unplaced = card("b");
    expect(cardPasses(onRail, facets({ rail: ["r1"], exclude: excluded({ rail: ["r1"] }) }), rails)).toBe(false);
    expect(cardPasses(unplaced, facets({ rail: ["r1"], exclude: excluded({ rail: ["r1"] }) }), rails)).toBe(true);
    expect(cardPasses(unplaced, facets({ rail: [NO_RAIL], exclude: excluded({ rail: [NO_RAIL] }) }), rails)).toBe(false);
    expect(cardPasses(onRail, facets({ rail: [NO_RAIL], exclude: excluded({ rail: [NO_RAIL] }) }), rails)).toBe(true);
  });

  it("ignores an invert whose option is not ticked", () => {
    const selected = facets({ exclude: excluded({ kind: ["plan"] }) });
    expect(cardPasses(card("a", { kind: "plan" }), selected, EMPTY_RAILS)).toBe(true);
    expect(facetsActive(selected)).toBe(false);
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
    const out = filterBoardByFacets(merged, facets({ context: ["/ws/app"] }), EMPTY_RAILS);
    expect(out.columns[0].planCards).toEqual([]);
    expect(out.autoColumns[0].planCards.map((c) => c.title)).toEqual(["away"]);
    expect(out.shown).toBe(1);
    expect(out.total).toBe(3);
  });

  it("counts what each column lost, so its destructive actions can refuse", () => {
    const out = filterBoardByFacets(merged, facets({ kind: ["plan"] }), EMPTY_RAILS);
    expect(out.hiddenIn("todo")).toBe(1);
    expect(out.hiddenIn("done")).toBe(0);
    expect(out.hiddenIn(AUTO_KEY_PREFIX + "Blocked")).toBe(1);
    expect(out.hiddenIn("nosuchcolumn")).toBe(0);
  });

  it("never mutates the projection it is given", () => {
    filterBoardByFacets(merged, facets({ kind: ["plan"] }), EMPTY_RAILS);
    expect(merged.columns[0].planCards).toHaveLength(2);
    expect(merged.autoColumns[0].planCards).toHaveLength(1);
  });

  it("keeps a passing card's children whole", () => {
    const child = card("child", { kind: "task" });
    const parent = card("parent", { kind: "plan", nestedChildren: [child] });
    const out = filterBoardByFacets(
      { columns: [column("todo", [parent])], autoColumns: [] },
      facets({ kind: ["plan"] }),
      EMPTY_RAILS
    );
    expect(out.columns[0].planCards[0].nestedChildren.map((c) => c.title)).toEqual(["child"]);
  });

  it("keeps a failing card as a home for the children that pass", () => {
    const hit = card("hit", { kind: "task" });
    const miss = card("miss", { kind: "note" });
    const parent = card("parent", { kind: "plan", nestedChildren: [miss, hit] });
    const out = filterBoardByFacets(
      { columns: [column("todo", [parent])], autoColumns: [] },
      facets({ kind: ["task"] }),
      EMPTY_RAILS
    );
    expect(out.columns[0].planCards).toHaveLength(1);
    expect(out.columns[0].planCards[0].nestedChildren.map((c) => c.title)).toEqual(["hit"]);
    // The home does not count as a shown card of its own kind, but it is
    // the top-level card the column renders, so it counts once.
    expect(out.shown).toBe(1);
  });

  it("drops a card whose children all fail too", () => {
    const parent = card("parent", { kind: "plan", nestedChildren: [card("child", { kind: "note" })] });
    const out = filterBoardByFacets(
      { columns: [column("todo", [parent])], autoColumns: [] },
      facets({ kind: ["task"] }),
      EMPTY_RAILS
    );
    expect(out.columns[0].planCards).toEqual([]);
    expect(out.shown).toBe(0);
  });

  it("reaches a nested task on a rail whose parent plan is on none", () => {
    const child = card("child", { kind: "task" });
    const parent = card("parent", { kind: "plan", nestedChildren: [child] });
    const rails = railIndex(orch([rail("r1", "Rail one", [child.id])]));
    const out = filterBoardByFacets(
      { columns: [column("todo", [parent])], autoColumns: [] },
      facets({ rail: ["r1"] }),
      rails
    );
    expect(out.columns[0].planCards[0].nestedChildren.map((c) => c.title)).toEqual(["child"]);
  });
});

describe("filterCards", () => {
  it("is the same lens over a flat list, and the identity when unset", () => {
    const cards = [card("a", { kind: "plan" }), card("b", { kind: "note" })];
    expect(filterCards(cards, NO_FACETS, EMPTY_RAILS)).toBe(cards);
    expect(filterCards(cards, facets({ kind: ["note"] }), EMPTY_RAILS).map((c) => c.title)).toEqual(["b"]);
  });
});

describe("pruneFacets", () => {
  const contexts = contextFacets(
    tree([context({ folderPath: "/ws", kind: "root" }), context({ folderPath: "/ws/app" })])
  );
  const rails = railIndex(orch([rail("r1", "Rail one", [])]));

  it("leaves a live selection alone, identity included", () => {
    const selected = facets({ context: ["/ws/app"], kind: ["plan"], rail: ["r1"] });
    expect(pruneFacets(selected, contexts, rails)).toBe(selected);
  });

  it("drops a context that is no longer in the tree, and keeps the live ones", () => {
    expect(pruneFacets(facets({ context: ["/ws/gone"] }), contexts, rails).context).toEqual([]);
    expect(pruneFacets(facets({ context: ["/ws/app", "/ws/gone"] }), contexts, rails).context).toEqual(["/ws/app"]);
  });

  it("resets a rail that was deleted, but never NO_RAIL", () => {
    expect(pruneFacets(facets({ rail: ["r9"] }), contexts, rails).rail).toEqual([]);
    expect(pruneFacets(facets({ rail: [NO_RAIL] }), contexts, rails).rail).toEqual([NO_RAIL]);
    expect(pruneFacets(facets({ rail: ["r1", "r9"] }), contexts, rails).rail).toEqual(["r1"]);
  });

  it("keeps the kind facet, which has no vocabulary to lose", () => {
    expect(pruneFacets(facets({ context: ["/ws/gone"], kind: ["note"] }), contexts, rails).kind).toEqual(["note"]);
  });

  it("leaves a facet alone while its vocabulary has not loaded", () => {
    const selected = facets({ context: ["/ws/gone"], rail: ["r9"] });
    expect(pruneFacets(selected, null, null)).toBe(selected);
    expect(pruneFacets(selected, null, rails)).toEqual(facets({ context: ["/ws/gone"], rail: [] }));
    expect(pruneFacets(selected, contexts, null)).toEqual(facets({ context: [], rail: ["r9"] }));
  });
});

describe("labelFacets", () => {
  it("offers each name and nothing else — no Any row, no Not pair", () => {
    expect(labelFacets([{ name: "windows" }, { name: "memory" }]).map((o) => [o.value, o.label])).toEqual([
      ["windows", "windows"],
      ["memory", "memory"],
    ]);
  });
});

describe("cardPasses label facet", () => {
  it("keeps a card that carries the label, slug-matched like a column", () => {
    const selected = facets({ label: ["windows"] });
    expect(cardPasses(card("a", { labels: ["windows"] }), selected, EMPTY_RAILS)).toBe(true);
    expect(cardPasses(card("a", { labels: [" Windows "] }), selected, EMPTY_RAILS)).toBe(true);
    expect(cardPasses(card("a", { labels: ["memory"] }), selected, EMPTY_RAILS)).toBe(false);
    expect(cardPasses(card("a"), selected, EMPTY_RAILS)).toBe(false);
  });

  it("ORs several labels — a card carrying any of them passes", () => {
    const selected = facets({ label: ["windows", "memory"] });
    expect(cardPasses(card("a", { labels: ["windows"] }), selected, EMPTY_RAILS)).toBe(true);
    expect(cardPasses(card("a", { labels: ["memory"] }), selected, EMPTY_RAILS)).toBe(true);
    expect(cardPasses(card("a", { labels: ["windows", "memory"] }), selected, EMPTY_RAILS)).toBe(true);
    expect(cardPasses(card("a"), selected, EMPTY_RAILS)).toBe(false);
  });

  it("ANDs the label with the other facets", () => {
    const selected = facets({ context: ["/ws"], kind: ["task"], label: ["windows"] });
    expect(cardPasses(card("a", { labels: ["windows"] }), selected, EMPTY_RAILS)).toBe(true);
    expect(cardPasses(card("a", { kind: "plan", labels: ["windows"] }), selected, EMPTY_RAILS)).toBe(false);
  });

  it("inverts a label facet so a card carrying any chosen label drops", () => {
    const selected = facets({ label: ["windows"], exclude: excluded({ label: ["windows"] }) });
    expect(cardPasses(card("a", { labels: ["windows"] }), selected, EMPTY_RAILS)).toBe(false);
    expect(cardPasses(card("a", { labels: [" Windows "] }), selected, EMPTY_RAILS)).toBe(false);
    expect(cardPasses(card("a", { labels: ["memory"] }), selected, EMPTY_RAILS)).toBe(true);
    expect(cardPasses(card("a"), selected, EMPTY_RAILS)).toBe(true);
  });

  it("inverts several labels — a card carrying any of them fails", () => {
    const selected = facets({
      label: ["windows", "memory"],
      exclude: excluded({ label: ["windows", "memory"] }),
    });
    expect(cardPasses(card("a", { labels: ["windows"] }), selected, EMPTY_RAILS)).toBe(false);
    expect(cardPasses(card("a", { labels: ["memory"] }), selected, EMPTY_RAILS)).toBe(false);
    expect(cardPasses(card("a"), selected, EMPTY_RAILS)).toBe(true);
  });

  it("can require one label and invert another", () => {
    const selected = facets({
      label: ["windows", "memory"],
      exclude: excluded({ label: ["memory"] }),
    });
    expect(cardPasses(card("a", { labels: ["windows"] }), selected, EMPTY_RAILS)).toBe(true);
    expect(cardPasses(card("a", { labels: ["memory"] }), selected, EMPTY_RAILS)).toBe(false);
    expect(cardPasses(card("a", { labels: ["windows", "memory"] }), selected, EMPTY_RAILS)).toBe(false);
    expect(cardPasses(card("a"), selected, EMPTY_RAILS)).toBe(false);
  });
});

describe("pruneFacets label", () => {
  const labels = [{ name: "windows" }, { name: "memory" }];

  it("drops a label that left the vocabulary and keeps the live ones", () => {
    expect(pruneFacets(facets({ label: ["gone"] }), null, null, labels).label).toEqual([]);
    expect(pruneFacets(facets({ label: ["windows", "gone"] }), null, null, labels).label).toEqual(["windows"]);
  });

  it("keeps a live label", () => {
    expect(pruneFacets(facets({ label: ["windows"] }), null, null, labels).label).toEqual(["windows"]);
  });

  it("leaves the label alone while the vocabulary has not loaded", () => {
    const selected = facets({ label: ["gone"] });
    expect(pruneFacets(selected, null, null, null)).toBe(selected);
  });

  it("drops an invert whose option left the vocabulary", () => {
    const selected = facets({
      label: ["windows", "gone"],
      exclude: excluded({ label: ["windows", "gone"] }),
    });
    const next = pruneFacets(selected, null, null, labels);
    expect(next.label).toEqual(["windows"]);
    expect(next.exclude.label).toEqual(["windows"]);
  });
});

describe("toggleFacet / facetSummary / facetMenuEntries", () => {
  it("adds a missing value and drops a present one", () => {
    expect(toggleFacet([], "plan")).toEqual(["plan"]);
    expect(toggleFacet(["plan"], "task")).toEqual(["plan", "task"]);
    expect(toggleFacet(["plan", "task"], "plan")).toEqual(["task"]);
  });

  it("summarises in option order, and reads the empty label when nothing is ticked", () => {
    expect(facetSummary([], KIND_FACETS, ANY_KIND_LABEL)).toBe(ANY_KIND_LABEL);
    expect(facetSummary(["task"], KIND_FACETS, ANY_KIND_LABEL)).toBe("Tasks");
    expect(facetSummary(["note", "plan"], KIND_FACETS, ANY_KIND_LABEL)).toBe("Plans, Notes");
  });

  it("prefixes only the inverted options in the summary", () => {
    expect(facetSummary(["task"], KIND_FACETS, ANY_KIND_LABEL, ["task"])).toBe("Not Tasks");
    expect(facetSummary(["note", "plan"], KIND_FACETS, ANY_KIND_LABEL, ["note"])).toBe("Plans, Not Notes");
    expect(facetSummary([], KIND_FACETS, ANY_KIND_LABEL, ["plan"])).toBe(ANY_KIND_LABEL);
  });

  it("selects an option as inverted, then switches it back to include", () => {
    expect(toggleFacetExclude([], [], "plan")).toEqual({ selected: ["plan"], exclude: ["plan"] });
    expect(toggleFacetExclude(["plan"], [], "plan")).toEqual({ selected: ["plan"], exclude: ["plan"] });
    expect(toggleFacetExclude(["plan"], ["plan"], "plan")).toEqual({ selected: ["plan"], exclude: [] });
  });

  it("builds keep-open checkboxes with a NOT switch on each row", () => {
    const picked: string[] = [];
    const inverted: string[] = [];
    const entries = facetMenuEntries(KIND_FACETS, ["plan"], ["plan"], (v) => picked.push(v), (v) => inverted.push(v));
    expect(entries.every(isMenuItem)).toBe(true);
    expect(
      entries.map((e) =>
        isMenuItem(e) ? [e.label, e.checked, e.keepOpen, e.switch?.label, e.switch?.active] : null
      )
    ).toEqual([
      ["Plans", true, true, "NOT", true],
      ["Tasks", false, true, "NOT", false],
      ["Notes", false, true, "NOT", false],
    ]);
    const task = entries[1];
    if (isMenuItem(task)) {
      task.onPick();
      task.switch?.onPick();
    }
    expect(picked).toEqual(["task"]);
    expect(inverted).toEqual(["task"]);
  });
});

describe("railFacets", () => {
  it("leads with On no rail, then each rail", () => {
    expect(railFacets(railIndex(orch([rail("r1", "Rail one", [])]))).map((o) => [o.value, o.label])).toEqual([
      [NO_RAIL, "On no rail"],
      ["r1", "Rail one"],
    ]);
  });
});

describe("facetsEqual", () => {
  it("compares by contents, not by identity", () => {
    expect(facetsEqual(facets({ kind: ["plan"] }), facets({ kind: ["plan"] }))).toBe(true);
    expect(facetsEqual(facets({ kind: ["plan"] }), facets({ kind: ["task"] }))).toBe(false);
    expect(facetsEqual(NO_FACETS, emptyFacets())).toBe(true);
  });

  it("treats a polarity flip as a different answer", () => {
    const include = facets({ kind: ["plan"] });
    const exclude = facets({ kind: ["plan"], exclude: excluded({ kind: ["plan"] }) });
    expect(facetsEqual(include, exclude)).toBe(false);
  });
});

describe("emptyFacets", () => {
  it("returns a fresh object so two unset states do not share arrays", () => {
    const a = emptyFacets();
    const b = emptyFacets();
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
    expect(a.kind).not.toBe(b.kind);
    expect(a.exclude).not.toBe(b.exclude);
    expect(a.exclude.kind).not.toBe(b.exclude.kind);
  });
});

describe("ANY", () => {
  it("is still the empty-string sentinel the Plans query uses", () => {
    expect(ANY).toBe("");
    expect(ALL_CONTEXTS_LABEL).toBe("All contexts");
  });
});
