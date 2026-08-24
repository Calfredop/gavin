import { describe, it, expect } from "vitest";
import { queryTokens, matchesFields, matchesQuery, filterList, isSearching } from "./search";

describe("queryTokens", () => {
  it("splits on whitespace and lower-cases", () => {
    expect(queryTokens("  Git  Tab ")).toEqual(["git", "tab"]);
  });

  it("is empty for blank input", () => {
    expect(queryTokens("")).toEqual([]);
    expect(queryTokens("   ")).toEqual([]);
  });
});

describe("isSearching", () => {
  it("ignores whitespace-only queries", () => {
    expect(isSearching("")).toBe(false);
    expect(isSearching("  ")).toBe(false);
    expect(isSearching(" a ")).toBe(true);
  });
});

describe("matchesFields", () => {
  it("matches every token, in any field, in any order", () => {
    const fields = ["Git tab — worktrees", "git-tab-worktrees.md"];
    expect(matchesFields(["worktrees", "git"], fields)).toBe(true);
    expect(matchesFields(["worktrees", "kanban"], fields)).toBe(false);
  });

  it("matches substrings, not whole words", () => {
    expect(matchesFields(["ktree"], ["worktrees"])).toBe(true);
  });

  it("ignores null and undefined fields", () => {
    expect(matchesFields(["a"], [null, undefined, "Alpha"])).toBe(true);
    expect(matchesFields(["a"], [null, undefined])).toBe(false);
  });

  it("matches everything when there are no tokens", () => {
    expect(matchesFields([], [])).toBe(true);
  });

  it("is case-insensitive on the field side too", () => {
    expect(matchesFields(["done"], ["DONE"])).toBe(true);
  });
});

describe("matchesQuery", () => {
  it("takes the raw query string", () => {
    expect(matchesQuery("in prog", ["In Progress"])).toBe(true);
    expect(matchesQuery("  ", ["anything"])).toBe(true);
  });
});

describe("filterList", () => {
  const items = [{ p: "src/lib/git.ts" }, { p: "src/lib/kanban.ts" }];

  it("keeps the items whose fields match", () => {
    expect(filterList(items, "git", (i) => [i.p])).toEqual([items[0]]);
  });

  it("returns the same array instance when nothing is being searched", () => {
    expect(filterList(items, "  ", (i) => [i.p])).toBe(items);
  });
});
