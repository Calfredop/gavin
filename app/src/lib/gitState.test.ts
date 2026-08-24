import { describe, it, expect, vi, beforeEach } from "vitest";
import { get } from "svelte/store";

vi.mock("./backend", () => ({
  gitRepoInfo: vi.fn(),
  gitStatus: vi.fn(),
  gitDiff: vi.fn(),
  gitStageFiles: vi.fn().mockResolvedValue(undefined),
  gitUnstageFiles: vi.fn().mockResolvedValue(undefined),
  gitStageAll: vi.fn().mockResolvedValue(undefined),
  gitUnstageAll: vi.fn().mockResolvedValue(undefined),
  gitApplyPatch: vi.fn().mockResolvedValue(undefined),
  gitDiscardFiles: vi.fn().mockResolvedValue(undefined),
  gitCommit: vi.fn().mockResolvedValue(undefined),
  gitInit: vi.fn().mockResolvedValue(undefined),
  gitWatch: vi.fn().mockResolvedValue(undefined),
  gitUnwatch: vi.fn().mockResolvedValue(undefined),
  gitRefs: vi.fn(),
  gitFetch: vi.fn().mockResolvedValue(undefined),
  gitPull: vi.fn().mockResolvedValue(undefined),
  gitPush: vi.fn().mockResolvedValue(undefined),
  gitCancelOp: vi.fn().mockResolvedValue(true),
  gitCheckout: vi.fn().mockResolvedValue(undefined),
  gitCreateBranch: vi.fn().mockResolvedValue(undefined),
  gitDeleteBranch: vi.fn().mockResolvedValue(undefined),
  gitMerge: vi.fn().mockResolvedValue(undefined),
  gitAbortInProgress: vi.fn().mockResolvedValue(undefined),
  gitContinueRebase: vi.fn().mockResolvedValue(undefined),
  gitAddRemote: vi.fn().mockResolvedValue(undefined),
  gitRemoveRemote: vi.fn().mockResolvedValue(undefined),
  gitStashPush: vi.fn().mockResolvedValue(undefined),
  gitStashPop: vi.fn().mockResolvedValue(undefined),
  gitStashApply: vi.fn().mockResolvedValue(undefined),
  gitStashDrop: vi.fn().mockResolvedValue(undefined),
  gitStashFiles: vi.fn().mockResolvedValue([]),
  gitWorktreeAdd: vi.fn().mockResolvedValue(undefined),
  gitWorktreeRemove: vi.fn().mockResolvedValue(undefined),
  gitWorktreePrune: vi.fn().mockResolvedValue(undefined),
  gitLog: vi.fn(),
  gitCommitDetail: vi.fn(),
  gitCheckoutCommit: vi.fn().mockResolvedValue(undefined),
  gitCherryPick: vi.fn().mockResolvedValue(undefined),
  gitRevert: vi.fn().mockResolvedValue(undefined),
  gitReset: vi.fn().mockResolvedValue(undefined),
  gitContinueInProgress: vi.fn().mockResolvedValue(undefined),
  gitConflict: vi.fn(),
  gitMarkResolved: vi.fn().mockResolvedValue(undefined),
  gitResolveWhole: vi.fn().mockResolvedValue(undefined),
  gitResolveDeleted: vi.fn().mockResolvedValue(undefined),
  gitRestoreConflict: vi.fn().mockResolvedValue(undefined),
  gitMergeToolName: vi.fn().mockResolvedValue(null),
  writeFileForEditor: vi.fn().mockResolvedValue(undefined),
  createSession: vi.fn().mockResolvedValue("agent-1"),
  setSessionName: vi.fn().mockResolvedValue(undefined),
}));
// pty-output listeners are collected so a test can push a hidden run's
// output at them; every other event keeps the inert default.
const ptyListeners: Array<(e: { payload: [string, string] }) => void> = [];
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((name: string, handler: (e: { payload: [string, string] }) => void) => {
    if (name === "pty-output") ptyListeners.push(handler);
    return Promise.resolve(() => {
      const i = ptyListeners.indexOf(handler);
      if (i >= 0) ptyListeners.splice(i, 1);
    });
  }),
}));
vi.mock("./layoutState", async () => {
  const { writable } = await import("svelte/store");
  return {
    setGitViewPrefs: vi.fn().mockResolvedValue(undefined),
    layoutState: writable({ workspaces: [] }),
    createSessionForCard: vi.fn().mockResolvedValue("sess-1"),
    resolvedAgentFor: vi.fn(() => ({
      profileId: "claude-code",
      file: "CLAUDE.md",
      command: "claude",
      mcpSupported: true,
      mcpConfigFile: ".mcp.json",
      headlessArgs: '-p --allowedTools "Bash(git *)" --',
    })),
    sessionExits: writable(new Map<string, number>()),
    handleAgentSessionSpawned: vi.fn(),
    switchWorkspaceView: vi.fn().mockResolvedValue(undefined),
    switchToSessionInPage: vi.fn().mockResolvedValue(undefined),
  };
});

