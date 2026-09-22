import { describe, it, expect, vi, beforeEach } from "vitest";
import { get, writable } from "svelte/store";

vi.mock("$lib/core/backend", () => ({
  createSession: vi.fn(),
  readFileForViewer: vi.fn(),
  writeFileForEditor: vi.fn(),
  gitRefs: vi.fn(),
}));
vi.mock("$lib/core/layoutState", () => ({
  // Both read by actionPromptsState: the launch prompts resolve through it.
  layoutState: writable({ workspaces: [] }),
  agentDefaultsStore: writable({ actionPromptOverrides: {} }),
  resolvedAgentFor: vi.fn(),
  armFailureDetection: vi.fn().mockResolvedValue(undefined),
  handleAgentSessionSpawned: vi.fn(),
  setSessionName: vi.fn().mockResolvedValue(undefined),
  workspaceRootPath: vi.fn(() => null as string | null),
}));
vi.mock("$lib/core/gavinState", () => ({ gavinTrees: writable({}) }));
vi.mock("$lib/board/kanbanState", () => ({
  kanbanState: writable({}),
  cardSessionFor: vi.fn(() => null),
}));
vi.mock("$lib/cards/cardRunActions", () => ({ revealSession: vi.fn().mockResolvedValue(true) }));
// The launch wall's queue, stubbed. It is a live module (a poller, a
// drain loop, localStorage) that these tests are not about, and its
// dependency cone reaches layoutState -- which this file replaces with a
// handful of functions. `holdOrQueue` returning null is "the gate is
// open", which is the state every assertion here assumes.
vi.mock("$lib/agents/launchQueue", () => ({
  holdOrQueue: vi.fn(() => null),
  mayLaunch: vi.fn(() => true),
  launchBlockedReason: vi.fn(() => null),
}));

import * as backend from "$lib/core/backend";
import {
  resolvedAgentFor,
  handleAgentSessionSpawned,
  setSessionName,
  workspaceRootPath,
} from "$lib/core/layoutState";
import { gavinTrees } from "$lib/core/gavinState";
import { cardSessionFor } from "$lib/board/kanbanState";
import { revealSession } from "$lib/cards/cardRunActions";
import {
  reviewRequest,
  cancelReview,
  confirmReview,
  createReviewRules,
  requestBranchReview,
  requestCardReview,
} from "$lib/review/codeReviewActions";
import { REVIEW_RULES_STARTER } from "$lib/review/codeReview";
import type { CardView } from "$lib/core/planBoard";

const AGENT = {
  profileId: "claude-code",
  label: "Claude Code",
  file: "CLAUDE.md",
  command: "claude",
  launchCommand: "claude",
  mcpSupported: true,
  headlessArgs: "-p --",
  promptArgs: "" as string | null,
  mcpConfigFile: ".mcp.json",
  model: "",
  failurePatterns: [],
  failureCauses: [],
  sessionIdArgs: "",
  resumeArgs: "",
};

function card(over: Partial<CardView> = {}): CardView {
  return {
    id: "/repo/.gavin-root/plans/thing.md",
    title: "Thing",
    kind: "plan",
    status: "In Progress",
    contextFolder: "/repo",
    fileName: "thing.md",
    ...(over as object),
  } as CardView;
}

function rootTree(): void {
  gavinTrees.set({
    "ws-1": {
      contexts: [{ folderPath: "/repo", kind: "root", name: "repo", plans: [], docs: [], specs: [], hasPrd: true, configWarning: false }],
    },
  } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  cancelReview();
  rootTree();
  vi.mocked(resolvedAgentFor).mockReturnValue({ ...AGENT } as never);
  vi.mocked(backend.gitRefs).mockResolvedValue({
    branches: [
      { name: "topic", current: true, upstream: null, ahead: 0, behind: 0, sha: "a", subject: "s" },
      { name: "main", current: false, upstream: null, ahead: 0, behind: 0, sha: "b", subject: "s" },
    ],
    remotes: [],
    stashes: [],
    worktrees: [],
    headBranch: "topic",
  } as never);
  vi.mocked(backend.readFileForViewer).mockResolvedValue({ content: "", truncated: false, exists: false });
  vi.mocked(backend.createSession).mockResolvedValue("s-1");
  vi.mocked(cardSessionFor).mockReturnValue(null as never);
  vi.mocked(workspaceRootPath).mockReturnValue(null);
});

