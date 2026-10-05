// The Demo Workstation's repository: enough of git to do on it what the
// Git surface does on a real one, with the answers a real host gives.
import { describe, expect, it } from "vitest";
import * as git from "$companion/demo/repo";
import { DemoFailure } from "$companion/demo/answer";
import { DEMO, sampleState } from "$companion/demo/sampleData";
import { ATLAS_COMMITS } from "$companion/demo/sampleProjects";

function atlas() {
  const state = sampleState();
  return { repo: state.repos[DEMO.atlasRoot], files: state.files, state };
}

function notes() {
  const state = sampleState();
  return { repo: state.repos[DEMO.notesRoot], files: state.files };
}

const at = (rel: string) => `${DEMO.atlasRoot}/${rel}`;

describe("atlas-api as the demo opens it", () => {
  it("is mid-task: a change staged, one not yet, and a new file untracked", () => {
    const { repo, files } = atlas();
    expect(git.status(repo, files)).toEqual({
      staged: [{ path: "test/tokens.test.ts", status: "M" }],
      unstaged: [
        { path: "src/auth/rotation.ts", status: "?" },
        { path: "src/auth/tokens.ts", status: "M" },
      ],
    });
  });

  it("is on main, one commit ahead of origin, beside a finished feature branch", () => {
    const { repo } = atlas();
    const refs = git.refs(repo);
    expect(refs.headBranch).toBe("main");
    expect(refs.branches.map((b) => [b.name, b.current, b.upstream, b.ahead, b.behind])).toEqual([
      ["feat/login-rate-limit", false, "origin/feat/login-rate-limit", 0, 0],
      ["main", true, "origin/main", 1, 0],
    ]);
    expect(refs.remotes).toEqual([
      {
        name: "origin",
        url: "git@github.com:demo/atlas-api.git",
        branches: ["feat/login-rate-limit", "fix/session-expiry", "main"],
      },
    ]);
    expect(refs.worktrees).toEqual([
      { path: DEMO.atlasRoot, head: ATLAS_COMMITS.documented, branch: "main", isMain: true, locked: false, prunable: false },
    ]);
  });

  it("says who commits, and what HEAD's message is", () => {
    const info = git.repoInfo(atlas().repo);
    expect(info).toMatchObject({ notARepo: false, root: DEMO.atlasRoot, branch: "main", detached: false });
    expect(info.author).toEqual({ name: "Demo Human", email: "human@demo.invalid" });
    expect(info.headMessage?.split("\n")[0]).toBe("Document the rate limits");
  });

  it("gives the sidebar's chip for the checkout its sessions sit in", () => {
    const { repo, files } = atlas();
    expect(git.chip(repo, files)).toEqual({
      repoRoot: DEMO.atlasRoot,
      branch: "main",
      dirty: true,
      ahead: 1,
      behind: 0,
      hasUpstream: true,
    });
    const clean = notes();
    expect(git.chip(clean.repo, clean.files)).toMatchObject({ dirty: false, ahead: 0 });
  });

  it("is a working tree made of the demo's own files", () => {
    const { repo, files } = atlas();
    const tree = git.workingTree(repo, files);
    expect(tree["src/auth/rotation.ts"]).toBe(files[at("src/auth/rotation.ts")]);
    expect(Object.keys(tree).some((p) => p.startsWith("/"))).toBe(false);
    expect(Object.keys(git.workingTree(notes().repo, files))).not.toContain("src/auth/tokens.ts");
  });
});