import * as backend from "./backend";
import { listen } from "@tauri-apps/api/event";
import {
  setGitViewPrefs,
  createSessionForCard,
  layoutState,
  resolvedAgentFor,
  sessionExits,
  handleAgentSessionSpawned,
  switchToSessionInPage,
} from "./layoutState";
import {
  gitStore, initialState, applyStatus, followSelection, splitMessage, joinMessage, canCommit,
  ensureGitView, refresh, select, run, stageFiles, stageAll, commit, setCommitDraft, setLineSelection,
  effectiveRemote, pushLabel, canSync, setActiveRemote, startOp, fetch, selectStash, selectChanges,
  switchWorktree, mergeBack, rootPathOf, removeWorktree,
  selectCommits, loadMore, selectCommit, selectDetailFile, setGraphAll,
  markResolved, saveConflict, openMergeTool,
  commitViaAgent, revealAgentCommit, agentCommitPhase, agentCommitBlocker, AGENT_COMMIT_FLASH_MS,
} from "./gitState";
import type { RefsSnapshot, RepoInfo, StatusResult } from "./git";

const snapshot: RefsSnapshot = {
  branches: [{ name: "main", current: true, upstream: "origin/main", ahead: 2, behind: 1, sha: "a", subject: "s" }],
  remotes: [{ name: "origin", url: "u", branches: ["main"] }, { name: "upstream", url: "v", branches: [] }],
  stashes: [],
  worktrees: [],
  headBranch: "main",
};

const repo: RepoInfo = {
  notARepo: false, root: "/r", branch: "main", detached: false, unborn: false,
  author: { name: "A", email: "a@b" }, headMessage: "old subject\n\nold body", inProgress: null,
};
const status: StatusResult = {
  unstaged: [{ path: "a.ts", status: "M" }, { path: "u.txt", status: "?" }],
  staged: [{ path: "a.ts", status: "M" }, { path: "n.ts", status: "A" }],
};

beforeEach(() => {
  vi.clearAllMocks();
  gitStore.set({});
  sessionExits.set(new Map());
  ptyListeners.length = 0;
  vi.mocked(backend.gitRepoInfo).mockResolvedValue(repo);
  vi.mocked(backend.gitStatus).mockResolvedValue(status);
  vi.mocked(backend.gitDiff).mockResolvedValue({ path: "a.ts", binary: false, tooLarge: false, hunks: [] });
  vi.mocked(backend.gitRefs).mockResolvedValue(snapshot);
  vi.mocked(backend.gitLog).mockResolvedValue({ commits: [commitInfo("aaa", ["bbb"]), commitInfo("bbb", [])], hasMore: true });
  vi.mocked(backend.gitCommitDetail).mockResolvedValue({ body: "subject\n\nbody", files: [{ path: "a.ts", status: "M" }, { path: "b.ts", status: "A" }] });
});

function commitInfo(sha: string, parents: string[]) {
  return { sha, parents, author: "A", email: "a@b", date: "2026-08-21T00:00:00Z", subject: `s ${sha}`, refs: [], isHead: false };
}

