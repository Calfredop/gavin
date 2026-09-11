import { describe, it, expect } from "vitest";
import {
  MEASURED_EMPTY_HINT,
  NO_FILES_GROUP_ID,
  NO_FILES_HINT,
  NO_FILES_LABEL,
  MAX_REMEMBERED_GROUPS,
  SAME_BASELINE_LABEL,
  everyGroupExpanded,
  fileLabel,
  isGroupExpanded,
  setAllGroupsExpanded,
  toggleExpandedGroup,
  noFilesHint,
  groupCandidates,
  groupLabel,
  resolveReviewColumns,
  resolveSelection,
  reviewCards,
  reviewStatusSlugs,
  reviewSummary,
  withBaselinePeers,
  type ReviewCandidate,
  type ReviewGroup,
} from "$lib/review/reviewBoard";
import type { CardView, MergedProjection } from "$lib/core/planBoard";
import type { Column } from "$lib/board/kanban";
import { NO_FACETS, type BoardFacets } from "$lib/board/boardFilters";
import { railIndex } from "$lib/board/planFilter";
import type { Orchestration, Rail } from "$lib/orchestration/orchestration";

const NO_RAILS = railIndex(null);

function card(title: string, over: Partial<CardView> = {}): CardView {
  const fileName = `${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.md`;
  return {
    id: `/ws/.gavin-root/plans/${fileName}`,
    title,
    status: "Done",
    priority: null,
    order: null,
    kind: "plan",
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

function candidate(
  title: string,
  files: string[] | null,
  over: Partial<CardView> = {},
  measured: Partial<Pick<ReviewCandidate, "checkout" | "baseSha">> = {}
): ReviewCandidate {
  // One checkout and no baseline unless a test says otherwise: the
  // default is the ordinary board, where cards were measured in the same
  // place and each from its own launch point.
  return { card: card(title, over), files, checkout: "/repo", baseSha: null, ...measured };
}

const COLUMNS: Column[] = [
  { id: "todo", name: "To Do", position: 0 },
  { id: "wip", name: "In Progress", position: 1 },
  { id: "done", name: "Done", position: 2 },
];

function merged(over: Partial<MergedProjection> = {}): MergedProjection {
  return { columns: [], autoColumns: [], archived: [], ...over };
}

describe("resolveReviewColumns", () => {
  it("defaults to the board's done column when nothing is chosen", () => {
    expect(resolveReviewColumns(COLUMNS, null).map((c) => c.id)).toEqual(["done"]);
  });

  it("uses the terminal column whatever it is called", () => {
    const shipped: Column[] = [
      { id: "todo", name: "To Do", position: 0 },
      { id: "shipped", name: "Shipped", position: 9 },
    ];
    expect(resolveReviewColumns(shipped, null).map((c) => c.name)).toEqual(["Shipped"]);
  });

  it("honours a chosen set, in board order", () => {
    expect(resolveReviewColumns(COLUMNS, ["done", "wip"]).map((c) => c.id)).toEqual(["wip", "done"]);
  });

  it("drops ids that no longer name a column", () => {
    expect(resolveReviewColumns(COLUMNS, ["done", "gone"]).map((c) => c.id)).toEqual(["done"]);
  });

  it("falls back to the default rather than emptying the tab", () => {
    // Every chosen column was deleted elsewhere. An empty answer here
    // would leave the human standing in a tab that lists nothing with no
    // way to tell why.
    expect(resolveReviewColumns(COLUMNS, ["gone", "also-gone"]).map((c) => c.id)).toEqual(["done"]);
  });

  it("has nothing to review on a board with no columns", () => {
    expect(resolveReviewColumns([], null)).toEqual([]);
  });

  it("slugs the column names for archived-card matching", () => {
    expect([...reviewStatusSlugs(resolveReviewColumns(COLUMNS, ["wip", "done"]))]).toEqual([
      "in-progress",
      "done",
    ]);
  });
});

function opts(over: {
  includeArchived: boolean;
  query: string;
  facets?: BoardFacets;
  rails?: ReturnType<typeof railIndex>;
}) {
  return { facets: NO_FACETS, rails: NO_RAILS, ...over };
}

describe("reviewCards", () => {
  const done = COLUMNS[2];

  it("lists the review columns' cards in board order", () => {
    const projection = merged({
      columns: [
        { column: COLUMNS[0], planCards: [card("Not yet")] },
        { column: done, planCards: [card("First"), card("Second")] },
      ],
    });
    const got = reviewCards(projection, [done], opts({ includeArchived: false, query: "" }));
    expect(got.map((c) => c.title)).toEqual(["First", "Second"]);
  });

  it("leaves notes out — a note has no run, no diff and no session", () => {
    const projection = merged({
      columns: [{ column: done, planCards: [card("A plan"), card("A note", { kind: "note" })] }],
    });
    const got = reviewCards(projection, [done], opts({ includeArchived: false, query: "" }));
    expect(got.map((c) => c.title)).toEqual(["A plan"]);
  });

  it("hides the archive by default", () => {
    const projection = merged({
      columns: [{ column: done, planCards: [card("On the board")] }],
      archived: [card("Archived")],
    });
    const got = reviewCards(projection, [done], opts({ includeArchived: false, query: "" }));
    expect(got.map((c) => c.title)).toEqual(["On the board"]);
  });

  it("matches archived cards on the status they were archived with", () => {
    const projection = merged({
      columns: [{ column: done, planCards: [card("On the board")] }],
      archived: [card("Archived done"), card("Archived early", { status: "To Do" })],
    });
    const got = reviewCards(projection, [done], opts({ includeArchived: true, query: "" }));
    expect(got.map((c) => c.title)).toEqual(["On the board", "Archived done"]);
  });

  it("filters by the search query", () => {
    const projection = merged({
      columns: [{ column: done, planCards: [card("Rail branch seed"), card("Terminal font size")] }],
    });
    const got = reviewCards(projection, [done], opts({ includeArchived: false, query: "rail" }));
    expect(got.map((c) => c.title)).toEqual(["Rail branch seed"]);
  });

  // The trio Kanban and Plans answer the same way (boardFilters.ts,
  // shared across tabs by hubFacets.ts) has to narrow this list too, or
  // linking the Review tab to the other two would do nothing.
  describe("the shared context/kind/rail facets", () => {
    it("narrows by context, the same way the board does", () => {
      const projection = merged({
        columns: [
          {
            column: done,
            planCards: [card("Auth work", { contextFolder: "/ws/auth" }), card("Other work", { contextFolder: "/ws/api" })],
          },
        ],
      });
      const got = reviewCards(
        projection,
        [done],
        opts({ includeArchived: false, query: "", facets: { ...NO_FACETS, context: ["/ws/auth"] } })
      );
      expect(got.map((c) => c.title)).toEqual(["Auth work"]);
    });

    it("narrows by kind, and an empty list is the honest answer for notes", () => {
      const projection = merged({
        columns: [{ column: done, planCards: [card("A task", { kind: "task" }), card("A plan", { kind: "plan" })] }],
      });
      const tasksOnly = reviewCards(
        projection,
        [done],
        opts({ includeArchived: false, query: "", facets: { ...NO_FACETS, kind: ["task"] } })
      );
      expect(tasksOnly.map((c) => c.title)).toEqual(["A task"]);

      const notesOnly = reviewCards(
        projection,
        [done],
        opts({ includeArchived: false, query: "", facets: { ...NO_FACETS, kind: ["note"] } })
      );
      expect(notesOnly).toEqual([]);
    });

    it("narrows by rail", () => {
      const on: Rail = {
        id: "r1",
        name: "Backend",
        position: 0,
        worktreePath: null,
        pageId: null,
        stages: [{ id: "r1-s0", position: 0, steps: [{ id: "r1-t0", cardPath: "/ws/.gavin-root/plans/on-rail.md", position: 0 }] }],
      };
      const orch: Orchestration = { rails: [on], conflictNotes: [], railRuns: [], stepRuns: [] };
      const projection = merged({
        columns: [
          {
            column: done,
            planCards: [
              card("On rail", { id: "/ws/.gavin-root/plans/on-rail.md" }),
              card("Off rail", { id: "/ws/.gavin-root/plans/off-rail.md" }),
            ],
          },
        ],
      });
      const got = reviewCards(
        projection,
        [done],
        opts({
          includeArchived: false,
          query: "",
          facets: { ...NO_FACETS, rail: ["r1"] },
          rails: railIndex(orch),
        })
      );
      expect(got.map((c) => c.title)).toEqual(["On rail"]);
    });
  });
});

describe("groupCandidates", () => {
  it("puts cards that share a file in one group", () => {
    const groups = groupCandidates([
      candidate("A", ["app/src/lib/git.ts"]),
      candidate("B", ["app/src/lib/git.ts", "app/src/lib/orchestration.ts"]),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].cards.map((c) => c.card.title)).toEqual(["A", "B"]);
  });

  it("joins transitively — A shares with B, B with C, so all three group", () => {
    const groups = groupCandidates([
      candidate("A", ["a.ts"]),
      candidate("B", ["a.ts", "b.ts"]),
      candidate("C", ["b.ts"]),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].cards.map((c) => c.card.title)).toEqual(["A", "B", "C"]);
  });

  it("keeps cards that share nothing apart", () => {
    const groups = groupCandidates([candidate("A", ["a.ts"]), candidate("B", ["b.ts"])]);
    expect(groups.map((g) => g.cards.map((c) => c.card.title))).toEqual([["A"], ["B"]]);
  });

  it("names the header with the most-shared files first", () => {
    const groups = groupCandidates([
      candidate("A", ["z-shared.ts", "only-a.ts"]),
      candidate("B", ["z-shared.ts", "only-b.ts"]),
    ]);
    // z-shared.ts is touched twice, so it leads even though it sorts last.
    expect(groups[0].files[0]).toBe("z-shared.ts");
    expect(groups[0].label).toBe("z-shared.ts, only-a.ts +1");
  });

  it("orders the biggest group first and pins the fileless one last", () => {
    const groups = groupCandidates([
      candidate("Lonely", ["solo.ts"]),
      candidate("Unmeasured", null),
      candidate("A", ["shared.ts"]),
      candidate("B", ["shared.ts"]),
    ]);
    expect(groups.map((g) => g.label)).toEqual(["shared.ts", "solo.ts", NO_FILES_LABEL]);
    expect(groups[2].id).toBe(NO_FILES_GROUP_ID);
  });

  it("treats a measured empty run as fileless but not as unmeasured", () => {
    // Both land in the same group -- the list has one bucket for "we
    // cannot show you files" -- but the candidate keeps the difference,
    // so the card's own column can still say which it is.
    const groups = groupCandidates([candidate("Measured", []), candidate("Unmeasured", null)]);
    expect(groups).toHaveLength(1);
    expect(groups[0].cards.map((c) => c.files)).toEqual([[], null]);
  });

  it("gives a group an id that survives a refetch", () => {
    const once = groupCandidates([candidate("A", ["a.ts", "b.ts"])]);
    const twice = groupCandidates([candidate("A", ["b.ts", "a.ts"])]);
    expect(once[0].id).toBe(twice[0].id);
  });

  it("has nothing to group when there is nothing to review", () => {
    expect(groupCandidates([])).toEqual([]);
  });

  it("does not collide two checkouts on the same path", () => {
    // The same repo-relative path in two worktrees is two files. Left
    // unscoped, one hub file put every card on the board in one group.
    const groups = groupCandidates([
      candidate("Here", ["app/src/lib/git.ts"], {}, { checkout: "/repo" }),
      candidate("There", ["app/src/lib/git.ts"], {}, { checkout: "/repo-wt" }),
    ]);
    expect(groups.map((g) => g.cards.map((c) => c.card.title))).toEqual([["Here"], ["There"]]);
  });

  it("gives two checkouts with the same files two groups, not one id", () => {
    const groups = groupCandidates([
      candidate("Here", ["a.ts"], {}, { checkout: "/repo" }),
      candidate("There", ["a.ts"], {}, { checkout: "/repo-wt" }),
    ]);
    expect(new Set(groups.map((g) => g.id)).size).toBe(2);
  });

  it("still collides two cards measured in the same checkout", () => {
    const groups = groupCandidates([
      candidate("A", ["a.ts"], {}, { checkout: "/repo", baseSha: "1" }),
      candidate("B", ["a.ts"], {}, { checkout: "/repo", baseSha: "2" }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].label).toBe("a.ts");
  });

  it("does not read a shared measurement as a file collision", () => {
    // Two runs launched from the same commit in the same checkout are
    // measured identically, so the files they share are not evidence
    // that either of them touched anything.
    const groups = groupCandidates([
      candidate("A", ["a.ts", "b.ts"], {}, { checkout: "/repo", baseSha: "same" }),
      candidate("B", ["a.ts", "b.ts"], {}, { checkout: "/repo", baseSha: "same" }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].label).toBe(SAME_BASELINE_LABEL);
    expect(groups[0].hint).toContain("same commit");
    expect(groups[0].files).toEqual(["a.ts", "b.ts"]);
  });

  it("names files when the group holds more than one baseline", () => {
    const groups = groupCandidates([
      candidate("A", ["a.ts"], {}, { checkout: "/repo", baseSha: "one" }),
      candidate("B", ["a.ts"], {}, { checkout: "/repo", baseSha: "one" }),
      candidate("C", ["a.ts"], {}, { checkout: "/repo", baseSha: "two" }),
    ]);
    expect(groups[0].label).toBe("a.ts");
    expect(groups[0].hint).toBeNull();
  });

  it("does not call one card a shared measurement", () => {
    const groups = groupCandidates([candidate("A", ["a.ts"], {}, { baseSha: "one" })]);
    expect(groups[0].label).toBe("a.ts");
    expect(groups[0].hint).toBeNull();
  });

  it("carries the fileless group's hint on the group", () => {
    const groups = groupCandidates([candidate("Unmeasured", null)]);
    expect(groups[0].hint).toBe(NO_FILES_HINT);
  });
});

describe("withBaselinePeers", () => {
  it("gives a run the other baselines recorded in its checkout", () => {
    const peers = withBaselinePeers([
      { cwd: "/repo", baseSha: "a" },
      { cwd: "/repo", baseSha: "b" },
    ]);
    expect(peers.map((r) => r.peers)).toEqual([
      ["a", "b"],
      ["a", "b"],
    ]);
  });

  it("keeps checkouts apart — a peer only bounds a run measured beside it", () => {
    const peers = withBaselinePeers([
      { cwd: "/repo", baseSha: "a" },
      { cwd: "/repo-wt", baseSha: "b" },
    ]);
    expect(peers.map((r) => r.peers)).toEqual([["a"], ["b"]]);
  });

  it("orders and dedupes, so the same board asks the same question twice", () => {
    const once = withBaselinePeers([
      { cwd: "/repo", baseSha: "b" },
      { cwd: "/repo", baseSha: "a" },
      { cwd: "/repo", baseSha: "b" },
    ]);
    expect(once.every((r) => r.peers.join() === "a,b")).toBe(true);
  });

  it("keeps every other field of the request", () => {
    const peers = withBaselinePeers([{ cwd: "/repo", baseSha: "a", path: "/plans/x.md" }]);
    expect(peers[0].path).toBe("/plans/x.md");
  });
});

describe("groupLabel", () => {
  it("names files, not paths", () => {
    expect(fileLabel("app/src/lib/git.ts")).toBe("git.ts");
    expect(fileLabel("README.md")).toBe("README.md");
    expect(groupLabel(["app/src/lib/git.ts"])).toBe("git.ts");
  });

  it("counts the files it does not name", () => {
    expect(groupLabel(["a.ts", "b.ts", "c.ts", "d.ts"])).toBe("a.ts, b.ts +2");
  });

  it("says the fileless group's words rather than an empty header", () => {
    expect(groupLabel([])).toBe(NO_FILES_LABEL);
  });

  it("does not say why, because the group holds both answers", () => {
    // "No files recorded" over a card whose own row says "0 files" is
    // the list contradicting itself about the one distinction this
    // module exists to draw.
    expect(NO_FILES_LABEL).not.toMatch(/record/i);
  });
});

describe("noFilesHint", () => {
  it("says nobody measured these runs when nobody did", () => {
    expect(noFilesHint([candidate("A", null), candidate("B", null)])).toBe(NO_FILES_HINT);
  });

  it("does not claim a measured run was never measured", () => {
    const hint = noFilesHint([candidate("A", []), candidate("B", [])]);
    expect(hint).toBe(MEASURED_EMPTY_HINT);
    expect(hint).not.toContain("didn't record");
  });

  it("says both when the group holds both", () => {
    const hint = noFilesHint([candidate("A", null), candidate("B", [])]);
    expect(hint).toContain(NO_FILES_HINT);
    expect(hint).toContain(MEASURED_EMPTY_HINT);
  });
});

describe("reviewSummary", () => {
  it("counts the cards and the file groups", () => {
    const groups = groupCandidates([
      candidate("A", ["a.ts"]),
      candidate("B", ["b.ts"]),
      candidate("C", null),
    ]);
    expect(reviewSummary(groups)).toBe("3 cards · 2 groups");
  });

  it("does not count the fileless group as a group", () => {
    expect(reviewSummary(groupCandidates([candidate("C", null)]))).toBe("1 card");
  });

  it("says nothing when there is nothing to review", () => {
    expect(reviewSummary([])).toBeNull();
  });
});

describe("resolveSelection", () => {
  const groups = groupCandidates([candidate("A", ["a.ts"]), candidate("B", ["b.ts"])]);

  it("keeps a selection the list still holds", () => {
    const b = groups[1].cards[0].card.id;
    expect(resolveSelection(groups, b)).toBe(b);
  });

  it("falls to the first card when the selection dropped out of the list", () => {
    expect(resolveSelection(groups, "/ws/.gavin-root/plans/gone.md")).toBe(groups[0].cards[0].card.id);
  });

  it("selects the first card when nothing was selected", () => {
    expect(resolveSelection(groups, null)).toBe(groups[0].cards[0].card.id);
  });

  it("selects nothing when the list is empty", () => {
    expect(resolveSelection([], "/ws/.gavin-root/plans/a.md")).toBeNull();
  });
});

describe("group expansion", () => {
  const group = (id: string): ReviewGroup => ({
    id,
    files: [],
    label: id,
    hint: null,
    cards: [],
  });

  it("closes a group nobody has opened", () => {
    // The default the whole feature rests on: an id that is not
    // remembered is closed, so a group whose file set churned comes
    // back closed rather than springing open.
    expect(isGroupExpanded([], "g1")).toBe(false);
    expect(isGroupExpanded(["g2"], "g1")).toBe(false);
    expect(isGroupExpanded(["g1"], "g1")).toBe(true);
  });

  it("opens and closes one group", () => {
    expect(toggleExpandedGroup([], "g1")).toEqual(["g1"]);
    expect(toggleExpandedGroup(["g1"], "g1")).toEqual([]);
  });

  it("keeps the most recently opened first", () => {
    expect(toggleExpandedGroup(["g1"], "g2")).toEqual(["g2", "g1"]);
  });

  it("stops remembering rather than growing without bound", () => {
    const many = Array.from({ length: MAX_REMEMBERED_GROUPS }, (_, i) => `g${i}`);
    const next = toggleExpandedGroup(many, "new");
    expect(next).toHaveLength(MAX_REMEMBERED_GROUPS);
    expect(next[0]).toBe("new");
    expect(next).not.toContain(`g${MAX_REMEMBERED_GROUPS - 1}`);
  });

  it("says whether the one control has anything left to open", () => {
    const groups = [group("a"), group("b")];
    expect(everyGroupExpanded(groups, ["a"])).toBe(false);
    expect(everyGroupExpanded(groups, ["a", "b"])).toBe(true);
  });

  it("does not offer to close an empty list", () => {
    expect(everyGroupExpanded([], [])).toBe(false);
  });

  it("expands every listed group", () => {
    expect(setAllGroupsExpanded([group("a"), group("b")], [], true)).toEqual(["a", "b"]);
  });

  it("collapses every listed group", () => {
    expect(setAllGroupsExpanded([group("a"), group("b")], ["a", "b"], false)).toEqual([]);
  });

  it("leaves groups the query is hiding alone", () => {
    // Expand-all is not also a quiet "forget everything else": the
    // search box narrows the list, and a group off screen keeps the
    // state the human left it in.
    expect(setAllGroupsExpanded([group("a")], ["hidden"], true)).toEqual(["a", "hidden"]);
    expect(setAllGroupsExpanded([group("a")], ["a", "hidden"], false)).toEqual(["hidden"]);
  });

  it("does not remember a group twice", () => {
    expect(setAllGroupsExpanded([group("a")], ["a"], true)).toEqual(["a"]);
  });
});
