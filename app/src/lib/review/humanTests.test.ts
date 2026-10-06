import { describe, it, expect } from "vitest";
import {
  humanTestList,
  humanTestsSummary,
  humanTestsWaiting,
  reviewTestRows,
  testSubjectDetail,
  testSubjectWaits,
  type HumanTestsInput,
} from "$lib/review/humanTests";
import type { DecisionCard } from "$lib/decisions/decisions";
import type { HumanItem, PlanFileInfo } from "$lib/core/gavin";
import type { CardView } from "$lib/core/planBoard";
import { NO_FACETS } from "$lib/board/boardFilters";
import { railIndex } from "$lib/board/planFilter";
import { hubViewAttention, hubViewAttentionLabel } from "$lib/hub/hubViewMeta";
import { allSources } from "$lib/sources";

// The Review tab's human tests: which cards owe one, what counts as
// waiting on the human, and the lens the tab narrows them through.
//
// The failures worth pinning are the ones the move from the Decisions
// tab could reintroduce: a decision listed as a test, a finished card's
// test listed at all, and a failed test lighting a mark that no amount of
// checking can clear.

const PLANS = "/ws/.gavin-root/plans";

function item(overrides: Partial<HumanItem> = {}): HumanItem {
  const kind = overrides.kind ?? "test";
  const text = overrides.text ?? "the installer runs";
  return {
    kind,
    text,
    done: false,
    options: [],
    latest: null,
    state: "open",
    lineText: `${kind === "decision" ? "Decision" : "Human test"}: ${text}`,
    lineIndex: 12,
    ...overrides,
  };
}

function plan(fileName: string, items: HumanItem[], overrides: Partial<PlanFileInfo> = {}): PlanFileInfo {
  return {
    path: `${PLANS}/${fileName}`,
    fileName,
    title: fileName.replace(/\.md$/, ""),
    status: "In Progress",
    priority: null,
    order: null,
    kind: "task",
    parent: null,
    labels: [],
    checklistDone: 0,
    checklistTotal: 0,
    parseWarning: false,
    humanItems: items,
    ...overrides,
  };
}

function input(plans: PlanFileInfo[], overrides: Partial<HumanTestsInput> = {}): HumanTestsInput {
  return {
    cards: new Map<string, DecisionCard>(
      plans.map((p) => [p.path, { plan: p, contextFolder: "/ws/.gavin-root" }])
    ),
    bindings: new Map(),
    doneStatus: "Done",
    ...overrides,
  };
}

function view(path: string, over: Partial<CardView> = {}): CardView {
  return {
    id: path,
    title: path.split("/").at(-1)!.replace(/\.md$/, ""),
    status: "In Progress",
    priority: null,
    order: null,
    kind: "task",
    parent: null,
    parentTitle: null,
    parentBroken: false,
    labels: [],
    checklistDone: 0,
    checklistTotal: 0,
    parseWarning: false,
    contextFolder: "/ws/.gavin-root",
    contextName: "root",
    fileName: path.split("/").at(-1)!,
    nestedChildren: [],
    ...over,
  } as CardView;
}

describe("which cards owe a test", () => {
  it("lists a card's open and failed tests and none of its decisions", () => {
    const list = humanTestList(
      input([
        plan("card.md", [
          item({ kind: "decision", text: "Which serializer?", lineIndex: 3 }),
          item({ lineIndex: 5 }),
          item({ text: "it signs", state: "failed", lineIndex: 7 }),
          item({ text: "it boots", state: "passed", done: true, lineIndex: 9 }),
        ]),
      ])
    );
    expect(list.subjects).toHaveLength(1);
    expect(list.subjects[0].items.map((i) => i.text)).toEqual(["the installer runs", "it signs"]);
  });

  it("leaves out a card whose only items are decisions", () => {
    const list = humanTestList(input([plan("card.md", [item({ kind: "decision" })])]));
    expect(list.subjects).toEqual([]);
  });

  it("leaves out Done and archived cards", () => {
    const list = humanTestList(
      input([
        plan("done.md", [item()], { status: "Done", path: `${PLANS}/done/done.md` }),
        plan("archived.md", [item()], { status: "Review", path: `${PLANS}/archive/archived.md` }),
        plan("live.md", [item()], { status: "Review" }),
      ])
    );
    expect(list.subjects.map((s) => s.title)).toEqual(["live"]);
    expect(list.subjects[0].status).toBe("Review");
  });

  it("reads a nested task's status off its parent plan", () => {
    const nested = plan("task.md", [item()], { status: null, parent: "plan.md" });
    const shipped = plan("plan.md", [], { kind: "plan", status: "Done" });
    expect(humanTestList(input([nested, shipped])).subjects).toEqual([]);
    const open = plan("plan.md", [], { kind: "plan", status: "To Do" });
    expect(humanTestList(input([nested, open])).subjects[0].status).toBe("To Do");
  });

  it("carries the card's bound session, which a pass or a failure is told to", () => {
    const card = plan("card.md", [item()]);
    const list = humanTestList(input([card], { bindings: new Map([[card.path, "s1"]]) }));
    expect(list.subjects[0].sessionId).toBe("s1");
  });

  // An older daemon parses no item lines, so its silence is not "no
  // tests": nothing is listed and the reason is carried out to be said.
  it("lists nothing behind the version gate, and says why", () => {
    const list = humanTestList(input([plan("card.md", [item()])], { itemsBlockedReason: "needs v42" }));
    expect(list.subjects).toEqual([]);
    expect(list.itemsBlockedReason).toBe("needs v42");
  });

  it("puts a card with a test to run before one whose tests the agent owes", () => {
    const list = humanTestList(
      input([
        plan("a-owed.md", [item({ state: "failed" })]),
        plan("b-open.md", [item()]),
      ])
    );
    expect(list.subjects.map((s) => s.title)).toEqual(["b-open", "a-owed"]);
  });
});