describe("followSelection", () => {
  it("keeps a selection that still exists", () => {
    expect(followSelection(status, { path: "a.ts", area: "unstaged" })).toEqual({ path: "a.ts", area: "unstaged" });
  });
  it("jumps to the counterpart list when the file left its list", () => {
    const after: StatusResult = { unstaged: [], staged: [{ path: "u.txt", status: "A" }] };
    expect(followSelection(after, { path: "u.txt", area: "unstaged" })).toEqual({ path: "u.txt", area: "staged" });
  });
  it("clears when the file has no changes anywhere", () => {
    expect(followSelection({ unstaged: [], staged: [] }, { path: "a.ts", area: "staged" })).toBeNull();
  });
});

describe("applyStatus", () => {
  it("drops the stale diff and line selection when the selection moves", () => {
    const s = { ...initialState("/r"), selected: { path: "u.txt", area: "unstaged" as const }, diff: { path: "u.txt", binary: false, tooLarge: false, hunks: [] }, lineSelection: new Set(["0:0"]) };
    const next = applyStatus(s, { unstaged: [], staged: [{ path: "u.txt", status: "A" }] });
    expect(next.selected).toEqual({ path: "u.txt", area: "staged" });
    expect(next.diff).toBeNull();
    expect(next.lineSelection.size).toBe(0);
  });
});

describe("commit message helpers", () => {
  it("splits on the first blank line and joins back", () => {
    expect(splitMessage("subject\n\nbody\nmore")).toEqual({ summary: "subject", description: "body\nmore" });
    expect(splitMessage("only subject")).toEqual({ summary: "only subject", description: "" });
    expect(joinMessage({ summary: "s", description: "d", amend: false })).toBe("s\n\nd");
    expect(joinMessage({ summary: "s", description: "", amend: false })).toBe("s");
  });
  it("canCommit needs author, summary, staged files (or amend), and no busy op", () => {
    const base = { ...initialState("/r"), repo, status, commit: { summary: "x", description: "", amend: false } };
    expect(canCommit(base)).toBe(true);
    expect(canCommit({ ...base, repo: { ...repo, author: null } })).toBe(false);
    expect(canCommit({ ...base, commit: { ...base.commit, summary: "  " } })).toBe(false);
    expect(canCommit({ ...base, status: { unstaged: [], staged: [] } })).toBe(false);
    expect(canCommit({ ...base, status: { unstaged: [], staged: [] }, commit: { ...base.commit, amend: true } })).toBe(true);
    expect(canCommit({ ...base, busy: "Commit" })).toBe(false);
  });
});

describe("refresh", () => {
  it("loads repo + status and re-diffs the selection", async () => {
    ensureGitView("ws", "/r");
    await select("ws", { path: "a.ts", area: "staged" });
    await refresh("ws");
    const s = get(gitStore)["ws"];
    expect(s.repo).toEqual(repo);
    expect(s.status).toEqual(status);
    expect(backend.gitDiff).toHaveBeenLastCalledWith("/r", "a.ts", null, true, false);
  });

  it("drops a superseded result", async () => {
    ensureGitView("ws", "/r");
    let resolveFirst!: (v: StatusResult) => void;
    vi.mocked(backend.gitStatus)
      .mockImplementationOnce(() => new Promise((res) => (resolveFirst = res)))
      .mockResolvedValueOnce({ unstaged: [], staged: [] });
    const first = refresh("ws");
    await refresh("ws");
    resolveFirst(status);
    await first;
    expect(get(gitStore)["ws"].status).toEqual({ unstaged: [], staged: [] });
  });

  it("flags a missing git binary instead of erroring", async () => {
    ensureGitView("ws", "/r");
    vi.mocked(backend.gitRepoInfo).mockRejectedValueOnce("git was not found on PATH");
    await refresh("ws");
    expect(get(gitStore)["ws"].gitMissing).toBe(true);
    expect(get(gitStore)["ws"].error).toBeNull();
  });
});

