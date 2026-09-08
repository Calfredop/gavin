import { describe, it, expect } from "vitest";
import { lineId, parseLineId, splitPath, branchLabel, changedCount, defaultWorktreePath, validateBranchName, branchNameFrom, freeBranchNameFrom, branchResolvable, type RepoInfo, type RefsSnapshot } from "./git";

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

describe("defaultWorktreePath", () => {
  it("builds a sibling folder named <repo>-<branch> with slashes flattened (G11)", () => {
    expect(defaultWorktreePath("/a/b/repo", "feat/x")).toBe("/a/b/repo-feat-x");
    expect(defaultWorktreePath("/a/b/repo/", "main")).toBe("/a/b/repo-main");
  });
});

describe("validateBranchName", () => {
  it("accepts ordinary names and rejects git's forbidden shapes", () => {
    expect(validateBranchName("feature/thing-1")).toBeNull();
    expect(validateBranchName("")).toMatch(/required/i);
    expect(validateBranchName("has space")).toMatch(/space/i);
    expect(validateBranchName("a..b")).toMatch(/\.\./);
    expect(validateBranchName("-lead")).toMatch(/start/i);
    expect(validateBranchName("x.lock")).toMatch(/lock/i);
    expect(validateBranchName("bad~name")).toMatch(/character/i);
  });

  it("rejects names starting with - to prevent git flag injection (R10)", () => {
    expect(validateBranchName("--upload-pack=x")).toMatch(/start/i);
    expect(validateBranchName("--force")).toMatch(/start/i);
    expect(validateBranchName("-a")).toMatch(/start/i);
  });
});

describe("branchNameFrom", () => {
  it("slugifies a rail's name into a branch segment", () => {
    expect(branchNameFrom("Auth rework")).toBe("auth-rework");
    expect(branchNameFrom("Rail 1")).toBe("rail-1");
    expect(branchNameFrom("  Spaces  &  Symbols!! ")).toBe("spaces-symbols");
    expect(branchNameFrom("already-kebab")).toBe("already-kebab");
  });

  it("keeps / as the hierarchy separator, trimming each segment", () => {
    expect(branchNameFrom("Feature/Auth")).toBe("feature/auth");
    expect(branchNameFrom("/ leading / trailing /")).toBe("leading/trailing");
  });

  // The point of the helper: whatever a rail is called, the seeded
  // input must not open already-invalid.
  it("produces a name validateBranchName accepts, for every shape git forbids", () => {
    for (const railName of [
      "Auth rework",
      "a..b",
      "-leading dash",
      "x.lock",
      "bad~name^with:every?forbidden*char[\\]",
      "at@{brace}",
      "Feature / Auth",
      "trailing dot.",
      "UPPER_snake_Case",
      "emoji 🎉 rail",
    ]) {
      const seeded = branchNameFrom(railName);
      expect(seeded).not.toBe("");
      expect(validateBranchName(seeded)).toBeNull();
    }
  });

  it("returns empty when nothing legal survives, so the caller shows a placeholder", () => {
    expect(branchNameFrom("")).toBe("");
    expect(branchNameFrom("   ")).toBe("");
    expect(branchNameFrom("!!!")).toBe("");
    expect(branchNameFrom("///")).toBe("");
  });
});

describe("freeBranchNameFrom", () => {
  it("numbers past the branches that already exist", () => {
    expect(freeBranchNameFrom("Auth rework", [])).toBe("auth-rework");
    expect(freeBranchNameFrom("Auth rework", ["auth-rework"])).toBe("auth-rework-2");
    expect(freeBranchNameFrom("Auth rework", ["auth-rework", "auth-rework-2"])).toBe("auth-rework-3");
    // A near-miss is not a collision.
    expect(freeBranchNameFrom("Auth rework", ["auth-reworked"])).toBe("auth-rework");
  });

  it("stays empty when the name slugs to nothing, however crowded the repo", () => {
    expect(freeBranchNameFrom("???", ["a", "b"])).toBe("");
  });

  it("numbers a name git still accepts", () => {
    expect(validateBranchName(freeBranchNameFrom("Feature/Auth", ["feature/auth"]))).toBeNull();
    expect(freeBranchNameFrom("Feature/Auth", ["feature/auth"])).toBe("feature/auth-2");
  });
});

describe("branchResolvable", () => {
  /// Only the two lists the answer reads; the rest of a snapshot has no
  /// bearing on whether git can find a branch.
  function refs(local: string[], remote: Record<string, string[]> = {}): RefsSnapshot {
    return {
      branches: local.map((name) => ({
        name, current: false, upstream: null, ahead: 0, behind: 0, sha: "a", subject: "s",
      })),
      remotes: Object.entries(remote).map(([name, branches]) => ({ name, url: "u", branches })),
      stashes: [],
      worktrees: [],
      headBranch: null,
    };
  }

  it("finds a local branch", () => {
    expect(branchResolvable(refs(["main", "feat/api"]), "feat/api")).toBe(true);
  });

  it("finds a branch that exists only on a remote", () => {
    // `git switch feat/api` with only origin/feat/api creates the local
    // tracking branch itself, so refusing this would refuse a binding
    // that works.
    expect(branchResolvable(refs(["main"], { origin: ["feat/api"] }), "feat/api")).toBe(true);
  });

  it("finds a remote branch whose own name contains slashes", () => {
    // parse_remotes splits `origin/feat/layout` on the FIRST slash, so
    // the branch it records keeps the rest of the path.
    expect(branchResolvable(refs([], { origin: ["feat/layout/deep"] }), "feat/layout/deep")).toBe(true);
  });

  it("answers false for a branch no ref names", () => {
    expect(branchResolvable(refs(["main"], { origin: ["main"] }), "feat/layout-homologation")).toBe(false);
  });

  it("answers false for a repo with no refs at all", () => {
    expect(branchResolvable(refs([]), "main")).toBe(false);
  });
});
