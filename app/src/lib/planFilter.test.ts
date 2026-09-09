import { describe, it, expect } from "vitest";
import { railIndex, statusFacets, filterExplorer, underContext, NO_RAIL, ANY } from "$lib/planFilter";
import type { ExplorerContextNode } from "$lib/planExplorer";
import type { Orchestration, Rail } from "$lib/orchestration";

function file(
  path: string,
  label: string,
  status: string | null,
  group: "plans" | "docs" | "specs" | "archive" = "plans",
  kind: "plan" | "task" | "note" | null = "plan"
) {
  return { path, label, group, status, priority: null, parseWarning: false, kind } as const;
}

function context(over: Partial<ExplorerContextNode> = {}): ExplorerContextNode {
  return {
    folderPath: "/ws",
    name: "root",
    kind: "root",
    configWarning: false,
    gavinDir: "/ws/.gavin-root",
    depth: 0,
    outside: false,
    groups: [],
    ...over,
  };
}

const gitTab = file("/ws/.gavin-root/plans/git-tab.md", "Git tab", "To Do");
const kanban = file("/ws/.gavin-root/plans/kanban.md", "Kanban search", "Done");
const readme = file("/ws/.gavin-root/docs/readme.md", "readme.md", null, "docs", null);

const contexts: ExplorerContextNode[] = [
  context({
    groups: [
      { group: "plans", label: "Plans", files: [gitTab, kanban], archived: [] },
      { group: "docs", label: "Docs", files: [readme], archived: [] },
    ],
  }),
];

function rail(id: string, name: string, cardPaths: string[]): Rail {
  return {
    id,
    name,
    position: 0,
    worktreePath: null,
    pageId: null,
    stages: [{ id: `${id}-s0`, position: 0, steps: cardPaths.map((p, i) => ({ id: `${id}-t${i}`, cardPath: p, position: i })) }],
  };
}

const orch: Orchestration = {
  rails: [rail("r1", "Backend", [gitTab.path])],
  conflictNotes: [],
  railRuns: [],
  stepRuns: [],
};

describe("railIndex", () => {
  it("maps every placed card to the rail holding it", () => {
    const index = railIndex(orch);
    expect(index.byCard.get(gitTab.path)).toBe("r1");
    expect(index.byCard.has(kanban.path)).toBe(false);
    expect(index.rails).toEqual([{ id: "r1", name: "Backend" }]);
  });

  it("is empty without an orchestration", () => {
    expect(railIndex(null).rails).toEqual([]);
  });
});

describe("statusFacets", () => {
  it("offers the board's columns first, then any status only a file wears", () => {
    expect(statusFacets(["To Do", "Done"], contexts)).toEqual(["To Do", "Done"]);
    const blocked = [context({ groups: [{ group: "plans", label: "Plans", files: [file("/a.md", "A", "Blocked")], archived: [] }] })];
    expect(statusFacets(["To Do"], blocked)).toEqual(["To Do", "Blocked"]);
  });

  it("does not repeat a status that only differs in spelling from a column", () => {
    const cased = [context({ groups: [{ group: "plans", label: "Plans", files: [file("/a.md", "A", "to-do")], archived: [] }] })];
    expect(statusFacets(["To Do"], cased)).toEqual(["To Do"]);
  });
});

const shipped = file("/ws/.gavin-root/plans/done/shipped.md", "Shipped thing", "Done");
const withArchive: ExplorerContextNode[] = [
  context({
    groups: [{ group: "plans", label: "Plans", files: [gitTab], archived: [shipped] }],
  }),
];

describe("filterExplorer with archived plans", () => {
  const base = { query: "", status: ANY, rail: ANY, context: ANY, kind: ANY };

  it("counts archived cards in the total", () => {
    const out = filterExplorer(withArchive, base, railIndex(orch));
    expect(out.total).toBe(2);
  });

  it("searches archived cards and surfaces a hit flat, not behind the Done fold", () => {
    const out = filterExplorer(withArchive, { ...base, query: "shipped" }, railIndex(orch));
    expect(out.shown).toBe(1);
    expect(out.contexts[0].groups[0].files.map((f) => f.label)).toEqual(["Shipped thing"]);
    expect(out.contexts[0].groups[0].archived).toEqual([]);
  });

  it("drops a group whose only match was neither live nor archived", () => {
    const out = filterExplorer(withArchive, { ...base, query: "nothing" }, railIndex(orch));
    expect(out.contexts).toEqual([]);
  });
});