describe("run / mutations", () => {
  it("serialises: a second action while busy is refused", async () => {
    ensureGitView("ws", "/r");
    let release!: () => void;
    const slow = run("ws", "Stage", () => new Promise<void>((res) => (release = res)));
    expect(await run("ws", "Stage all", async () => {})).toBe(false);
    release();
    expect(await slow).toBe(true);
    expect(get(gitStore)["ws"].busy).toBeNull();
  });

  it("clears the line selection after a successful mutation but keeps it on failure", async () => {
    ensureGitView("ws", "/r");
    setLineSelection("ws", new Set(["0:1"]));
    vi.mocked(backend.gitStageFiles).mockRejectedValueOnce("boom");
    await stageFiles("ws", ["a.ts"]);
    expect(get(gitStore)["ws"].lineSelection.size).toBe(1);
    await stageFiles("ws", ["a.ts"]);
    expect(get(gitStore)["ws"].lineSelection.size).toBe(0);
  });

  it("records '<label> failed: <stderr>' and still refreshes on failure", async () => {
    ensureGitView("ws", "/r");
    vi.mocked(backend.gitStageFiles).mockRejectedValueOnce("fatal: pathspec 'x' did not match");
    expect(await stageFiles("ws", ["x"])).toBe(false);
    expect(get(gitStore)["ws"].error).toBe("Stage failed: fatal: pathspec 'x' did not match");
    expect(backend.gitStatus).toHaveBeenCalled();
  });

  it("commit joins the draft, clears it on success", async () => {
    ensureGitView("ws", "/r");
    await refresh("ws");
    setCommitDraft("ws", { summary: "feat: x", description: "body" });
    expect(await commit("ws")).toBe(true);
    expect(backend.gitCommit).toHaveBeenCalledWith("/r", "feat: x\n\nbody", false);
    expect(get(gitStore)["ws"].commit).toEqual({ summary: "", description: "", amend: false });
  });

  it("amend pre-fills from HEAD only when the draft is empty, and unticking restores it", async () => {
    ensureGitView("ws", "/r");
    await refresh("ws");
    setCommitDraft("ws", { amend: true });
    expect(get(gitStore)["ws"].commit).toEqual({ summary: "old subject", description: "old body", amend: true });
    setCommitDraft("ws", { amend: false });
    expect(get(gitStore)["ws"].commit).toEqual({ summary: "", description: "", amend: false });

    setCommitDraft("ws", { summary: "mine" });
    setCommitDraft("ws", { amend: true });
    expect(get(gitStore)["ws"].commit.summary).toBe("mine");
  });

  it("ensureGitView resets state when the cwd changes and keeps it otherwise", () => {
    ensureGitView("ws", "/r");
    setLineSelection("ws", new Set(["0:1"]));
    ensureGitView("ws", "/r");
    expect(get(gitStore)["ws"].lineSelection.size).toBe(1);
    ensureGitView("ws", "/other");
    expect(get(gitStore)["ws"].cwd).toBe("/other");
    expect(get(gitStore)["ws"].lineSelection.size).toBe(0);
  });
});

describe("sync helpers", () => {
  it("effectiveRemote prefers the override, then the upstream's remote, then origin", async () => {
    ensureGitView("ws", "/r");
    await refresh("ws");
    expect(effectiveRemote(get(gitStore)["ws"])).toBe("origin");
    setActiveRemote("ws", "upstream");
    expect(effectiveRemote(get(gitStore)["ws"])).toBe("upstream");
  });

  it("pushLabel is Publish without an upstream and canSync explains why things are disabled", async () => {
    ensureGitView("ws", "/r");
    await refresh("ws");
    expect(pushLabel(get(gitStore)["ws"])).toBe("Push");
    vi.mocked(backend.gitRefs).mockResolvedValueOnce({ ...snapshot, branches: [{ ...snapshot.branches[0], upstream: null, ahead: 0, behind: 0 }] });
    await refresh("ws");
    expect(pushLabel(get(gitStore)["ws"])).toBe("Publish");
    vi.mocked(backend.gitRefs).mockResolvedValueOnce({ ...snapshot, remotes: [] });
    await refresh("ws");
    expect(canSync(get(gitStore)["ws"])).toMatchObject({ fetch: false, reason: expect.stringContaining("No remotes") });
  });
});

