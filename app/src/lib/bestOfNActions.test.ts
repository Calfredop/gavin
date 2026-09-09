import { describe, it, expect, vi, beforeEach } from "vitest";
import { get, writable } from "svelte/store";
import type { BestOfNRun, CandidatePlan } from "$lib/bestOfN";
import type { CardView } from "$lib/planBoard";

// The order every step happens in is what this file is really testing --
// a run creates real folders and real processes, and the order is what
// makes a failure survivable. So every side effect appends to one log.
const trace: string[] = [];

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));

vi.mock("$lib/backend", () => ({
  setPlanFrontmatterField: vi.fn(async (path: string) => {
    trace.push("status");
    return path;
  }),
  readFileForViewer: vi.fn(async () => ({ exists: true, content: "---\ntitle: t\n---\nBODY" })),
  worktreeSetup: vi.fn(async () => ["npm install"]),
  attachmentStatus: vi.fn(),
  linkCardSession: vi.fn(),
  unlinkCardSession: vi.fn(),
  getBoard: vi.fn(),
  createSession: vi.fn(),
}));

const createTiledPage = vi.fn(async (_ws: string, _name: string, specs: { cwd: string; command: string }[]) => {
  trace.push(`sessions:${specs.length}`);
  return { pageId: "page-1", sessionIds: specs.map((_, i) => `s${i + 1}`) };
});

vi.mock("$lib/layoutState", () => ({
  layoutState: writable({ workspaces: [], sessionStatusById: {}, interruptedSessionIds: new Set(), failureReasonById: {} }),
  createTiledPage: (...args: Parameters<typeof createTiledPage>) => createTiledPage(...args),
  candidateAgentFor: vi.fn((_ws: string, c: { profileId: string; model: string }) => ({
    profileId: c.profileId,
    label: c.profileId === "cursor" ? "Cursor" : "Claude Code",
    launchCommand: c.model ? `claude --model ${c.model}` : "claude",
    // cursor is the stock profile that takes no prompt at all, which is
    // the one agent gate a run has to fail on.
    promptArgs: c.profileId === "cursor" ? null : "",
    sessionIdArgs: "",
    resumeArgs: "",
    failurePatterns: ["API Error:"],
  })),
  conversationIdForLaunch: vi.fn(() => null),
  armFailureDetection: vi.fn().mockResolvedValue(undefined),
  setSessionName: vi.fn().mockResolvedValue(undefined),
  switchWorkspaceView: vi.fn().mockResolvedValue(undefined),
  // Approved: these cases are about what a run does, not about the gate.
  // The unapproved case is its own test below.
  configTrustFor: vi.fn(() => configTrust),
}));

/// Flipped by the one case that cares. A best-of-N launch `&&`-chains
/// `[worktree] setup` ahead of every candidate's agent, so an unapproved
/// config must reach those sessions carrying nothing.
let configTrust = { trusted: true };

const forkWorktree = vi.fn(async (_ws: string, opts: { path: string; from: string | null }) => {
  trace.push(`fork:${opts.path}`);
  return { ok: true, error: null } as { ok: boolean; error: string | null };
});
const discardWorktrees = vi.fn(async (_ws: string, entries: { path: string }[], deleteBranches: boolean) => {
  trace.push(`discard:${entries.map((e) => e.path).join(",")}:${deleteBranches ? "branches" : "keep"}`);
  return true;
});
vi.mock("$lib/gitState", () => ({
  forkWorktree: (...a: Parameters<typeof forkWorktree>) => forkWorktree(...a),
  discardWorktrees: (...a: Parameters<typeof discardWorktrees>) => discardWorktrees(...a),
}));

const linkCardSessionAction = vi.fn(async () => {
  trace.push("bind");
});
vi.mock("$lib/board/kanbanState", () => ({
  kanbanState: writable({ "ws-1": {} }),
  cardSessionFor: vi.fn(() => null),
  linkCardSessionAction: (...a: unknown[]) => linkCardSessionAction(...(a as [])),
}));

