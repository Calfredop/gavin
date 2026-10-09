import { describe, expect, it } from "vitest";
import type { BranchInfo, RefsSnapshot, RepoInfo, StatusResult } from "$lib/git/git";
import { initialState, type GitViewState } from "$lib/git/gitState";
import {
  agentCommitControl,
  branchLine,
  changeSections,
  changesCount,
  diffBody,
  diffHeading,
  fileAction,
  gitLocked,
  gitScreen,
  inProgressBanner,
  localBranches,
  mergeQuestion,
  newBranchProblem,
  openFile,
  remoteOnlyBranches,
  statusWord,
  syncButtons,
  syncNote,
} from "$companion/surfaces/phoneGit";

const ROOT = "/Users/demo/code/atlas-api";

function repo(patch: Partial<RepoInfo> = {}): RepoInfo {
  return {
    notARepo: false,
    root: ROOT,
    branch: "main",
    detached: false,
    unborn: false,
    author: { name: "Demo", email: "demo@demo.invalid" },
    headMessage: "Document the rate limits",
    inProgress: null,
    ...patch,
  };
}

function branch(name: string, patch: Partial<BranchInfo> = {}): BranchInfo {
  return { name, current: false, upstream: `origin/${name}`, ahead: 0, behind: 0, sha: "a".repeat(40), subject: `on ${name}`, ...patch };
}

function refs(patch: Partial<RefsSnapshot> = {}): RefsSnapshot {
  return {
    branches: [branch("feat/x"), branch("main", { current: true, ahead: 1 })],
    remotes: [{ name: "origin", url: "git@example.invalid:a.git", branches: ["HEAD", "feat/x", "fix/y", "main"] }],
    stashes: [],
    worktrees: [],
    headBranch: "main",
    ...patch,
  };
}

function ready(patch: Partial<GitViewState> = {}): GitViewState {
  const status: StatusResult = {
    unstaged: [
      { path: "src/auth/rotation.ts", status: "?" },
      { path: "src/auth/tokens.ts", status: "M" },
    ],
    staged: [{ path: "test/tokens.test.ts", status: "M" }],
  };
  return { ...initialState(ROOT), repo: repo(), status, refs: refs(), ...patch };
}

describe("which screen the tab is on", () => {
  it("has nothing to read without a folder, and is loading until the first read lands", () => {
    expect(gitScreen(null, null)).toBe("no-root");
    expect(gitScreen(ROOT, null)).toBe("loading");
    expect(gitScreen(ROOT, initialState(ROOT))).toBe("loading");
  });

  it("says when git is missing or the folder is no repository, as the desk does", () => {
    expect(gitScreen(ROOT, { ...initialState(ROOT), gitMissing: true })).toBe("git-missing");
    expect(gitScreen(ROOT, { ...initialState(ROOT), repo: repo({ notARepo: true }) })).toBe("not-a-repo");
  });

  it("draws a failed first read with its error rather than loading for ever", () => {
    expect(gitScreen(ROOT, { ...initialState(ROOT), error: "Refresh failed: boom" })).toBe("ready");
    expect(gitScreen(ROOT, ready())).toBe("ready");
  });
});

describe("the sync buttons", () => {
  it("offer all three, counting what Pull and Push would move", () => {
    const view = ready({ refs: refs({ branches: [branch("main", { current: true, ahead: 2, behind: 1 })] }) });
    expect(syncButtons(view)).toEqual({
      fetch: { label: "Fetch", enabled: true, count: 0 },
      pull: { label: "Pull", enabled: true, count: 1 },
      push: { label: "Push", enabled: true, count: 2 },
    });
  });

  it("call Push Publish for a branch with no upstream", () => {
    const view = ready({ refs: refs({ branches: [branch("main", { current: true, upstream: null })] }) });
    expect(syncButtons(view).push.label).toBe("Publish");
  });

  it("are all shut while a git command runs", () => {
    for (const view of [ready({ busy: "Commit" }), ready({ op: { id: "o", label: "Push", line: null, cancellable: true } })]) {
      const buttons = syncButtons(view);
      expect([buttons.fetch.enabled, buttons.pull.enabled, buttons.push.enabled]).toEqual([false, false, false]);
      expect(gitLocked(view)).toBe(true);
    }
    expect(gitLocked(ready())).toBe(false);
    expect(gitLocked(null)).toBe(true);
  });

  it("say why syncing is off, in words that do not send the human to a sidebar", () => {
    expect(syncNote(ready({ refs: refs({ remotes: [] }) }))).toBe("This repository has no remote to fetch from or push to.");
    expect(syncNote(ready({ repo: repo({ detached: true }) }))).toMatch(/detached/);
    expect(syncNote(ready({ repo: repo({ unborn: true }) }))).toMatch(/Nothing is committed yet/);
    expect(syncNote(ready())).toBeNull();
    expect(syncButtons(ready({ refs: refs({ remotes: [] }) })).fetch.enabled).toBe(false);
  });
});

