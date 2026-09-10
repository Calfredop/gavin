import { describe, it, expect } from "vitest";
import { searchDrawer, searchOrchestration, stepMatches } from "$lib/orchestration/orchestrationSearch";
import type { Tool } from "$lib/orchestration/orchestrationTools";
import type { GroupTemplate } from "$lib/orchestration/orchestrationGroups";
import type { CardEntry, Orchestration, Rail, UnplacedGroup } from "$lib/orchestration/orchestration";
import type { PlanFileInfo } from "$lib/core/gavin";

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

describe("searchDrawer", () => {
  function tool(over: Partial<Tool> & Pick<Tool, "id" | "name">): Tool {
    return {
      description: "",
      kind: "command",
      body: "",
      params: [],
      scope: "builtin",
      ...over,
    };
  }
  function template(over: Partial<GroupTemplate> & Pick<GroupTemplate, "id" | "name">): GroupTemplate {
    return { description: "", mode: "parallel", steps: [], scope: "workspace", ...over };
  }

  const tools: Tool[] = [
    tool({ id: "builtin:merge", name: "Merge", description: "Bring main in" }),
    tool({ id: "t2", name: "Ship it", kind: "agent", scope: "workspace" }),
    tool({ id: "t3", name: "Lint", kind: "script", scope: "global" }),
  ];
  const templates: GroupTemplate[] = [
    template({ id: "g1", name: "Review then merge" }),
    template({ id: "g2", name: "Smoke", scope: "global", mode: "sequence" }),
  ];
  const groups: UnplacedGroup[] = [
    { status: "To Do", slug: "to-do", isDone: false, cards: [entry(gitTab), entry(kanban)] },
    { status: "Done", slug: "done", isDone: true, cards: [entry(gitTab)] },
  ];
  const lists = { templates, tools, groups };

  it("hands every list back untouched for a blank query", () => {
    const out = searchDrawer("   ", lists);
    expect(out.filtering).toBe(false);
    expect(out.tools).toBe(tools);
    expect(out.templates).toBe(templates);
    expect(out.groups).toBe(groups);
    expect(out.cardsShown).toBe(2);
    expect(out.cardsTotal).toBe(2);
  });

  // The whole point of this second box: the tab's lens searches cards
  // and rails, so a tool -- which has never been on a rail -- was
  // unfindable by any query at all.
  it("finds a tool by name", () => {
    const out = searchDrawer("lint", lists);
    expect(out.filtering).toBe(true);
    expect(out.tools.map((t) => t.name)).toEqual(["Lint"]);
    expect(out.toolsTotal).toBe(3);
  });

  it("finds a tool by its description, its kind and its scope", () => {
    expect(searchDrawer("main", lists).tools.map((t) => t.name)).toEqual(["Merge"]);
    expect(searchDrawer("agent", lists).tools.map((t) => t.name)).toEqual(["Ship it"]);
    expect(searchDrawer("global", lists).tools.map((t) => t.name)).toEqual(["Lint"]);
  });

  // The row's tooltip says "Bash command" / "Agent prompt", so those are
  // the words a human reads off the panel and then types back into it.
  it("finds a tool by the words its own kind label uses", () => {
    expect(searchDrawer("bash command", lists).tools.map((t) => t.name)).toEqual(["Merge"]);
    expect(searchDrawer("prompt", lists).tools.map((t) => t.name)).toEqual(["Ship it"]);
  });

  it("filters saved groups on the same query", () => {
    const out = searchDrawer("merge", lists);
    expect(out.templates.map((t) => t.name)).toEqual(["Review then merge"]);
    expect(out.templatesTotal).toBe(2);
    expect(out.tools.map((t) => t.name)).toEqual(["Merge"]);
  });

  it("filters the unplaced cards exactly as the tab's lens does", () => {
    const out = searchDrawer("kanban", lists);
    expect(out.groups).toHaveLength(1);
    expect(out.groups[0].cards.map((c) => c.plan.title)).toEqual(["Kanban search"]);
    expect(out.cardsShown).toBe(1);
    expect(out.cardsTotal).toBe(2);
  });

  // Same rule the header count has always followed: a done group is
  // listed but never counted, so the panel cannot report finished work
  // as still waiting for a rail.
  it("never counts a done group in either number", () => {
    const out = searchDrawer("git", lists);
    expect(out.groups.map((g) => g.status)).toEqual(["To Do", "Done"]);
    expect(out.cardsShown).toBe(1);
    expect(out.cardsTotal).toBe(2);
  });

  it("empties every list when nothing matches, and still reports the totals", () => {
    const out = searchDrawer("zzz", lists);
    expect(out.tools).toEqual([]);
    expect(out.templates).toEqual([]);
    expect(out.groups).toEqual([]);
    expect(out.toolsTotal).toBe(3);
    expect(out.templatesTotal).toBe(2);
    expect(out.cardsTotal).toBe(2);
    expect(out.cardsShown).toBe(0);
  });

  // Every other box in the app ANDs its tokens across fields; this one
  // is no exception, or "merge main" would find nothing.
  it("ANDs its tokens across a row's fields", () => {
    expect(searchDrawer("merge main", lists).tools.map((t) => t.name)).toEqual(["Merge"]);
    expect(searchDrawer("merge lint", lists).tools).toEqual([]);
  });
});