vi.mock("$lib/board/columnRunAction", () => ({ cardSessionState: vi.fn(() => "none") }));
vi.mock("$lib/cardRunActions", () => ({
  resolveAttachmentsForRun: vi.fn(async () => ({ paths: [], withheld: [], statuses: [] })),
}));
// The first-Run review, as the launcher reaches it. A real one raises
// the app's dialog and waits; this is the seam the answer is driven
// through, and it says yes unless a test says otherwise.
vi.mock("$lib/cardReviewActions", () => ({ ensureCardReviewed: vi.fn(async () => true) }));
vi.mock("$lib/gavinState", () => ({
  gavinTrees: writable({ "ws-1": { rootPath: "/repos/gavin" } }),
  // The store, not a `worktreeSetup` call: the launch reads the same
  // copy workspace trust hashed, so a fresher read cannot slip lines
  // past the approval.
  worktreeSetups: writable({ "ws-1": ["npm install"] }),
  patchPlanField: vi.fn(),
  patchPlanPath: vi.fn(),
}));
vi.mock("$lib/tabActions", () => ({
  closeTabsNow: vi.fn(async (ids: string[]) => {
    trace.push(`close:${ids.join(",")}`);
  }),
}));

const askConfirmChecked = vi.fn(async () => ({ confirmed: true, checked: true }));
vi.mock("$lib/dialog", () => ({ askConfirmChecked: (...a: unknown[]) => askConfirmChecked(...(a as [])) }));

const { startBestOfN, pickCandidate, abandonRun } = await import("$lib/bestOfNActions");
const { bestOfNRuns } = await import("$lib/bestOfNState");
const backend = await import("$lib/backend");
const layoutState = await import("$lib/layoutState");
const columnRunAction = await import("$lib/board/columnRunAction");

const CARD: CardView = {
  id: "/repos/gavin/.gavin-root/plans/auth.md",
  title: "Auth rework",
  status: "To Do",
  priority: null,
  order: null,
  kind: "plan",
  parent: null,
  parentTitle: null,
  parentBroken: false,
  labels: [],
  checklistDone: 0,
  checklistTotal: 0,
  contextName: "root",
  contextFolder: "/repos/gavin/.gavin-root",
  fileName: "auth.md",
  parseWarning: false,
  nestedChildren: [],
  attachments: [],
};

function plan(profileId: string, model: string, branch: string): CandidatePlan {
  return {
    candidate: { profileId, model },
    label: model ? `Claude Code · ${model}` : profileId,
    branch,
    worktreePath: `/repos/gavin-${branch}`,
  };
}

const PLANS = [plan("claude-code", "opus", "auth-opus"), plan("claude-code", "sonnet", "auth-sonnet")];

beforeEach(() => {
  trace.length = 0;
  vi.clearAllMocks();
  bestOfNRuns.set({});
  // The layout store is module-level, so a card left under a develop run
  // by one test would refuse every launch in the next one.
  layoutState.layoutState.update((st) => ({ ...st, workspaces: [] }));
  // vi.clearAllMocks wipes the implementations declared above.
  forkWorktree.mockImplementation(async (_ws, opts) => {
    trace.push(`fork:${opts.path}`);
    return { ok: true, error: null };
  });
  discardWorktrees.mockImplementation(async (_ws, entries, deleteBranches) => {
    trace.push(`discard:${entries.map((e) => e.path).join(",")}:${deleteBranches ? "branches" : "keep"}`);
    return true;
  });
  createTiledPage.mockImplementation(async (_ws, _name, specs) => {
    trace.push(`sessions:${specs.length}`);
    return { pageId: "page-1", sessionIds: specs.map((_, i) => `s${i + 1}`) };
  });
  askConfirmChecked.mockResolvedValue({ confirmed: true, checked: true });
  vi.mocked(backend.setPlanFrontmatterField).mockImplementation(async (path: string) => {
    trace.push("status");
    return path;
  });
  vi.mocked(backend.readFileForViewer).mockResolvedValue({ exists: true, content: "---\ntitle: t\n---\nBODY" } as never);
  configTrust = { trusted: true };
  vi.mocked(columnRunAction.cardSessionState).mockReturnValue("none" as never);
});