describe("the branch line", () => {
  it("names the branch and where it stands against its upstream", () => {
    expect(branchLine(ready())).toBe("main · ↑1");
    expect(branchLine(ready({ refs: refs({ branches: [branch("main", { current: true })] }) }))).toBe("main");
    expect(branchLine(ready({ refs: refs({ branches: [branch("main", { current: true, ahead: 1, behind: 3 })] }) }))).toBe(
      "main · ↑1 ↓3"
    );
    expect(branchLine(ready({ refs: refs({ branches: [branch("main", { current: true, upstream: null })] }) }))).toBe(
      "main · not published"
    );
  });

  it("says detached and unborn as such", () => {
    expect(branchLine(ready({ repo: repo({ detached: true, branch: "a1b2c3d" }) }))).toBe("a1b2c3d · detached");
    expect(branchLine(ready({ repo: repo({ unborn: true }) }))).toBe("main · no commits yet");
    expect(branchLine({ ...initialState(ROOT) })).toBeNull();
  });
});

describe("an operation stopped part-way", () => {
  it("is not there when nothing is in progress", () => {
    expect(inProgressBanner(ready())).toBeNull();
  });

  it("says how many files are conflicted, and leaves a merge to the commit box", () => {
    const view = ready({
      repo: repo({ inProgress: "merge" }),
      status: { unstaged: [{ path: "a.ts", status: "U" }, { path: "b.ts", status: "U" }], staged: [] },
    });
    expect(inProgressBanner(view)).toEqual({
      kind: "merge",
      text: "Merge in progress — 2 files conflicted; resolve them and commit",
      canContinue: false,
      continueEnabled: false,
    });
  });

  it("offers Continue on a rebase once nothing is conflicted", () => {
    expect(inProgressBanner(ready({ repo: repo({ inProgress: "rebase" }) }))).toEqual({
      kind: "rebase",
      text: "Rebase in progress — no conflicts left — continue when ready",
      canContinue: true,
      continueEnabled: true,
    });
  });
});

describe("the Changes pane", () => {
  it("lists what is not staged and what is, with the bulk action each has", () => {
    const [unstaged, staged] = changeSections(ready());
    expect(unstaged).toMatchObject({ area: "unstaged", title: "Unstaged", total: 2, hidden: 0, bulk: "Stage all" });
    expect(unstaged.entries.map((e) => e.path)).toEqual(["src/auth/rotation.ts", "src/auth/tokens.ts"]);
    expect(staged).toMatchObject({ area: "staged", title: "Staged", total: 1, bulk: "Unstage all" });
  });

  it("offers no bulk action on an empty section, and says it is empty", () => {
    const [, staged] = changeSections(ready({ status: { unstaged: [], staged: [] } }));
    expect(staged).toMatchObject({ bulk: null, empty: "Nothing staged", entries: [] });
  });

  it("caps a huge list as the desk does, and says how many it left out", () => {
    const unstaged = Array.from({ length: 1003 }, (_, i) => ({ path: `f${i}.ts`, status: "M" as const }));
    const [section] = changeSections(ready({ status: { unstaged, staged: [] } }));
    expect(section.entries).toHaveLength(1000);
    expect(section.hidden).toBe(3);
  });

  it("counts each changed file once, staged or not", () => {
    const view = ready({
      status: { unstaged: [{ path: "a.ts", status: "M" }], staged: [{ path: "a.ts", status: "M" }, { path: "b.ts", status: "A" }] },
    });
    expect(changesCount(view)).toBe(2);
  });
});

