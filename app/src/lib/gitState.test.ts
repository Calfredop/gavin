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
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));

import * as backend from "./backend";
import { listen } from "@tauri-apps/api/event";
import {
  gitStore, initialState, applyStatus, followSelection, splitMessage, joinMessage, canCommit,
  ensureGitView, refresh, select, run, stageFiles, stageAll, commit, setCommitDraft, setLineSelection,
  effectiveRemote, pushLabel, canSync, setActiveRemote, startOp, fetch, selectStash, selectChanges,
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
  vi.mocked(backend.gitRepoInfo).mockResolvedValue(repo);
  vi.mocked(backend.gitStatus).mockResolvedValue(status);
  vi.mocked(backend.gitDiff).mockResolvedValue({ path: "a.ts", binary: false, tooLarge: false, hunks: [] });
  vi.mocked(backend.gitRefs).mockResolvedValue(snapshot);
});

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
