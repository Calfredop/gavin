import { describe, it, expect } from "vitest";
import {
  DEFAULT_REVIEW_PREFS,
  REVIEW_PREFS_KEY,
  loadReviewPrefs,
  normalizeReviewPrefs,
  pruneReviewPrefs,
  saveReviewPrefs,
  toggleReviewColumn,
  type ReviewPrefs,
} from "./reviewPrefs";

function storage(seed: Record<string, string> = {}) {
  const data = new Map(Object.entries(seed));
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
    raw: () => data,
  };
}

const THROWS = {
  getItem() {
    throw new Error("blocked");
  },
  setItem() {
    throw new Error("blocked");
  },
  removeItem() {
    throw new Error("blocked");
  },
};

function prefs(over: Partial<ReviewPrefs> = {}): ReviewPrefs {
  return { ...DEFAULT_REVIEW_PREFS, ...over };
}

describe("normalizeReviewPrefs", () => {
  it("fills every field a stored record did not supply", () => {
    expect(normalizeReviewPrefs({ includeArchived: true })).toEqual(prefs({ includeArchived: true }));
  });

  it("reads a non-object as the default rather than throwing", () => {
    expect(normalizeReviewPrefs(null)).toEqual(DEFAULT_REVIEW_PREFS);
    expect(normalizeReviewPrefs([1, 2])).toEqual(DEFAULT_REVIEW_PREFS);
    expect(normalizeReviewPrefs("done")).toEqual(DEFAULT_REVIEW_PREFS);
  });

  it("keeps null and an empty column list apart", () => {
    // null inherits the done-column default; [] is a stored choice.
    expect(normalizeReviewPrefs({}).columns).toBeNull();
    expect(normalizeReviewPrefs({ columns: [] }).columns).toEqual([]);
  });

  it("drops non-strings and duplicates from the column list", () => {
    expect(normalizeReviewPrefs({ columns: ["done", "done", 3, "", "wip"] }).columns).toEqual([
      "done",
      "wip",
    ]);
  });

  it("keeps a stored query, and reads a non-string as none", () => {
    expect(normalizeReviewPrefs({ query: "rail" }).query).toBe("rail");
    expect(normalizeReviewPrefs({ query: 7 }).query).toBe("");
  });

  it("only accepts `true` for the two flags", () => {
    const got = normalizeReviewPrefs({ includeArchived: "yes", listCollapsed: 1 });
    expect(got.includeArchived).toBe(false);
    expect(got.listCollapsed).toBe(false);
  });
});

describe("load / save", () => {
  it("round-trips a record", () => {
    const store = storage();
    const record = { ws1: prefs({ columns: ["done"], selected: "/a.md" }) };
    saveReviewPrefs(record, store);
    expect(loadReviewPrefs(store)).toEqual(record);
  });

  it("counts a live query as worth storing", () => {
    const store = storage();
    saveReviewPrefs({ ws1: prefs({ query: "rail" }) }, store);
    expect(loadReviewPrefs(store).ws1.query).toBe("rail");
  });

  it("does not store an entry that says nothing", () => {
    const store = storage();
    saveReviewPrefs({ ws1: prefs(), ws2: prefs({ listCollapsed: true }) }, store);
    expect(loadReviewPrefs(store)).toEqual({ ws2: prefs({ listCollapsed: true }) });
  });

  it("removes the key entirely once nothing is worth keeping", () => {
    const store = storage();
    saveReviewPrefs({ ws1: prefs({ listCollapsed: true }) }, store);
    saveReviewPrefs({ ws1: prefs() }, store);
    expect(store.raw().has(REVIEW_PREFS_KEY)).toBe(false);
  });

  it("forgets rather than throwing on corrupt storage", () => {
    expect(loadReviewPrefs(storage({ [REVIEW_PREFS_KEY]: "{not json" }))).toEqual({});
    expect(loadReviewPrefs(storage({ [REVIEW_PREFS_KEY]: "[1,2]" }))).toEqual({});
  });

  it("survives a storage that refuses to be read or written", () => {
    expect(loadReviewPrefs(THROWS)).toEqual({});
    expect(() => saveReviewPrefs({ ws1: prefs({ listCollapsed: true }) }, THROWS)).not.toThrow();
  });

  it("remembers nothing when there is no storage at all", () => {
    expect(loadReviewPrefs(undefined)).toEqual({});
    expect(() => saveReviewPrefs({ ws1: prefs({ listCollapsed: true }) }, undefined)).not.toThrow();
  });
});

describe("pruneReviewPrefs", () => {
  it("drops workspaces that no longer exist", () => {
    const record = { ws1: prefs({ listCollapsed: true }), gone: prefs({ selected: "/a.md" }) };
    expect(pruneReviewPrefs(record, ["ws1"])).toEqual({ ws1: prefs({ listCollapsed: true }) });
  });
});

describe("toggleReviewColumn", () => {
  it("starts from the defaults when nothing has been chosen", () => {
    expect(toggleReviewColumn(null, ["done"], "wip")).toEqual(["done", "wip"]);
  });

  it("unticks a chosen column", () => {
    expect(toggleReviewColumn(["done", "wip"], ["done"], "wip")).toEqual(["done"]);
  });

  it("clears back to the default rather than reaching an empty tab", () => {
    // Unticking the last column must not leave the tab listing nothing:
    // null sends resolveReviewColumns back to the done column.
    expect(toggleReviewColumn(["done"], ["done"], "done")).toBeNull();
  });

  it("can untick the default itself once another column is on", () => {
    expect(toggleReviewColumn(null, ["done"], "done")).toBeNull();
    expect(toggleReviewColumn(["done", "wip"], ["done"], "done")).toEqual(["wip"]);
  });
});
