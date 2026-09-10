import { describe, it, expect } from "vitest";
import { archiveView, archivedOn, chronological } from "$lib/files/archive";
import { isArchivedCard, type CardView } from "$lib/core/planBoard";

function card(title: string, over: Partial<CardView> = {}): CardView {
  const fileName = `${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.md`;
  return {
    id: `/ws/.gavin-root/plans/archive/${fileName}`,
    title,
    modifiedAt: null,
    status: "Done",
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

describe("isArchivedCard", () => {
  it("claims plans/archive/ in any context, and nothing else", () => {
    expect(isArchivedCard("/ws/.gavin-root/plans/archive/a.md")).toBe(true);
    expect(isArchivedCard("/ws/src/auth/.gavin/plans/archive/a.md")).toBe(true);
    expect(isArchivedCard("/ws/.gavin-root/plans/a.md")).toBe(false);
    expect(isArchivedCard("/ws/.gavin-root/plans/done/a.md")).toBe(false);
  });

  it("does not claim a hand-made folder that merely ends in archive", () => {
    // The daemon refuses to file cards into somebody else's hierarchy,
    // so the explorer must not fold one away as if it had.
    expect(isArchivedCard("/ws/.gavin-root/plans/roadmap/archive/a.md")).toBe(false);
    expect(isArchivedCard("/ws/archive/a.md")).toBe(false);
  });
});

describe("chronological", () => {
  it("puts the most recently archived card first", () => {
    const out = chronological([
      card("Old", { modifiedAt: 1000 }),
      card("New", { modifiedAt: 3000 }),
      card("Middle", { modifiedAt: 2000 }),
    ]);
    expect(out.map((c) => c.title)).toEqual(["New", "Middle", "Old"]);
  });

  it("sorts cards with no date LAST, not first", () => {
    const out = chronological([
      card("Undated"),
      card("Dated", { modifiedAt: 1000 }),
    ]);
    expect(out.map((c) => c.title)).toEqual(["Dated", "Undated"]);
  });

  it("breaks ties by path so the order is stable", () => {
    const out = chronological([
      card("Bravo", { modifiedAt: 500 }),
      card("Alpha", { modifiedAt: 500 }),
    ]);
    expect(out.map((c) => c.title)).toEqual(["Alpha", "Bravo"]);
    // ...and undated cards tie-break the same way.
    expect(chronological([card("Delta"), card("Charlie")]).map((c) => c.title)).toEqual([
      "Charlie",
      "Delta",
    ]);
  });

  it("does not mutate the array it is given", () => {
    const input = [card("Old", { modifiedAt: 1 }), card("New", { modifiedAt: 2 })];
    chronological(input);
    expect(input.map((c) => c.title)).toEqual(["Old", "New"]);
  });

  it("treats an absent modifiedAt exactly like an explicit null", () => {
    const absent = card("Absent");
    delete (absent as { modifiedAt?: number | null }).modifiedAt;
    const out = chronological([absent, card("Dated", { modifiedAt: 10 })]);
    expect(out.map((c) => c.title)).toEqual(["Dated", "Absent"]);
  });
});

describe("archiveView", () => {
  const cards = [
    card("Ship the thing", { modifiedAt: 3000 }),
    card("Fix the bug", { modifiedAt: 1000, labels: ["bug"] }),
    card("Write the docs", { modifiedAt: 2000 }),
  ];

  it("is chronological and reports the full count when unfiltered", () => {
    const view = archiveView(cards, "");
    expect(view.filtering).toBe(false);
    expect(view.cards.map((c) => c.title)).toEqual([
      "Ship the thing",
      "Write the docs",
      "Fix the bug",
    ]);
    expect(view.shown).toBe(3);
    expect(view.total).toBe(3);
  });

  it("filters on the same fields the board searches, and keeps the order", () => {
    const view = archiveView(cards, "the");
    expect(view.filtering).toBe(true);
    expect(view.cards.map((c) => c.title)).toEqual([
      "Ship the thing",
      "Write the docs",
      "Fix the bug",
    ]);
    expect(archiveView(cards, "bug").cards.map((c) => c.title)).toEqual(["Fix the bug"]);
    // A label the board matches on, matched here too.
    expect(archiveView(cards, "docs").cards.map((c) => c.title)).toEqual(["Write the docs"]);
  });

  it("counts what it hid, so the toggle can say so", () => {
    const view = archiveView(cards, "bug");
    expect(view.shown).toBe(1);
    expect(view.total).toBe(3);
  });

  it("finds a plan through its nested children and narrows to the ones that matched", () => {
    const plan = card("Big plan", {
      kind: "plan",
      modifiedAt: 5000,
      nestedChildren: [card("Wire the socket"), card("Paint the wall")],
    });
    const view = archiveView([plan], "socket");
    expect(view.cards).toHaveLength(1);
    expect(view.cards[0].nestedChildren.map((c) => c.title)).toEqual(["Wire the socket"]);
  });

  it("whitespace is not a query", () => {
    expect(archiveView(cards, "   ").filtering).toBe(false);
  });

  it("an empty archive is not an error", () => {
    const view = archiveView([], "anything");
    expect(view.cards).toEqual([]);
    expect(view.total).toBe(0);
  });
});

describe("archivedOn", () => {
  it("stamps a date the human can read without parsing it", () => {
    // 2026-08-24T12:00:00Z -- mid-day, so no timezone can slide the
    // local date off the 24th.
    expect(archivedOn(Date.UTC(2026, 7, 24, 12) / 1000)).toBe("24 Aug 2026");
  });

  it("has nothing to say about a missing or unusable date", () => {
    expect(archivedOn(null)).toBeNull();
    expect(archivedOn(undefined)).toBeNull();
    expect(archivedOn(Number.NaN)).toBeNull();
  });
});