describe("long ops", () => {
  it("startOp sets op, records progress for its id, refuses a second op, refreshes and clears", async () => {
    ensureGitView("ws", "/r");
    let handler!: (e: { payload: { opId: string; line: string } }) => void;
    vi.mocked(listen).mockImplementationOnce(async (_n, h) => {
      handler = h as never;
      return () => {};
    });
    let finish!: () => void;
    const p = startOp("ws", "Fetch", () => new Promise<void>((res) => (finish = res)));
    await Promise.resolve();
    await Promise.resolve();
    const id = get(gitStore)["ws"].op!.id;
    handler({ payload: { opId: "other", line: "nope" } });
    handler({ payload: { opId: id, line: "Receiving objects: 50%" } });
    expect(get(gitStore)["ws"].op).toMatchObject({ label: "Fetch", line: "Receiving objects: 50%" });
    expect(await startOp("ws", "Pull", async () => {})).toBe(false);
    expect(await stageAll("ws")).toBe(false);
    finish();
    await p;
    expect(get(gitStore)["ws"].op).toBeNull();
    expect(backend.gitStatus).toHaveBeenCalled();
  });

  it("a cancelled op reports 'cancelled' in the banner", async () => {
    ensureGitView("ws", "/r");
    await refresh("ws");
    vi.mocked(backend.gitFetch).mockRejectedValueOnce("cancelled");
    await fetch("ws");
    expect(get(gitStore)["ws"].error).toBe("Fetch cancelled");
    expect(backend.gitFetch).toHaveBeenCalledWith("/r", "origin", expect.any(String));
  });
});

describe("nav selection", () => {
  it("selectStash loads its files and selectChanges restores", async () => {
    ensureGitView("ws", "/r");
    vi.mocked(backend.gitStashFiles).mockResolvedValueOnce([{ path: "a", status: "M" }]);
    await selectStash("ws", 0);
    expect(get(gitStore)["ws"].navSelection).toEqual({ stash: 0 });
    expect(get(gitStore)["ws"].stashFiles).toEqual([{ path: "a", status: "M" }]);
    selectChanges("ws");
    expect(get(gitStore)["ws"].navSelection).toBe("changes");
    expect(get(gitStore)["ws"].stashFiles).toBeNull();
  });
});

describe("worktrees", () => {
  it("switchWorktree resets state to the new cwd, persists the selection and refreshes", async () => {
    ensureGitView("ws", "/r");
    setLineSelection("ws", new Set(["0:1"]));
    await switchWorktree("ws", "/r-feature");
    const s = get(gitStore)["ws"];
    expect(s.cwd).toBe("/r-feature");
    expect(s.lineSelection.size).toBe(0);
    expect(setGitViewPrefs).toHaveBeenCalledWith("ws", { worktree: "/r-feature" });
    expect(backend.gitRepoInfo).toHaveBeenLastCalledWith("/r-feature");
  });

  it("rootPathOf prefers the main worktree from refs", async () => {
    ensureGitView("ws", "/r-feature");
    vi.mocked(backend.gitRefs).mockResolvedValueOnce({
      ...snapshot,
      worktrees: [
        { path: "/r", head: "a", branch: "main", isMain: true, locked: false, prunable: false },
        { path: "/r-feature", head: "b", branch: "feature", isMain: false, locked: false, prunable: false },
      ],
    });
    await refresh("ws");
    expect(rootPathOf(get(gitStore)["ws"])).toBe("/r");
  });

  it("mergeBack merges in the root checkout and classifies conflicts", async () => {
    ensureGitView("ws", "/r-feature");
    expect(await mergeBack("ws", "/r", "feature")).toBe("merged");
    expect(backend.gitMerge).toHaveBeenCalledWith("/r", "feature");
    vi.mocked(backend.gitMerge).mockRejectedValueOnce("CONFLICT (content)");
    vi.mocked(backend.gitRepoInfo).mockResolvedValue({ ...repo, inProgress: "merge" });
    expect(await mergeBack("ws", "/r", "feature")).toBe("conflict");
  });

  it("removeWorktree optionally deletes the branch in the same op", async () => {
    ensureGitView("ws", "/r");
    await removeWorktree("ws", "/r-feature", false, "feature");
    expect(backend.gitWorktreeRemove).toHaveBeenCalledWith("/r", "/r-feature", false);
    expect(backend.gitDeleteBranch).toHaveBeenCalledWith("/r", "feature", false);
  });
});