describe("diffs", () => {
  it("shows the unstaged change against the index", () => {
    const { repo, files } = atlas();
    const diff = git.diff(repo, files, "src/auth/tokens.ts", { staged: false, untracked: false, rev: null });
    const added = diff.hunks.flatMap((h) => h.lines).filter((l) => l.kind === "add").map((l) => l.text);
    expect(added).toContain('  if (wasUsed(claims.jti)) throw new Error("refresh token reused");');
  });

  it("shows the staged change against HEAD", () => {
    const { repo, files } = atlas();
    const diff = git.diff(repo, files, "test/tokens.test.ts", { staged: true, untracked: false, rev: null });
    expect(diff.hunks.flatMap((h) => h.lines).some((l) => l.kind === "add" && l.text.includes("used twice"))).toBe(true);
  });

  it("shows an untracked file whole", () => {
    const { repo, files } = atlas();
    const [hunk] = git.diff(repo, files, "src/auth/rotation.ts", { staged: false, untracked: true, rev: null }).hunks;
    expect(hunk.header.startsWith("@@ -0,0 +1,")).toBe(true);
  });

  it("calls a picture binary rather than drawing its bytes", () => {
    const { repo, files } = atlas();
    files[at("docs/architecture.png")] += "!";
    expect(git.diff(repo, files, "docs/architecture.png", { staged: false, untracked: false, rev: null })).toEqual({
      path: "docs/architecture.png",
      binary: true,
      tooLarge: false,
      hunks: [],
    });
  });

  it("shows what a commit changed", () => {
    const { repo, files } = atlas();
    const diff = git.diff(repo, files, "docs/rate-limits.md", { staged: false, untracked: false, rev: ATLAS_COMMITS.documented });
    expect(diff.hunks[0].header.startsWith("@@ -0,0 +1,")).toBe(true);
  });
});

describe("staging", () => {
  it("stages a file, and unstages it back to HEAD", () => {
    const { repo, files } = atlas();
    git.stage(repo, files, ["src/auth/tokens.ts", "src/auth/rotation.ts"]);
    expect(git.status(repo, files).staged.map((e) => `${e.status} ${e.path}`)).toEqual([
      "A src/auth/rotation.ts",
      "M src/auth/tokens.ts",
      "M test/tokens.test.ts",
    ]);
    expect(git.status(repo, files).unstaged).toEqual([]);
    git.unstage(repo, ["src/auth/rotation.ts"]);
    expect(git.status(repo, files).unstaged).toEqual([{ path: "src/auth/rotation.ts", status: "?" }]);
  });

  it("stages a deletion", () => {
    const { repo, files } = atlas();
    delete files[at("README.md")];
    expect(git.status(repo, files).unstaged).toContainEqual({ path: "README.md", status: "D" });
    git.stage(repo, files, ["README.md"]);
    expect(git.status(repo, files).staged).toContainEqual({ path: "README.md", status: "D" });
  });

  it("stages and unstages everything", () => {
    const { repo, files } = atlas();
    git.stageAll(repo, files);
    expect(git.status(repo, files).unstaged).toEqual([]);
    git.unstageAll(repo);
    expect(git.status(repo, files).staged).toEqual([]);
  });

  it("refuses a path git has never seen", () => {
    const { repo, files } = atlas();
    expect(() => git.stage(repo, files, ["nope.ts"])).toThrow(DemoFailure);
    expect(() => git.stage(repo, files, ["nope.ts"])).toThrow("pathspec 'nope.ts' did not match any files");
  });
});

describe("committing", () => {
  it("records what is staged on the branch, and leaves the rest in the working tree", () => {
    const { repo, files } = atlas();
    git.commit(repo, "Test that a refresh token is single-use", false);
    expect(git.status(repo, files).staged).toEqual([]);
    expect(git.status(repo, files).unstaged).toHaveLength(2);
    expect(git.repoInfo(repo).headMessage).toBe("Test that a refresh token is single-use");
    const main = git.refs(repo).branches.find((b) => b.name === "main");
    expect(main).toMatchObject({ ahead: 2, subject: "Test that a refresh token is single-use" });
    expect(main?.sha).toMatch(/^[0-9a-f]{40}$/);
  });

  it("refuses an empty message, and a commit with nothing staged", () => {
    const { repo } = atlas();
    expect(() => git.commit(repo, "  ", false)).toThrow("empty commit message");
    git.unstageAll(repo);
    expect(() => git.commit(repo, "Nothing", false)).toThrow("nothing added to commit");
  });

  it("amends HEAD in place of a new commit", () => {
    const { repo, files } = atlas();
    git.commit(repo, "Document the rate limits, and the retry advice", true);
    const main = git.refs(repo).branches.find((b) => b.name === "main");
    expect(main).toMatchObject({ ahead: 1, subject: "Document the rate limits, and the retry advice" });
    expect(git.status(repo, files).staged).toEqual([]);
  });
});

