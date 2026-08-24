import { describe, it, expect } from "vitest";
import { searchOrchestration, stepMatches } from "./orchestrationSearch";
import type { CardEntry, Orchestration, Rail, UnplacedGroup } from "./orchestration";
import type { PlanFileInfo } from "./gavin";

function plan(fileName: string, title: string, over: Partial<PlanFileInfo> = {}): PlanFileInfo {
  return {
    path: `/ws/.gavin-root/plans/${fileName}`,
    fileName,
    title,
    status: "To Do",
    priority: null,
    order: null,
    kind: "task",
    parent: null,
    labels: [],
    checklistDone: 0,
    checklistTotal: 0,
    parseWarning: false,
    ...over,
  };
}

function entry(p: PlanFileInfo): CardEntry {
  return { plan: p, contextFolder: "/ws" };
}

const gitTab = plan("git-tab.md", "Git tab");
const kanban = plan("kanban-search.md", "Kanban search");
const cards = new Map<string, CardEntry>([
  [gitTab.path, entry(gitTab)],
  [kanban.path, entry(kanban)],
]);

function rail(id: string, name: string, cardPaths: string[]): Rail {
  return {
    id,
    name,
    position: 0,
    worktreePath: null,
    pageId: null,
    stages: cardPaths.map((path, i) => ({
      id: `${id}-s${i}`,
      position: i,
      steps: [{ id: `${id}-t${i}`, cardPath: path, position: 0 }],
    })),
  };
}

function orch(rails: Rail[]): Orchestration {
  return { rails, conflictNotes: [], railRuns: [], stepRuns: [] };
}

describe("stepMatches", () => {
  it("matches a step through the card it points at", () => {
    expect(stepMatches({ id: "t", cardPath: gitTab.path, position: 0 }, cards, ["git"])).toBe(true);
    expect(stepMatches({ id: "t", cardPath: gitTab.path, position: 0 }, cards, ["kanban"])).toBe(false);
  });

  it("never matches a step whose card has vanished", () => {
    expect(stepMatches({ id: "t", cardPath: "/gone.md", position: 0 }, cards, ["git"])).toBe(false);
  });
});

describe("searchOrchestration", () => {
  const rails = [rail("r1", "Backend", [gitTab.path]), rail("r2", "Frontend", [kanban.path])];

  it("is inert for a blank query", () => {
    const out = searchOrchestration(orch(rails), cards, "  ");
    expect(out.filtering).toBe(false);
    expect(out.railShown("r1")).toBe(true);
    expect(out.railShown("r2")).toBe(true);
    expect(out.stepLit("r1-t0")).toBe(false);
  });

  it("keeps only the rails holding a match, and lights the matching steps", () => {
    const out = searchOrchestration(orch(rails), cards, "git");
    expect(out.filtering).toBe(true);
    expect(out.railShown("r1")).toBe(true);
    expect(out.railShown("r2")).toBe(false);
    expect(out.stepLit("r1-t0")).toBe(true);
    expect(out.stepLit("r2-t0")).toBe(false);
    expect(out.railsShown).toBe(1);
    expect(out.stepsMatched).toBe(1);
  });

  it("keeps a whole rail whose NAME matches, without lighting its steps", () => {
    const out = searchOrchestration(orch(rails), cards, "frontend");
    expect(out.railShown("r2")).toBe(true);
    expect(out.railShown("r1")).toBe(false);
    expect(out.stepLit("r2-t0")).toBe(false);
    expect(out.stepsMatched).toBe(0);
  });

  it("matches a rail on its worktree path too", () => {
    const bound: Rail = { ...rails[0], worktreePath: "/ws/../gavin-hotfix" };
    const out = searchOrchestration(orch([bound]), cards, "hotfix");
    expect(out.railShown("r1")).toBe(true);
  });
});

describe("filterUnplaced", () => {
  const groups: UnplacedGroup[] = [
    { status: "To Do", slug: "to-do", isDone: false, cards: [entry(gitTab), entry(kanban)] },
    { status: "Shipped", slug: "shipped", isDone: true, cards: [] },
  ];

  it("returns the groups untouched for a blank query", () => {
    const out = searchOrchestration(orch([]), cards, "").filterUnplaced(groups);
    expect(out.groups).toBe(groups);
    expect(out.shown).toBe(2);
    expect(out.total).toBe(2);
  });

  it("drops non-matching cards and the groups left empty", () => {
    const out = searchOrchestration(orch([]), cards, "kanban").filterUnplaced(groups);
    expect(out.groups).toHaveLength(1);
    expect(out.groups[0].cards.map((c) => c.plan.title)).toEqual(["Kanban search"]);
    expect(out.shown).toBe(1);
    expect(out.total).toBe(2);
  });

  // The group's own name is a match target, the way a rail's name is:
  // searching "shipped" should show what is in Shipped, whatever the
  // individual cards are called.
  it("keeps a group whose STATUS name matches, with all of its cards", () => {
    const shipped: UnplacedGroup[] = [
      { status: "Shipped", slug: "shipped", isDone: true, cards: [entry(gitTab), entry(kanban)] },
    ];
    const out = searchOrchestration(orch([]), cards, "shipped").filterUnplaced(shipped);
    expect(out.groups).toHaveLength(1);
    expect(out.groups[0].cards).toHaveLength(2);
  });

  // Both counts are "how much is still waiting for a rail", so a done
  // group's cards are listed in the drawer but never counted -- the
  // header would otherwise report finished work as outstanding.
  const withDone: UnplacedGroup[] = [
    { status: "To Do", slug: "to-do", isDone: false, cards: [entry(gitTab), entry(kanban)] },
    { status: "Done", slug: "done", isDone: true, cards: [entry(gitTab)] },
  ];

  it("never counts a done group, for a blank query", () => {
    const out = searchOrchestration(orch([]), cards, "").filterUnplaced(withDone);
    expect(out.groups).toBe(withDone);
    expect(out.shown).toBe(2);
    expect(out.total).toBe(2);
  });

  it("never counts a done group while filtering", () => {
    const out = searchOrchestration(orch([]), cards, "kanban").filterUnplaced(withDone);
    expect(out.groups).toHaveLength(1);
    expect(out.shown).toBe(1);
    expect(out.total).toBe(2);
  });

  it("shows zero when the only matches are done cards", () => {
    const out = searchOrchestration(orch([]), cards, "git").filterUnplaced(withDone);
    expect(out.groups.map((g) => g.status)).toEqual(["To Do", "Done"]);
    expect(out.shown).toBe(1);
    expect(out.total).toBe(2);
  });
});