describe("history", () => {
  it("selectCommits loads page 0 over all branches and loadMore appends the next page", async () => {
    ensureGitView("ws", "/r");
    await selectCommits("ws");
    expect(get(gitStore)["ws"].navSelection).toBe("commits");
    expect(backend.gitLog).toHaveBeenLastCalledWith("/r", true, 0, 300);
    expect(get(gitStore)["ws"].log?.commits.map((c) => c.sha)).toEqual(["aaa", "bbb"]);
    vi.mocked(backend.gitLog).mockResolvedValueOnce({ commits: [commitInfo("ccc", [])], hasMore: false });
    await loadMore("ws");
    expect(backend.gitLog).toHaveBeenLastCalledWith("/r", true, 2, 300);
    expect(get(gitStore)["ws"].log).toMatchObject({ hasMore: false });
    expect(get(gitStore)["ws"].log?.commits).toHaveLength(3);
  });

  it("selectCommit loads the detail and the first file's diff at that revision; refresh keeps it", async () => {
    ensureGitView("ws", "/r");
    await selectCommits("ws");
    await selectCommit("ws", "aaa");
    const s = get(gitStore)["ws"];
    expect(s.commitDetail?.body).toBe("subject\n\nbody");
    expect(s.detailFile).toBe("a.ts");
    expect(backend.gitDiff).toHaveBeenLastCalledWith("/r", "a.ts", null, false, false, "aaa");
    await selectDetailFile("ws", "b.ts");
    expect(backend.gitDiff).toHaveBeenLastCalledWith("/r", "b.ts", null, false, false, "aaa");
    await refresh("ws");
    expect(get(gitStore)["ws"].selectedCommit).toBe("aaa");
    vi.mocked(backend.gitLog).mockResolvedValueOnce({ commits: [commitInfo("zzz", [])], hasMore: false });
    await refresh("ws");
    expect(get(gitStore)["ws"].selectedCommit).toBeNull();
    expect(get(gitStore)["ws"].commitDetail).toBeNull();
  });

  it("setGraphAll persists the scope and reloads page 0", async () => {
    ensureGitView("ws", "/r");
    await selectCommits("ws");
    await setGraphAll("ws", false);
    expect(setGitViewPrefs).toHaveBeenCalledWith("ws", { graphAll: false });
    expect(backend.gitLog).toHaveBeenLastCalledWith("/r", false, 0, 300);
  });
});

describe("conflicts", () => {
  const conflicted: StatusResult = {
    unstaged: [{ path: "a.ts", status: "U" }, { path: "b.ts", status: "U" }, { path: "c.ts", status: "M" }],
    staged: [],
  };
  const info = {
    path: "a.ts", kind: "text" as const, base: "b", ours: "o", theirs: "t", worktree: "<<<<<<< HEAD\no\n=======\nt\n>>>>>>> x\n",
    hasMarkers: true, eol: "lf" as const, finalNewline: true, labels: { ours: "main", theirs: "x", operation: "merge" as const }, deletedBy: null,
  };

  it("selecting a U row loads the conflict instead of a diff", async () => {
    vi.mocked(backend.gitStatus).mockResolvedValue(conflicted);
    vi.mocked(backend.gitConflict).mockResolvedValue(info);
    ensureGitView("ws", "/r");
    await refresh("ws");
    await select("ws", { path: "a.ts", area: "unstaged" });
    const s = get(gitStore)["ws"];
    expect(s.conflict?.path).toBe("a.ts");
    expect(s.diff).toBeNull();
    expect(backend.gitDiff).not.toHaveBeenCalled();
  });

  it("markResolved advances to the next conflicted file; stageFiles routes U paths; stageAll refuses", async () => {
    vi.mocked(backend.gitStatus).mockResolvedValue(conflicted);
    vi.mocked(backend.gitConflict).mockResolvedValue(info);
    ensureGitView("ws", "/r");
    await refresh("ws");
    await select("ws", { path: "a.ts", area: "unstaged" });
    vi.mocked(backend.gitStatus).mockResolvedValue({ unstaged: [{ path: "b.ts", status: "U" }, { path: "c.ts", status: "M" }], staged: [{ path: "a.ts", status: "M" }] });
    expect(await markResolved("ws")).toBe(true);
    expect(backend.gitMarkResolved).toHaveBeenCalledWith("/r", "a.ts");
    expect(get(gitStore)["ws"].selected).toEqual({ path: "b.ts", area: "unstaged" });

    await stageFiles("ws", ["b.ts", "c.ts"]);
    expect(backend.gitStageFiles).toHaveBeenCalledWith("/r", ["c.ts"]);
    expect(backend.gitMarkResolved).toHaveBeenCalledWith("/r", "b.ts");

    expect(await stageAll("ws")).toBe(false);
    expect(get(gitStore)["ws"].error).toMatch(/Resolve the 1 conflicted file first/);
    expect(backend.gitStageAll).not.toHaveBeenCalled();
  });

  it("saveConflict writes the file and openMergeTool opens a terminal in the worktree", async () => {
    vi.mocked(backend.gitStatus).mockResolvedValue(conflicted);
    vi.mocked(backend.gitConflict).mockResolvedValue(info);
    ensureGitView("ws", "/r");
    await refresh("ws");
    await select("ws", { path: "a.ts", area: "unstaged" });
    expect(await saveConflict("ws", "resolved\n")).toBe(true);
    expect(backend.writeFileForEditor).toHaveBeenCalledWith("/r/a.ts", "resolved\n");
    await openMergeTool("ws");
    expect(createSessionForCard).toHaveBeenCalledWith("ws", "/r", "git mergetool --no-prompt -- 'a.ts'");
  });
});