describe("starting a run", () => {
  it("writes the status, then makes the worktrees, then the sessions", async () => {
    // The order is the design: gates are free, the status write must not
    // happen after a refusal, and a session must never start in a folder
    // that does not exist yet.
    expect(await startBestOfN("ws-1", CARD, PLANS, "main")).toBeNull();
    expect(trace).toEqual(["status", "fork:/repos/gavin-auth-opus", "fork:/repos/gavin-auth-sonnet", "sessions:2"]);
  });

  it("forks every candidate from the base it was given, never from whatever git would pick", async () => {
    // `worktree add` with no start point forks from the HEAD of the
    // checkout the command runs in -- which is wherever the Git tab was
    // last pointed. Comparing agents cannot vary that.
    await startBestOfN("ws-1", CARD, PLANS, "main");
    expect(forkWorktree.mock.calls.map((c) => c[1].from)).toEqual(["main", "main"]);
  });

  it("chains the workspace's setup ahead of each agent, in that candidate's worktree", async () => {
    await startBestOfN("ws-1", CARD, PLANS, "main");
    const specs = createTiledPage.mock.calls[0][2];
    expect(specs[0].cwd).toBe("/repos/gavin-auth-opus");
    expect(specs[0].command.startsWith("npm install && claude --model opus ")).toBe(true);
    expect(specs[1].command).toContain("--model sonnet");
    // Each candidate is told which one it is, or three tabs name
    // themselves the same thing.
    expect(specs[0].command).toContain("Claude Code · opus");
  });

  it("drops the repo's setup from every candidate until the human has approved it", async () => {
    // config.toml ships with the repo, and this line runs `&&`-ed ahead
    // of the agent in a checkout that was cut a second earlier. The
    // launch still happens -- it is the repo's shell that does not.
    configTrust = { trusted: false };
    await startBestOfN("ws-1", CARD, PLANS, "main");
    const specs = createTiledPage.mock.calls[0][2];
    expect(specs[0].command.startsWith("claude --model opus ")).toBe(true);
    expect(specs.every((sp: { command: string }) => !sp.command.includes("npm install"))).toBe(true);
  });

  it("records the run against the card, with the branch and folder each candidate owns", async () => {
    await startBestOfN("ws-1", CARD, PLANS, "main");
    const run = get(bestOfNRuns)["ws-1"][0];
    expect(run.cardPath).toBe(CARD.id);
    expect(run.pageId).toBe("page-1");
    expect(run.candidates.map((c) => [c.sessionId, c.branch, c.worktreePath])).toEqual([
      ["s1", "auth-opus", "/repos/gavin-auth-opus"],
      ["s2", "auth-sonnet", "/repos/gavin-auth-sonnet"],
    ]);
  });

  it("refuses a note, a lone candidate, and two identical ones without touching anything", async () => {
    expect(await startBestOfN("ws-1", { ...CARD, kind: "note" }, PLANS, "main")).toMatch(/not runnable/);
    expect(await startBestOfN("ws-1", CARD, [PLANS[0]], "main")).toMatch(/at least two/);
    expect(await startBestOfN("ws-1", CARD, [PLANS[0], PLANS[0]], "main")).toMatch(/same agent and model/);
    expect(trace).toEqual([]);
  });

  it("refuses when a candidate's agent takes no prompt, before the status write", async () => {
    // Finding this out after two worktrees exist would leave the human to
    // clean them up for a run that never started.
    const withCursor = [PLANS[0], plan("cursor", "", "auth-cursor")];
    expect(await startBestOfN("ws-1", CARD, withCursor, "main")).toMatch(/takes no prompt/);
    expect(trace).toEqual([]);
  });

  it("refuses a second run on the same card, which would orphan the first one's folders", async () => {
    await startBestOfN("ws-1", CARD, PLANS, "main");
    trace.length = 0;
    expect(await startBestOfN("ws-1", CARD, PLANS, "main")).toMatch(/already has a best-of-N run/);
    expect(trace).toEqual([]);
  });

  it("refuses while a single agent is live on the card", async () => {
    vi.mocked(columnRunAction.cardSessionState).mockReturnValue("live" as never);
    expect(await startBestOfN("ws-1", CARD, PLANS, "main")).toMatch(/live agent/);
    expect(trace).toEqual([]);
  });

  // N times the reason a single Run has: this launch forks the card's
  // prompt into a worktree per candidate, so a file mid-rewrite would be
  // copied into all of them.
  it("refuses while an agent is developing the card, before any worktree exists", async () => {
    layoutState.layoutState.update((st) => ({
      ...st,
      workspaces: [{ id: "ws-1", developingCards: [{ path: CARD.id, sessionId: "s-dev" }] }] as never,
    }));

    expect(await startBestOfN("ws-1", CARD, PLANS, "main")).toMatch(/developing this card/);
    expect(trace).toEqual([]);
  });

  it("removes the worktrees it already made when a later fork fails", async () => {
    forkWorktree.mockImplementationOnce(async (_ws, opts) => {
      trace.push(`fork:${opts.path}`);
      return { ok: true, error: null };
    });
    forkWorktree.mockImplementationOnce(async () => {
      trace.push("fork:FAILED");
      return { ok: false, error: "New worktree failed: fatal: '/repos/x' already exists" };
    });
    const error = await startBestOfN("ws-1", CARD, PLANS, "main");
    // git's own words, not a pointer at a tab the human is not looking at.
    expect(error).toBe(
      "Couldn't create the worktree for Claude Code · sonnet — New worktree failed: fatal: '/repos/x' already exists"
    );
    expect(trace).toEqual(["status", "fork:/repos/gavin-auth-opus", "fork:FAILED", "discard:/repos/gavin-auth-opus:branches"]);
    expect(get(bestOfNRuns)["ws-1"] ?? []).toEqual([]);
  });

  it("removes them all when the sessions cannot be started", async () => {
    createTiledPage.mockImplementation(async () => null as never);
    expect(await startBestOfN("ws-1", CARD, PLANS, "main")).toMatch(/Couldn't start the candidates/);
    expect(trace.at(-1)).toBe("discard:/repos/gavin-auth-opus,/repos/gavin-auth-sonnet:branches");
  });

  it("leaves an already In Progress card's status alone", async () => {
    await startBestOfN("ws-1", { ...CARD, status: "In Progress" }, PLANS, "main");
    expect(trace[0]).toBe("fork:/repos/gavin-auth-opus");
  });

  it("names the tabs after the candidates, not after the card they share", async () => {
    await startBestOfN("ws-1", CARD, PLANS, "main");
    expect(vi.mocked(layoutState.setSessionName).mock.calls.map((c) => c[1])).toEqual([
      "Claude Code · opus",
      "Claude Code · sonnet",
    ]);
  });
});

function startedRun(): BestOfNRun {
  return {
    cardPath: CARD.id,
    cardTitle: CARD.title,
    pageId: "page-1",
    startedAt: 1,
    candidates: [
      { sessionId: "s1", label: "A", profileId: "claude-code", model: "opus", branch: "auth-opus", worktreePath: "/repos/gavin-auth-opus", command: "claude a", conversationId: "id-a" },
      { sessionId: "s2", label: "B", profileId: "claude-code", model: "sonnet", branch: "auth-sonnet", worktreePath: "/repos/gavin-auth-sonnet", command: "claude b", conversationId: null },
      { sessionId: "s3", label: "C", profileId: "codex", model: "", branch: "auth-codex", worktreePath: "/repos/gavin-auth-codex", command: "codex c", conversationId: null },
    ],
  };
}

describe("picking a winner", () => {
  it("closes the losing sessions before deleting the folders they were writing to", async () => {
    // An agent still writing into a folder being deleted is the one
    // failure here that can leave a half-removed worktree behind.
    expect(await pickCandidate("ws-1", startedRun(), "s2")).toBeNull();
    expect(trace).toEqual([
      "close:s1,s3",
      "bind",
      "discard:/repos/gavin-auth-opus,/repos/gavin-auth-codex:branches",
    ]);
  });

  it("binds the winner to the card with the command and conversation it was launched with", async () => {
    await pickCandidate("ws-1", startedRun(), "s1");
    expect(linkCardSessionAction).toHaveBeenCalledWith("ws-1", {
      path: CARD.id,
      sessionId: "s1",
      cwd: "/repos/gavin-auth-opus",
      command: "claude a",
      conversationId: "id-a",
      launchCwd: "/repos/gavin-auth-opus",
      resumeAttempts: 0,
    });
  });

  it("keeps the winner's worktree and branch, because merging is the human's", async () => {
    await pickCandidate("ws-1", startedRun(), "s2");
    const discarded = discardWorktrees.mock.calls[0][1].map((e) => e.path);
    expect(discarded).not.toContain("/repos/gavin-auth-sonnet");
  });

  it("keeps the losing branches when the tick-box is cleared", async () => {
    askConfirmChecked.mockResolvedValue({ confirmed: true, checked: false });
    await pickCandidate("ws-1", startedRun(), "s2");
    expect(trace.at(-1)?.endsWith(":keep")).toBe(true);
  });

  it("does nothing at all when the prompt is dismissed", async () => {
    askConfirmChecked.mockResolvedValue({ confirmed: false, checked: true });
    expect(await pickCandidate("ws-1", startedRun(), "s2")).toBeNull();
    expect(trace).toEqual([]);
  });

  it("refuses a candidate that is not in the run rather than discarding everything", async () => {
    expect(await pickCandidate("ws-1", startedRun(), "gone")).toMatch(/no longer part of this run/);
    expect(trace).toEqual([]);
  });

  it("forgets the run afterwards, so the card stops offering a pick", async () => {
    bestOfNRuns.set({ "ws-1": [startedRun()] });
    await pickCandidate("ws-1", startedRun(), "s2");
    expect(get(bestOfNRuns)["ws-1"]).toEqual([]);
  });

  it("reports a git failure but still forgets the run, since the sessions are already gone", async () => {
    discardWorktrees.mockResolvedValue(false);
    bestOfNRuns.set({ "ws-1": [startedRun()] });
    expect(await pickCandidate("ws-1", startedRun(), "s2")).toMatch(/could not be removed/);
    expect(get(bestOfNRuns)["ws-1"]).toEqual([]);
  });
});

describe("abandoning a run", () => {
  it("closes and deletes every candidate, and leaves the card's status where it is", async () => {
    bestOfNRuns.set({ "ws-1": [startedRun()] });
    expect(await abandonRun("ws-1", startedRun())).toBeNull();
    expect(trace).toEqual([
      "close:s1,s2,s3",
      "discard:/repos/gavin-auth-opus,/repos/gavin-auth-sonnet,/repos/gavin-auth-codex:branches",
    ]);
    // No status write: discarding three attempts is not a decision that
    // the card has stopped being worked.
    expect(backend.setPlanFrontmatterField).not.toHaveBeenCalled();
    expect(linkCardSessionAction).not.toHaveBeenCalled();
    expect(get(bestOfNRuns)["ws-1"]).toEqual([]);
  });

  it("does nothing at all when the prompt is dismissed", async () => {
    askConfirmChecked.mockResolvedValue({ confirmed: false, checked: true });
    bestOfNRuns.set({ "ws-1": [startedRun()] });
    await abandonRun("ws-1", startedRun());
    expect(trace).toEqual([]);
    expect(get(bestOfNRuns)["ws-1"]).toHaveLength(1);
  });
});