describe("requestBranchReview", () => {
  it("opens a request seeded from the checkout's branches", async () => {
    expect(await requestBranchReview("ws-1", "/repo")).toBeNull();
    const request = get(reviewRequest);
    expect(request?.base).toBe("main");
    expect(request?.cwd).toBe("/repo");
    expect(request?.contextFolder).toBe("/repo");
    expect(request?.plansFolder).toBe("/repo/.gavin-root/plans");
    expect(request?.rulesPath).toBe("/repo/.gavin-root/REVIEW.md");
    expect(request?.card).toBeNull();
  });

  // A branch is worth reviewing whether or not git can answer; the field
  // is free text, so a wrong seed costs one edit.
  it("still opens when the checkout cannot be read", async () => {
    vi.mocked(backend.gitRefs).mockRejectedValue(new Error("not a repo"));
    expect(await requestBranchReview("ws-1", "/repo")).toBeNull();
    expect(get(reviewRequest)?.base).toBe("main");
  });

  it("reports whether the rules file is there", async () => {
    await requestBranchReview("ws-1", "/repo");
    expect(get(reviewRequest)?.rulesExist).toBe(false);
    cancelReview();
    vi.mocked(backend.readFileForViewer).mockResolvedValue({ content: "# rules", truncated: false, exists: true });
    await requestBranchReview("ws-1", "/repo");
    expect(get(reviewRequest)?.rulesExist).toBe(true);
  });

  // Unreadable is not absent: offering to create it would overwrite.
  it("treats an unreadable rules file as present", async () => {
    vi.mocked(backend.readFileForViewer).mockRejectedValue(new Error("EACCES"));
    await requestBranchReview("ws-1", "/repo");
    expect(get(reviewRequest)?.rulesExist).toBe(true);
  });

  it("refuses a workspace with no gavin context and no root", async () => {
    gavinTrees.set({} as never);
    expect(await requestBranchReview("ws-1", "/repo")).toContain("nowhere to file");
    expect(get(reviewRequest)).toBeNull();
  });

  // The tree may not have arrived yet, and the root folder is where
  // `.gavin-root` is either way.
  it("falls back to the workspace root while the tree is in flight", async () => {
    gavinTrees.set({} as never);
    vi.mocked(workspaceRootPath).mockReturnValue("/repo");
    expect(await requestBranchReview("ws-1", "/repo")).toBeNull();
    expect(get(reviewRequest)?.contextFolder).toBe("/repo");
  });

  it("refuses an agent that takes no prompt", async () => {
    vi.mocked(resolvedAgentFor).mockReturnValue({ ...AGENT, promptArgs: null, label: "Cursor" } as never);
    expect(await requestBranchReview("ws-1", "/repo")).toContain("Cursor takes no prompt");
    expect(get(reviewRequest)).toBeNull();
  });
});

