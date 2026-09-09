import { describe, it, expect, vi } from "vitest";
import {
  AGE_BUCKETS,
  archiveDeleteEntries,
  archivePurgeLines,
  bucketCards,
  olderThan,
  archivePurgeTitle,
  bucketSubject,
  FILTERED_ROW,
  railStepsFor,
  selectRowLabel,
  undatedCards,
} from "$lib/files/archiveDelete";
import { isMenuItem, isSeparator, isHeading, type ContextMenuEntry } from "$lib/contextMenu";
import type { Orchestration } from "$lib/orchestration/orchestration";
import type { CardView } from "$lib/planBoard";

const NOW = Date.parse("2026-09-07T12:00:00Z");
const DAY = 86_400;

function card(title: string, agedDays: number | null, over: Partial<CardView> = {}): CardView {
  const fileName = `${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.md`;
  return {
    id: `/ws/.gavin-root/plans/archive/${fileName}`,
    title,
    modifiedAt: agedDays === null ? null : NOW / 1000 - agedDays * DAY,
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

function labels(entries: ContextMenuEntry[]): string[] {
  return entries.filter(isMenuItem).map((e) => e.label);
}

function handlers(over: Partial<Parameters<typeof archiveDeleteEntries>[2]> = {}) {
  return {
    selectMode: false,
    selectedCount: 0,
    filtered: false,
    onEnterSelectMode: vi.fn(),
    onLeaveSelectMode: vi.fn(),
    onDeleteSelected: vi.fn(),
    onDeleteBucket: vi.fn(),
    ...over,
  };
}

describe("olderThan", () => {
  it("claims a card past the cut-off and leaves one that is not", () => {
    const cards = [card("Old", 8), card("Fresh", 2)];
    expect(olderThan(cards, 7 * DAY, NOW).map((c) => c.title)).toEqual(["Old"]);
  });

  it("never claims a card it cannot date", () => {
    // An unknown date is not an old one. A sweep that took these would
    // delete exactly the cards whose age nobody can check afterwards.
    expect(olderThan([card("No date", null)], 90 * DAY, NOW)).toEqual([]);
    expect(undatedCards([card("No date", null), card("Old", 99)]).map((c) => c.title)).toEqual([
      "No date",
    ]);
  });

  it("uses hours, not days, for the 24h bucket", () => {
    const cards = [card("Yesterday", 1.5), card("This morning", 0.25)];
    const bucket = AGE_BUCKETS[0];
    expect(bucket.seconds).toBe(DAY);
    expect(olderThan(cards, bucket.seconds, NOW).map((c) => c.title)).toEqual(["Yesterday"]);
  });

  it("nests: every longer bucket claims a subset of the shorter one", () => {
    const cards = [card("a", 0.5), card("b", 4), card("c", 20), card("d", 200)];
    const counts = bucketCards(cards, NOW).map((b) => b.cards.length);
    expect(counts).toEqual([3, 3, 2, 2, 1, 1]);
    for (let i = 1; i < counts.length; i++) expect(counts[i]).toBeLessThanOrEqual(counts[i - 1]);
  });
});

describe("archiveDeleteEntries", () => {
  it("offers select mode, then one row per bucket carrying its count", () => {
    const cards = [card("a", 40), card("b", 2)];
    const entries = archiveDeleteEntries(cards, NOW, handlers());
    expect(entries.filter(isHeading)).toHaveLength(1);
    expect(entries.filter(isSeparator)).toHaveLength(1);
    expect(labels(entries)).toEqual([
      "Select cards to delete…",
      "Older than 24 hours · 2",
      "Older than 3 days · 1",
      "Older than 7 days · 1",
      "Older than 15 days · 1",
      "Older than 30 days · 1",
      "Older than 90 days · 0",
    ]);
  });

  it("darkens a bucket that would delete nothing, and marks the rest danger", () => {
    const entries = archiveDeleteEntries([card("a", 2)], NOW, handlers());
    const buckets = entries.filter(isMenuItem).slice(1);
    expect(buckets[0]).toMatchObject({ disabled: false, danger: true });
    expect(buckets.at(-1)).toMatchObject({ disabled: true, danger: false });
  });

  it("hands the bucket's own cards to the pick, not the whole archive", () => {
    const cards = [card("old", 40), card("new", 1)];
    const h = handlers();
    const entries = archiveDeleteEntries(cards, NOW, h);
    const thirtyDays = entries.filter(isMenuItem).find((e) => e.label.startsWith("Older than 30"))!;
    thirtyDays.onPick();
    expect(h.onDeleteBucket).toHaveBeenCalledWith(
      expect.objectContaining({ id: "30d" }),
      [cards[0]]
    );
  });

  it("turns the picker row into the delete once select mode is on", () => {
    const h = handlers({ selectMode: true, selectedCount: 3 });
    const entries = archiveDeleteEntries([card("a", 1)], NOW, h);
    expect(labels(entries).slice(0, 2)).toEqual(["Delete 3 selected", "Leave select mode"]);
    entries.filter(isMenuItem)[0].onPick();
    expect(h.onDeleteSelected).toHaveBeenCalled();
  });

  it("keeps the way out reachable while nothing is picked", () => {
    const h = handlers({ selectMode: true, selectedCount: 0 });
    const entries = archiveDeleteEntries([card("a", 1)], NOW, h);
    const items = entries.filter(isMenuItem);
    expect(items[0]).toMatchObject({ label: "Delete selected", disabled: true });
    expect(items[1].disabled).toBeUndefined();
    items[1].onPick();
    expect(h.onLeaveSelectMode).toHaveBeenCalled();
  });

  it("cannot enter select mode over an empty archive", () => {
    const entries = archiveDeleteEntries([], NOW, handlers());
    expect(entries.filter(isMenuItem)[0]).toMatchObject({ disabled: true });
  });

  it("swaps the age rows for the reason while a lens is on", () => {
    // Sweeping by age over a filtered grid would take cards nobody can
    // see -- the same refusal a column's Clear and Archive-all make.
    const entries = archiveDeleteEntries([card("a", 40)], NOW, handlers({ filtered: true }));
    const items = entries.filter(isMenuItem);
    expect(items).toHaveLength(2);
    expect(items[1]).toMatchObject({ label: FILTERED_ROW, disabled: true });
  });

  it("still lets a hand-made selection through while filtered", () => {
    const h = handlers({ filtered: true, selectMode: true, selectedCount: 2 });
    const items = archiveDeleteEntries([card("a", 40)], NOW, h).filter(isMenuItem);
    expect(items[0]).toMatchObject({ label: "Delete 2 selected", disabled: false });
  });

  it("says the same words the row does", () => {
    expect(selectRowLabel(false, 4)).toBe("Select cards to delete…");
    expect(selectRowLabel(true, 1)).toBe("Delete 1 selected");
  });
});

describe("archivePurgeTitle", () => {
  it("names which cards, in the words the pick used", () => {
    expect(archivePurgeTitle(12, bucketSubject(AGE_BUCKETS[2]))).toBe(
      "Delete 12 cards older than 7 days?"
    );
    expect(archivePurgeTitle(1, "from the archive")).toBe("Delete 1 card from the archive?");
  });
});

describe("railStepsFor", () => {
  function orch(cardPaths: Array<string | null>): Orchestration {
    return {
      rails: [
        {
          id: "r1",
          name: "r1",
          position: 0,
          worktreePath: null,
          branch: null,
          autoResume: null,
          pageId: null,
          stages: [
            {
              id: "s1",
              position: 0,
              mode: "parallel",
              name: null,
              steps: cardPaths.map((p, i) => ({
                id: `t${i}`,
                position: i,
                cardPath: p ?? "",
                toolId: p === null ? "tool-1" : null,
                toolParams: {},
              })),
            },
          ],
        },
      ],
      conflictNotes: [],
      railRuns: [],
      stepRuns: [],
      tools: [],
      groupTemplates: [],
    } as unknown as Orchestration;
  }

  it("counts only the steps aimed at these cards", () => {
    const doomed = card("a", 40);
    expect(railStepsFor(orch([doomed.id, "/ws/.gavin-root/plans/other.md"]), [doomed])).toBe(1);
  });

  it("ignores a tool step, which has no card at all", () => {
    const doomed = card("a", 40);
    expect(railStepsFor(orch([null]), [doomed])).toBe(0);
  });

  it("reads an unloaded orchestration as no steps rather than throwing", () => {
    expect(railStepsFor(null, [card("a", 1)])).toBe(0);
  });
});

describe("archivePurgeLines", () => {
  const base = {
    cards: 1,
    files: 1,
    unparent: 0,
    railSteps: 0,
    boundSessions: 0,
    undated: 0,
    purgeBlocked: null,
  };

  it("leads with what goes, and says nothing it does not have to", () => {
    expect(archivePurgeLines(base)).toEqual([
      "Deletes 1 archived card permanently — from disk, with no archive left to take it back.",
    ]);
  });

  it("counts the nested tasks travelling with a plan", () => {
    expect(archivePurgeLines({ ...base, cards: 2, files: 5 })[1]).toBe(
      "3 nested tasks inside them go too."
    );
  });

  it("promises the rail steps go when the daemon can take them", () => {
    expect(archivePurgeLines({ ...base, railSteps: 2 }).at(-1)).toBe(
      "2 rail steps pointing at it are removed too."
    );
  });

  it("promises the opposite when the daemon cannot", () => {
    const line = archivePurgeLines({ ...base, railSteps: 1, purgeBlocked: "Needs daemon v34." }).at(-1)!;
    expect(line).toContain("will STAY on its rail");
    expect(line).toContain("Needs daemon v34.");
    expect(line).not.toContain("removed too");
  });

  it("accounts for the cards an age sweep could not date", () => {
    expect(archivePurgeLines({ ...base, undated: 2 }).at(-1)).toBe(
      "2 archived cards whose file date couldn't be read are left alone."
    );
  });
});