describe("commit via agent", () => {
  // The action's promise only settles when the hidden session exits, so
  // every test here holds it and drives the exit itself. Microtask
  // flushes, not timers: the launch path is all awaited promises.
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  };

  // Boxed: `await` unwraps a promise that resolves to a promise, so
  // returning the in-flight run bare would wait for the very exit these
  // tests are here to drive.
  async function launch(): Promise<{ done: Promise<boolean> }> {
    ensureGitView("ws", "/r");
    await refresh("ws");
    const done = commitViaAgent("ws");
    await flush();
    return { done };
  }

  function exitWith(code: number): void {
    sessionExits.set(new Map([["agent-1", code]]));
  }

  function emit(data: string, sessionId = "agent-1"): void {
    for (const l of ptyListeners) l({ payload: [sessionId, data] });
  }

  it("runs the canned prompt headlessly, in the view's cwd, with no tab", async () => {
    const { done } = await launch();
    expect(backend.createSession).toHaveBeenCalledWith(
      "/r",
      'claude -p --allowedTools "Bash(git *)" -- \'Commit pending and unversioned changes, in logical chunks. Do not push.\''
    );
    // Hidden: nothing lands on the Agents page unless the human asks.
    expect(handleAgentSessionSpawned).not.toHaveBeenCalled();
    // Named anyway, for the moment they do ask.
    expect(backend.setSessionName).toHaveBeenCalledWith("agent-1", "commit");
    expect(agentCommitPhase(get(gitStore)["ws"])).toBe("running");
    exitWith(0);
    await done;
  });

  it("flashes done on a clean exit that emptied the tree, then goes back to idle", async () => {
    vi.useFakeTimers();
    try {
      const { done } = await launch();
      vi.mocked(backend.gitStatus).mockClear();
      vi.mocked(backend.gitStatus).mockResolvedValue({ unstaged: [], staged: [] });
      exitWith(0);
      expect(await done).toBe(true);
      expect(agentCommitPhase(get(gitStore)["ws"])).toBe("done");
      expect(get(gitStore)["ws"].error).toBeNull();
      // The commits the agent just made are only visible after a refresh.
      expect(backend.gitStatus).toHaveBeenCalled();
      vi.advanceTimersByTime(AGENT_COMMIT_FLASH_MS);
      expect(agentCommitPhase(get(gitStore)["ws"])).toBe("idle");
    } finally {
      vi.useRealTimers();
    }
  });

  // A failure never flashes: it goes to the banner, which stays until
  // dismissed, because a message you missed is a run you cannot account for.
  it("puts a non-zero exit in the error banner, quoting what the run said", async () => {
    const { done } = await launch();
    emit("I could not run git here.\n");
    exitWith(2);
    expect(await done).toBe(false);
    expect(agentCommitPhase(get(gitStore)["ws"])).toBe("idle");
    expect(get(gitStore)["ws"].error).toBe(
      "Commit via agent failed (exit 2) — I could not run git here."
    );
  });

  // Exit 0 is not the verdict: a headless agent that decides it cannot
  // do the job says so in prose and exits cleanly.
  it("refuses to call a still-dirty tree committed, even on a clean exit", async () => {
    const { done } = await launch();
    emit("Nothing to do: the repo has no user.email set.");
    exitWith(0);
    expect(await done).toBe(false);
    expect(agentCommitPhase(get(gitStore)["ws"])).toBe("idle");
    expect(get(gitStore)["ws"].error).toBe(
      "Commit via agent left 4 changes uncommitted — Nothing to do: the repo has no user.email set."
    );
  });

  it("refuses a second run while one is in flight", async () => {
    const { done } = await launch();
    expect(await commitViaAgent("ws")).toBe(false);
    expect(backend.createSession).toHaveBeenCalledTimes(1);
    exitWith(0);
    await done;
  });

  it("surfaces a failed spawn and returns to idle", async () => {
    vi.mocked(backend.createSession).mockRejectedValueOnce(new Error("no pty"));
    ensureGitView("ws", "/r");
    await refresh("ws");
    expect(await commitViaAgent("ws")).toBe(false);
    expect(agentCommitPhase(get(gitStore)["ws"])).toBe("idle");
    expect(get(gitStore)["ws"].error).toBe("Commit via agent failed: no pty");
  });

  it("refuses an agent with no headless mode, saying so", async () => {
    vi.mocked(resolvedAgentFor).mockReturnValueOnce({
      profileId: "codex", file: "AGENTS.md", command: "codex",
      mcpSupported: false, mcpConfigFile: "", headlessArgs: "",
    });
    ensureGitView("ws", "/r");
    await refresh("ws");
    expect(await commitViaAgent("ws")).toBe(false);
    expect(backend.createSession).not.toHaveBeenCalled();
    expect(get(gitStore)["ws"].error).toMatch(/needs a headless agent/);
  });

  // A worktree switch replaces the view; the run it started must not
  // write its verdict into the state that replaced it.
  it("drops the verdict when the view has been replaced under it", async () => {
    const { done } = await launch();
    ensureGitView("ws", "/other");
    exitWith(3);
    expect(await done).toBe(false);
    expect(get(gitStore)["ws"].error).toBeNull();
    expect(agentCommitPhase(get(gitStore)["ws"])).toBe("idle");
  });

  it("reveals the hidden session on the Agents page and jumps to it", async () => {
    const { done } = await launch();
    layoutState.set({
      workspaces: [{ id: "ws", pages: [{ id: "p1", layout: { type: "leaf", tabs: ["agent-1"], activeTabIndex: 0 } }] }],
    } as never);
    await revealAgentCommit("ws");
    expect(handleAgentSessionSpawned).toHaveBeenCalledWith("ws", "agent-1");
    expect(switchToSessionInPage).toHaveBeenCalledWith("ws", "p1", "agent-1");
    exitWith(0);
    await done;
  });

  it("has nothing to reveal before the daemon hands back a session", async () => {
    await revealAgentCommit("ws");
    expect(handleAgentSessionSpawned).not.toHaveBeenCalled();
  });
});

describe("agentCommitBlocker", () => {
  const HEADLESS = '-p --allowedTools "Bash(git *)" --';

  it("passes a dirty tree with a headless agent and nothing else running", async () => {
    ensureGitView("ws", "/r");
    await refresh("ws");
    expect(agentCommitBlocker(get(gitStore)["ws"], HEADLESS)).toBeNull();
  });

  it("names the reason it cannot run", async () => {
    expect(agentCommitBlocker(null, HEADLESS)).toBe("No repository");
    ensureGitView("ws", "/r");
    await refresh("ws");
    const view = get(gitStore)["ws"];
    expect(agentCommitBlocker(view, "")).toMatch(/no verified headless mode/);
    expect(agentCommitBlocker({ ...view, busy: "Stage" }, HEADLESS)).toBe("Another git operation is running");
    expect(agentCommitBlocker({ ...view, status: { unstaged: [], staged: [] } }, HEADLESS)).toBe("Nothing to commit");
  });
});
