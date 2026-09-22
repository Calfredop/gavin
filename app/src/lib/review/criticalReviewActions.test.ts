import { describe, it, expect, vi, beforeEach } from "vitest";
import { get, writable } from "svelte/store";
import type { CardView } from "$lib/core/planBoard";

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));

vi.mock("$lib/core/backend", () => ({
  gitRefs: vi.fn(async () => ({
    branches: [{ name: "main", current: false, upstream: null, ahead: 0, behind: 0, sha: "a", subject: "" }],
    tags: [],
    worktrees: [],
  })),
  readFileForViewer: vi.fn(async () => ({ exists: true, content: "", truncated: false })),
  writeFileForEditor: vi.fn(async () => {}),
}));

const createTiledPage = vi.fn(
  async (_ws: string, _name: string, specs: { cwd: string; command: string }[]) => ({
    pageId: "page-1",
    sessionIds: specs.map((_, i) => `s${i + 1}`),
  })
);

vi.mock("$lib/core/layoutState", () => ({
  layoutState: writable({ workspaces: [], sessionStatusById: {}, interruptedSessionIds: new Set(), failureReasonById: {} }),
  // Read by actionPromptsState: the launch prompts resolve through it.
  agentDefaultsStore: writable({ actionPromptOverrides: {} }),
  agentProfilesStore: writable([
    { id: "claude-code", label: "Claude Code", models: ["sonnet", "opus"], promptArgs: "" },
    { id: "codex", label: "Codex", models: ["gpt"], promptArgs: "" },
  ]),
  resolvedAgentFor: vi.fn(() => ({
    profileId: "claude-code",
    label: "Claude Code",
    launchCommand: "claude",
    promptArgs: "",
    sessionIdArgs: "",
    resumeArgs: "",
    failurePatterns: [],
  })),
  candidateAgentFor: vi.fn((_ws: string, c: { profileId: string; model: string }) => ({
    profileId: c.profileId,
    label: c.profileId === "custom" ? "Custom" : c.profileId,
    launchCommand: c.model ? `cli --model ${c.model}` : "cli",
    promptArgs: c.profileId === "custom" ? null : "",
    sessionIdArgs: "",
    resumeArgs: "",
    failurePatterns: ["API Error:"],
  })),
  conversationIdForLaunch: vi.fn(() => null),
  createTiledPage: (...args: Parameters<typeof createTiledPage>) => createTiledPage(...args),
  armFailureDetection: vi.fn().mockResolvedValue(undefined),
  setSessionName: vi.fn().mockResolvedValue(undefined),
  switchWorkspaceView: vi.fn().mockResolvedValue(undefined),
  workspaceRootPath: vi.fn(() => "/repo"),
}));

vi.mock("$lib/core/gavinState", () => ({
  gavinTrees: writable({
    "ws-1": {
      rootPath: "/repo",
      rootMissing: false,
      contexts: [{ folderPath: "/repo", kind: "root" }],
    },
  }),
}));

vi.mock("$lib/board/kanbanState", () => ({
  kanbanState: writable({ "ws-1": {} }),
  cardSessionFor: vi.fn(() => ({
    path: "/repo/.gavin-root/plans/x.md",
    sessionId: "old",
    cwd: "/repo",
    command: null,
    launchCwd: "/repo/wt",
    baseSha: "deadbeef",
  })),
}));

vi.mock("$lib/review/criticalReviewState", () => ({
  putRun: vi.fn(),
}));

import * as backend from "$lib/core/backend";
import {
  cancelCriticalReview,
  confirmCriticalReview,
  criticalReviewRequest,
  requestCardCriticalReview,
  requestRailCriticalReview,
} from "$lib/review/criticalReviewActions";

function card(over: Partial<CardView> = {}): CardView {
  return {
    id: "/repo/.gavin-root/plans/x.md",
    fileName: "x.md",
    title: "Fix login",
    kind: "plan",
    status: "Done",
    priority: null,
    parent: null,
    labels: [],
    contextFolder: "/repo",
    checklist: null,
    attachments: [],
    ...over,
  } as CardView;
}

beforeEach(() => {
  cancelCriticalReview();
  createTiledPage.mockClear();
  vi.mocked(backend.gitRefs).mockClear();
});

