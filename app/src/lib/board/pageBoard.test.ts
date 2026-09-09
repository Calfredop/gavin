import { describe, it, expect } from "vitest";
import { dropAgainstWholeBoard, pageHolding, pageScope, scopeBoardToPage, translateDropIndex } from "$lib/board/pageBoard";
import { AUTO_KEY_PREFIX } from "$lib/board/boardSearch";
import type { CardView, DisplayColumn } from "$lib/planBoard";
import type { Board, CardSession, Column } from "$lib/board/kanban";
import { emptyOrchestration } from "$lib/orchestration";
import type { Orchestration, Rail, Stage, Step } from "$lib/orchestration";
import type { Page, Workspace } from "$lib/workspace";
import type { LayoutNode } from "$lib/panes/layout";

const PLANS = "/ws/.gavin-root/plans";

function card(title: string, over: Partial<CardView> = {}): CardView {
  const fileName = `${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.md`;
  return {
    id: `${PLANS}/${fileName}`,
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

function column(id: string, planCards: CardView[]): DisplayColumn {
  const col: Column = { id, name: id, position: 0 };
  return { column: col, planCards };
}

function leaf(...tabs: string[]): LayoutNode {
  return { type: "leaf", tabs, activeTabIndex: 0 };
}

function page(id: string, layout: LayoutNode): Page {
  return { id, name: id, layout, focusedSessionId: null };
}

function binding(path: string, sessionId: string): CardSession {
  return { path, sessionId, cwd: "/ws", command: null };
}

function board(cardSessions: CardSession[]): Board {
  return { columns: [], labels: [], cardSessions };
}

function step(cardPath: string, position = 0): Step {
  return { id: `step-${cardPath}`, position, cardPath };
}

function stage(steps: Step[], position = 0): Stage {
  return { id: `stage-${position}`, position, steps };
}

function rail(id: string, pageId: string | null, cardPaths: string[]): Rail {
  return {
    id,
    name: id,
    position: 0,
    worktreePath: null,
    pageId,
    stages: cardPaths.map((p, i) => stage([step(p)], i)),
  };
}

function orch(rails: Rail[]): Orchestration {
  return { ...emptyOrchestration(), rails };
}

describe("pageScope", () => {
  it("takes a card whose bound session is a tab on this page", () => {
    const scope = pageScope(
      page("p-1", leaf("s-1", "s-2")),
      board([binding(`${PLANS}/a.md`, "s-1"), binding(`${PLANS}/b.md`, "s-elsewhere")]),
      undefined
    );
    expect([...scope.paths]).toEqual([`${PLANS}/a.md`]);
  });

  it("takes every card on a rail bound to this page, run or not", () => {
    const scope = pageScope(
      page("p-1", leaf("s-1")),
      board([]),
      orch([rail("r-1", "p-1", [`${PLANS}/a.md`, `${PLANS}/b.md`]), rail("r-2", "p-2", [`${PLANS}/c.md`])])
    );
    expect([...scope.paths].sort()).toEqual([`${PLANS}/a.md`, `${PLANS}/b.md`]);
  });

  it("unions the two halves, and counts a card in both only once", () => {
    const scope = pageScope(
      page("p-1", leaf("s-1")),
      board([binding(`${PLANS}/a.md`, "s-1")]),
      orch([rail("r-1", "p-1", [`${PLANS}/a.md`, `${PLANS}/b.md`])])
    );
    expect([...scope.paths].sort()).toEqual([`${PLANS}/a.md`, `${PLANS}/b.md`]);
  });

  // A binding row outlives the session it names. The page's LAYOUT is
  // what decides, so an exited agent's card leaves the board with its
  // tab rather than lingering as a card nothing on this page runs.
  it("drops a binding whose tab is no longer in the page's layout", () => {
    const scope = pageScope(page("p-1", leaf("s-2")), board([binding(`${PLANS}/a.md`, "s-1")]), undefined);
    expect(scope.paths.size).toBe(0);
  });

  it("reports the rails bound to this page, in position order", () => {
    const first = { ...rail("r-1", "p-1", []), position: 2 };
    const second = { ...rail("r-2", "p-1", []), position: 1 };
    const other = { ...rail("r-3", "p-2", []), position: 0 };
    const scope = pageScope(page("p-1", leaf("s-1")), board([]), orch([first, second, other]));
    expect(scope.rails.map((r) => r.id)).toEqual(["r-2", "r-1"]);
  });

  it("is empty for no page at all", () => {
    const scope = pageScope(null, board([binding(`${PLANS}/a.md`, "s-1")]), orch([rail("r-1", "p-1", [])]));
    expect(scope.paths.size).toBe(0);
    expect(scope.rails).toEqual([]);
  });
});

describe("scopeBoardToPage", () => {
  const a = card("A");
  const b = card("B");

  it("keeps the cards in scope and drops the rest", () => {
    const scoped = scopeBoardToPage({ columns: [column("todo", [a, b])], autoColumns: [] }, new Set([a.id]));
    expect(scoped.columns[0].planCards.map((c) => c.id)).toEqual([a.id]);
  });

  it("scopes the auto columns too", () => {
    const scoped = scopeBoardToPage(
      { columns: [], autoColumns: [{ status: "Blocked", planCards: [a, b] }] },
      new Set([b.id])
    );
    expect(scoped.autoColumns[0].planCards.map((c) => c.id)).toEqual([b.id]);
  });

  // The same narrowing boardSearch.project does, so the two lenses
  // compose: a plan in scope is whole, a plan out of scope survives only
  // as a home for the children that ARE in scope.
  it("keeps every child of a plan that is itself in scope", () => {
    const child = card("Child");
    const plan = card("Plan", { kind: "plan", nestedChildren: [child, card("Other")] });
    const scoped = scopeBoardToPage({ columns: [column("todo", [plan])], autoColumns: [] }, new Set([plan.id]));
    expect(scoped.columns[0].planCards[0].nestedChildren).toHaveLength(2);
  });

  it("keeps an out-of-scope plan for its in-scope children, narrowed to them", () => {
    const child = card("Child");
    const plan = card("Plan", { kind: "plan", nestedChildren: [child, card("Other")] });
    const scoped = scopeBoardToPage({ columns: [column("todo", [plan])], autoColumns: [] }, new Set([child.id]));
    expect(scoped.columns[0].planCards.map((c) => c.id)).toEqual([plan.id]);
    expect(scoped.columns[0].planCards[0].nestedChildren.map((c) => c.id)).toEqual([child.id]);
  });

  it("counts the top-level cards it kept and the ones it was given", () => {
    const scoped = scopeBoardToPage(
      { columns: [column("todo", [a, b])], autoColumns: [{ status: "Blocked", planCards: [card("C")] }] },
      new Set([a.id])
    );
    expect(scoped.inScope).toBe(1);
    expect(scoped.total).toBe(3);
  });

  it("leaves the projection it was given untouched", () => {
    const merged = { columns: [column("todo", [a, b])], autoColumns: [] };
    scopeBoardToPage(merged, new Set([a.id]));
    expect(merged.columns[0].planCards).toHaveLength(2);
  });
});

// computeOrderWrites renumbers whatever list it is handed, so a drop
// committed against the page's SUBSET would reshuffle the cards this
// board hides relative to the ones it shows. The visual slot is
// translated into the full column instead: land right after the visible
// card you were dropped after.
describe("translateDropIndex", () => {
  const [a, b, c, d] = [card("A"), card("B"), card("C"), card("D")];
  const full = [a, b, c, d];
  const scoped = [b, d];

  it("maps a drop after a visible card to the slot right after it", () => {
    expect(translateDropIndex(scoped, full, 1)).toBe(2); // after B
    expect(translateDropIndex(scoped, full, 2)).toBe(4); // after D
  });

  it("maps a drop at the top to the slot right before the first visible card", () => {
    expect(translateDropIndex(scoped, full, 0)).toBe(1); // before B
  });

  it("appends when the page shows nothing in that column", () => {
    expect(translateDropIndex([], full, 0)).toBe(4);
  });

  it("is the identity when the page shows the whole column", () => {
    expect(translateDropIndex(full, full, 0)).toBe(0);
    expect(translateDropIndex(full, full, 2)).toBe(2);
    expect(translateDropIndex(full, full, 4)).toBe(4);
  });

  it("clamps an index past either end", () => {
    expect(translateDropIndex(scoped, full, 99)).toBe(4);
    expect(translateDropIndex(scoped, full, -1)).toBe(1);
  });

  // The dragged card is excluded from both lists by the drag engine, so
  // a neighbour the full list does not know is a projection that moved
  // under the drop. Appending is the honest answer.
  it("appends when a visible neighbour is not in the full column", () => {
    expect(translateDropIndex([card("Z")], full, 1)).toBe(4);
  });
});

describe("pageHolding", () => {
  function workspace(id: string, pages: Page[]): Workspace {
    return { id, name: id, pages, activePageId: pages[0]?.id ?? null };
  }

  it("finds the page whose layout holds the tab", () => {
    const ws = [
      workspace("ws-1", [page("p-1", leaf("a", "b")), page("p-2", leaf("c"))]),
      workspace("ws-2", [page("p-3", leaf("d"))]),
    ];
    expect(pageHolding(ws, "c")?.id).toBe("p-2");
    expect(pageHolding(ws, "d")?.id).toBe("p-3");
  });

  it("is null for a tab no tree holds, and for no tab at all", () => {
    const ws = [workspace("ws-1", [page("p-1", leaf("a"))])];
    expect(pageHolding(ws, "gone")).toBeNull();
    expect(pageHolding(ws, null)).toBeNull();
  });
});

describe("dropAgainstWholeBoard", () => {
  const [a, b, c] = [card("A"), card("B"), card("C")];
  const merged = { columns: [column("todo", [a, b, c])], autoColumns: [] };
  const scoped = { columns: [column("todo", [c])], autoColumns: [] };

  it("translates the visual slot into one over the whole column", () => {
    const drag = { id: a.id, target: { columnId: "todo", index: 1 } };
    // Dropped after C, the only card the page shows: C sits last in the
    // full column once the dragged A is taken out of it.
    expect(dropAgainstWholeBoard(drag, scoped, merged).target.index).toBe(2);
  });

  it("leaves a nest drop alone -- a shown card keeps all its children", () => {
    const drag = { id: a.id, target: { columnId: "todo", index: 1, nest: b.id } };
    expect(dropAgainstWholeBoard(drag, scoped, merged).target).toEqual(drag.target);
  });

  it("is the identity when the board was never scoped", () => {
    const drag = { id: a.id, target: { columnId: "todo", index: 1 } };
    expect(dropAgainstWholeBoard(drag, null, merged)).toBe(drag);
  });

  it("translates a drop into an auto column too", () => {
    const full = { columns: [], autoColumns: [{ status: "Blocked", planCards: [a, b, c] }] };
    const page = { columns: [], autoColumns: [{ status: "Blocked", planCards: [c] }] };
    const drag = { id: a.id, target: { columnId: `${AUTO_KEY_PREFIX}Blocked`, index: 0 } };
    // Dropped above C, which the full column holds at index 1 once A is out.
    expect(dropAgainstWholeBoard(drag, page, full).target.index).toBe(1);
  });
});