describe("the two counts", () => {
  // A failed test is back with the AGENT, so it must not light a mark the
  // human cannot clear.
  it("counts a failed test apart, and does not light the Review tab on it alone", () => {
    const owed = humanTestList(input([plan("card.md", [item({ state: "failed" })])]));
    expect(owed.summary).toEqual({ waiting: 0, failed: 1 });
    expect(humanTestsWaiting(owed.summary)).toBe(false);
    expect(testSubjectWaits(owed.subjects[0])).toBe(false);

    const both = humanTestList(
      input([plan("card.md", [item(), item({ state: "failed", lineIndex: 14 }), item({ lineIndex: 16 })])])
    );
    expect(humanTestsSummary(both.subjects)).toEqual({ waiting: 2, failed: 1 });
    expect(humanTestsWaiting(both.summary)).toBe(true);
  });

  it("says what a row holds for the human and what is with the agent", () => {
    const list = humanTestList(
      input([plan("card.md", [item(), item({ state: "failed", lineIndex: 14 }), item({ lineIndex: 16 })])])
    );
    expect(testSubjectDetail(list.subjects[0])).toBe("2 tests · 1 failed, with the agent");
  });
});

describe("the Review tab's lens", () => {
  const RAILS = railIndex(null);
  const subjects = humanTestList(
    input([
      plan("alpha.md", [item({ text: "the installer runs" })]),
      plan("beta.md", [item({ text: "the dock icon bounces" })], { status: "Review" }),
    ])
  ).subjects;
  const cards = new Map([
    [`${PLANS}/alpha.md`, view(`${PLANS}/alpha.md`, { labels: ["ui"] })],
    [`${PLANS}/beta.md`, view(`${PLANS}/beta.md`, { status: "Review", kind: "plan" })],
  ]);

  it("shows every row with nothing typed and no facet set", () => {
    const rows = reviewTestRows(subjects, cards, { query: "", facets: NO_FACETS, rails: RAILS });
    expect(rows.map((r) => r.subject.title).sort()).toEqual(["alpha", "beta"]);
    expect(rows.every((r) => r.card !== null)).toBe(true);
  });

  it("finds a card by its title and its test text together", () => {
    const rows = reviewTestRows(subjects, cards, { query: "dock beta", facets: NO_FACETS, rails: RAILS });
    expect(rows.map((r) => r.subject.title)).toEqual(["beta"]);
  });

  it("narrows by the same facets as the card groups", () => {
    const rows = reviewTestRows(subjects, cards, {
      query: "",
      facets: { ...NO_FACETS, kind: ["plan"] },
      rails: RAILS,
    });
    expect(rows.map((r) => r.subject.title)).toEqual(["beta"]);
  });

  // A card the projection does not hold cannot be judged against a facet.
  it("shows a card the board has not projected only while no facet is set", () => {
    const empty = new Map<string, CardView>();
    expect(reviewTestRows(subjects, empty, { query: "", facets: NO_FACETS, rails: RAILS })).toHaveLength(2);
    expect(
      reviewTestRows(subjects, empty, { query: "", facets: { ...NO_FACETS, kind: ["plan"] }, rails: RAILS })
    ).toEqual([]);
  });
});

describe("the Review tab's mark", () => {
  const IDLE = { committing: false, railsWantingAttention: false };

  it("lights the Review tab, and only it, when a test waits", () => {
    expect(hubViewAttention("review", { ...IDLE, reviewWaiting: true })).toBe(true);
    expect(hubViewAttention("review", IDLE)).toBe(false);
    expect(hubViewAttention("decisions", { ...IDLE, reviewWaiting: true })).toBe(false);
    expect(hubViewAttention("review", { ...IDLE, decisionsWaiting: true })).toBe(false);
  });

  it("says it is a test that waits, not a rail", () => {
    expect(hubViewAttentionLabel("review")).toMatch(/test/i);
    expect(hubViewAttentionLabel("review")).not.toMatch(/rail/i);
  });
});

describe("the Review tab's surfaces", () => {
  const SOURCES = allSources();
  const source = (name: string): string => {
    const text = SOURCES[name];
    if (!text) throw new Error(`no source for ${name}`);
    return text;
  };

  it("is fed its mark from a store, not from inside the tab it marks", () => {
    expect(source("humanTestsAttention.ts")).toContain("humanTestsWaiting(list.summary)");
  });

  it("answers a test with the Decisions tab's own row and write", () => {
    const view = source("ReviewHubView.svelte");
    expect(view).toContain("<DecisionsItemRow {item} blockedReason={testsBlockedReason} onAnswer={answerTest} />");
    expect(view).toContain("answerHumanItem(");
    expect(view).toContain("{#key selectedTests.cardPath}");
  });

  // The entry alone is a dead gate (CLAUDE.md): the gate has to reach
  // the controls and the list alike.
  it("puts the human-items version gate on the tests", () => {
    const view = source("ReviewHubView.svelte");
    expect(view).toContain('featureBlockedReason($daemonCompat, "humanItems")');
    expect(view).toContain("itemsBlockedReason: testsBlockedReason");
    expect(source("ReviewCardList.svelte")).toContain("Human tests can't be shown: {testsBlockedReason}");
  });
});