describe("requestCardCriticalReview", () => {
  it("opens a pending request on the card's launch cwd", async () => {
    expect(await requestCardCriticalReview("ws-1", card())).toBeNull();
    const req = get(criticalReviewRequest);
    expect(req?.cwd).toBe("/repo/wt");
    expect(req?.subjectKind).toBe("card");
    expect(req?.card?.fileName).toBe("x.md");
    expect(req?.subject).toContain("Fix login");
  });

  it("refuses a note", async () => {
    expect(await requestCardCriticalReview("ws-1", card({ kind: "note" }))).toMatch(
      /no work to review/
    );
    expect(get(criticalReviewRequest)).toBeNull();
  });
});

describe("requestRailCriticalReview", () => {
  it("opens on the rail worktree and seeds from step baseShas", async () => {
    expect(
      await requestRailCriticalReview(
        "ws-1",
        { id: "r1", name: "auth", worktreePath: "/repo/auth-wt" },
        { stepBaseShas: [null, "abc1234"] }
      )
    ).toBeNull();
    const req = get(criticalReviewRequest);
    expect(req?.cwd).toBe("/repo/auth-wt");
    expect(req?.subjectKind).toBe("rail");
    expect(req?.railId).toBe("r1");
    expect(req?.base).toBe("abc1234");
    expect(req?.subject).toContain("auth");
  });

  it("prefers a worktree fork point over step shas", async () => {
    await requestRailCriticalReview(
      "ws-1",
      { id: "r1", name: "auth", worktreePath: "/repo/auth-wt" },
      { worktreeForkPoint: "forked", stepBaseShas: ["step"] }
    );
    expect(get(criticalReviewRequest)?.base).toBe("forked");
  });

  it("refuses when there is no checkout at all", async () => {
    const { workspaceRootPath } = await import("$lib/core/layoutState");
    vi.mocked(workspaceRootPath).mockReturnValueOnce(null);
    expect(
      await requestRailCriticalReview("ws-1", {
        id: "r1",
        name: "auth",
        worktreePath: null,
      })
    ).toMatch(/no checkout/);
  });
});

describe("confirmCriticalReview", () => {
  it("tiles every reviewer on the same cwd with no worktrees", async () => {
    await requestCardCriticalReview("ws-1", card());
    const err = await confirmCriticalReview({
      base: "main",
      reviewers: [
        { profileId: "claude-code", model: "sonnet" },
        { profileId: "codex", model: "gpt" },
      ],
      alsoBuildFindingsRail: false,
    });
    expect(err).toBeNull();
    expect(get(criticalReviewRequest)).toBeNull();
    expect(createTiledPage).toHaveBeenCalledTimes(1);
    const specs = createTiledPage.mock.calls[0][2];
    expect(specs).toHaveLength(2);
    expect(specs.every((s: { cwd: string }) => s.cwd === "/repo/wt")).toBe(true);
    expect(createTiledPage.mock.calls[0][1]).toMatch(/Critical review/);
    // Filing path reused: every command embeds gavin_create_plan.
    for (const s of specs) {
      expect(s.command).toContain("gavin_create_plan");
      expect(s.command).toContain("one of 2 reviewers");
      expect(s.command).not.toContain("findings rail");
    }
    const { putRun } = await import("$lib/review/criticalReviewState");
    expect(putRun).toHaveBeenCalledWith(
      "ws-1",
      expect.objectContaining({
        pageId: "page-1",
        alsoBuildFindingsRail: false,
        sessionIds: ["s1", "s2"],
        stepId: null,
      })
    );
  });

  it("mentions the findings rail in the prompt when the toggle is on", async () => {
    await requestCardCriticalReview("ws-1", card());
    await confirmCriticalReview({
      base: "main",
      reviewers: [
        { profileId: "claude-code", model: "sonnet" },
        { profileId: "claude-code", model: "opus" },
      ],
      alsoBuildFindingsRail: true,
    });
    const specs = createTiledPage.mock.calls[0][2];
    expect(specs[0].command).toContain("findings rail");
  });

  it("refuses a single reviewer before spawning", async () => {
    await requestCardCriticalReview("ws-1", card());
    expect(
      await confirmCriticalReview({
        base: "main",
        reviewers: [{ profileId: "claude-code", model: "" }],
      })
    ).toMatch(/at least two/);
    expect(createTiledPage).not.toHaveBeenCalled();
    expect(get(criticalReviewRequest)).not.toBeNull();
  });

  it("refuses a reviewer whose CLI takes no prompt", async () => {
    await requestCardCriticalReview("ws-1", card());
    expect(
      await confirmCriticalReview({
        base: "main",
        reviewers: [
          { profileId: "claude-code", model: "sonnet" },
          { profileId: "custom", model: "" },
        ],
      })
    ).toMatch(/takes no prompt/);
    expect(createTiledPage).not.toHaveBeenCalled();
  });
});