describe("the diff page", () => {
  it("is open while the desk's selection names a file that is still changed", () => {
    expect(openFile(ready())).toBeNull();
    expect(openFile(ready({ selected: { path: "src/auth/tokens.ts", area: "unstaged" } }))).toEqual({
      path: "src/auth/tokens.ts",
      status: "M",
    });
    expect(openFile(ready({ selected: { path: "gone.ts", area: "unstaged" } }))).toBeNull();
  });

  it("heads the page with the file, its folder, and what kind of change it is", () => {
    expect(diffHeading({ path: "src/auth/tokens.ts", status: "M" }, "unstaged")).toEqual({
      name: "tokens.ts",
      dir: "src/auth/",
      detail: "Modified · not staged",
    });
    expect(diffHeading({ path: "b.ts", oldPath: "a.ts", status: "R" }, "staged").dir).toBe("a.ts → ");
    expect(statusWord("?")).toBe("Untracked");
  });

  it("shows a conflict rather than a diff, and says why there is none otherwise", () => {
    const entry = { path: "a.ts", status: "M" as const };
    expect(diffBody(ready(), { path: "a.ts", status: "U" })).toBe("conflict");
    expect(diffBody(ready(), entry)).toBe("loading");
    const diff = { path: "a.ts", binary: false, tooLarge: false, hunks: [] };
    expect(diffBody(ready({ diff }), entry)).toBe("empty");
    expect(diffBody(ready({ diff: { ...diff, binary: true } }), entry)).toBe("binary");
    expect(diffBody(ready({ diff: { ...diff, tooLarge: true } }), entry)).toBe("too-large");
    const hunk = { header: "@@ -1 +1 @@", oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: [] };
    expect(diffBody(ready({ diff: { ...diff, hunks: [hunk] } }), entry)).toBe("lines");
  });

  it("stages what is not staged, unstages what is, and marks a conflict resolved", () => {
    expect(fileAction({ path: "a.ts", status: "M" }, "unstaged")).toBe("Stage");
    expect(fileAction({ path: "a.ts", status: "M" }, "staged")).toBe("Unstage");
    expect(fileAction({ path: "a.ts", status: "U" }, "unstaged")).toBe("Mark resolved");
  });
});

describe("the Branches pane", () => {
  it("puts the branch checked out first, with where each stands", () => {
    expect(localBranches(ready())).toEqual([
      { name: "main", current: true, subject: "on main", standing: "↑1" },
      { name: "feat/x", current: false, subject: "on feat/x", standing: "" },
    ]);
  });

  it("offers the remote's branches this repository has no branch of, and never HEAD", () => {
    expect(remoteOnlyBranches(ready())).toEqual([{ remote: "origin", name: "fix/y" }]);
  });

  it("refuses a new branch name git would, and one already taken", () => {
    expect(newBranchProblem(ready(), "feat/rotation")).toBeNull();
    expect(newBranchProblem(ready(), "has space")).toBe("No spaces allowed");
    expect(newBranchProblem(ready(), "feat/x")).toBe("A branch named feat/x already exists");
  });

  it("asks before merging, naming both branches", () => {
    expect(mergeQuestion(ready(), "feat/x")).toBe("Merge feat/x into main?");
  });
});

describe("Commit via agent", () => {
  const HEADLESS = "-p";

  it("is a button the desk's blocker rules, said beside it", () => {
    expect(agentCommitControl(ready(), HEADLESS, 0)).toEqual({
      shows: "button",
      label: "Commit via agent",
      elapsed: null,
      blocker: null,
      canShow: false,
      canStop: false,
      session: null,
    });
    expect(agentCommitControl(ready(), "", 0).blocker).toBe("This workspace's agent has no verified headless mode");
    expect(agentCommitControl(ready({ busy: "Stage" }), HEADLESS, 0).blocker).toBe("Another git operation is running");
    expect(agentCommitControl(ready({ status: { unstaged: [], staged: [] } }), HEADLESS, 0).blocker).toBe(
      "Nothing to commit"
    );
  });

  it("waits for the agent settings rather than calling the agent headless-less", () => {
    expect(agentCommitControl(ready(), null, 0).blocker).toBe("Reading the Workstation’s agent settings…");
  });

  it("says Committing… with how long, from the press until the session, and offers Show and Stop once there is one", () => {
    const starting = ready({ agentCommit: { sessionId: null, startedAt: 1_000, stopping: false } });
    expect(agentCommitControl(starting, HEADLESS, 4_000)).toMatchObject({
      shows: "running",
      label: "Committing…",
      elapsed: "3s",
      canShow: false,
      canStop: false,
    });
    const running = ready({ agentCommit: { sessionId: "agent-1", startedAt: 1_000, stopping: false } });
    expect(agentCommitControl(running, HEADLESS, 62_000)).toMatchObject({
      label: "Committing…",
      elapsed: "1m 1s",
      canShow: true,
      canStop: true,
      session: "agent-1",
    });
  });

  it("says Stopping… and takes Stop away once it is asked for", () => {
    const stopping = ready({ agentCommit: { sessionId: "agent-1", startedAt: null, stopping: true } });
    expect(agentCommitControl(stopping, HEADLESS, 0)).toMatchObject({
      label: "Stopping…",
      elapsed: null,
      canShow: true,
      canStop: false,
    });
  });

  it("says Committed after a run that emptied the tree", () => {
    expect(agentCommitControl(ready({ agentCommitDone: true }), HEADLESS, 0)).toMatchObject({
      shows: "done",
      label: "Committed",
    });
  });
});