describe("branches", () => {
  it("switches to a branch, carrying local changes it does not touch", () => {
    const { repo, files } = atlas();
    expect(git.checkout(repo, files, "feat/login-rate-limit", null)).toEqual([
      "Switched to branch 'feat/login-rate-limit'",
    ]);
    expect(files[at("src/auth/rateLimit.ts")]).toContain("limitLogins");
    // The branch never had the rate-limits doc; the local changes came along.
    expect(files[at("docs/rate-limits.md")]).toBeUndefined();
    expect(git.status(repo, files).unstaged.map((e) => e.path)).toEqual(["src/auth/rotation.ts", "src/auth/tokens.ts"]);
    expect(git.refs(repo).headBranch).toBe("feat/login-rate-limit");
  });

  it("refuses to switch where a local change would be overwritten, and changes nothing", () => {
    const { repo, files } = atlas();
    files[at("src/server.ts")] += "// a local edit\n";
    const before = { ...files };
    expect(() => git.checkout(repo, files, "feat/login-rate-limit", null)).toThrow(
      "error: Your local changes to the following files would be overwritten by checkout:\n\tsrc/server.ts"
    );
    expect(files).toEqual(before);
    expect(git.refs(repo).headBranch).toBe("main");
  });

  it("checks a remote-only branch out as a new branch tracking it", () => {
    const { repo, files } = atlas();
    expect(git.checkout(repo, files, "fix/session-expiry", "origin")).toEqual([
      "branch 'fix/session-expiry' set up to track 'origin/fix/session-expiry'.",
      "Switched to a new branch 'fix/session-expiry'",
    ]);
    expect(git.refs(repo).branches.find((b) => b.current)).toMatchObject({
      name: "fix/session-expiry",
      upstream: "origin/fix/session-expiry",
      ahead: 0,
      behind: 0,
    });
    expect(files[at("test/session.test.ts")]).toContain("isExpired");
  });

  it("creates a branch at HEAD, and switches to it when asked", () => {
    const { repo, files } = atlas();
    git.createBranch(repo, files, "feat/rotation", null, true);
    const refs = git.refs(repo);
    expect(refs.headBranch).toBe("feat/rotation");
    expect(refs.branches.find((b) => b.name === "feat/rotation")).toMatchObject({
      upstream: null,
      sha: ATLAS_COMMITS.documented,
    });
    // A new branch at HEAD changes nothing on disk.
    expect(git.status(repo, files).unstaged).toHaveLength(2);
  });

  it("refuses a branch name git would, and one already taken", () => {
    const { repo, files } = atlas();
    expect(() => git.createBranch(repo, files, "has space", null, false)).toThrow("is not a valid branch name");
    expect(() => git.createBranch(repo, files, "main", null, false)).toThrow("a branch named 'main' already exists");
  });
});

