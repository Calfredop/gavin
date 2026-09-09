import { describe, it, expect } from "vitest";
import { filterFiles, filterBranches, filterRemotes, filterStashes } from "$lib/gitSearch";
import type { BranchInfo, FileEntry, RemoteInfo, StashInfo } from "$lib/git";

const files: FileEntry[] = [
  { path: "src/lib/git.ts", status: "M" },
  { path: "src/lib/kanban.ts", status: "M" },
  { path: "docs/readme.md", status: "?" },
  { path: "src/lib/new.ts", oldPath: "src/lib/old.ts", status: "R" },
];

describe("filterFiles", () => {
  it("matches on the path, in any segment order", () => {
    expect(filterFiles(files, "git").map((f) => f.path)).toEqual(["src/lib/git.ts"]);
    expect(filterFiles(files, "lib ts").map((f) => f.path)).toEqual([
      "src/lib/git.ts",
      "src/lib/kanban.ts",
      "src/lib/new.ts",
    ]);
  });

  it("matches a rename on its old path too", () => {
    expect(filterFiles(files, "old.ts").map((f) => f.path)).toEqual(["src/lib/new.ts"]);
  });

  it("returns the same array for a blank query", () => {
    expect(filterFiles(files, "")).toBe(files);
  });
});

describe("filterBranches", () => {
  const branches: BranchInfo[] = [
    { name: "main", current: true, upstream: "origin/main", ahead: 0, behind: 0, sha: "aaa", subject: "init" },
    { name: "feature/search", current: false, upstream: null, ahead: 0, behind: 0, sha: "bbb", subject: "wip search box" },
  ];

  it("matches the branch name and its subject", () => {
    expect(filterBranches(branches, "search").map((b) => b.name)).toEqual(["feature/search"]);
    expect(filterBranches(branches, "init").map((b) => b.name)).toEqual(["main"]);
  });

  it("matches the upstream", () => {
    expect(filterBranches(branches, "origin").map((b) => b.name)).toEqual(["main"]);
  });
});

describe("filterRemotes", () => {
  const remotes: RemoteInfo[] = [
    { name: "origin", url: "git@github.com:me/gavin.git", branches: ["main", "feature/search"] },
    { name: "upstream", url: "git@github.com:org/gavin.git", branches: ["main"] },
  ];

  it("keeps a remote whose own name or url matches, with every branch", () => {
    const out = filterRemotes(remotes, "upstream");
    expect(out).toHaveLength(1);
    expect(out[0].branches).toEqual(["main"]);
  });

  it("narrows a remote to the branches that match", () => {
    const out = filterRemotes(remotes, "feature");
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe("origin");
    expect(out[0].branches).toEqual(["feature/search"]);
  });

  it("drops a remote with no match at all", () => {
    expect(filterRemotes(remotes, "nothing")).toEqual([]);
  });
});

describe("filterStashes", () => {
  const stashes: StashInfo[] = [
    { index: 0, message: "WIP on main: search box", date: "2 hours ago" },
    { index: 1, message: "WIP on git: diff tweak", date: "yesterday" },
  ];

  it("matches the message", () => {
    expect(filterStashes(stashes, "diff").map((s) => s.index)).toEqual([1]);
  });
});