describe("requestCardReview", () => {
  it("carries the card and files into the card's own context", async () => {
    expect(await requestCardReview("ws-1", card())).toBeNull();
    const request = get(reviewRequest);
    expect(request?.card).toEqual({
      path: "/repo/.gavin-root/plans/thing.md",
      fileName: "thing.md",
      title: "Thing",
      kind: "plan",
    });
    expect(request?.subject).toContain("Thing");
  });

  // The work is in the checkout the agent RAN in, not the context folder:
  // a card worked in a worktree left its changes there.
  it("reviews the checkout the card's agent ran in", async () => {
    vi.mocked(cardSessionFor).mockReturnValue({
      sessionId: "s-old",
      cwd: "/somewhere/else",
      launchCwd: "/worktrees/thing",
    } as never);
    await requestCardReview("ws-1", card());
    expect(get(reviewRequest)?.cwd).toBe("/worktrees/thing");
  });

  it("falls back to the context folder when nothing ever ran", async () => {
    await requestCardReview("ws-1", card());
    expect(get(reviewRequest)?.cwd).toBe("/repo");
  });

  it("refuses a note", async () => {
    expect(await requestCardReview("ws-1", card({ kind: "note" }))).toContain("no work to review");
    expect(get(reviewRequest)).toBeNull();
  });
});

describe("createReviewRules", () => {
  it("writes the starter and marks the request as having rules", async () => {
    await requestBranchReview("ws-1", "/repo");
    expect(await createReviewRules()).toBeNull();
    expect(backend.writeFileForEditor).toHaveBeenCalledWith(
      "/repo/.gavin-root/REVIEW.md",
      REVIEW_RULES_STARTER
    );
    expect(get(reviewRequest)?.rulesExist).toBe(true);
  });

  // The starter has no rules in it, so dropping it over real rules would
  // be the worst thing this feature could do.
  it("never overwrites rules that are already there", async () => {
    vi.mocked(backend.readFileForViewer).mockResolvedValue({ content: "# rules", truncated: false, exists: true });
    await requestBranchReview("ws-1", "/repo");
    expect(await createReviewRules()).toBeNull();
    expect(backend.writeFileForEditor).not.toHaveBeenCalled();
  });

  it("reports a write that failed", async () => {
    await requestBranchReview("ws-1", "/repo");
    vi.mocked(backend.writeFileForEditor).mockRejectedValue(new Error("read-only"));
    expect(await createReviewRules()).toContain("read-only");
    expect(get(reviewRequest)?.rulesExist).toBe(false);
  });
});

describe("confirmReview", () => {
  it("launches a visible session in the reviewed checkout and clears the dialog", async () => {
    await requestBranchReview("ws-1", "/repo");
    expect(await confirmReview("origin/main")).toBeNull();
    const [cwd, command] = vi.mocked(backend.createSession).mock.calls[0];
    expect(cwd).toBe("/repo");
    expect(command).toContain("origin/main");
    expect(command).toContain("gavin_create_plan");
    expect(handleAgentSessionSpawned).toHaveBeenCalledWith("ws-1", "s-1");
    expect(revealSession).toHaveBeenCalledWith("s-1");
    expect(setSessionName).toHaveBeenCalledWith("s-1", "review");
    expect(get(reviewRequest)).toBeNull();
  });

  it("names a card review after the card", async () => {
    await requestCardReview("ws-1", card());
    await confirmReview("main");
    expect(setSessionName).toHaveBeenCalledWith("s-1", "review: Thing");
  });

  it("trims the base and refuses an empty one without spawning", async () => {
    await requestBranchReview("ws-1", "/repo");
    expect(await confirmReview("   ")).toContain("Name a branch");
    expect(backend.createSession).not.toHaveBeenCalled();
    expect(get(reviewRequest)).not.toBeNull();
  });

  // The dialog stays up and shows the reason: there is nowhere else for
  // a refused launch to be reported from.
  it("keeps the dialog up when the session cannot start", async () => {
    await requestBranchReview("ws-1", "/repo");
    vi.mocked(backend.createSession).mockRejectedValue(new Error("no pty"));
    expect(await confirmReview("main")).toContain("no pty");
    expect(get(reviewRequest)).not.toBeNull();
  });

  it("does nothing when no review is pending", async () => {
    expect(await confirmReview("main")).toBeNull();
    expect(backend.createSession).not.toHaveBeenCalled();
  });
});