describe("merging", () => {
  it("merges a finished branch into main with a merge commit, keeping local changes", () => {
    const { repo, files } = atlas();
    expect(git.merge(repo, files, "feat/login-rate-limit")).toEqual(["Merge made by the 'ort' strategy."]);
    expect(files[at("src/auth/rateLimit.ts")]).toContain("limitLogins");
    expect(files[at("docs/rate-limits.md")]).toContain("Rate limits");
    expect(files[at("src/server.ts")]).toContain("limitLogins(refresh)");
    const main = git.refs(repo).branches.find((b) => b.name === "main");
    expect(main).toMatchObject({ subject: "Merge branch 'feat/login-rate-limit'", ahead: 3 });
    expect(git.status(repo, files).staged).toEqual([{ path: "test/tokens.test.ts", status: "M" }]);
  });

  it("says so when there is nothing to merge", () => {
    const { repo, files } = atlas();
    git.merge(repo, files, "feat/login-rate-limit");
    expect(git.merge(repo, files, "feat/login-rate-limit")).toEqual(["Already up to date."]);
  });

  it("fast-forwards a branch that is only behind", () => {
    const { repo, files } = atlas();
    git.createBranch(repo, files, "old", ATLAS_COMMITS.refresh, true);
    // The index still holds the staged test; take it along.
    const progress = git.merge(repo, files, "main");
    expect(progress).toEqual([`Updating ${ATLAS_COMMITS.refresh.slice(0, 7)}..${ATLAS_COMMITS.documented.slice(0, 7)}`, "Fast-forward"]);
    expect(git.refs(repo).branches.find((b) => b.name === "old")?.sha).toBe(ATLAS_COMMITS.documented);
  });

  it("refuses a merge whose two sides changed one file, and changes nothing", () => {
    const { repo, files } = atlas();
    git.stageAll(repo, files);
    git.commit(repo, "Rotate refresh tokens", false);
    git.checkout(repo, files, "feat/login-rate-limit", null);
    files[at("src/auth/tokens.ts")] = "// rewritten on the branch\n";
    git.stageAll(repo, files);
    git.commit(repo, "Rewrite tokens", false);
    git.checkout(repo, files, "main", null);
    const before = { ...files };
    expect(() => git.merge(repo, files, "feat/login-rate-limit")).toThrow(
      "CONFLICT (content): Merge conflict in src/auth/tokens.ts"
    );
    expect(files).toEqual(before);
  });

  it("refuses a name that is nothing", () => {
    const { repo, files } = atlas();
    expect(() => git.merge(repo, files, "nope")).toThrow("merge: nope - not something we can merge");
  });
});

describe("the remote", () => {
  it("pushes what main has that origin does not, and says what it sent", () => {
    const { repo } = atlas();
    const progress = git.push(repo, "origin");
    expect(progress[0]).toBe("Enumerating objects: 3, done.");
    expect(progress).toContain("Writing objects: 100% (3/3), done.");
    expect(progress.at(-1)).toBe(`   ${ATLAS_COMMITS.refresh.slice(0, 7)}..${ATLAS_COMMITS.documented.slice(0, 7)}  main -> main`);
    expect(git.refs(repo).branches.find((b) => b.name === "main")).toMatchObject({ ahead: 0, behind: 0 });
    expect(git.push(repo, "origin")).toEqual(["Everything up-to-date"]);
  });

  it("publishes a branch origin has never had, and tracks it", () => {
    const { repo, files } = atlas();
    git.createBranch(repo, files, "feat/rotation", null, true);
    expect(git.push(repo, "origin").at(-1)).toBe(" * [new branch]      feat/rotation -> feat/rotation");
    expect(git.refs(repo).branches.find((b) => b.current)?.upstream).toBe("origin/feat/rotation");
  });

  it("refuses a push origin would reject, and a remote there is none of", () => {
    const { repo } = atlas();
    repo.remote.branches.main = ATLAS_COMMITS.expiryFix;
    expect(() => git.push(repo, "origin")).toThrow("[rejected]        main -> main (fetch first)");
    expect(() => git.push(repo, "upstream")).toThrow("'upstream' does not appear to be a git repository");
  });

  it("fetches and pulls nothing new from a remote that has not moved", () => {
    const { repo, files } = notes();
    expect(git.fetch(repo, "origin")).toEqual(["From git@github.com:demo/field-notes.git"]);
    expect(git.pull(repo, files)).toEqual(["From git@github.com:demo/field-notes.git", "Already up to date."]);
  });
});
