import { describe, it, expect, vi, beforeEach } from "vitest";
import { get } from "svelte/store";

vi.mock("$lib/core/backend", () => ({
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
  gitMergedBranches: vi.fn().mockResolvedValue([]),
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
  gitReadIgnoreFile: vi.fn().mockResolvedValue(""),
  gitWriteIgnoreFile: vi.fn().mockResolvedValue(undefined),
  gitAddIgnorePattern: vi.fn().mockResolvedValue(undefined),
  gitCompare: vi.fn(),
  gitCompareDiff: vi.fn(),
  writeFileForEditor: vi.fn().mockResolvedValue(undefined),
  createSession: vi.fn().mockResolvedValue("agent-1"),
  setSessionName: vi.fn().mockResolvedValue(undefined),
  adoptSession: vi.fn().mockResolvedValue(true),
  killSession: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));
vi.mock("$lib/core/notifications", () => ({ maybeNotifyAgentCommit: vi.fn().mockResolvedValue(undefined) }));
vi.mock("$lib/agents/launchQueue", async (original) => ({
  ...(await original<typeof import("$lib/agents/launchQueue")>()),
  deviceLaunchRefusal: vi.fn(() => null),
}));
vi.mock("$lib/core/layoutState", async () => {
  const { writable } = await import("svelte/store");
  return {
    setGitViewPrefs: vi.fn().mockResolvedValue(undefined),
    layoutState: writable({ workspaces: [] }),
    daemonCompat: writable({ daemonVersion: 22, appVersion: 22, degraded: false }),
    createSessionForCard: vi.fn().mockResolvedValue("sess-1"),
    profileIdForLaunch: vi.fn((agent: { profileId: string }): string | undefined => agent.profileId),
    resolvedAgentFor: vi.fn(() => ({
      profileId: "claude-code",
      label: "Claude Code",
      file: "CLAUDE.md",
      command: "claude",
      launchCommand: "claude",
      mcpSupported: true,
      mcpConfigFile: ".mcp.json",
      headlessArgs: '-p --allowedTools "Bash(git *)" --',
      failureCauses: [],
      promptArgs: "",
    })),
    sessionExits: writable(new Map<string, number>()),
    handleAgentSessionSpawned: vi.fn(),
    switchWorkspaceView: vi.fn().mockResolvedValue(undefined),
    switchToSessionInPage: vi.fn().mockResolvedValue(undefined),
    workspaceRootPath: vi.fn(() => "/repos/gavin"),
    agentDefaultsStore: writable({
      customCommand: "",
      customModelFlag: "",
      complexity: {},
      fallbackChains: {},
    }),
  };
});

import * as backend from "$lib/core/backend";
import {
  gitStore,
  ensureGitView,
  refresh,
  selectCompare,
  setCompareBase,
  setCompareTarget,
  swapCompareRefs,
  setCompareMode,
  selectCompareFile,
} from "$lib/git/gitState";
import type { CompareSummary, RefsSnapshot, RepoInfo, StatusResult } from "$lib/git/git";

const snapshot: RefsSnapshot = {
  branches: [
    { name: "main", current: true, upstream: null, ahead: 0, behind: 0, sha: "a", subject: "s" },
    { name: "feature", current: false, upstream: null, ahead: 0, behind: 0, sha: "b", subject: "s" },
  ],
  remotes: [{ name: "origin", url: "u", branches: ["main"] }],
  stashes: [],
  worktrees: [],
  headBranch: "main",
};

const repo: RepoInfo = {
  notARepo: false, root: "/r", branch: "main", detached: false, unborn: false,
  author: { name: "A", email: "a@b" }, headMessage: "subject", inProgress: null,
};
const status: StatusResult = { unstaged: [], staged: [] };

function summary(over: Partial<CompareSummary> = {}): CompareSummary {
  return {
    files: [{ path: "a.ts", status: "M" }],
    insertions: 3,
    deletions: 1,
    filesChanged: 1,
    commitsAhead: 1,
    commitsBehind: 2,
    mergeBase: "0123456789abcdef",
    ...over,
  };
}

const emptyDiff = { path: "a.ts", binary: false, tooLarge: false, hunks: [] };

beforeEach(() => {
  vi.clearAllMocks();
  gitStore.set({});
  vi.mocked(backend.gitRepoInfo).mockResolvedValue(repo);
  vi.mocked(backend.gitStatus).mockResolvedValue(status);
  vi.mocked(backend.gitRefs).mockResolvedValue(snapshot);
  vi.mocked(backend.gitCompare).mockResolvedValue(summary());
  vi.mocked(backend.gitCompareDiff).mockResolvedValue(emptyDiff);
});

describe("selectCompare", () => {
  it("opens on the main branch against HEAD and loads the summary", async () => {
    ensureGitView("ws", "/r");
    await refresh("ws");

    await selectCompare("ws");

    const s = get(gitStore)["ws"];
    expect(s.navSelection).toBe("compare");
    expect(backend.gitCompare).toHaveBeenCalledWith("/r", "main", "HEAD", true);
    expect(s.compare.summary?.files).toHaveLength(1);
    expect(s.compare.loading).toBe(false);
  });

  it("keeps the pair the human picked when re-opened", async () => {
    ensureGitView("ws", "/r");
    await refresh("ws");
    await selectCompare("ws");
    await setCompareBase("ws", "feature");
    vi.mocked(backend.gitCompare).mockClear();

    await selectCompare("ws");

    expect(get(gitStore)["ws"].compare.base).toBe("feature");
    expect(backend.gitCompare).toHaveBeenCalledWith("/r", "feature", "HEAD", true);
  });

  it("falls back to HEAD against HEAD without refs", async () => {
    ensureGitView("ws", "/r");
    await selectCompare("ws");

    expect(backend.gitCompare).toHaveBeenCalledWith("/r", "HEAD", "HEAD", true);
  });
});

describe("editing the pair", () => {
  beforeEach(async () => {
    ensureGitView("ws", "/r");
    await refresh("ws");
    await selectCompare("ws");
    vi.mocked(backend.gitCompare).mockClear();
  });

  it("re-runs when either ref changes", async () => {
    await setCompareBase("ws", "origin/main");
    expect(backend.gitCompare).toHaveBeenLastCalledWith("/r", "origin/main", "HEAD", true);
    await setCompareTarget("ws", "feature");
    expect(backend.gitCompare).toHaveBeenLastCalledWith("/r", "origin/main", "feature", true);
  });

  it("swaps base and target", async () => {
    await swapCompareRefs("ws");

    const s = get(gitStore)["ws"];
    expect([s.compare.base, s.compare.target]).toEqual(["HEAD", "main"]);
    expect(backend.gitCompare).toHaveBeenLastCalledWith("/r", "HEAD", "main", true);
  });

  it("re-runs in two-dot mode", async () => {
    await setCompareMode("ws", false);

    expect(get(gitStore)["ws"].compare.threeDot).toBe(false);
    expect(backend.gitCompare).toHaveBeenLastCalledWith("/r", "main", "HEAD", false);
  });
});

describe("the file diff", () => {
  it("loads the selected file between the same endpoints", async () => {
    ensureGitView("ws", "/r");
    await refresh("ws");
    await selectCompare("ws");

    await selectCompareFile("ws", "a.ts");

    expect(backend.gitCompareDiff).toHaveBeenCalledWith("/r", "main", "HEAD", "a.ts", null, true);
    expect(get(gitStore)["ws"].compare.diff).toEqual(emptyDiff);
    expect(get(gitStore)["ws"].compare.diffLoading).toBe(false);
  });

  it("passes a rename's old path through", async () => {
    vi.mocked(backend.gitCompare).mockResolvedValue(
      summary({ files: [{ path: "new.ts", oldPath: "old.ts", status: "R" }] })
    );
    ensureGitView("ws", "/r");
    await refresh("ws");
    await selectCompare("ws");

    await selectCompareFile("ws", "new.ts");

    expect(backend.gitCompareDiff).toHaveBeenCalledWith("/r", "main", "HEAD", "new.ts", "old.ts", true);
  });

  it("drops the selection when its file leaves the list", async () => {
    ensureGitView("ws", "/r");
    await refresh("ws");
    await selectCompare("ws");
    await selectCompareFile("ws", "a.ts");
    expect(get(gitStore)["ws"].compare.selectedPath).toBe("a.ts");

    vi.mocked(backend.gitCompare).mockResolvedValue(summary({ files: [], filesChanged: 0 }));
    await refresh("ws");

    const s = get(gitStore)["ws"];
    expect(s.compare.selectedPath).toBeNull();
    expect(s.compare.diff).toBeNull();
  });
});

describe("refresh integration", () => {
  it("re-runs an open compare on every refresh pass", async () => {
    ensureGitView("ws", "/r");
    await refresh("ws");
    await selectCompare("ws");
    vi.mocked(backend.gitCompare).mockClear();

    await refresh("ws");

    expect(backend.gitCompare).toHaveBeenCalledWith("/r", "main", "HEAD", true);
  });

  it("asks nothing while the compare view is not open", async () => {
    ensureGitView("ws", "/r");
    await refresh("ws");

    expect(backend.gitCompare).not.toHaveBeenCalled();
  });

  it("reports a failure in the banner rather than as an empty list", async () => {
    vi.mocked(backend.gitCompare).mockRejectedValue(new Error("unknown revision"));
    ensureGitView("ws", "/r");
    await refresh("ws");

    await selectCompare("ws");

    const s = get(gitStore)["ws"];
    expect(s.error).toContain("unknown revision");
    expect(s.compare.loading).toBe(false);
    expect(s.compare.summary).toBeNull();
  });
});
