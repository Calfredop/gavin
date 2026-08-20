import { describe, it, expect } from "vitest";
import { lineId, parseLineId, splitPath, branchLabel, changedCount, type RepoInfo } from "./git";

const repo: RepoInfo = {
  notARepo: false, root: "/r", branch: "main", detached: false, unborn: false,
  author: { name: "A", email: "a@b" }, headMessage: "m", inProgress: null,
};

describe("lineId", () => {
  it("round-trips hunk and line indexes", () => {
    expect(lineId(2, 17)).toBe("2:17");
    expect(parseLineId("2:17")).toEqual({ hunk: 2, line: 17 });
  });
});

describe("splitPath", () => {
  it("splits directory (with trailing slash) from file name", () => {
    expect(splitPath("src/lib/foo.ts")).toEqual({ dir: "src/lib/", name: "foo.ts" });
    expect(splitPath("README.md")).toEqual({ dir: "", name: "README.md" });
  });
});

describe("branchLabel", () => {
  it("renders normal, unborn and detached heads (spec §1 toolbar)", () => {
    expect(branchLabel(repo)).toBe("main");
    expect(branchLabel({ ...repo, unborn: true })).toBe("main (no commits)");
    expect(branchLabel({ ...repo, detached: true, branch: "abc1234" })).toBe("abc1234 · detached");
  });
});

describe("changedCount", () => {
  it("counts unique paths across both lists", () => {
    expect(
      changedCount({
        unstaged: [{ path: "a", status: "M" }, { path: "b", status: "?" }],
        staged: [{ path: "a", status: "M" }, { path: "c", status: "A" }],
      })
    ).toBe(3);
    expect(changedCount(null)).toBe(0);
  });
});