describe("filterExplorer", () => {
  const base = { query: "", status: ANY, rail: ANY, context: ANY, kind: ANY };

  it("passes the tree straight through when nothing is set", () => {
    const out = filterExplorer(contexts, base, railIndex(orch));
    expect(out.filtering).toBe(false);
    expect(out.contexts).toBe(contexts);
    expect(out.shown).toBe(3);
  });

  it("filters by text across plans, docs and specs", () => {
    const out = filterExplorer(contexts, { ...base, query: "readme" }, railIndex(orch));
    expect(out.filtering).toBe(true);
    expect(out.contexts[0].groups.map((g) => g.group)).toEqual(["docs"]);
    expect(out.shown).toBe(1);
    expect(out.total).toBe(3);
  });

  it("filters plans by status, and drops docs and specs entirely", () => {
    const out = filterExplorer(contexts, { ...base, status: "Done" }, railIndex(orch));
    expect(out.contexts[0].groups).toHaveLength(1);
    expect(out.contexts[0].groups[0].files.map((f) => f.label)).toEqual(["Kanban search"]);
  });

  it("matches a status by slug, so spelling never hides a card", () => {
    const out = filterExplorer(contexts, { ...base, status: "to-do" }, railIndex(orch));
    expect(out.contexts[0].groups[0].files.map((f) => f.label)).toEqual(["Git tab"]);
  });

  it("filters by the rail a plan sits on", () => {
    const out = filterExplorer(contexts, { ...base, rail: "r1" }, railIndex(orch));
    expect(out.contexts[0].groups[0].files.map((f) => f.label)).toEqual(["Git tab"]);
  });

  it("offers the cards on no rail at all", () => {
    const out = filterExplorer(contexts, { ...base, rail: NO_RAIL }, railIndex(orch));
    expect(out.contexts[0].groups[0].files.map((f) => f.label)).toEqual(["Kanban search"]);
  });

  it("ands the facets together", () => {
    const out = filterExplorer(contexts, { ...base, query: "git", status: "Done" }, railIndex(orch));
    expect(out.shown).toBe(0);
    expect(out.contexts).toEqual([]);
  });

  it("drops a context that keeps no file", () => {
    const two = [...contexts, context({ folderPath: "/ws/auth", name: "auth", kind: "context", groups: [] })];
    const out = filterExplorer(two, { ...base, query: "git" }, railIndex(orch));
    expect(out.contexts.map((c) => c.name)).toEqual(["root"]);
  });

  // The archive holds ordinary plan files that happen to be filed away,
  // so the two card-only facets have to read them. Before the archive
  // was its own group they were `plans` rows and did; the group split
  // must not quietly take them out of the facets' reach.
  describe("the archive group", () => {
    const filed = file("/ws/.gavin-root/plans/archive/old.md", "Old work", "Done", "archive");
    const withArchive: ExplorerContextNode[] = [
      context({
        groups: [
          { group: "plans", label: "Plans", files: [gitTab], archived: [] },
          { group: "archive", label: "Archive", files: [filed], archived: [] },
          { group: "docs", label: "Docs", files: [readme], archived: [] },
        ],
      }),
    ];

    it("answers the status facet", () => {
      const out = filterExplorer(withArchive, { ...base, status: "Done" }, railIndex(orch));
      expect(out.contexts[0].groups.map((g) => g.group)).toEqual(["archive"]);
      expect(out.contexts[0].groups[0].files.map((f) => f.label)).toEqual(["Old work"]);
    });

    it("answers the rail facet", () => {
      const onRail = railIndex({
        rails: [rail("r9", "Ship", [filed.path])],
        conflictNotes: [],
        railRuns: [],
        stepRuns: [],
      });
      const out = filterExplorer(withArchive, { ...base, rail: "r9" }, onRail);
      expect(out.contexts[0].groups[0].files.map((f) => f.label)).toEqual(["Old work"]);
    });

    // An EMPTY rail index, so that "on no rail at all" keeps both card
    // groups: `orch` puts gitTab on r1, which would drop the plans group
    // on its own merits and hide the thing this asserts -- that the facet
    // takes out docs and specs, and only those.
    it("still lets docs and specs fall out when a facet is set", () => {
      const out = filterExplorer(withArchive, { ...base, status: ANY, rail: NO_RAIL }, railIndex(null));
      expect(out.contexts[0].groups.map((g) => g.group)).toEqual(["plans", "archive"]);
    });

    it("contributes an off-vocabulary status to the facet options", () => {
      const odd = [
        context({
          groups: [
            {
              group: "archive",
              label: "Archive",
              files: [file("/ws/.gavin-root/plans/archive/x.md", "X", "Shipped", "archive")],
              archived: [],
            },
          ],
        }),
      ];
      expect(statusFacets(["To Do", "Done"], odd)).toEqual(["To Do", "Done", "Shipped"]);
    });
  });

  describe("the context facet", () => {
    const auth = context({
      folderPath: "/ws/auth",
      name: "auth",
      kind: "context",
      groups: [{ group: "plans", label: "Plans", files: [file("/ws/auth/.gavin/plans/login.md", "Login", "To Do")], archived: [] }],
    });
    const two = [...contexts, auth];

    it("drops a context outside the chosen folder, docs and specs included", () => {
      const out = filterExplorer(two, { ...base, context: "/ws/auth" }, railIndex(orch));
      expect(out.contexts.map((c) => c.name)).toEqual(["auth"]);
      expect(out.contexts[0].groups.map((g) => g.group)).toEqual(["plans"]);
    });

    it("keeps a context's own subfolders, not just an exact path match", () => {
      const nested = context({
        folderPath: "/ws/auth/oauth",
        name: "oauth",
        kind: "context",
        groups: [{ group: "plans", label: "Plans", files: [file("/ws/auth/oauth/.gavin/plans/x.md", "X", "To Do")], archived: [] }],
      });
      const out = filterExplorer([...two, nested], { ...base, context: "/ws/auth" }, railIndex(orch));
      expect(out.contexts.map((c) => c.name)).toEqual(["auth", "oauth"]);
    });

    it("does not treat a sibling with a shared prefix as under the folder", () => {
      const authTwo = context({ folderPath: "/ws/auth2", name: "auth2", kind: "context", groups: [] });
      const out = filterExplorer([...two, authTwo], { ...base, context: "/ws/auth" }, railIndex(orch));
      expect(out.contexts.map((c) => c.name)).toEqual(["auth"]);
    });
  });

  describe("the kind facet", () => {
    const reminder = file("/ws/.gavin-root/plans/reminder.md", "Reminder", null, "plans", "note");
    const withKinds: ExplorerContextNode[] = [
      context({ groups: [{ group: "plans", label: "Plans", files: [gitTab, kanban, reminder], archived: [] }] }),
    ];

    it("keeps only cards of the chosen kind", () => {
      const out = filterExplorer(withKinds, { ...base, kind: "note" }, railIndex(orch));
      expect(out.contexts[0].groups[0].files.map((f) => f.label)).toEqual(["Reminder"]);
    });

    it("drops docs and specs entirely, like status and rail", () => {
      const out = filterExplorer(
        [context({ groups: [{ group: "plans", label: "Plans", files: [gitTab], archived: [] }, { group: "docs", label: "Docs", files: [readme], archived: [] }] })],
        { ...base, kind: "plan" },
        railIndex(orch)
      );
      expect(out.contexts[0].groups.map((g) => g.group)).toEqual(["plans"]);
    });
  });
});

describe("underContext", () => {
  it("matches the folder itself and its subfolders", () => {
    expect(underContext("/ws/auth", "/ws/auth")).toBe(true);
    expect(underContext("/ws/auth/oauth", "/ws/auth")).toBe(true);
  });

  it("does not match a sibling with a shared prefix", () => {
    expect(underContext("/ws/auth2", "/ws/auth")).toBe(false);
  });
});
