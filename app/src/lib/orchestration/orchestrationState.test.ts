import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { get, writable, type Writable } from "svelte/store";

vi.mock("$lib/core/backend", () => ({
  getOrchestration: vi.fn(),
  setOrchestration: vi.fn(),
  setRailRun: vi.fn(),
  setStepRun: vi.fn(),
  readFileForViewer: vi.fn(),
  setPlanFrontmatterField: vi.fn(),
  setSessionName: vi.fn(),
  getTools: vi.fn(),
  saveTool: vi.fn(),
  deleteTool: vi.fn(),
  gitStatus: vi.fn(),
  gitCheckout: vi.fn(),
  // The decoy sweep's one call: what THIS run changed in its own
  // checkout, baseline included, so a committed decoy edit still shows.
  gitRunChanges: vi.fn(),
  attachmentStatus: vi.fn(),
  // prState reads the backend through the same module object.
  prStatus: vi.fn(),
  // "unknown" by default -- gavin cannot tell whether the transcript is
  // there, which is today's behaviour. The guard test drives it.
  conversationLog: vi.fn(async () => "unknown" as const),
}));

// tick() reads four stores through get(), so each mock must expose a
// real store contract, not just its functions -- a bare object makes
// get() throw and the failure reads as an unrelated crash.
/// Hoisted so the `vi.mock` factory below (hoisted above every import)
/// can close over it, and so `resolvedAgentFor` and `agentForCard` can
/// be the same function object.
const agentMock = vi.hoisted(() =>
  vi.fn(() => ({
    command: "claude",
    launchCommand: "claude",
    file: "CLAUDE.md",
    profile: "claude-code",
    profileId: "claude-code",
    model: "sonnet",
    failurePatterns: ["API Error:"],
    failureCauses: [
      { pattern: "/login", cause: "auth" },
      { pattern: "Connection dropped", cause: "network" },
    ],
    sessionIdArgs: "",
    resumeArgs: "",
    label: "Claude Code",
    promptArgs: "",
  }))
);

vi.mock("$lib/core/layoutState", () => ({
  // A REAL store: tick() derives the set of LIVE session ids from it, so
  // a test that needs a running step's session to still exist has to be
  // able to put a page holding it in here.
  layoutState: writable({
    workspaces: [] as unknown[],
    sessionStatusById: {} as Record<string, string>,
    // rule 3d's input: a failed agent is LIVE and quiet, so without this
    // the scheduler reads its silence as a finished turn.
    failureReasonById: {} as Record<string, string>,
  }),
  agentDefaultsStore: writable({
    customCommand: "",
    customModelFlag: "",
    complexity: {},
    agentFallback: [] as string[],
  }),
  resolvedAgentFor: agentMock,
  // The SAME mock function, deliberately: no card fixture here carries a
  // complexity, so `agentForCard` really does resolve to the workspace's
  // agent -- and a test that moves one has to move both, or a rail's
  // card steps and its tool steps would launch with different agents.
  agentForCard: agentMock,
  agentForProfile: agentMock,
  agentProfilesStore: writable([
    {
      id: "claude-code",
      label: "Claude Code",
      models: ["sonnet", "opus"],
      promptArgs: "",
    },
  ]),
  armFailureDetection: vi.fn().mockResolvedValue(undefined),
  // Null by default: no conversation id unless a test asks for one, which
  // is what an unverified profile OR a pre-v21 daemon looks like.
  conversationIdForLaunch: vi.fn(() => null as string | null),
  // Same default for the run baseline: absent unless a test asks.
  baseShaForLaunch: vi.fn(async () => null as string | null),
  createSessionOnPage: vi.fn(),
  createSessionOnNewPage: vi.fn().mockResolvedValue(null),
  // The card-attachment run gate resolves relative paths against the
  // workspace ROOT when the rail has no checkout of its own, so the
  // scheduler reaches for this before it spawns on an unbound rail.
  workspaceRootPath: vi.fn(() => "/ws"),
  // The first-Run review's marker read: a rail stalls a step whose card
  // nobody has read. True by default, since almost every fixture here is
  // about scheduling rather than about provenance.
  cardReviewed: vi.fn(() => true),
  setSessionName: vi.fn().mockResolvedValue(undefined),
  retainTabOnExit: vi.fn(),
  // tick() reads this through get(), so it has to be a real store.
  sessionExits: { subscribe: (fn: (v: unknown) => void) => (fn(new Map()), () => {}) },
  // initOrchestrationListeners now starts auto-resume beside the
  // scheduler, and auto-resume registers itself through this seam.
  setSessionFailureHook: vi.fn(),
  // The turn verdict's driver is started beside auto-resume's and hands
  // layoutState a hook the same way.
  setSessionStatusHook: vi.fn(),
  // And it starts the tray's half of the same feature, which registers
  // into this second seam (verdictNoticeState.ts).
  setStatusNoticeHold: vi.fn(),
  notifyPrefsFor: vi.fn(() => ({ needsInput: true, finished: true })),
  daemonCompat: writable(null),
}));
// A REAL store, left empty by default: tick() bails early without a
// board, so the rail-control tests exercise arming without also running
// the scheduler. The drop-onto-a-running-stage tests set a board into it
// precisely because they need the scheduler to run.
vi.mock("$lib/review/criticalReviewActions", () => ({
  launchCriticalReviewSessions: vi.fn().mockResolvedValue(null),
}));

vi.mock("$lib/board/kanbanState", () => ({
  kanbanState: writable<Record<string, unknown>>({}),
  linkCardSessionAction: vi.fn(),
  // The real lookup rather than a stub: a resume READS the binding it is
  // about to rewrite (for the baseline it must carry, not re-resolve),
  // and a stub returning nothing would make that carrying untestable.
  cardSessionFor: (board: { cardSessions?: { path: string }[] } | undefined, path: string) =>
    board?.cardSessions?.find((cs) => cs.path === path),
}));
// /x/a.md's `attachments:` line, settable per test: every OTHER launch
// test in this file must keep launching without the attachment gate
// asking the host anything, so the default is none.
const cardAttachments = vi.hoisted(() => ({ a: [] as string[] }));
// ...and its column, for the loop-back that has to take a re-run card
// back OUT of the done one. `get()` re-subscribes on every read, so the
// tree below is rebuilt each time and picks this up.
const cardStatus = vi.hoisted(() => ({ a: "To Do" }));
// Cards a single test needs and nobody else does -- a plan with a nested
// task under it, for the completion cascade. Reset in beforeEach.
const extraPlans = vi.hoisted(() => ({ list: [] as Record<string, unknown>[] }));
vi.mock("$lib/core/gavinState", () => ({
  gavinTrees: {
    subscribe: (fn: (v: unknown) => void) => (
      fn({
        "ws-1": {
          rootPath: "/ws",
          rootMissing: false,
          contexts: [
            {
              folderPath: "/ws/.gavin-root",
              kind: "root",
              name: "ws",
              plans: [
                {
                  path: "/x/a.md",
                  fileName: "a.md",
                  title: "Wire the API",
                  status: cardStatus.a,
                  priority: null,
                  order: null,
                  kind: "task",
                  parent: null,
                  labels: [],
                  attachments: cardAttachments.a,
                  checklistDone: 0,
                  checklistTotal: 0,
                  parseWarning: false,
                },
                {
                  path: "/x/b.md",
                  fileName: "b.md",
                  title: "Ship the UI",
                  status: "To Do",
                  priority: null,
                  order: null,
                  kind: "task",
                  parent: null,
                  labels: [],
                  checklistDone: 0,
                  checklistTotal: 0,
                  parseWarning: false,
                },
                ...extraPlans.list,
              ],
              docs: [],
              specs: [],
              hasPrd: true,
              configWarning: false
            },
          ],
        },
      }),
      () => {}
    ),
  },
  patchPlanField: vi.fn(),
  patchPlanPath: vi.fn(),
}));
// The daemon's own pushes, capturable: initOrchestrationListeners is the
// third place a plan can arrive, and the only one that needs a real
// `listen` to reach.
const tauriEvents = vi.hoisted(() => ({
  handlers: new Map<string, (event: { payload: unknown }) => void>(),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (name: string, handler: (event: { payload: unknown }) => void) => {
    tauriEvents.handlers.set(name, handler);
    return () => tauriEvents.handlers.delete(name);
  },
}));
vi.mock("$lib/core/dialog", () => ({
  askConfirm: vi.fn(),
  askConfirmChecked: vi.fn(),
}));
// The tray, mocked wholesale: a review step's launch summons the human,
// and the real one reaches for the OS window and the permission API.
// Only the two functions orchestrationState imports -- every other
// importer in this graph takes a TYPE from here, which is erased.
/// The launch wall, with a switch a test can throw.
///
/// Hoisted for the reason `agentMock` above is: the `vi.mock` factory is
/// lifted over every import. `launchHolding` is a REAL store, because
/// the scheduler subscribes to it as one of its tick inputs -- that
/// subscription is precisely what makes a lifted hold re-emit the launch
/// the pass before it skipped.
const gateMock = vi.hoisted(() => {
  // A minimal writable, hand-rolled: `vi.hoisted` runs before every
  // import in the file, so it cannot import svelte's own -- and the
  // scheduler subscribes to this one for real. The store contract is
  // three methods; these are them.
  let holding = false;
  const subscribers = new Set<(v: boolean) => void>();
  return {
    allowed: { value: true },
    launchHolding: {
      subscribe(run: (v: boolean) => void) {
        subscribers.add(run);
        run(holding);
        return () => void subscribers.delete(run);
      },
      set(next: boolean) {
        holding = next;
        for (const run of [...subscribers]) run(holding);
      },
    },
  };
});

vi.mock("$lib/agents/launchQueue", () => ({
  holdOrQueue: vi.fn(() => null),
  mayLaunch: () => gateMock.allowed.value,
  launchBlockedReason: () => (gateMock.allowed.value ? null : "Waiting for a slot"),
  launchHolding: gateMock.launchHolding,
}));

vi.mock("$lib/core/notifications", () => ({
  setRailNotificationVoice: vi.fn(),
  maybeNotifyReviewWait: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("$lib/git/gitState", () => {
  // Settable, not a constant: executeSwitchBranch reads the REFRESHED
  // refs back out of this store to decide whether the checkout actually
  // caught up, so a test has to be able to move it.
  let value: Record<string, unknown> = {};
  const subs = new Set<(v: unknown) => void>();
  return {
    gitStore: {
      subscribe: (fn: (v: unknown) => void) => {
        subs.add(fn);
        fn(value);
        return () => subs.delete(fn);
      },
    },
    ensureGitView: vi.fn(),
    refresh: vi.fn(),
    __setGitStore: (v: Record<string, unknown>) => {
      value = v;
      for (const fn of subs) fn(value);
    },
  };
});

import * as backend from "$lib/core/backend";
import * as gitStateModule from "$lib/git/gitState";
import * as gavinState from "$lib/core/gavinState";
import * as layoutStateModule from "$lib/core/layoutState";
import * as kanbanStateModule from "$lib/board/kanbanState";
import { toolRecords, __resetForTesting as toolsResetForTesting } from "$lib/orchestration/toolsState";
import { prReports, __resetForTesting as prResetForTesting } from "$lib/git/prState";
import { prKey } from "$lib/git/pullRequest";
import type { PrReport } from "$lib/git/pullRequest";
import { maybeNotifyReviewWait } from "$lib/core/notifications";
import {
  orchestrations,
  fetchOrchestration,
  addStepToStageAction,
  addToolToStageAction,
  moveStepIntoStageAction,
  addCardAsStageAction,
  tick,
  startRail,
  pauseRail,
  resumeRail,
  retryStep,
  markStepDone,
  skipStep,
  resumeStep,
  setRailAutoResumeAction,
  executeActions,
  startScheduler,
  initOrchestrationListeners,
  mutatePlan,
  setRailRunAction,
  setStepRunAction,
  saveErrors,
  dismissSaveError,
  moveRailCardsAction,
  clearDoneStepsAction,
  stepAttentionsByWorkspace,
  decoyEditsByWorkspace,
  refreshDecoyEdits,
  railStatusVoice,
  makeStageSequentialAction,
  setStageModeAction,
  renameStageAction,
  moveStageToIndexAction,
  ungroupStageAction,
  addTemplateAsStageAction,
  addTemplateToStageAction,
  __resetForTesting,
} from "$lib/orchestration/orchestrationState";
import { emptyOrchestration, addStep, findStage, stageMode } from "$lib/orchestration/orchestration";
import { UNREVIEWED_STALL } from "$lib/cards/cardReview";
import { askConfirmChecked } from "$lib/core/dialog";
import type { Orchestration, Rail, Stage } from "$lib/orchestration/orchestration";
import type { GroupTemplate } from "$lib/orchestration/orchestrationGroups";

function rail(id: string): Rail {
  return { id, name: id, position: 0, worktreePath: null, pageId: null, stages: [] };
}

function withRails(...ids: string[]): Orchestration {
  return { ...emptyOrchestration(), rails: ids.map(rail) };
}

/// The two stores tick() reads that the rest of this file leaves empty:
/// without a board it bails before the scheduler, and without a live page
/// the running sibling's session reads as dead and stalls the rail.
const boardStore = kanbanStateModule.kanbanState as unknown as Writable<Record<string, unknown>>;
const layoutStore = layoutStateModule.layoutState as unknown as Writable<{
  workspaces: unknown[];
  sessionStatusById: Record<string, string>;
  failureReasonById: Record<string, string>;
  sessionsSeenWorking?: Set<string>;
  activeWorkspaceId?: string | null;
}>;

beforeEach(() => {
  vi.clearAllMocks();
  __resetForTesting();
  // Both mocked stores are module-level and shared by every test in this
  // file: a page one test puts in must not decide what the next one
  // sees. `clearAllMocks` does nothing for them.
  boardStore.set({});
  layoutStore.set({ workspaces: [], sessionStatusById: {}, failureReasonById: {} });
  cardAttachments.a = [];
  cardStatus.a = "To Do";
  extraPlans.list = [];
  // Every launch that makes a session asks for the rail's page first, so
  // this mock is reached from far more tests than Start and Resume --
  // and `clearAllMocks` keeps implementations, so a describe that made
  // it answer a page would otherwise re-bind every later test's rail.
  vi.mocked(layoutStateModule.createSessionOnNewPage).mockResolvedValue(null);
});

/// The layout a rail bound to "p1" is entitled to: the page it names,
/// live. Since a launch checks that binding before it makes a session,
/// a fixture whose rail says "p1" over an EMPTY layout is the closed-page
/// case (spec O16) and gets a fresh page -- which is not what a test
/// asserting `"p1"` means to exercise.
function setRailPageLive(): void {
  setLayoutState({ workspaces: [{ id: "ws-1", pages: [{ id: "p1", name: "backend" }] }] });
}

function setLayoutState(value: { workspaces: unknown[] }): void {
  layoutStore.set({ ...value, sessionStatusById: {}, failureReasonById: {} });
}

describe("fetchOrchestration", () => {
  it("loads once and caches", async () => {
    vi.mocked(backend.getOrchestration).mockResolvedValue(withRails("r1"));
    await fetchOrchestration("ws-1");
    await fetchOrchestration("ws-1");
    expect(backend.getOrchestration).toHaveBeenCalledTimes(1);
    expect(get(orchestrations)["ws-1"].rails[0].id).toBe("r1");
  });

  // A pre-v11 daemon has no tool_id column, so a tool step handed to it
  // comes back as a step with neither a card nor a tool: an untitled
  // chip, and one the current daemon refuses to store, wedging every
  // later save. The app drops it on the way in.
  it("drops a step the daemon returned with neither a card nor a tool", async () => {
    vi.mocked(backend.getOrchestration).mockResolvedValue({
      ...emptyOrchestration(),
      rails: [
        {
          ...rail("r1"),
          stages: [
            {
              id: "st0",
              position: 0,
              steps: [
                { id: "t1", position: 0, cardPath: "/x/a.md", toolId: null },
                { id: "t2", position: 1, cardPath: "", toolId: null },
              ],
            },
          ],
        },
      ],
    });
    await fetchOrchestration("ws-1");
    expect(
      get(orchestrations)["ws-1"].rails[0].stages[0].steps.map((s) => s.id)
    ).toEqual(["t1"]);
  });

  it("leaves the workspace unset when the load fails", async () => {
    vi.mocked(backend.getOrchestration).mockRejectedValue(new Error("nope"));
    await fetchOrchestration("ws-1");
    expect(get(orchestrations)["ws-1"]).toBeUndefined();
  });
});

describe("mutatePlan", () => {
  it("applies optimistically and persists the whole plan", async () => {
    vi.mocked(backend.getOrchestration).mockResolvedValue(withRails("r1"));
    vi.mocked(backend.setOrchestration).mockResolvedValue(undefined);
    await fetchOrchestration("ws-1");

    await mutatePlan("ws-1", (o) => ({ ...o, rails: [...o.rails, rail("r2")] }));

    expect(get(orchestrations)["ws-1"].rails.map((r) => r.id)).toEqual(["r1", "r2"]);
    expect(backend.setOrchestration).toHaveBeenCalledWith(
      "ws-1",
      [expect.objectContaining({ id: "r1" }), expect.objectContaining({ id: "r2" })],
      []
    );
  });

  it("rolls back and records the message when the save fails", async () => {
    vi.mocked(backend.getOrchestration).mockResolvedValue(withRails("r1"));
    vi.mocked(backend.setOrchestration).mockRejectedValue(
      new Error("step t1 (/x/a.md) is running — pause or let it finish before removing it")
    );
    await fetchOrchestration("ws-1");

    await mutatePlan("ws-1", (o) => ({ ...o, rails: [] }));

    expect(get(orchestrations)["ws-1"].rails.map((r) => r.id)).toEqual(["r1"]);
    expect(get(saveErrors)["ws-1"]).toContain("is running");
    dismissSaveError("ws-1");
    expect(get(saveErrors)["ws-1"]).toBeUndefined();
  });

  it("is a no-op for a workspace that was never fetched", async () => {
    await mutatePlan("ws-nope", (o) => ({ ...o, rails: [rail("r1")] }));
    expect(backend.setOrchestration).not.toHaveBeenCalled();
  });
});

describe("run-state actions", () => {
  beforeEach(async () => {
    vi.mocked(backend.getOrchestration).mockResolvedValue(withRails("r1"));
    vi.mocked(backend.setRailRun).mockResolvedValue(undefined);
    vi.mocked(backend.setStepRun).mockResolvedValue(undefined);
    await fetchOrchestration("ws-1");
  });

  it("upserts a rail run in the store and persists it", async () => {
    await setRailRunAction("ws-1", "r1", "running", "s1");
    expect(get(orchestrations)["ws-1"].railRuns).toEqual([
      { railId: "r1", state: "running", currentStageId: "s1" },
    ]);
    expect(backend.setRailRun).toHaveBeenCalledWith("r1", "running", "s1", "ws-1");

    await setRailRunAction("ws-1", "r1", "paused", "s1");
    expect(get(orchestrations)["ws-1"].railRuns).toHaveLength(1);
    expect(get(orchestrations)["ws-1"].railRuns[0].state).toBe("paused");
  });

  it("upserts a step run in the store and persists it", async () => {
    await setStepRunAction("ws-1", "t1", "running", "sess-1", null);
    expect(get(orchestrations)["ws-1"].stepRuns).toEqual([
      {
        stepId: "t1",
        state: "running",
        sessionId: "sess-1",
        reason: null,
        conversationId: null,
        launchCwd: null,
        resumeAttempts: null,
      },
    ]);
    expect(backend.setStepRun).toHaveBeenCalledWith("t1", "running", "sess-1", null, null, null, null, "ws-1");
  });
});

// A rail with one stage of one step, bound to a worktree and a page --
// cardPath matches the CARD stubbed into gavinTrees above, so a launch
// reaches createSessionOnPage instead of stalling on a missing card.
function boundRail(): Orchestration {
  return {
    ...emptyOrchestration(),
    rails: [
      {
        id: "r1",
        name: "backend",
        position: 0,
        worktreePath: "/x/wt",
        pageId: "p1",
        stages: [{ id: "s1", position: 0, steps: [{ id: "t1", position: 0, cardPath: "/x/a.md" }] }],
      },
    ],
  };
}

/// A rail bound to a branch, with two pending steps in one stage -- the
/// shape that makes "stall the whole stage" observable.
function branchRail(): Orchestration {
  return {
    ...emptyOrchestration(),
    rails: [
      {
        id: "r1",
        name: "backend",
        position: 0,
        worktreePath: "/x/wt",
        branch: "feature/api",
        pageId: "p1",
        stages: [
          {
            id: "s1",
            position: 0,
            steps: [
              { id: "t1", position: 0, cardPath: "/x/a.md" },
              { id: "t2", position: 1, cardPath: "/x/b.md" },
            ],
          },
        ],
      },
    ],
    railRuns: [{ railId: "r1", state: "running", currentStageId: "s1" }],
  };
}

const SWITCH = {
  kind: "switchBranch" as const,
  railId: "r1",
  path: "/x/wt",
  branch: "feature/api",
};

describe("executeActions — switchBranch (spec O15)", () => {
  beforeEach(async () => {
    vi.mocked(backend.getOrchestration).mockResolvedValue(branchRail());
    vi.mocked(backend.setRailRun).mockResolvedValue(undefined);
    vi.mocked(backend.setStepRun).mockResolvedValue(undefined);
    await fetchOrchestration("ws-1");
  });

  /// Point the mocked refs snapshot at a branch for /x/wt.
  ///
  /// A COMPLETE snapshot, because `refs` is never partial in the app --
  /// gitState publishes what `refs()` returned or nothing at all -- and
  /// executeSwitchBranch now reads the branch lists out of the same one
  /// it reads the worktrees from. `has` is what the repo itself holds,
  /// SWITCH's branch included by default: every test here but the
  /// missing-branch one is about a binding that exists.
  function refsSay(branch: string, has: string[] = ["main", "feature/api"]): void {
    (gitStateModule as unknown as { __setGitStore: (v: unknown) => void }).__setGitStore({
      "ws-1": {
        refs: {
          branches: has.map((name) => ({
            name, current: name === branch, upstream: null, ahead: 0, behind: 0, sha: "a", subject: "s",
          })),
          remotes: [],
          stashes: [],
          worktrees: [
            { path: "/x/wt", head: "a", branch, isMain: false, locked: false, prunable: false },
          ],
          headBranch: branch,
        },
      },
    });
  }

  it("switches a clean checkout and refreshes the refs snapshot", async () => {
    vi.mocked(backend.gitStatus).mockResolvedValue({ staged: [], unstaged: [] });
    vi.mocked(backend.gitCheckout).mockResolvedValue(undefined);
    vi.mocked(gitStateModule.refresh).mockImplementation(async () => refsSay("feature/api"));

    const again = await executeActions("ws-1", [SWITCH]);

    expect(backend.gitCheckout).toHaveBeenCalledWith("/x/wt", "feature/api", null);
    // Without the refresh the refs snapshot still shows the old branch
    // and the next tick would switch all over again.
    expect(gitStateModule.refresh).toHaveBeenCalledWith("ws-1");
    expect(backend.setStepRun).not.toHaveBeenCalled();
    // The switch half-finishes the tick: the rail is launchable only on
    // the pass that reads the new snapshot.
    expect(again).toBe(true);
  });

  it("asks for no follow-up when the refs snapshot did not catch up", async () => {
    // A failed refresh leaves the OLD snapshot in place. Re-ticking on
    // that would re-emit this very switch, and checking out a branch you
    // are already on succeeds every time — an endless loop.
    vi.mocked(backend.gitStatus).mockResolvedValue({ staged: [], unstaged: [] });
    vi.mocked(backend.gitCheckout).mockResolvedValue(undefined);
    vi.mocked(gitStateModule.refresh).mockImplementation(async () => refsSay("main"));

    expect(await executeActions("ws-1", [SWITCH])).toBe(false);
  });

  it("asks for no follow-up when the switch was refused", async () => {
    vi.mocked(backend.gitStatus).mockResolvedValue({
      staged: [],
      unstaged: [{ path: "a.ts", status: "M", staged: false, untracked: false }],
    } as never);

    expect(await executeActions("ws-1", [SWITCH])).toBe(false);
  });

  it("refuses a dirty checkout without calling git at all", async () => {
    vi.mocked(backend.gitStatus).mockResolvedValue({
      staged: [],
      unstaged: [{ path: "app/src/lib/git.ts", status: "M", staged: false, untracked: false }],
    } as never);

    await executeActions("ws-1", [SWITCH]);

    expect(backend.gitCheckout).not.toHaveBeenCalled();
    expect(backend.setStepRun).toHaveBeenCalledWith(
      "t1",
      "stalled",
      null,
      expect.stringContaining("uncommitted"),
      null,
      null,
      null,
      "ws-1",
    );
    expect(backend.setRailRun).toHaveBeenCalledWith("r1", "paused", "s1", "ws-1");
  });

  /// The bug this covers: every rail bound to a worktree of a gavin
  /// workspace stalled on its FIRST tick, before anything launched,
  /// because the only thing in the checkout was gavin's own board --
  /// untracked on that branch, and reported as `unstaged` by
  /// `--untracked-files=all`. The advice the stall gave was advice the
  /// human must not take: committing the board onto a feature branch is
  /// wrong, and the stash stack is shared with every other checkout.
  it("lets gavin's own files through — .gavin-root never blocks the switch", async () => {
    vi.mocked(backend.gitStatus).mockResolvedValue({
      staged: [],
      unstaged: [{ path: ".gavin-root", status: "?", staged: false, untracked: true }],
    } as never);
    vi.mocked(backend.gitCheckout).mockResolvedValue(undefined);
    vi.mocked(gitStateModule.refresh).mockImplementation(async () => refsSay("feature/api"));

    await executeActions("ws-1", [SWITCH]);

    expect(backend.gitCheckout).toHaveBeenCalledWith("/x/wt", "feature/api", null);
    expect(backend.setStepRun).not.toHaveBeenCalled();
  });

  /// Turning tracking off STAGES the removal of gavin's files and never
  /// commits it (git/tracking.rs), so that state sits in the index for
  /// as long as the human takes to review it. Same story on both sides.
  it("lets a staged removal of gavin's files through too", async () => {
    vi.mocked(backend.gitStatus).mockResolvedValue({
      staged: [{ path: ".gavin-root/PRD.md", status: "D", staged: true, untracked: false }],
      unstaged: [],
    } as never);
    vi.mocked(backend.gitCheckout).mockResolvedValue(undefined);
    vi.mocked(gitStateModule.refresh).mockImplementation(async () => refsSay("feature/api"));

    await executeActions("ws-1", [SWITCH]);

    expect(backend.gitCheckout).toHaveBeenCalledWith("/x/wt", "feature/api", null);
  });

  it("still refuses when gavin's files sit BESIDE the human's work", async () => {
    vi.mocked(backend.gitStatus).mockResolvedValue({
      staged: [],
      unstaged: [
        { path: ".gavin-root", status: "?", staged: false, untracked: true },
        { path: "app/src/lib/git.ts", status: "M", staged: false, untracked: false },
      ],
    } as never);

    await executeActions("ws-1", [SWITCH]);

    expect(backend.gitCheckout).not.toHaveBeenCalled();
    expect(backend.setRailRun).toHaveBeenCalledWith("r1", "paused", "s1", "ws-1");
  });

  it("counts STAGED changes as dirty too", async () => {
    vi.mocked(backend.gitStatus).mockResolvedValue({
      staged: [{ path: "a.ts", status: "M", staged: true, untracked: false }],
      unstaged: [],
    } as never);

    await executeActions("ws-1", [SWITCH]);
    expect(backend.gitCheckout).not.toHaveBeenCalled();
  });

  it("surfaces git's own refusal — the branch is checked out elsewhere", async () => {
    vi.mocked(backend.gitStatus).mockResolvedValue({ staged: [], unstaged: [] });
    vi.mocked(backend.gitCheckout).mockRejectedValue(
      new Error("fatal: 'feature/api' is already checked out at '/x/other'")
    );

    await executeActions("ws-1", [SWITCH]);

    expect(backend.setStepRun).toHaveBeenCalledWith(
      "t1",
      "stalled",
      null,
      expect.stringContaining("already checked out"),
      null,
      null,
      null,
      "ws-1",
    );
  });

  it("stalls every pending step of the current stage, not just the first", async () => {
    vi.mocked(backend.gitStatus).mockResolvedValue({ staged: [], unstaged: [] });
    vi.mocked(backend.gitCheckout).mockRejectedValue(new Error("nope"));

    await executeActions("ws-1", [SWITCH]);

    const stalled = vi.mocked(backend.setStepRun).mock.calls.map((c) => c[0]);
    expect(stalled).toEqual(["t1", "t2"]);
  });

  it("refuses a branch this repo does not have, without calling git at all", async () => {
    // git's own answer is `fatal: invalid reference: <name>`, which
    // reads as a gavin fault rather than the binding it is -- and the
    // binding is the one an agent-written rail arrives with, since
    // gavin_set_orchestration takes any string.
    refsSay("main", ["main"]);
    vi.mocked(backend.gitStatus).mockResolvedValue({ staged: [], unstaged: [] });

    await executeActions("ws-1", [SWITCH]);

    expect(backend.gitCheckout).not.toHaveBeenCalled();
    expect(backend.setStepRun).toHaveBeenCalledWith(
      "t1",
      "stalled",
      null,
      expect.stringContaining("feature/api is not a branch of this repo"),
      null,
      null,
      null,
      "ws-1",
    );
    expect(backend.setRailRun).toHaveBeenCalledWith("r1", "paused", "s1", "ws-1");
  });

  it("switches to a branch that exists only on a remote", async () => {
    // `git switch feature/api` with nothing local but origin/feature/api
    // creates the tracking branch itself. Refusing it would refuse a
    // binding that works.
    (gitStateModule as unknown as { __setGitStore: (v: unknown) => void }).__setGitStore({
      "ws-1": {
        refs: {
          branches: [{ name: "main", current: true, upstream: null, ahead: 0, behind: 0, sha: "a", subject: "s" }],
          remotes: [{ name: "origin", url: "u", branches: ["main", "feature/api"] }],
          stashes: [],
          worktrees: [{ path: "/x/wt", head: "a", branch: "main", isMain: false, locked: false, prunable: false }],
          headBranch: "main",
        },
      },
    });
    vi.mocked(backend.gitStatus).mockResolvedValue({ staged: [], unstaged: [] });
    vi.mocked(backend.gitCheckout).mockResolvedValue(undefined);
    vi.mocked(gitStateModule.refresh).mockImplementation(async () => refsSay("feature/api"));

    expect(await executeActions("ws-1", [SWITCH])).toBe(true);
    expect(backend.gitCheckout).toHaveBeenCalledWith("/x/wt", "feature/api", null);
  });

  it("switches when the refs snapshot has not loaded — unknown is not gone", async () => {
    // The same cold-start rule launchBlocker and branchSwitchFor follow.
    // A workspace whose git view was never opened has no snapshot, and
    // reading that as "no branch exists" would stall every bound rail.
    (gitStateModule as unknown as { __setGitStore: (v: unknown) => void }).__setGitStore({});
    vi.mocked(backend.gitStatus).mockResolvedValue({ staged: [], unstaged: [] });
    vi.mocked(backend.gitCheckout).mockResolvedValue(undefined);
    vi.mocked(gitStateModule.refresh).mockImplementation(async () => refsSay("feature/api"));

    expect(await executeActions("ws-1", [SWITCH])).toBe(true);
    expect(backend.gitCheckout).toHaveBeenCalledWith("/x/wt", "feature/api", null);
  });

  it("leaves a step that is not pending alone", async () => {
    // Defensive: the scheduler never emits a switch while a step runs,
    // but a stale tick must not stall a live agent's step.
    await setStepRunAction("ws-1", "t1", "running", "sess-1", null);
    vi.mocked(backend.setStepRun).mockClear();
    vi.mocked(backend.gitStatus).mockResolvedValue({ staged: [], unstaged: [] });
    vi.mocked(backend.gitCheckout).mockRejectedValue(new Error("nope"));

    await executeActions("ws-1", [SWITCH]);

    const stalled = vi.mocked(backend.setStepRun).mock.calls.map((c) => c[0]);
    expect(stalled).toEqual(["t2"]);
  });
});

describe("rail controls", () => {
  beforeEach(async () => {
    vi.mocked(backend.getOrchestration).mockResolvedValue(boundRail());
    // Explicit, because an earlier describe leaves this rejecting to
    // exercise rollback and `clearAllMocks` keeps implementations.
    vi.mocked(backend.setOrchestration).mockResolvedValue(undefined);
    vi.mocked(backend.setRailRun).mockResolvedValue(undefined);
    vi.mocked(backend.setStepRun).mockResolvedValue(undefined);
    await fetchOrchestration("ws-1");
  });

  it("Start arms the rail at its first unfinished stage", async () => {
    await startRail("ws-1", "r1");
    expect(backend.setRailRun).toHaveBeenCalledWith("r1", "running", "s1", "ws-1");
  });

  it("Start is a no-op for a rail whose every stage is done", async () => {
    await setStepRunAction("ws-1", "t1", "done", null, null);
    vi.mocked(backend.setRailRun).mockClear();
    await startRail("ws-1", "r1");
    expect(backend.setRailRun).not.toHaveBeenCalled();
  });

  // The mechanism auto-resume drives, and the human's own button for a
  // step whose agent broke: reopen the SAME conversation in place, not a
  // fresh agent over a checkout that already carries the first attempt's
  // edits.
  it("Resume step reopens the conversation in the directory the run was launched in", async () => {
    setRailPageLive();
    vi.mocked(layoutStateModule.resolvedAgentFor).mockReturnValue({
      launchCommand: "claude",
      promptArgs: "",
      resumeArgs: "--resume",
      failurePatterns: ["API Error:"],
      failureCauses: [],
      sessionIdArgs: "--session-id",
    } as never);
    vi.mocked(layoutStateModule.createSessionOnPage).mockResolvedValue("sess-2");
    await setStepRunAction("ws-1", "t1", "stalled", "sess-1", "broke", "conv-1", "/x/wt");
    await setRailRunAction("ws-1", "r1", "paused", "s1");

    expect(await resumeStep("ws-1", "t1")).toBeNull();

    expect(layoutStateModule.createSessionOnPage).toHaveBeenCalledWith(
      "ws-1",
      "p1",
      "/x/wt",
      "claude --resume conv-1"
    );
    // The same conversation id, the new session, and the budget
    // UNTOUCHED: a human's press is not an automatic attempt.
    expect(backend.setStepRun).toHaveBeenLastCalledWith(
      "t1",
      "running",
      "sess-2",
      null,
      "conv-1",
      "/x/wt",
      null,
      "ws-1",
    );
  });

  // Rule 5 paused the rail when the step stalled. A resumed step on a
  // paused rail would finish and advance nothing.
  it("Resume step puts the paused rail back to running", async () => {
    vi.mocked(layoutStateModule.resolvedAgentFor).mockReturnValue({
      launchCommand: "claude",
      promptArgs: "",
      resumeArgs: "--resume",
      failurePatterns: [],
      failureCauses: [],
      sessionIdArgs: "--session-id",
    } as never);
    vi.mocked(layoutStateModule.createSessionOnPage).mockResolvedValue("sess-2");
    await setStepRunAction("ws-1", "t1", "stalled", "sess-1", "broke", "conv-1", "/x/wt");
    await setRailRunAction("ws-1", "r1", "paused", "s1");
    vi.mocked(backend.setRailRun).mockClear();

    await resumeStep("ws-1", "t1");
    expect(backend.setRailRun).toHaveBeenCalledWith("r1", "running", "s1", "ws-1");
  });

  // An AUTOMATIC resume is the one that spends the budget, and it spends
  // it on the persisted count rather than a counter in this window.
  it("Resume step spends the budget only when gavin decided it", async () => {
    vi.mocked(layoutStateModule.resolvedAgentFor).mockReturnValue({
      launchCommand: "claude",
      promptArgs: "",
      resumeArgs: "--resume",
      failurePatterns: [],
      failureCauses: [],
      sessionIdArgs: "--session-id",
    } as never);
    vi.mocked(layoutStateModule.createSessionOnPage).mockResolvedValue("sess-2");
    await setStepRunAction("ws-1", "t1", "stalled", "sess-1", "broke", "conv-1", "/x/wt");

    await resumeStep("ws-1", "t1", { automatic: true });
    expect(backend.setStepRun).toHaveBeenLastCalledWith(
      "t1",
      "running",
      "sess-2",
      null,
      "conv-1",
      "/x/wt",
      1,
      "ws-1",
    );
  });

  // A profile with no verified resume argv, or a run recorded before the
  // conversation id existed. Reopening is simply not available -- and
  // saying so beats launching a fresh agent under the word "Resume".
  it("Resume step refuses a run with no conversation to reopen", async () => {
    await setStepRunAction("ws-1", "t1", "stalled", "sess-1", "broke");
    const err = await resumeStep("ws-1", "t1");
    expect(err).toMatch(/no conversation to reopen/);
    expect(layoutStateModule.createSessionOnPage).not.toHaveBeenCalled();
  });

  // Gavin minted the conversation id before the agent did anything, so
  // the id proves a launch was ATTEMPTED, not that a conversation was
  // written. A step whose agent died at launch has nothing to reopen --
  // `claude --resume <uuid>` would say so and exit -- and auto-resume
  // reaches this without a human, so the refusal has to happen here, not
  // in the agent's own error text. Retry (a fresh run) is the way on.
  it("Resume step refuses a conversation the agent never wrote", async () => {
    setRailPageLive();
    vi.mocked(layoutStateModule.resolvedAgentFor).mockReturnValue({
      profileId: "claude-code",
      launchCommand: "claude",
      promptArgs: "",
      resumeArgs: "--resume",
      failurePatterns: [],
      failureCauses: [],
      sessionIdArgs: "--session-id",
    } as never);
    vi.mocked(backend.conversationLog).mockResolvedValueOnce("missing");
    await setStepRunAction("ws-1", "t1", "stalled", "sess-1", "broke", "conv-1", "/x/wt");
    vi.mocked(backend.setStepRun).mockClear();

    const err = await resumeStep("ws-1", "t1");

    expect(err).toMatch(/before it wrote a line/);
    expect(err).toMatch(/Retry/);
    expect(backend.conversationLog).toHaveBeenCalledWith("claude-code", "conv-1");
    expect(layoutStateModule.createSessionOnPage).not.toHaveBeenCalled();
    // Nothing launched, so nothing written: the step stays stalled where
    // it was, with its reason.
    expect(backend.setStepRun).not.toHaveBeenCalled();
  });

  // Consent is part of the PLAN, so it rides the same wholesale save
  // every other rail edit does -- and an agent reading the rails over
  // MCP sees it.
  it("the rail's auto-resume opt-in is a plan edit", async () => {
    await setRailAutoResumeAction("ws-1", "r1", true);
    expect(get(orchestrations)["ws-1"].rails[0].autoResume).toBe(true);
    expect(backend.setOrchestration).toHaveBeenCalledWith(
      "ws-1",
      [expect.objectContaining({ id: "r1", autoResume: true })],
      []
    );
  });

  it("Pause keeps the current stage", async () => {
    await startRail("ws-1", "r1");
    await pauseRail("ws-1", "r1");
    expect(backend.setRailRun).toHaveBeenLastCalledWith("r1", "paused", "s1", "ws-1");
  });

  it("Resume picks up at the stage the pause left the rail on", async () => {
    await startRail("ws-1", "r1");
    await pauseRail("ws-1", "r1");
    vi.mocked(backend.setRailRun).mockClear();
    await resumeRail("ws-1", "r1");
    expect(backend.setRailRun).toHaveBeenCalledWith("r1", "running", "s1", "ws-1");
  });

  // An edit, a reorganize or a Clear done that lands while a rail is
  // paused can take the very stage it is parked on. Handing that id back
  // to the scheduler finds no stage and calls the rail COMPLETE, so
  // pressing Play would idle the rail instead of running it.
  it("Resume re-arms when the stage it was paused on is gone", async () => {
    await setRailRunAction("ws-1", "r1", "paused", "swept-stage");
    vi.mocked(backend.setRailRun).mockClear();
    await resumeRail("ws-1", "r1");
    expect(backend.setRailRun).toHaveBeenCalledWith("r1", "running", "s1", "ws-1");
  });

  it("Resume on a rail with nothing left to run lets the tick complete it", async () => {
    await setStepRunAction("ws-1", "t1", "done", null, null);
    await setRailRunAction("ws-1", "r1", "paused", "swept-stage");
    vi.mocked(backend.setRailRun).mockClear();
    await resumeRail("ws-1", "r1");
    expect(backend.setRailRun).toHaveBeenCalledWith("r1", "running", null, "ws-1");
  });

  // Spec O16, but at LAUNCH. Arming used to spawn the page here, which
  // meant opening a blank shell to have something to put on it -- and
  // that shell then sat first in the tab strip for the life of the page,
  // ahead of every agent the page existed for. `boundRail` names page
  // "p1" over an empty layout, so this rail is exactly the unbound /
  // closed-page case that used to spawn one.
  it("Start arms the rail without spawning a page", async () => {
    await startRail("ws-1", "r1");
    expect(layoutStateModule.createSessionOnNewPage).not.toHaveBeenCalled();
    expect(backend.setRailRun).toHaveBeenCalledWith("r1", "running", "s1", "ws-1");
    expect(get(orchestrations)["ws-1"].rails[0].pageId).toBe("p1");
  });

  it("Resume arms the rail without spawning one either", async () => {
    await setRailRunAction("ws-1", "r1", "paused", "s1");
    vi.mocked(backend.setRailRun).mockClear();
    await resumeRail("ws-1", "r1");
    expect(layoutStateModule.createSessionOnNewPage).not.toHaveBeenCalled();
    expect(backend.setRailRun).toHaveBeenCalledWith("r1", "running", "s1", "ws-1");
  });

  it("Retry returns a stalled step to pending and clears its reason", async () => {
    await setStepRunAction("ws-1", "t1", "stalled", "sess-1", "card file is missing");
    await retryStep("ws-1", "t1");
    // `0`, not null: a Retry starts the run over, and an `until` step's
    // loop budget is the one count no launch clears (see retryStep).
    expect(backend.setStepRun).toHaveBeenLastCalledWith("t1", "pending", null, null, null, null, 0, "ws-1");
  });

  // The escape hatch. A step whose completion signal never arrives used
  // to cost the human the session AND the step -- the only way to get a
  // `running` row out of the daemon's way.
  it("Mark done files a running step done, keeping its session", async () => {
    await setStepRunAction("ws-1", "t1", "running", "sess-1", null);
    await markStepDone("ws-1", "t1");
    expect(backend.setStepRun).toHaveBeenLastCalledWith("t1", "done", "sess-1", null, null, null, null, "ws-1");
  });

  it("Mark done clears a stalled step's reason with it", async () => {
    await setStepRunAction("ws-1", "t1", "stalled", null, "Push branch exited with code 1");
    await markStepDone("ws-1", "t1");
    expect(backend.setStepRun).toHaveBeenLastCalledWith("t1", "done", null, null, null, null, null, "ws-1");
  });

  // The other half of the pair. "Mark done" was the only way past a step
  // that would not finish, so it got pressed for work nobody did -- and
  // every tally downstream counted that step as delivered.
  it("Skip files a running step skipped, keeping its session", async () => {
    await setStepRunAction("ws-1", "t1", "running", "sess-1", null);
    await skipStep("ws-1", "t1");
    // Not "done": the rail is past this step and nothing about it
    // happened. The session survives -- a live agent the human has
    // stopped waiting for is still theirs to read, and to kill from the
    // session itself if that is what they meant.
    expect(backend.setStepRun).toHaveBeenLastCalledWith("t1", "skipped", "sess-1", null, null, null, null, "ws-1");
  });

  it("Skip clears a stalled step's reason with it", async () => {
    await setStepRunAction("ws-1", "t1", "stalled", null, "Push branch exited with code 1");
    await skipStep("ws-1", "t1");
    // The stall is no longer why the rail is where it is, and a bubble
    // still quoting it would describe a decision nobody made.
    expect(backend.setStepRun).toHaveBeenLastCalledWith("t1", "skipped", null, null, null, null, null, "ws-1");
  });

  // The "and proceed" half. Rule 5 pauses a rail around a stall, so the
  // step most worth skipping sits on a rail that would otherwise skip it
  // and then advance nothing.
  it("Skip puts a rail paused by the stall back to running", async () => {
    await setRailRunAction("ws-1", "r1", "paused", "s1");
    await setStepRunAction("ws-1", "t1", "stalled", null, "agent exited before the card reached Done");
    vi.mocked(backend.setRailRun).mockClear();
    await skipStep("ws-1", "t1");
    expect(backend.setRailRun).toHaveBeenCalledWith("r1", "running", "s1", "ws-1");
  });

  // Skipping one step is not starting a rail. A rail the human left idle
  // must stay idle, or a skip would launch work out of nowhere.
  it("Skip does not start an idle rail", async () => {
    await setStepRunAction("ws-1", "t1", "stalled", null, "worktree is gone");
    vi.mocked(backend.setRailRun).mockClear();
    await skipStep("ws-1", "t1");
    expect(backend.setRailRun).not.toHaveBeenCalled();
  });
});

/// A rail whose run row already says `running` and whose `pageId` is
/// null: what an agent writing SetRailRun straight to the daemon socket
/// leaves behind, and what fetchOrchestration adopts after a restart.
/// Neither path passes through startRail, so nothing armed a page. Two
/// stages, so a SECOND launch on the same rail is observable.
function adoptedRail(pageId: string | null = null): Orchestration {
  return {
    ...emptyOrchestration(),
    rails: [
      {
        id: "r1",
        name: "backend",
        position: 0,
        worktreePath: "/x/wt",
        pageId,
        stages: [
          { id: "s1", position: 0, steps: [{ id: "t1", position: 0, cardPath: "/x/a.md" }] },
          { id: "s2", position: 1, steps: [{ id: "t2", position: 0, cardPath: "/x/b.md" }] },
        ],
      },
    ],
    railRuns: [{ railId: "r1", state: "running", currentStageId: "s1" }],
  };
}

// Spec O16, enforced at LAUNCH and ONLY at launch. The Grimoria failure:
// five rails armed over the socket, every step of every rail stacked on
// the workspace's active page, because the page was reachable only from
// Start and Resume. Arming spawns none now, so this is the whole of it.
describe("a rail gets its page at its first launch (spec O16)", () => {
  // The page is made AROUND the launch's own session -- name, cwd,
  // command, and the posture that keeps the human on the Orchestration
  // tab -- so nothing blank is opened to have something to put on it.
  const pageArgs = (command: unknown = expect.any(String)) => [
    "ws-1",
    "backend",
    "/x/wt",
    command,
    { activate: false },
  ];

  beforeEach(async () => {
    __resetForTesting();
    toolsResetForTesting();
    vi.clearAllMocks();
    vi.mocked(backend.getOrchestration).mockResolvedValue(adoptedRail());
    vi.mocked(backend.setOrchestration).mockResolvedValue(undefined);
    vi.mocked(backend.setRailRun).mockResolvedValue(undefined);
    vi.mocked(backend.setStepRun).mockResolvedValue(undefined);
    vi.mocked(backend.setPlanFrontmatterField).mockImplementation(async (p) => p);
    vi.mocked(backend.readFileForViewer).mockResolvedValue({
      content: "---\ntitle: Wire the API\n---\ndo the thing",
      truncated: false,
      exists: true,
    });
    vi.mocked(layoutStateModule.createSessionOnPage).mockResolvedValue("sess-9");
    vi.mocked(layoutStateModule.setSessionName).mockResolvedValue(undefined);
    vi.mocked(layoutStateModule.createSessionOnNewPage).mockResolvedValue({
      pageId: "pg-rail",
      sessionId: "sess-9",
    });
    setLayoutState({ workspaces: [{ id: "ws-1", pages: [] }] });
    await fetchOrchestration("ws-1");
  });

  it("the first launch lands on a page named after the rail, and binds it", async () => {
    await executeActions("ws-1", [{ kind: "launch", stepId: "t1" }]);
    expect(layoutStateModule.createSessionOnNewPage).toHaveBeenCalledWith(
      ...pageArgs(expect.stringContaining("claude"))
    );
    // The agent IS the page's first tab. Making the page first and
    // landing the session on it afterwards is what left a blank shell
    // ahead of it, first in the tab strip for the life of the page.
    expect(layoutStateModule.createSessionOnPage).not.toHaveBeenCalled();
    expect(get(orchestrations)["ws-1"].rails[0].pageId).toBe("pg-rail");
    // And that one session is the step's, not a shell beside it.
    expect(backend.setStepRun).toHaveBeenCalledWith("t1", "running", "sess-9", null, null, "/x/wt", 0, "ws-1");
  });

  // AG-01: a rail is the one launcher nobody is standing in front of, so
  // it cannot ASK. It stalls the step and names the card instead; the
  // human answers on the card, and Retry starts it.
  it("stalls a step whose card nobody has read, instead of launching it", async () => {
    // Once: `mockReturnValue` would outlive clearAllMocks and leave every
    // later test in this file waiting to be reviewed.
    vi.mocked(layoutStateModule.cardReviewed).mockReturnValueOnce(false);

    await executeActions("ws-1", [{ kind: "launch", stepId: "t1" }]);

    expect(layoutStateModule.createSessionOnNewPage).not.toHaveBeenCalled();
    expect(layoutStateModule.createSessionOnPage).not.toHaveBeenCalled();
    expect(backend.setStepRun).toHaveBeenCalledWith(
      "t1",
      "stalled",
      null,
      expect.stringContaining(UNREVIEWED_STALL),
      null,
      null,
      null,
      "ws-1",
    );
    // And the card is left where it was: no In Progress for a run that
    // never happened.
    expect(backend.setPlanFrontmatterField).not.toHaveBeenCalled();
    // And the rail stops here, in the launch itself: no later pass would
    // pause it, because a stalled step on a running rail reads as one to
    // retry.
    expect(backend.setRailRun).toHaveBeenCalledWith("r1", "paused", "s1", "ws-1");
  });

  it("the rail's second launch reuses that page", async () => {
    await executeActions("ws-1", [{ kind: "launch", stepId: "t1" }]);
    // The mock puts nothing in the layout; the real one does.
    setLayoutState({ workspaces: [{ id: "ws-1", pages: [{ id: "pg-rail", name: "backend" }] }] });
    vi.mocked(layoutStateModule.createSessionOnNewPage).mockClear();
    await executeActions("ws-1", [{ kind: "launch", stepId: "t2" }]);
    expect(layoutStateModule.createSessionOnNewPage).not.toHaveBeenCalled();
    expect(layoutStateModule.createSessionOnPage).toHaveBeenLastCalledWith(
      "ws-1",
      "pg-rail",
      "/x/wt",
      expect.any(String)
    );
  });

  it("a rail whose page was closed gets a fresh one at the next launch", async () => {
    vi.mocked(backend.getOrchestration).mockResolvedValue(adoptedRail("p-gone"));
    __resetForTesting();
    await fetchOrchestration("ws-1");
    setLayoutState({ workspaces: [{ id: "ws-1", pages: [{ id: "p-other", name: "Page 1" }] }] });
    await executeActions("ws-1", [{ kind: "launch", stepId: "t1" }]);
    expect(layoutStateModule.createSessionOnNewPage).toHaveBeenCalledWith(...pageArgs());
    expect(get(orchestrations)["ws-1"].rails[0].pageId).toBe("pg-rail");
  });

  // The launch button is still showing while the page is being made, so
  // a second launch can reach a rail that is still unbound. It WAITS for
  // the page rather than racing it: giving up on one used to drop that
  // session on the Agents page, and re-reading a half-written binding
  // would have made a second page named after the same rail.
  it("two launches racing an unbound rail spawn one page, not two", async () => {
    let finish: (v: { pageId: string; sessionId: string } | null) => void = () => {};
    const gate = new Promise<{ pageId: string; sessionId: string } | null>((r) => (finish = r));
    vi.mocked(layoutStateModule.createSessionOnNewPage).mockReturnValue(gate);
    const first = executeActions("ws-1", [{ kind: "launch", stepId: "t1" }]);
    const second = executeActions("ws-1", [{ kind: "launch", stepId: "t2" }]);
    // Both launches must be past the guard before the page lands, or the
    // race this covers never happens.
    await vi.waitFor(() => expect(layoutStateModule.createSessionOnNewPage).toHaveBeenCalled());
    // The real one puts the page in the layout; without that, the waiting
    // launch sees a binding naming a page that does not exist -- the
    // closed-page case -- and spawns another.
    setLayoutState({ workspaces: [{ id: "ws-1", pages: [{ id: "pg-rail", name: "backend" }] }] });
    finish({ pageId: "pg-rail", sessionId: "sess-9" });
    await Promise.all([first, second]);
    expect(layoutStateModule.createSessionOnNewPage).toHaveBeenCalledTimes(1);
    expect(layoutStateModule.createSessionOnPage).toHaveBeenLastCalledWith(
      "ws-1",
      "pg-rail",
      "/x/wt",
      expect.any(String)
    );
  });

  // Spec §4.3 step 4: a page is where agents land, not a precondition
  // for running them. The step goes to the fallback and the rail keeps
  // advancing -- a page failure must never read as a stalled step.
  it("a page that cannot be created still launches the step on the fallback and leaves the rail running", async () => {
    vi.mocked(layoutStateModule.createSessionOnNewPage).mockResolvedValue(null);
    await executeActions("ws-1", [{ kind: "launch", stepId: "t1" }]);
    expect(layoutStateModule.createSessionOnPage).toHaveBeenCalledWith(
      "ws-1",
      null,
      "/x/wt",
      expect.any(String)
    );
    expect(backend.setStepRun).toHaveBeenCalledWith("t1", "running", "sess-9", null, null, "/x/wt", 0, "ws-1");
    expect(backend.setRailRun).not.toHaveBeenCalled();
    expect(get(orchestrations)["ws-1"].railRuns).toEqual([
      { railId: "r1", state: "running", currentStageId: "s1" },
    ]);
  });

  it("a tool step launches onto the rail's page the same way", async () => {
    vi.mocked(backend.getOrchestration).mockResolvedValue({
      ...toolRail(),
      rails: toolRail().rails.map((r) => ({ ...r, pageId: null })),
      railRuns: [{ railId: "r1", state: "running", currentStageId: "s1" }],
    });
    __resetForTesting();
    await fetchOrchestration("ws-1");
    toolRecords.set({ "ws-1": [] });
    await executeActions("ws-1", [{ kind: "launch", stepId: "t1" }]);
    expect(layoutStateModule.createSessionOnNewPage).toHaveBeenCalledWith(
      ...pageArgs(expect.stringContaining("git push -u origin HEAD"))
    );
  });

  // A `gavin` action has no session, so it has nothing to put on a page
  // -- the rail carrying it must not gain one on its account.
  it("a gavin action spawns no page for the rail carrying it", async () => {
    vi.mocked(backend.getOrchestration).mockResolvedValue({
      ...toolRail(),
      rails: toolRail().rails.map((r) => ({
        ...r,
        pageId: null,
        stages: [
          {
            id: "s1",
            position: 0,
            steps: [
              {
                id: "t1",
                position: 0,
                cardPath: "",
                toolId: "builtin:start-rail",
                toolParams: { rail: "no such rail" },
              },
            ],
          },
        ],
      })),
      railRuns: [{ railId: "r1", state: "running", currentStageId: "s1" }],
    });
    __resetForTesting();
    await fetchOrchestration("ws-1");
    toolRecords.set({ "ws-1": [] });
    await executeActions("ws-1", [{ kind: "launch", stepId: "t1" }]);
    expect(layoutStateModule.createSessionOnNewPage).not.toHaveBeenCalled();
    expect(layoutStateModule.createSessionOnPage).not.toHaveBeenCalled();
  });

  // The step's `workspace` parameter is a workspace ID from
  // StepParamsDialog's picker, and the rail it names lives in a
  // DIFFERENT workspace's plan -- one this app has not fetched yet,
  // which is the normal case for a workspace nobody has switched to.
  it("a gavin action can arm a rail in a workspace of its own choosing", async () => {
    vi.mocked(backend.getOrchestration).mockImplementation(async (workspaceId: string) =>
      workspaceId === "ws-2"
        ? {
            ...emptyOrchestration(),
            rails: [
              {
                id: "r2",
                name: "deploy",
                position: 0,
                worktreePath: "/x/wt2",
                pageId: null,
                stages: [
                  {
                    id: "s2",
                    position: 0,
                    steps: [{ id: "u1", position: 0, cardPath: "", toolId: "builtin:push", toolParams: {} }],
                  },
                ],
              },
            ],
          }
        : {
            ...toolRail(),
            rails: toolRail().rails.map((r) => ({
              ...r,
              pageId: null,
              stages: [
                {
                  id: "s1",
                  position: 0,
                  steps: [
                    {
                      id: "t1",
                      position: 0,
                      cardPath: "",
                      toolId: "builtin:start-rail",
                      toolParams: { rail: "deploy", workspace: "ws-2" },
                    },
                  ],
                },
              ],
            })),
            railRuns: [{ railId: "r1", state: "running", currentStageId: "s1" }],
          }
    );
    __resetForTesting();
    setLayoutState({
      workspaces: [
        { id: "ws-1", pages: [] },
        { id: "ws-2", pages: [], rootPath: "/ws2" },
      ],
    });
    await fetchOrchestration("ws-1");
    toolRecords.set({ "ws-1": [], "ws-2": [] });

    // Not pre-fetched: the executor has to load ws-2's plan itself.
    expect(get(orchestrations)["ws-2"]).toBeUndefined();
    await executeActions("ws-1", [{ kind: "launch", stepId: "t1" }]);

    // Routed to the daemon that holds r2 -- ws-2's -- not to the workspace
    // whose action started it.
    expect(backend.setRailRun).toHaveBeenCalledWith("r2", "running", "s2", "ws-2");
    expect(get(orchestrations)["ws-2"].railRuns).toEqual([
      { railId: "r2", state: "running", currentStageId: "s2" },
    ]);
    // The calling step is done, on its OWN workspace -- arming another
    // workspace's rail must not be mistaken for this step's own launch.
    expect(backend.setStepRun).toHaveBeenCalledWith("t1", "done", null, null, null, null, null, "ws-1");
  });

  it("resuming a stalled step reopens it on the rail's page too", async () => {
    vi.mocked(layoutStateModule.resolvedAgentFor).mockReturnValueOnce({
      launchCommand: "claude",
      promptArgs: "",
      resumeArgs: "--resume",
      failurePatterns: [],
      failureCauses: [],
      sessionIdArgs: "--session-id",
    } as never);
    await setStepRunAction("ws-1", "t1", "stalled", "sess-1", "broke", "conv-1", "/x/wt");
    await setRailRunAction("ws-1", "r1", "paused", "s1");
    expect(await resumeStep("ws-1", "t1")).toBeNull();
    expect(layoutStateModule.createSessionOnNewPage).toHaveBeenCalledWith(
      ...pageArgs("claude --resume conv-1")
    );
  });
});

describe("executeActions", () => {
  beforeEach(async () => {
    vi.mocked(backend.getOrchestration).mockResolvedValue({
      ...boundRail(),
      railRuns: [{ railId: "r1", state: "running", currentStageId: "s1" }],
    });
    vi.mocked(backend.setRailRun).mockResolvedValue(undefined);
    vi.mocked(backend.setStepRun).mockResolvedValue(undefined);
    setRailPageLive();
    await fetchOrchestration("ws-1");
  });

  it("a stall records the reason and pauses the owning rail", async () => {
    await executeActions("ws-1", [{ kind: "stall", stepId: "t1", reason: "card file is missing" }]);
    expect(backend.setStepRun).toHaveBeenCalledWith("t1", "stalled", null, "card file is missing", null, null, null, "ws-1");
    expect(backend.setRailRun).toHaveBeenCalledWith("r1", "paused", "s1", "ws-1");
  });

  // Rule 5 stops a rail that is ADVANCING. A rail that is idle or paused
  // has nothing to stop, and a reconciling stall must not relabel a rail
  // nobody started as "paused".
  it("a stall on a rail that is not running leaves its state alone", async () => {
    await setRailRunAction("ws-1", "r1", "idle", null);
    vi.mocked(backend.setRailRun).mockClear();
    await executeActions("ws-1", [
      { kind: "stall", stepId: "t1", reason: "agent exited before the card reached Done" },
    ]);
    expect(backend.setStepRun).toHaveBeenCalledWith(
      "t1",
      "stalled",
      null,
      "agent exited before the card reached Done",
      null,
      null,
      null,
      "ws-1",
    );
    expect(backend.setRailRun).not.toHaveBeenCalled();
  });

  it("markDone keeps the session id so the transcript stays reachable", async () => {
    await setStepRunAction("ws-1", "t1", "running", "sess-1", null);
    await executeActions("ws-1", [{ kind: "markDone", stepId: "t1" }]);
    expect(backend.setStepRun).toHaveBeenLastCalledWith("t1", "done", "sess-1", null, null, null, null, "ws-1");
  });

  it("advance moves the rail's current stage", async () => {
    await executeActions("ws-1", [{ kind: "advance", railId: "r1", stageId: "s2" }]);
    expect(backend.setRailRun).toHaveBeenLastCalledWith("r1", "running", "s2", "ws-1");
  });

  it("complete returns the rail to idle", async () => {
    await executeActions("ws-1", [{ kind: "complete", railId: "r1" }]);
    expect(backend.setRailRun).toHaveBeenLastCalledWith("r1", "idle", null, "ws-1");
  });

  it("a step whose card is being DEVELOPED stalls instead of running the prompt it is replacing", async () => {
    // The rail's half of the develop lock. A stall, not a failure: the
    // sweep frees the card when the develop run ends and the rail picks
    // the step up on the next tick -- with the card the human asked for
    // rather than the thin one it was.
    layoutStateModule.layoutState.update((st) => ({
      ...st,
      // Only the two fields the develop lookup reads; the rest of a
      // Workspace is irrelevant to it.
      workspaces: [{ id: "ws-1", developingCards: [{ path: "/x/a.md", sessionId: "s-dev" }] }] as never,
    }));

    await executeActions("ws-1", [{ kind: "launch", stepId: "t1" }]);

    expect(backend.setStepRun).toHaveBeenCalledWith(
      "t1",
      "stalled",
      null,
      expect.stringContaining("being developed"),
      null,
      null,
      null,
      "ws-1",
    );
    expect(layoutStateModule.createSessionOnPage).not.toHaveBeenCalled();
    // The one launch stall that leaves its rail RUNNING, because it is
    // the one that clears itself: the sweep frees the card and the next
    // pass retries the step. Paused, it would wait on a human for a
    // lock nobody has to lift.
    expect(backend.setRailRun).not.toHaveBeenCalled();
  });

  it("a step whose card has a missing attachment stalls with the file named and pauses its rail, spawning nothing", async () => {
    // The rail's half of the run gate. The reason reaches the chip and
    // the rail stops -- launching with a dead path would carry the
    // damage into every later stage.
    cardAttachments.a = ["docs/spec.md"];
    vi.mocked(backend.attachmentStatus).mockResolvedValue([
      {
        path: "docs/spec.md",
        absolutePath: "/ws/docs/spec.md",
        exists: false,
        location: "root",
        refusedReason: null,
      },
    ]);

    await executeActions("ws-1", [{ kind: "launch", stepId: "t1" }]);

    expect(backend.setStepRun).toHaveBeenCalledWith(
      "t1",
      "stalled",
      null,
      expect.stringContaining("docs/spec.md"),
      null,
      null,
      null,
      "ws-1",
    );
    expect(backend.setRailRun).toHaveBeenCalledWith("r1", "paused", "s1", "ws-1");
    expect(layoutStateModule.createSessionOnPage).not.toHaveBeenCalled();
  });

  // What a launch stall used to add up to across passes. It left its
  // rail `running`: rule 5 pauses only on a stall nextActions decides,
  // and by the next pass this one reads as a stalled step on a running
  // rail, which rule 2 retries. So every emission of every scheduler
  // input re-checked the card's attachments and re-wrote the same
  // stall, under a rail header saying "running" about a rail that was
  // going nowhere -- Grimoria's Fixes rail, 2026-09-26.
  it("a launch that stalls is not retried by the passes after it", async () => {
    boardStore.set({
      "ws-1": {
        columns: [
          { id: "c0", name: "To Do", position: 0 },
          { id: "c1", name: "Done", position: 1 },
        ],
        labels: [],
        cardSessions: [],
      },
    });
    setLayoutState({
      workspaces: [{ id: "ws-1", pages: [{ id: "p1", name: "backend", layout: { type: "leaf", tabs: [] } }] }],
    });
    toolRecords.set({ "ws-1": [] });
    cardAttachments.a = ["docs/spec.md"];
    vi.mocked(backend.attachmentStatus).mockResolvedValue([
      {
        path: "docs/spec.md",
        absolutePath: "/x/wt/docs/spec.md",
        exists: false,
        location: "root",
        refusedReason: null,
      },
    ]);

    await tick("ws-1");
    await tick("ws-1");
    await tick("ws-1");

    expect(backend.attachmentStatus).toHaveBeenCalledTimes(1);
    expect(get(orchestrations)["ws-1"].railRuns).toEqual([
      { railId: "r1", state: "paused", currentStageId: "s1" },
    ]);
    expect(layoutStateModule.createSessionOnPage).not.toHaveBeenCalled();
  });

  it("a bound rail's step resolves its attachments against the worktree and puts those paths in the prompt", async () => {
    cardAttachments.a = ["docs/spec.md"];
    vi.mocked(backend.attachmentStatus).mockResolvedValue([
      {
        path: "docs/spec.md",
        absolutePath: "/x/wt/docs/spec.md",
        exists: true,
        location: "root",
        refusedReason: null,
      },
    ]);
    vi.mocked(backend.readFileForViewer).mockResolvedValue({
      content: "---\ntitle: Wire the API\n---\ndo the thing",
      truncated: false,
      exists: true,
    });
    vi.mocked(backend.setPlanFrontmatterField).mockImplementation(async (p) => p);
    vi.mocked(layoutStateModule.createSessionOnPage).mockResolvedValue("sess-9");

    await executeActions("ws-1", [{ kind: "launch", stepId: "t1" }]);

    // Resolved against the rail's worktree, the checkout the agent is
    // about to run in, not the workspace root: the rail was given a
    // worktree precisely so its agent works on files that differ from
    // the root's, and a card placed on it is about THAT checkout. The
    // root's copy is a file the agent is not editing.
    expect(backend.attachmentStatus).toHaveBeenCalledWith("/x/wt", ["docs/spec.md"]);
    const command = vi.mocked(layoutStateModule.createSessionOnPage).mock.calls[0][3] as string;
    expect(command).toContain("/x/wt/docs/spec.md");
  });

  it("an unbound rail's step still resolves its attachments against the workspace root", async () => {
    // No checkout of its own means its agent runs in the root, exactly
    // as a board Run's does -- so it reads the same files from the same
    // place a Run would.
    orchestrations.update((all) => ({
      ...all,
      "ws-1": {
        ...all["ws-1"],
        rails: all["ws-1"].rails.map((r) => ({ ...r, worktreePath: null })),
      },
    }));
    cardAttachments.a = ["docs/spec.md"];
    vi.mocked(backend.attachmentStatus).mockResolvedValue([
      {
        path: "docs/spec.md",
        absolutePath: "/ws/docs/spec.md",
        exists: true,
        location: "root",
        refusedReason: null,
      },
    ]);
    vi.mocked(backend.readFileForViewer).mockResolvedValue({
      content: "---\ntitle: Wire the API\n---\ndo the thing",
      truncated: false,
      exists: true,
    });
    vi.mocked(backend.setPlanFrontmatterField).mockImplementation(async (p) => p);
    vi.mocked(layoutStateModule.createSessionOnPage).mockResolvedValue("sess-9");

    await executeActions("ws-1", [{ kind: "launch", stepId: "t1" }]);

    expect(backend.attachmentStatus).toHaveBeenCalledWith("/ws", ["docs/spec.md"]);
    const command = vi.mocked(layoutStateModule.createSessionOnPage).mock.calls[0][3] as string;
    expect(command).toContain("/ws/docs/spec.md");
  });

  it("a bound rail launches on an attachment that exists only in its worktree, instead of stalling", async () => {
    // The case the gate used to get wrong: a file the rail's branch
    // ADDED. Stat'd against the root it does not exist, and the step
    // stalled before any session was spawned; stat'd against the
    // worktree it is there, and the step runs with it in the prompt.
    cardAttachments.a = ["app/src-tauri/src/agent_install.rs"];
    vi.mocked(backend.attachmentStatus).mockImplementation(async (root, paths) =>
      paths.map((path) => ({
        path,
        absolutePath: `${root}/${path}`,
        exists: root === "/x/wt",
        location: "root" as const,
        refusedReason: null,
      }))
    );
    vi.mocked(backend.readFileForViewer).mockResolvedValue({
      content: "---\ntitle: Wire the API\n---\ndo the thing",
      truncated: false,
      exists: true,
    });
    vi.mocked(backend.setPlanFrontmatterField).mockImplementation(async (p) => p);
    vi.mocked(layoutStateModule.createSessionOnPage).mockResolvedValue("sess-9");

    await executeActions("ws-1", [{ kind: "launch", stepId: "t1" }]);

    expect(backend.setStepRun).not.toHaveBeenCalledWith(
      "t1",
      "stalled",
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      "ws-1",
    );
    expect(layoutStateModule.createSessionOnPage).toHaveBeenCalledTimes(1);
    const command = vi.mocked(layoutStateModule.createSessionOnPage).mock.calls[0][3] as string;
    expect(command).toContain("/x/wt/app/src-tauri/src/agent_install.rs");
  });

  it("a launch that cannot create a session stalls the step instead of throwing", async () => {
    vi.mocked(backend.readFileForViewer).mockResolvedValue({
      content: "---\ntitle: Wire the API\n---\ndo the thing",
      truncated: false,
      exists: true,
    });
    vi.mocked(layoutStateModule.createSessionOnPage).mockResolvedValue(null);
    await executeActions("ws-1", [{ kind: "launch", stepId: "t1" }]);
    expect(backend.setStepRun).toHaveBeenCalledWith(
      "t1",
      "stalled",
      null,
      expect.stringContaining("could not start"),
      null,
      null,
      null,
      "ws-1",
    );
  });

  it("a launch names the tab from the card title, so a rail tab is never a bare session id", async () => {
    // Same reason as the tool step below: the tab has to say what it is
    // running before the agent has drawn a frame -- and the agent's own
    // gavin_name_session is the first thing to break when the gavin
    // tools are unreachable.
    vi.mocked(backend.readFileForViewer).mockResolvedValue({
      content: "---\ntitle: Wire the API\n---\ndo the thing",
      truncated: false,
      exists: true,
    });
    vi.mocked(backend.setPlanFrontmatterField).mockImplementation(async (p) => p);
    vi.mocked(layoutStateModule.createSessionOnPage).mockResolvedValue("sess-9");

    await executeActions("ws-1", [{ kind: "launch", stepId: "t1" }]);

    expect(layoutStateModule.setSessionName).toHaveBeenCalledWith("sess-9", "Wire the API");
  });

  it("a launch whose naming fails still records the run", async () => {
    vi.mocked(backend.readFileForViewer).mockResolvedValue({
      content: "---\ntitle: Wire the API\n---\ndo the thing",
      truncated: false,
      exists: true,
    });
    vi.mocked(backend.setPlanFrontmatterField).mockImplementation(async (p) => p);
    vi.mocked(layoutStateModule.createSessionOnPage).mockResolvedValue("sess-9");
    vi.mocked(layoutStateModule.setSessionName).mockRejectedValueOnce(new Error("nope"));

    await executeActions("ws-1", [{ kind: "launch", stepId: "t1" }]);

    expect(backend.setStepRun).toHaveBeenCalledWith("t1", "running", "sess-9", null, null, "/x/wt", 0, "ws-1");
  });

  it("a launch binds the card session, records the session id, and writes In Progress", async () => {
    vi.mocked(backend.readFileForViewer).mockResolvedValue({
      content: "---\ntitle: Wire the API\n---\ndo the thing",
      truncated: false,
      exists: true,
    });
    vi.mocked(backend.setPlanFrontmatterField).mockImplementation(async (p) => p);
    vi.mocked(layoutStateModule.createSessionOnPage).mockResolvedValue("sess-9");
    await executeActions("ws-1", [{ kind: "launch", stepId: "t1" }]);

    expect(layoutStateModule.createSessionOnPage).toHaveBeenCalledWith(
      "ws-1",
      "p1",
      "/x/wt",
      expect.stringContaining("claude ")
    );
    expect(kanbanStateModule.linkCardSessionAction).toHaveBeenCalledWith("ws-1", {
      path: "/x/a.md",
      sessionId: "sess-9",
      cwd: "/x/wt",
      command: expect.stringContaining("claude "),
      // No conversation id: the mocked profile verifies no `--session-id`
      // argv. `launchCwd` is recorded regardless -- it is what a resume
      // would need, and unlike `cwd` it never drifts.
      conversationId: null,
      launchCwd: "/x/wt",
      // The commit the rail's checkout was on before the step ran. Null
      // here for the same reason as the id above: the mocked launch
      // resolves none (no repo, or a daemon too old to keep it).
      baseSha: null,
    });
    expect(backend.setStepRun).toHaveBeenCalledWith("t1", "running", "sess-9", null, null, "/x/wt", 0, "ws-1");
    expect(backend.setPlanFrontmatterField).toHaveBeenCalledWith("/x/a.md", "status", "In Progress");
  });

  /// A rail step is a card run like any other, so it records the same
  /// baseline -- resolved in the RAIL's checkout, which is what makes a
  /// per-run diff worth having at all: several rails edit several
  /// worktrees at once and the workspace Git tab shows one of them.
  it("a launch records the baseline of the rail's own checkout, before the session", async () => {
    const BASE = "4444444444444444444444444444444444444444";
    vi.mocked(backend.readFileForViewer).mockResolvedValue({
      content: "---\ntitle: Wire the API\n---\ndo the thing",
      truncated: false,
      exists: true,
    });
    vi.mocked(backend.setPlanFrontmatterField).mockImplementation(async (p) => p);
    vi.mocked(layoutStateModule.baseShaForLaunch).mockResolvedValue(BASE);
    vi.mocked(layoutStateModule.createSessionOnPage).mockResolvedValue("sess-9");

    await executeActions("ws-1", [{ kind: "launch", stepId: "t1" }]);

    expect(layoutStateModule.baseShaForLaunch).toHaveBeenCalledWith("/x/wt");
    // Before the agent exists: a sha resolved afterwards would already
    // carry whatever it had done by then.
    expect(vi.mocked(layoutStateModule.baseShaForLaunch).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(layoutStateModule.createSessionOnPage).mock.invocationCallOrder[0]
    );
    expect(kanbanStateModule.linkCardSessionAction).toHaveBeenCalledWith(
      "ws-1",
      expect.objectContaining({ baseSha: BASE })
    );
  });
});

// ---- the loop-until step ----------------------------------------------------
// The pure half is orchestrationLoop.test.ts. This is the executor: what
// actually gets written when a check fails, which is the half a source
// grep cannot check.

/// A card step, then the check that guards it.
function loopRailPlan(untilParams: Record<string, string> = {}): Orchestration {
  return {
    ...emptyOrchestration(),
    rails: [
      {
        id: "r1",
        name: "backend",
        position: 0,
        worktreePath: "/x/wt",
        pageId: "p1",
        stages: [
          {
            id: "s0",
            position: 0,
            steps: [{ id: "work", position: 0, cardPath: "/x/a.md", toolId: null }],
          },
          {
            id: "s1",
            position: 1,
            steps: [
              { id: "check", position: 0, cardPath: "", toolId: "builtin:until", toolParams: untilParams },
            ],
          },
        ],
      },
    ],
    railRuns: [{ railId: "r1", state: "running", currentStageId: "s1" }],
    stepRuns: [
      { stepId: "work", state: "done", sessionId: "sess-w", reason: null },
      { stepId: "check", state: "running", sessionId: "sess-c", reason: null },
    ],
  };
}

describe("a loop-until step's executor", () => {
  const CHECK_LOG = "/tmp/gavin-until-check.log";

  beforeEach(async () => {
    __resetForTesting();
    toolsResetForTesting();
    vi.clearAllMocks();
    vi.mocked(backend.setStepRun).mockResolvedValue(undefined);
    vi.mocked(backend.setRailRun).mockResolvedValue(undefined);
    vi.mocked(layoutStateModule.setSessionName).mockResolvedValue(undefined);
    vi.mocked(layoutStateModule.createSessionOnPage).mockResolvedValue("sess-new");
    // The card body FileEditor read, and the check's log, from one mock.
    vi.mocked(backend.readFileForViewer).mockImplementation(async (path: string) => ({
      exists: true,
      truncated: false,
      content: path === CHECK_LOG ? "FAIL src/x.test.ts\n1 failing test\n" : "# a card",
    }));
    vi.mocked(backend.getOrchestration).mockResolvedValue(loopRailPlan());
    setRailPageLive();
    await fetchOrchestration("ws-1");
    toolRecords.set({ "ws-1": [] });
  });

  it("runs the check as a visible session on the rail's page, capturing its output", async () => {
    await setStepRunAction("ws-1", "check", "pending", null, null);
    vi.mocked(backend.setStepRun).mockClear();
    await executeActions("ws-1", [{ kind: "launch", stepId: "check" }]);
    const command = vi.mocked(layoutStateModule.createSessionOnPage).mock.calls[0][3] as string;
    expect(command).toContain("set -o pipefail");
    // The whole script is single-quoted into `bash -c`, so the log
    // path's own quotes arrive as `'\''` -- the path itself is what
    // matters here.
    expect(command).toContain(`tee '\\''${CHECK_LOG}`);
    expect(command).toContain("npm test");
    // The whole point of the wrapper: the pipeline's status is the
    // check's, so the epilogue reports the real code.
    expect(command).toContain('exit "$__gavin_code"');
  });

  // Every other launch writes 0 here. The same field holds this step's
  // LOOP budget, so zeroing it would make the budget unspendable.
  it("preserves the loop budget across the check's own relaunches", async () => {
    await setStepRunAction("ws-1", "check", "pending", null, null);
    vi.mocked(backend.setStepRun).mockClear();
    await executeActions("ws-1", [{ kind: "launch", stepId: "check" }]);
    expect(backend.setStepRun).toHaveBeenLastCalledWith(
      "check", "running", "sess-new", null, null, "/x/wt", null,
      "ws-1",
    );
  });

  it("re-arms both steps and points the rail back at the work's stage", async () => {
    const again = await executeActions("ws-1", [
      { kind: "loopBack", stepId: "check", previousStepId: "work", attempt: 1, max: 5 },
    ]);
    // The check carries the count -- that pair is what says a loop is in
    // flight, and what the re-armed step's launch reads.
    expect(backend.setStepRun).toHaveBeenCalledWith("check", "pending", null, null, null, null, 1, "ws-1");
    // The work's own count is left alone; its launch zeroes it anyway.
    expect(backend.setStepRun).toHaveBeenCalledWith("work", "pending", null, null, null, null, null, "ws-1");
    expect(backend.setRailRun).toHaveBeenCalledWith("r1", "running", "s0", "ws-1");
    // Never paused: a rail that pauses itself every time a test fails is
    // a rail that never retries anything.
    expect(backend.setRailRun).not.toHaveBeenCalledWith("r1", "paused", expect.anything(), "ws-1");
    // The pass that scheduled the loop-back stopped there, so nothing
    // has launched the re-armed step yet.
    expect(again).toBe(true);
  });

  // Rule 1 files a card step done on sight when its card is in the done
  // column -- before rule 2 could ever launch it. A loop that re-armed
  // such a step would spend its whole budget without re-running anything.
  it("takes a re-run card back out of the done column", async () => {
    boardStore.set({ "ws-1": { columns: [{ id: "c0", name: "To Do", position: 0 }, { id: "c1", name: "Done", position: 1 }], labels: [], cardSessions: [] } });
    cardStatus.a = "Done";
    await executeActions("ws-1", [
      { kind: "loopBack", stepId: "check", previousStepId: "work", attempt: 1, max: 5 },
    ]);
    expect(backend.setPlanFrontmatterField).toHaveBeenCalledWith("/x/a.md", "status", "In Progress");
    expect(gavinState.patchPlanField).toHaveBeenCalledWith("ws-1", "/x/a.md", "status", "In Progress");
  });

  it("leaves a card that is not finished exactly where it is", async () => {
    boardStore.set({ "ws-1": { columns: [{ id: "c0", name: "To Do", position: 0 }, { id: "c1", name: "Done", position: 1 }], labels: [], cardSessions: [] } });
    await executeActions("ws-1", [
      { kind: "loopBack", stepId: "check", previousStepId: "work", attempt: 1, max: 5 },
    ]);
    expect(backend.setPlanFrontmatterField).not.toHaveBeenCalled();
  });

  it("stalls with the check's own last words when the budget is spent", async () => {
    await executeActions("ws-1", [{ kind: "loopExhausted", stepId: "check", max: 2 }]);
    expect(backend.setStepRun).toHaveBeenCalledWith(
      "check",
      "stalled",
      null,
      "the check still failed after 2 retries — FAIL src/x.test.ts\n1 failing test",
      null,
      null,
      // Zeroed as it stalls: rule 2 retries a stalled step when the run
      // reaches it again, and a spent count would give up at once.
      0,
      "ws-1",
    );
    expect(backend.setRailRun).toHaveBeenCalledWith("r1", "paused", "s1", "ws-1");
  });

  // The re-armed agent has to be told what failed, or it writes the same
  // code again. Derived from the run rows and the log on disk, never
  // from a note held between the two ticks.
  it("opens the re-run card's prompt with the failure", async () => {
    await mutateRunState_loopMidFlight();
    await executeActions("ws-1", [{ kind: "launch", stepId: "work" }]);
    const command = vi.mocked(layoutStateModule.createSessionOnPage).mock.calls[0][3] as string;
    expect(command).toContain("The previous attempt failed this check:");
    expect(command).toContain("1 failing test");
    expect(command).toContain("Fix it, then finish.");
    // ...and the card's own prompt is still in there, after it.
    expect(command).toContain("/x/a.md");
  });

  // A shell step is simply re-run. Pasting a paragraph of test output in
  // front of a bash body would not retry the step, it would break it.
  it("re-runs a shell step with its command line untouched", async () => {
    const plan = loopRailPlan();
    vi.mocked(backend.getOrchestration).mockResolvedValue({
      ...plan,
      rails: [
        {
          ...plan.rails[0],
          stages: [
            {
              ...plan.rails[0].stages[0],
              steps: [
                { id: "work", position: 0, cardPath: "", toolId: "builtin:push", toolParams: {} },
              ],
            },
            plan.rails[0].stages[1],
          ],
        },
      ],
    });
    __resetForTesting();
    await fetchOrchestration("ws-1");
    toolRecords.set({ "ws-1": [] });
    await mutateRunState_loopMidFlight();
    await executeActions("ws-1", [{ kind: "launch", stepId: "work" }]);
    const command = vi.mocked(layoutStateModule.createSessionOnPage).mock.calls[0][3] as string;
    expect(command).toContain("git push -u origin HEAD");
    expect(command).not.toContain("The previous attempt failed this check:");
  });

  it("leaves a first run's prompt alone", async () => {
    await setStepRunAction("ws-1", "work", "pending", null, null, null, null, 0);
    await setStepRunAction("ws-1", "check", "pending", null, null, null, null, 0);
    await executeActions("ws-1", [{ kind: "launch", stepId: "work" }]);
    const command = vi.mocked(layoutStateModule.createSessionOnPage).mock.calls[0][3] as string;
    expect(command).not.toContain("The previous attempt failed this check:");
  });

  /// The state executeLoopBack leaves behind: both steps pending, the
  /// count on the check's row.
  async function mutateRunState_loopMidFlight(): Promise<void> {
    await setStepRunAction("ws-1", "work", "pending", null, null);
    await setStepRunAction("ws-1", "check", "pending", null, null, null, null, 1);
  }
});

// ---- the pull-request wait step ---------------------------------------------
// The pure halves are pullRequest.test.ts (what a report MEANS) and
// orchestration.test.ts (which action each verdict produces). This is
// the executor: what is actually written, and what the re-run's prompt
// gets handed -- the half a source grep cannot check.

/// A card step, then the wait on the pull request for the rail's branch.
function prRailPlan(): Orchestration {
  return {
    ...emptyOrchestration(),
    rails: [
      {
        id: "r1",
        name: "backend",
        position: 0,
        worktreePath: "/x/wt",
        branch: "feat/x",
        pageId: "p1",
        stages: [
          {
            id: "s0",
            position: 0,
            steps: [{ id: "work", position: 0, cardPath: "/x/a.md", toolId: null }],
          },
          {
            id: "s1",
            position: 1,
            steps: [{ id: "wait", position: 0, cardPath: "", toolId: "builtin:await-pr" }],
          },
        ],
      },
    ],
    railRuns: [{ railId: "r1", state: "running", currentStageId: "s1" }],
    stepRuns: [
      { stepId: "work", state: "done", sessionId: "sess-w", reason: null },
      { stepId: "wait", state: "pending", sessionId: null, reason: null },
    ],
  };
}

function prReport(checks: Array<{ name: string; state: string }>) {
  return {
    state: "ready" as const,
    number: 9,
    url: "https://example.test/pr/9",
    title: "t",
    prState: "OPEN",
    isDraft: false,
    reviewDecision: "",
    mergeable: "MERGEABLE",
    createdAt: 0,
    checks: checks.map((c) => ({ ...c, url: "" })),
    observedAt: 1000,
    cached: false,
  } as PrReport;
}

describe("a pull-request wait step's executor", () => {
  beforeEach(async () => {
    __resetForTesting();
    toolsResetForTesting();
    prResetForTesting();
    vi.clearAllMocks();
    vi.mocked(backend.setStepRun).mockResolvedValue(undefined);
    vi.mocked(backend.setRailRun).mockResolvedValue(undefined);
    vi.mocked(layoutStateModule.setSessionName).mockResolvedValue(undefined);
    vi.mocked(layoutStateModule.createSessionOnPage).mockResolvedValue("sess-new");
    vi.mocked(backend.readFileForViewer).mockResolvedValue({
      exists: true,
      truncated: false,
      content: "# a card",
    });
    vi.mocked(backend.getOrchestration).mockResolvedValue(prRailPlan());
    setRailPageLive();
    await fetchOrchestration("ws-1");
    toolRecords.set({ "ws-1": [] });
  });

  afterEach(() => prResetForTesting());

  /// The difference from every other tool kind, and the reason `pr` is a
  /// kind: it starts nothing, and it still goes `running`. A `gavin`
  /// action resolves inside its own launch and so could never wait.
  it("starts no session and leaves the step running with none", async () => {
    await executeActions("ws-1", [{ kind: "launch", stepId: "wait" }]);
    expect(layoutStateModule.createSessionOnPage).not.toHaveBeenCalled();
    expect(backend.setStepRun).toHaveBeenLastCalledWith(
      "wait", "running", null, null, null, null, null,
      "ws-1",
    );
  });

  /// The same field carries the loop budget, so zeroing it at launch
  /// would make the budget unspendable and the loop unbounded.
  it("preserves the loop budget across its own relaunches", async () => {
    await executeActions("ws-1", [{ kind: "launch", stepId: "wait" }]);
    const last = vi.mocked(backend.setStepRun).mock.calls.at(-1);
    // resumeAttempts is the seventh argument; the workspace id follows it.
    expect(last?.[6]).toBeNull();
  });

  /// A pull request belongs to a branch. Waiting on one an unbound rail
  /// cannot have is not slow, it is meaningless -- and it would sit
  /// `running` with nothing able to end it.
  it("refuses to launch on a rail that binds no branch", async () => {
    const plan = prRailPlan();
    vi.mocked(backend.getOrchestration).mockResolvedValue({
      ...plan,
      rails: [{ ...plan.rails[0], branch: null }],
    });
    __resetForTesting();
    await fetchOrchestration("ws-1");
    toolRecords.set({ "ws-1": [] });
    await executeActions("ws-1", [{ kind: "launch", stepId: "wait" }]);
    expect(backend.setStepRun).toHaveBeenCalledWith(
      "wait", "stalled", null,
      "this rail binds no branch, so there is no pull request to wait for",
      null, null, null,
      "ws-1",
    );
  });

  /// What the whole loop is for: the re-run opens with what GitHub said,
  /// derived from the live report rather than remembered -- so an app
  /// reload between the re-arm and the launch changes nothing.
  it("opens the re-run's prompt with the failing checks", async () => {
    prReports.set({ [prKey("/x/wt", "feat/x")]: prReport([{ name: "build", state: "failure" }]) });
    // The state executeLoopBack leaves behind: both pending, the count
    // on the wait step's own row.
    await setStepRunAction("ws-1", "work", "pending", null, null);
    await setStepRunAction("ws-1", "wait", "pending", null, null, null, null, 1);
    vi.mocked(backend.setStepRun).mockClear();

    await executeActions("ws-1", [{ kind: "launch", stepId: "work" }]);
    const command = vi.mocked(layoutStateModule.createSessionOnPage).mock.calls[0][3] as string;
    expect(command).toContain("build");
    expect(command).toContain("#9");
  });

  /// Not mid-loop: the wait step has spent no retries, so this launch is
  /// the first attempt and its prompt must stay byte-identical.
  it("leaves an ordinary launch's prompt alone", async () => {
    prReports.set({ [prKey("/x/wt", "feat/x")]: prReport([{ name: "build", state: "failure" }]) });
    await setStepRunAction("ws-1", "work", "pending", null, null);
    await executeActions("ws-1", [{ kind: "launch", stepId: "work" }]);
    const command = vi.mocked(layoutStateModule.createSessionOnPage).mock.calls[0][3] as string;
    expect(command).not.toContain("failing");
  });

  /// The reason has to quote what failed, and this verdict was reached by
  /// reading GitHub -- so unlike an until step's, there is no log on disk
  /// and the note travels with the action.
  it("stalls with the failing checks when the budget is spent", async () => {
    await executeActions("ws-1", [
      { kind: "loopExhausted", stepId: "wait", max: 3, note: "1 check is failing on pull request #9:\n- build" },
    ]);
    const stall = vi
      .mocked(backend.setStepRun)
      .mock.calls.find((c) => c[1] === "stalled");
    expect(stall?.[3]).toBe(
      "the pull request still was not ready after 3 retries — 1 check is failing on pull request #9:"
    );
    // The budget is zeroed as it stalls, so a later Resume gets a fresh
    // one rather than giving up on its first look.
    expect(stall?.[6]).toBe(0);
  });
});

// ---- the manual-review gate --------------------------------------------------
// The `pr` step's sibling, with a PERSON in place of GitHub. The pure
// half is orchestration.test.ts (the scheduler emits nothing for it);
// this is the executor -- what a launch actually writes, and what it
// tells the human, neither of which a source grep can check.

/// A card step, then the gate that holds the rail, then more work.
function reviewRailPlan(): Orchestration {
  return {
    ...emptyOrchestration(),
    rails: [
      {
        id: "r1",
        name: "backend",
        position: 0,
        worktreePath: "/x/wt",
        branch: null,
        pageId: "p1",
        stages: [
          {
            id: "s0",
            position: 0,
            steps: [{ id: "work", position: 0, cardPath: "/x/a.md", toolId: null }],
          },
          {
            id: "s1",
            position: 1,
            steps: [{ id: "gate", position: 0, cardPath: "", toolId: "builtin:manual-review" }],
          },
        ],
      },
    ],
    railRuns: [{ railId: "r1", state: "running", currentStageId: "s1" }],
    stepRuns: [
      { stepId: "work", state: "done", sessionId: "sess-w", reason: null },
      { stepId: "gate", state: "pending", sessionId: null, reason: null },
    ],
  };
}

describe("a manual-review gate's executor", () => {
  beforeEach(async () => {
    __resetForTesting();
    toolsResetForTesting();
    vi.clearAllMocks();
    vi.mocked(backend.setStepRun).mockResolvedValue(undefined);
    vi.mocked(backend.setRailRun).mockResolvedValue(undefined);
    vi.mocked(layoutStateModule.createSessionOnPage).mockResolvedValue("sess-new");
    vi.mocked(backend.getOrchestration).mockResolvedValue(reviewRailPlan());
    setRailPageLive();
    await fetchOrchestration("ws-1");
    toolRecords.set({ "ws-1": [] });
  });

  /// Same shape as the pull-request wait, and for the same reason:
  /// waiting is a STATE, so the step goes `running` with no session
  /// rather than resolving inside its own launch the way a `gavin`
  /// action does.
  it("starts no session and leaves the step running with none", async () => {
    await executeActions("ws-1", [{ kind: "launch", stepId: "gate" }]);
    expect(layoutStateModule.createSessionOnPage).not.toHaveBeenCalled();
    expect(backend.setStepRun).toHaveBeenLastCalledWith(
      "gate", "running", null, null, null, null, 0,
      "ws-1",
    );
  });

  /// The difference from the `pr` step's launch, which passes null to
  /// protect a loop budget in the same field. This step neither loops
  /// nor auto-resumes, so a count left over from a previous run would
  /// make the rail header claim a retry that is not happening.
  it("starts from a clean resume count, unlike a looping step", async () => {
    await executeActions("ws-1", [{ kind: "launch", stepId: "gate" }]);
    expect(vi.mocked(backend.setStepRun).mock.calls.at(-1)?.[6]).toBe(0);
  });

  /// A rail can be running unattended on a tab nobody is watching, and a
  /// gate that summons nobody stops the rail until somebody happens to
  /// look. Names the rail and the step, because a fleet can have several
  /// stopped at once.
  it("tells the human the rail is waiting on them", async () => {
    await executeActions("ws-1", [{ kind: "launch", stepId: "gate" }]);
    expect(maybeNotifyReviewWait).toHaveBeenCalledWith(
      "backend",
      "Manual review",
      expect.objectContaining({ needsInput: true })
    );
  });

  /// Nothing about a review needs a branch or a worktree: it is a hold
  /// on the rail. Refusing an unbound rail would be a refusal about
  /// something the step was never going to touch -- and `reviewRailPlan`
  /// binds no branch precisely so this is asserted rather than assumed.
  it("holds an unbound rail just the same", async () => {
    await executeActions("ws-1", [{ kind: "launch", stepId: "gate" }]);
    const stalls = vi.mocked(backend.setStepRun).mock.calls.filter((c) => c[1] === "stalled");
    expect(stalls).toEqual([]);
  });

  /// The human's move, and the whole of "and proceed": the gate is
  /// skipped and the rail carries on to the stage after it.
  it("is ended by Skip, which files it skipped and lets the rail move on", async () => {
    await executeActions("ws-1", [{ kind: "launch", stepId: "gate" }]);
    vi.mocked(backend.setStepRun).mockClear();
    await skipStep("ws-1", "gate");
    expect(backend.setStepRun).toHaveBeenCalledWith(
      "gate", "skipped", null, null, null, null, null,
      "ws-1",
    );
  });

  /// The other honest answer: the human looked, the work was right, and
  /// "done" says so where "skipped" would not.
  it("is ended by Mark done as well, for a review that passed", async () => {
    await executeActions("ws-1", [{ kind: "launch", stepId: "gate" }]);
    vi.mocked(backend.setStepRun).mockClear();
    await markStepDone("ws-1", "gate");
    expect(backend.setStepRun).toHaveBeenCalledWith("gate", "done", null, null, null, null, null, "ws-1");
  });
});

/// Critical review on the rail: N reviewers via the shared launch, step
/// left running with no single sessionId (scheduler reads criticalReviewRuns).
function critiqueRailPlan(): Orchestration {
  return {
    ...emptyOrchestration(),
    rails: [
      {
        id: "r1",
        name: "backend",
        position: 0,
        worktreePath: "/x/wt",
        branch: null,
        pageId: "p1",
        stages: [
          {
            id: "s0",
            position: 0,
            steps: [{ id: "crit", position: 0, cardPath: "", toolId: "builtin:critical-review" }],
          },
        ],
      },
    ],
    railRuns: [{ railId: "r1", state: "running", currentStageId: "s0" }],
    stepRuns: [{ stepId: "crit", state: "pending", sessionId: null, reason: null }],
  };
}

describe("a critical-review step's executor", () => {
  beforeEach(async () => {
    __resetForTesting();
    toolsResetForTesting();
    vi.clearAllMocks();
    vi.mocked(backend.setStepRun).mockResolvedValue(undefined);
    vi.mocked(backend.setRailRun).mockResolvedValue(undefined);
    vi.mocked(backend.getOrchestration).mockResolvedValue(critiqueRailPlan());
    setRailPageLive();
    await fetchOrchestration("ws-1");
    toolRecords.set({ "ws-1": [] });
  });

  it("launches N reviewers through the shared critical-review path", async () => {
    const { launchCriticalReviewSessions } = await import("$lib/review/criticalReviewActions");
    await executeActions("ws-1", [{ kind: "launch", stepId: "crit" }]);
    expect(launchCriticalReviewSessions).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "ws-1",
        cwd: "/x/wt",
        railId: "r1",
        stepId: "crit",
        alsoBuildFindingsRail: false,
        switchToTerminal: false,
      })
    );
    const reviewers = vi.mocked(launchCriticalReviewSessions).mock.calls[0][0].reviewers;
    expect(reviewers.length).toBeGreaterThanOrEqual(2);
    expect(backend.setStepRun).toHaveBeenLastCalledWith(
      "crit",
      "running",
      null,
      null,
      null,
      "/x/wt",
      0,
      "ws-1",
    );
  });

  it("stalls with the launch error when reviewers cannot start", async () => {
    const { launchCriticalReviewSessions } = await import("$lib/review/criticalReviewActions");
    vi.mocked(launchCriticalReviewSessions).mockResolvedValueOnce("need two reviewers");
    await executeActions("ws-1", [{ kind: "launch", stepId: "crit" }]);
    expect(backend.setStepRun).toHaveBeenLastCalledWith(
      "crit",
      "stalled",
      null,
      "need two reviewers",
      null,
      null,
      null,
      "ws-1",
    );
  });
});

describe("moveRailCardsAction", () => {
  /// A rail over the one card the mocked tree knows (/x/a.md, "To Do"),
  /// a card it does NOT (/x/gone.md), and a tool step.
  function mixedRail(): Orchestration {
    return {
      ...emptyOrchestration(),
      rails: [
        {
          id: "r1",
          name: "r1",
          position: 0,
          worktreePath: null,
          pageId: null,
          stages: [
            {
              id: "s1",
              position: 0,
              steps: [
                { id: "t1", position: 0, cardPath: "/x/a.md" },
                { id: "t2", position: 1, cardPath: "/x/gone.md" },
              ],
            },
            {
              id: "s2",
              position: 1,
              steps: [{ id: "t3", position: 0, cardPath: "", toolId: "builtin:push" }],
            },
          ],
        },
      ],
    };
  }

  beforeEach(() => {
    orchestrations.set({ "ws-1": mixedRail() });
  });

  it("writes the column to every card the tree resolves, and patches each", async () => {
    vi.mocked(backend.setPlanFrontmatterField).mockImplementation(async (p) => p);
    expect(await moveRailCardsAction("ws-1", "r1", "Done")).toBeNull();
    expect(vi.mocked(backend.setPlanFrontmatterField).mock.calls).toEqual([
      ["/x/a.md", "status", "Done"],
    ]);
    expect(gavinState.patchPlanField).toHaveBeenCalledWith("ws-1", "/x/a.md", "status", "Done");
  });

  it("writes nothing when every card is already in that column", async () => {
    expect(await moveRailCardsAction("ws-1", "r1", "To Do")).toBeNull();
    expect(backend.setPlanFrontmatterField).not.toHaveBeenCalled();
  });

  it("names the file that refused and stops there", async () => {
    vi.mocked(backend.setPlanFrontmatterField).mockRejectedValue(new Error("read-only"));
    expect(await moveRailCardsAction("ws-1", "r1", "Done")).toBe(
      "Couldn't move a.md to Done: read-only"
    );
    expect(gavinState.patchPlanField).not.toHaveBeenCalled();
  });

  it("is a no-op for an unknown rail", async () => {
    expect(await moveRailCardsAction("ws-1", "nope", "Done")).toBeNull();
    expect(backend.setPlanFrontmatterField).not.toHaveBeenCalled();
  });

  // Filing a whole rail into Done is the bulk version of the drag that
  // used to sweep nested tasks away without saying so (cardCompletion.ts).
  describe("a rail carrying a plan with nested tasks", () => {
    beforeEach(() => {
      boardStore.set({
        "ws-1": {
          columns: [
            { id: "c1", name: "To Do", position: 0 },
            { id: "c2", name: "Done", position: 1 },
          ],
          labels: [],
          cardSessions: [],
        },
      });
      extraPlans.list = [
        {
          path: "/x/plan.md",
          fileName: "plan.md",
          title: "File explorer",
          status: "To Do",
          priority: null,
          order: null,
          kind: "plan",
          parent: null,
          labels: [],
          checklistDone: 0,
          checklistTotal: 0,
          parseWarning: false,
        },
        {
          path: "/x/lens.md",
          fileName: "lens.md",
          title: "Tree lens",
          status: null,
          priority: null,
          order: null,
          kind: "task",
          parent: "plan.md",
          labels: [],
          checklistDone: 0,
          checklistTotal: 0,
          parseWarning: false,
        },
      ];
      orchestrations.set({
        "ws-1": {
          ...emptyOrchestration(),
          rails: [
            {
              id: "r1",
              name: "r1",
              position: 0,
              worktreePath: null,
              pageId: null,
              stages: [
                {
                  id: "s1",
                  position: 0,
                  steps: [
                    { id: "t1", position: 0, cardPath: "/x/plan.md" },
                    { id: "t2", position: 1, cardPath: "/x/a.md" },
                  ],
                },
              ],
            },
          ],
        },
      });
    });

    it("asks about the plan, naming the task that would travel with it", async () => {
      vi.mocked(backend.setPlanFrontmatterField).mockImplementation(async (p) => p);
      vi.mocked(askConfirmChecked).mockResolvedValue({ confirmed: true, checked: false });
      expect(await moveRailCardsAction("ws-1", "r1", "Done")).toBeNull();
      expect(vi.mocked(askConfirmChecked).mock.calls[0][0].lines).toContain("“Tree lens”");
      expect(vi.mocked(backend.setPlanFrontmatterField).mock.calls).toEqual([
        ["/x/plan.md", "status", "Done"],
        ["/x/a.md", "status", "Done"],
      ]);
    });

    // Declining is about THAT card. The rail's other cards were never
    // what the question was about, and leaving them unfiled would make
    // one "no" undo the whole gesture.
    it("skips only the declined card and files the rest", async () => {
      vi.mocked(backend.setPlanFrontmatterField).mockImplementation(async (p) => p);
      vi.mocked(askConfirmChecked).mockResolvedValue({ confirmed: false, checked: false });
      expect(await moveRailCardsAction("ws-1", "r1", "Done")).toBeNull();
      expect(vi.mocked(backend.setPlanFrontmatterField).mock.calls).toEqual([
        ["/x/a.md", "status", "Done"],
      ]);
    });

    it("breaks the nested task out into the first column when the box is ticked", async () => {
      vi.mocked(backend.setPlanFrontmatterField).mockImplementation(async (p) => p);
      vi.mocked(askConfirmChecked).mockResolvedValue({ confirmed: true, checked: true });
      expect(await moveRailCardsAction("ws-1", "r1", "Done")).toBeNull();
      expect(vi.mocked(backend.setPlanFrontmatterField).mock.calls).toEqual([
        ["/x/lens.md", "status", "To Do"],
        ["/x/plan.md", "status", "Done"],
        ["/x/a.md", "status", "Done"],
      ]);
    });
  });
});

describe("clearDoneStepsAction", () => {
  /// Three sequential stages over the one card the mocked tree knows,
  /// so every step here is a card step the board could also finish.
  function threeStages(): Orchestration {
    return {
      ...emptyOrchestration(),
      rails: [
        {
          id: "r1",
          name: "backend",
          position: 0,
          worktreePath: "/x/wt",
          pageId: "p1",
          stages: [
            { id: "s1", position: 0, steps: [{ id: "t1", position: 0, cardPath: "/x/a.md" }] },
            { id: "s2", position: 1, steps: [{ id: "t2", position: 0, cardPath: "/x/b.md" }] },
            { id: "s3", position: 2, steps: [{ id: "t3", position: 0, cardPath: "/x/c.md" }] },
          ],
        },
      ],
    };
  }

  function done(...stepIds: string[]): Orchestration["stepRuns"] {
    return stepIds.map((stepId) => ({ stepId, state: "done" as const, sessionId: null, reason: null }));
  }

  beforeEach(() => {
    vi.mocked(backend.setOrchestration).mockResolvedValue(undefined);
    vi.mocked(backend.setRailRun).mockResolvedValue(undefined);
    orchestrations.set({ "ws-1": { ...threeStages(), stepRuns: done("t1", "t2") } });
  });

  it("takes the done steps off the rail and drops the stages they emptied", async () => {
    expect(await clearDoneStepsAction("ws-1", "r1")).toBeNull();
    const rails = vi.mocked(backend.setOrchestration).mock.calls[0][1] as Rail[];
    expect(rails[0].stages.map((s) => [s.id, s.position])).toEqual([["s3", 0]]);
    expect(get(orchestrations)["ws-1"].stepRuns).toEqual([]);
  });

  it("writes nothing when the rail has no done steps", async () => {
    orchestrations.set({ "ws-1": threeStages() });
    expect(await clearDoneStepsAction("ws-1", "r1")).toBeNull();
    expect(backend.setOrchestration).not.toHaveBeenCalled();
  });

  it("is a no-op for an unknown rail", async () => {
    expect(await clearDoneStepsAction("ws-1", "nope")).toBeNull();
    expect(backend.setOrchestration).not.toHaveBeenCalled();
  });

  // The daemon refuses a plan write that drops a running step, so the
  // clear leaves it -- and the stage it stands in -- exactly where it is.
  it("leaves a running step on the rail", async () => {
    orchestrations.set({
      "ws-1": {
        ...threeStages(),
        stepRuns: [
          ...done("t1"),
          { stepId: "t2", state: "running", sessionId: "sess-1", reason: null },
        ],
      },
    });
    expect(await clearDoneStepsAction("ws-1", "r1")).toBeNull();
    const rails = vi.mocked(backend.setOrchestration).mock.calls[0][1] as Rail[];
    expect(rails[0].stages.map((s) => s.id)).toEqual(["s2", "s3"]);
  });

  // Cleared out from under a running rail, `currentStageId` would name a
  // stage that no longer exists and the next tick would call the rail
  // complete.
  it("repoints a running rail whose current stage was cleared away", async () => {
    orchestrations.set({
      "ws-1": {
        ...threeStages(),
        stepRuns: done("t1", "t2"),
        railRuns: [{ railId: "r1", state: "running", currentStageId: "s2" }],
      },
    });
    expect(await clearDoneStepsAction("ws-1", "r1")).toBeNull();
    expect(backend.setRailRun).toHaveBeenCalledWith("r1", "running", "s3", "ws-1");
  });

  it("leaves a current stage that survived the clear alone", async () => {
    orchestrations.set({
      "ws-1": {
        ...threeStages(),
        stepRuns: done("t1"),
        railRuns: [{ railId: "r1", state: "running", currentStageId: "s2" }],
      },
    });
    expect(await clearDoneStepsAction("ws-1", "r1")).toBeNull();
    expect(backend.setRailRun).not.toHaveBeenCalled();
  });

  it("reports the failure and rolls the plan back", async () => {
    vi.mocked(backend.setOrchestration).mockRejectedValue(new Error("step t1 is running"));
    expect(await clearDoneStepsAction("ws-1", "r1")).toBe("step t1 is running");
    expect(get(orchestrations)["ws-1"].rails[0].stages.map((s) => s.id)).toEqual(["s1", "s2", "s3"]);
    expect(backend.setRailRun).not.toHaveBeenCalled();
  });
});

describe("makeStageSequentialAction", () => {
  beforeEach(() => {
    vi.mocked(backend.setOrchestration).mockResolvedValue(undefined);
    orchestrations.set({
      "ws-1": {
        ...emptyOrchestration(),
        rails: [
          {
            id: "r1",
            name: "backend",
            position: 0,
            worktreePath: "/x/wt",
            pageId: "p1",
            stages: [
              {
                id: "s1",
                position: 0,
                steps: [
                  { id: "t1", position: 0, cardPath: "/x/a.md" },
                  { id: "t2", position: 1, cardPath: "/x/b.md" },
                ],
              },
            ],
          },
        ],
      },
    });
  });

  it("flips the mode and keeps the group whole", async () => {
    // The repair used to detonate the stage into single-step stages, which
    // threw away the grouping the human built.
    await makeStageSequentialAction("ws-1", "s1");
    const after = get(orchestrations)["ws-1"];
    expect(findStage(after, "s1")?.steps).toHaveLength(2);
    expect(stageMode(findStage(after, "s1") as Stage)).toBe("sequence");
  });
});

// ---- Tool steps -------------------------------------------------------------

/// The same bound rail, but its single step runs a tool. `cardPath` is
/// empty on purpose: a step is a card OR a tool, never both.
function toolRail(toolParams: Record<string, string> = {}): Orchestration {
  return {
    ...emptyOrchestration(),
    rails: [
      {
        id: "r1",
        name: "backend",
        position: 0,
        worktreePath: "/x/wt",
        pageId: "p1",
        stages: [
          {
            id: "s1",
            position: 0,
            steps: [
              { id: "t1", position: 0, cardPath: "", toolId: "builtin:push", toolParams },
            ],
          },
        ],
      },
    ],
  };
}

describe("launching a tool step", () => {
  beforeEach(async () => {
    __resetForTesting();
    toolsResetForTesting();
    vi.clearAllMocks();
    vi.mocked(backend.setStepRun).mockResolvedValue(undefined);
    vi.mocked(layoutStateModule.setSessionName).mockResolvedValue(undefined);
    vi.mocked(backend.getOrchestration).mockResolvedValue(toolRail());
    setRailPageLive();
    await fetchOrchestration("ws-1");
    // An EMPTY library, which still contains the built-ins.
    toolRecords.set({ "ws-1": [] });
  });

  it("runs a command tool's body in the rail's worktree, on the rail's page", async () => {
    vi.mocked(layoutStateModule.createSessionOnPage).mockResolvedValue("sess-9");
    await executeActions("ws-1", [{ kind: "launch", stepId: "t1" }]);
    expect(layoutStateModule.createSessionOnPage).toHaveBeenCalledWith(
      "ws-1",
      "p1",
      "/x/wt",
      expect.stringContaining("git push -u origin HEAD")
    );
    expect(backend.setStepRun).toHaveBeenCalledWith("t1", "running", "sess-9", null, null, "/x/wt", 0, "ws-1");
  });

  // A tool is not a card: no card_sessions binding and no status write.
  it("never binds a card session or writes In Progress", async () => {
    vi.mocked(layoutStateModule.createSessionOnPage).mockResolvedValue("sess-9");
    await executeActions("ws-1", [{ kind: "launch", stepId: "t1" }]);
    expect(kanbanStateModule.linkCardSessionAction).not.toHaveBeenCalled();
    expect(backend.setPlanFrontmatterField).not.toHaveBeenCalled();
  });

  it("names the session after the tool, so a fast command's tab is identifiable", async () => {
    vi.mocked(layoutStateModule.createSessionOnPage).mockResolvedValue("sess-9");
    await executeActions("ws-1", [{ kind: "launch", stepId: "t1" }]);
    // Through the STORE, not backend.setSessionName directly: the backend
    // command only persists to config and pushes nothing back, so a tab
    // named that way keeps its cwd label until the app restarts.
    expect(layoutStateModule.setSessionName).toHaveBeenCalledWith("sess-9", "Push branch");
  });

  // Cosmetic only: the agent is already running, so a failed rename must
  // not stall a live step.
  it("still records the run when naming the session fails", async () => {
    vi.mocked(layoutStateModule.createSessionOnPage).mockResolvedValue("sess-9");
    vi.mocked(layoutStateModule.setSessionName).mockRejectedValue(new Error("nope"));
    await executeActions("ws-1", [{ kind: "launch", stepId: "t1" }]);
    expect(backend.setStepRun).toHaveBeenCalledWith("t1", "running", "sess-9", null, null, "/x/wt", 0, "ws-1");
  });

  // Tools spec T6/T11. A tool can carry a working directory of its own
  // (v30), and the Tools tab runs it there -- but a RAIL step ignores
  // it and runs in the rail's checkout, always.
  //
  // This is not tidiness. Rail conflict detection is computed off
  // `worktreePath ?? rootPath`: it is how gavin knows two rails are
  // about to work the same tree. A step that quietly jumped out of its
  // worktree would let two rails collide with nothing left to warn
  // about, and the human would find out from a merge.
  it("ignores the tool's own working directory and uses the rail's checkout", async () => {
    toolRecords.set({
      "ws-1": [
        {
          id: "u-cwd",
          workspaceId: "ws-1",
          name: "Deploy",
          description: "",
          kind: "command",
          body: "./deploy.sh",
          params: [],
          position: 0,
          cwd: "/somewhere/else",
          icon: null,
        },
      ],
    });
    vi.mocked(backend.getOrchestration).mockResolvedValue({
      ...toolRail(),
      rails: [
        {
          ...toolRail().rails[0],
          stages: [
            {
              id: "s1",
              position: 0,
              steps: [{ id: "t1", position: 0, cardPath: "", toolId: "u-cwd", toolParams: {} }],
            },
          ],
        },
      ],
    });
    __resetForTesting();
    await fetchOrchestration("ws-1");
    toolRecords.set({
      "ws-1": [
        {
          id: "u-cwd",
          workspaceId: "ws-1",
          name: "Deploy",
          description: "",
          kind: "command",
          body: "./deploy.sh",
          params: [],
          position: 0,
          cwd: "/somewhere/else",
          icon: null,
        },
      ],
    });
    setRailPageLive();
    vi.mocked(layoutStateModule.createSessionOnPage).mockResolvedValue("sess-9");

    await executeActions("ws-1", [{ kind: "launch", stepId: "t1" }]);

    expect(layoutStateModule.createSessionOnPage).toHaveBeenCalledWith(
      "ws-1",
      "p1",
      "/x/wt",
      expect.stringContaining("./deploy.sh")
    );
    expect(layoutStateModule.createSessionOnPage).not.toHaveBeenCalledWith(
      "ws-1",
      "p1",
      "/somewhere/else",
      expect.anything()
    );
  });

  it("substitutes the step's parameter overrides", async () => {
    vi.mocked(backend.getOrchestration).mockResolvedValue(toolRail({ remote: "upstream" }));
    __resetForTesting();
    await fetchOrchestration("ws-1");
    toolRecords.set({ "ws-1": [] });
    vi.mocked(layoutStateModule.createSessionOnPage).mockResolvedValue("sess-9");
    await executeActions("ws-1", [{ kind: "launch", stepId: "t1" }]);
    expect(layoutStateModule.createSessionOnPage).toHaveBeenCalledWith(
      "ws-1",
      "p1",
      "/x/wt",
      expect.stringContaining("git push -u upstream HEAD")
    );
  });

  it("stalls when the tool is no longer in the library", async () => {
    vi.mocked(backend.getOrchestration).mockResolvedValue({
      ...toolRail(),
      rails: [
        {
          ...toolRail().rails[0],
          stages: [
            {
              id: "s1",
              position: 0,
              steps: [{ id: "t1", position: 0, cardPath: "", toolId: "gone", toolParams: {} }],
            },
          ],
        },
      ],
    });
    __resetForTesting();
    await fetchOrchestration("ws-1");
    toolRecords.set({ "ws-1": [] });
    await executeActions("ws-1", [{ kind: "launch", stepId: "t1" }]);
    expect(backend.setStepRun).toHaveBeenCalledWith(
      "t1",
      "stalled",
      null,
      "tool is no longer in the library",
      null,
      null,
      null,
      "ws-1",
    );
  });

  it("stalls when the session cannot be created, naming the tool", async () => {
    vi.mocked(layoutStateModule.createSessionOnPage).mockResolvedValue(null);
    await executeActions("ws-1", [{ kind: "launch", stepId: "t1" }]);
    expect(backend.setStepRun).toHaveBeenCalledWith(
      "t1",
      "stalled",
      null,
      "could not start Push branch",
      null,
      null,
      null,
      "ws-1",
    );
  });

  // An AGENT tool goes through the same launch command a card step
  // uses, so the agent binary and its quoting have one implementation.
  it("runs an agent tool through the workspace's agent command", async () => {
    vi.mocked(backend.getOrchestration).mockResolvedValue({
      ...toolRail(),
      rails: [
        {
          ...toolRail().rails[0],
          stages: [
            {
              id: "s1",
              position: 0,
              steps: [
                { id: "t1", position: 0, cardPath: "", toolId: "builtin:commit", toolParams: {} },
              ],
            },
          ],
        },
      ],
    });
    __resetForTesting();
    await fetchOrchestration("ws-1");
    toolRecords.set({ "ws-1": [] });
    vi.mocked(layoutStateModule.createSessionOnPage).mockResolvedValue("sess-9");
    await executeActions("ws-1", [{ kind: "launch", stepId: "t1" }]);
    const command = vi.mocked(layoutStateModule.createSessionOnPage).mock.calls[0][3] as string;
    expect(command.startsWith("claude '")).toBe(true);
    expect(command).toContain("Commit the uncommitted work in this checkout");
  });
});

describe("launching a tool step before the library has loaded", () => {
  beforeEach(async () => {
    __resetForTesting();
    toolsResetForTesting();
    vi.clearAllMocks();
    vi.mocked(backend.setStepRun).mockResolvedValue(undefined);
    vi.mocked(backend.getOrchestration).mockResolvedValue(toolRail());
    await fetchOrchestration("ws-1");
    // toolRecords deliberately left UNSET: not fetched yet.
  });

  // Stalling here would turn a cold start into a stalled rail. The step
  // stays pending and the tab re-ticks when the library lands.
  it("writes nothing and leaves the step pending", async () => {
    await executeActions("ws-1", [{ kind: "launch", stepId: "t1" }]);
    expect(backend.setStepRun).not.toHaveBeenCalled();
    expect(layoutStateModule.createSessionOnPage).not.toHaveBeenCalled();
  });

  it("launches once the library lands", async () => {
    await executeActions("ws-1", [{ kind: "launch", stepId: "t1" }]);
    toolRecords.set({ "ws-1": [] });
    vi.mocked(layoutStateModule.createSessionOnPage).mockResolvedValue("sess-9");
    await executeActions("ws-1", [{ kind: "launch", stepId: "t1" }]);
    expect(backend.setStepRun).toHaveBeenCalledWith("t1", "running", "sess-9", null, null, "/x/wt", 0, "ws-1");
  });
});

// ---- Dropping onto a stage that is already running --------------------------
// A step that lands on the stage a rail is CURRENTLY on belongs to a beat
// already in flight. It used to sit `pending` until some unrelated change
// ticked the workspace, which made the drop look inert.

function armWorkspace(): void {
  boardStore.set({
    "ws-1": {
      columns: [
        { id: "c0", name: "To Do", position: 0 },
        { id: "c1", name: "Done", position: 1 },
      ],
      labels: [],
      cardSessions: [],
    },
  });
  layoutStore.set({
    // sess-9 is what createSessionOnPage is mocked to return: a step
    // this tick launches has to read as LIVE on the next one, or rule 3
    // would call its session dead and stall the rail.
    // "p1", because every fixture here binds its rail to "p1": a launch
    // checks that page is still live before making a session, and an
    // id-less page would read as closed and spawn a fresh one.
    workspaces: [
      {
        id: "ws-1",
        pages: [{ id: "p1", name: "backend", layout: { type: "leaf", tabs: ["sess-1", "sess-9"] } }],
      },
    ],
    // No status reported for either: a session the daemon has said
    // nothing about is not a finished one.
    sessionStatusById: {},
    // Nothing broke.
    failureReasonById: {},
    // Set because plenty of surfaces read it, not because the scheduler
    // does: it ticks every LOADED workspace, so which one is on screen
    // decides nothing about which rails run.
    activeWorkspaceId: "ws-1",
  });
}

/// A rail mid-run: stage s1 is the stage it is ON, and stage s2 is still
/// ahead. Exactly what the human is looking at when they drag a second
/// card onto s1.
///
/// s1 holds TWO steps -- t1 running, t0 already done and inert -- on
/// purpose: a stage holding exactly one step is what a drop GROUPS (G3),
/// and these tests are about joining a stage that is already parallel,
/// not forming a new group. A single-step s1 would silently flip these
/// drops into sequence-group formation.
function midRunRail(): Orchestration {
  return {
    ...emptyOrchestration(),
    rails: [
      {
        id: "r1",
        name: "backend",
        position: 0,
        worktreePath: "/x/wt",
        pageId: "p1",
        stages: [
          {
            id: "s1",
            position: 0,
            steps: [
              { id: "t1", position: 0, cardPath: "/x/a.md" },
              { id: "t0", position: 1, cardPath: "/x/a0.md" },
            ],
          },
          { id: "s2", position: 1, steps: [{ id: "t2", position: 0, cardPath: "/x/b.md" }] },
        ],
      },
    ],
    railRuns: [{ railId: "r1", state: "running", currentStageId: "s1" }],
    stepRuns: [
      { stepId: "t1", state: "running", sessionId: "sess-1", reason: null },
      { stepId: "t0", state: "done", sessionId: null, reason: null },
    ],
  };
}

describe("dropping onto a running stage", () => {
  beforeEach(async () => {
    __resetForTesting();
    toolsResetForTesting();
    vi.clearAllMocks();
    armWorkspace();
    vi.mocked(backend.setOrchestration).mockResolvedValue(undefined);
    vi.mocked(backend.setRailRun).mockResolvedValue(undefined);
    vi.mocked(backend.setStepRun).mockResolvedValue(undefined);
    vi.mocked(backend.setPlanFrontmatterField).mockImplementation(async (p) => p);
    vi.mocked(backend.readFileForViewer).mockResolvedValue({
      content: "---\ntitle: Ship the UI\n---\ndo the thing",
      truncated: false,
      exists: true,
    });
    vi.mocked(layoutStateModule.createSessionOnPage).mockResolvedValue("sess-9");
    vi.mocked(layoutStateModule.setSessionName).mockResolvedValue(undefined);
    vi.mocked(backend.getOrchestration).mockResolvedValue(midRunRail());
    await fetchOrchestration("ws-1");
  });

  it("starts a card dropped onto the stage the rail is running", async () => {
    expect(await addStepToStageAction("ws-1", "s1", "/x/b.md", 2)).toBeNull();
    expect(layoutStateModule.createSessionOnPage).toHaveBeenCalledWith(
      "ws-1",
      "p1",
      "/x/wt",
      expect.stringContaining("claude ")
    );
    const dropped = get(orchestrations)["ws-1"].rails[0].stages[0].steps[2];
    expect(get(orchestrations)["ws-1"].stepRuns).toContainEqual({
      stepId: dropped.id,
      state: "running",
      sessionId: "sess-9",
      reason: null,
      conversationId: null,
      launchCwd: "/x/wt",
      // A fresh conversation is a fresh run, so its auto-resume budget
      // starts at zero rather than inheriting whatever the step carried.
      resumeAttempts: 0,
    });
  });

  // The sibling was already running when the drop landed; re-running the
  // scheduler must not spawn a second session for it.
  it("leaves the step already running on that stage alone", async () => {
    await addStepToStageAction("ws-1", "s1", "/x/b.md", 2);
    expect(layoutStateModule.createSessionOnPage).toHaveBeenCalledTimes(1);
    expect(backend.setStepRun).not.toHaveBeenCalledWith("t1", expect.anything(), expect.anything(), expect.anything(), "ws-1");
  });

  it("starts a tool dropped onto that stage the same way", async () => {
    toolRecords.set({ "ws-1": [] });
    expect(await addToolToStageAction("ws-1", "s1", "builtin:push", 2)).toBeNull();
    expect(layoutStateModule.createSessionOnPage).toHaveBeenCalledWith(
      "ws-1",
      "p1",
      "/x/wt",
      expect.stringContaining("git push -u origin HEAD")
    );
  });

  // Same gesture, same rule: a queued step dragged onto the live stage is
  // now part of the beat in flight.
  it("starts a step moved onto that stage from a later one", async () => {
    expect(await moveStepIntoStageAction("ws-1", "t2", "s1", 2)).toBeNull();
    expect(backend.setStepRun).toHaveBeenCalledWith("t2", "running", "sess-9", null, null, "/x/wt", 0, "ws-1");
  });

  // Every OTHER drop target stays queued -- a new stage is a later beat.
  it("does not start a card dropped into a gap as its own stage", async () => {
    expect(await addCardAsStageAction("ws-1", "r1", 1, "/x/b.md")).toBeNull();
    expect(layoutStateModule.createSessionOnPage).not.toHaveBeenCalled();
  });

  it("does not start a card dropped onto a stage the rail has not reached", async () => {
    await addStepToStageAction("ws-1", "s2", "/x/b.md", 1);
    expect(layoutStateModule.createSessionOnPage).not.toHaveBeenCalled();
  });

  // O1: nothing spawns on an unarmed rail, however live the stage looked
  // when the rail was last running.
  it("does not start a card dropped onto the stage a PAUSED rail is parked on", async () => {
    await setRailRunAction("ws-1", "r1", "paused", "s1");
    vi.mocked(layoutStateModule.createSessionOnPage).mockClear();
    await addStepToStageAction("ws-1", "s1", "/x/b.md", 2);
    expect(layoutStateModule.createSessionOnPage).not.toHaveBeenCalled();
  });

  // A save that failed has rolled the plan back, so there is no step to
  // start and the scheduler must not be handed the rolled-back plan.
  it("starts nothing when the drop failed to save", async () => {
    vi.mocked(backend.setOrchestration).mockRejectedValue(new Error("nope"));
    expect(await addStepToStageAction("ws-1", "s1", "/x/b.md", 2)).toContain("nope");
    expect(layoutStateModule.createSessionOnPage).not.toHaveBeenCalled();
  });
});

/// A rail mid-run on a SEQUENCE group of one member -- t1 running, s1's
/// own mode already "sequence". Distinct from midRunRail (parallel, two
/// members already inert): this is what "queued behind a running one"
/// needs to exercise the sequence branch of nextActions (G4) rather than
/// the parallel branch the tests above cover.
function midRunSequenceGroup(): Orchestration {
  return {
    ...emptyOrchestration(),
    rails: [
      {
        id: "r1",
        name: "backend",
        position: 0,
        worktreePath: "/x/wt",
        pageId: "p1",
        stages: [
          {
            id: "s1",
            position: 0,
            mode: "sequence",
            steps: [{ id: "t1", position: 0, cardPath: "/x/a.md" }],
          },
        ],
      },
    ],
    railRuns: [{ railId: "r1", state: "running", currentStageId: "s1" }],
    stepRuns: [{ stepId: "t1", state: "running", sessionId: "sess-1", reason: null }],
  };
}

describe("dropping onto a running sequence group", () => {
  beforeEach(async () => {
    __resetForTesting();
    toolsResetForTesting();
    vi.clearAllMocks();
    armWorkspace();
    vi.mocked(backend.setOrchestration).mockResolvedValue(undefined);
    vi.mocked(backend.setRailRun).mockResolvedValue(undefined);
    vi.mocked(backend.setStepRun).mockResolvedValue(undefined);
    vi.mocked(backend.setPlanFrontmatterField).mockImplementation(async (p) => p);
    vi.mocked(backend.readFileForViewer).mockResolvedValue({
      content: "---\ntitle: Ship the UI\n---\ndo the thing",
      truncated: false,
      exists: true,
    });
    vi.mocked(layoutStateModule.createSessionOnPage).mockResolvedValue("sess-9");
    vi.mocked(layoutStateModule.setSessionName).mockResolvedValue(undefined);
    vi.mocked(backend.getOrchestration).mockResolvedValue(midRunSequenceGroup());
    await fetchOrchestration("ws-1");
  });

  // startIfStageRunning ticks; the tick must decline to launch a member
  // queued behind one still running in a SEQUENCE group (G4) -- the drop
  // is correctly inert until the member ahead of it finishes. Asserted
  // against layoutState.createSessionOnPage, the actual launch path this
  // tick would take (see executeLaunch): backend.createSession sits
  // underneath the REAL createSessionOnPage, which this file replaces
  // wholesale, so it is never reachable from here and would prove
  // nothing about whether the launch was attempted.
  it("a member queued behind a running one does not start on drop", async () => {
    await addStepToStageAction("ws-1", "s1", "/x/c.md", 1);
    expect(layoutStateModule.createSessionOnPage).not.toHaveBeenCalled();
  });
});

describe("group actions", () => {
  beforeEach(() => {
    vi.mocked(backend.setOrchestration).mockResolvedValue(undefined);
    orchestrations.set({
      "ws-1": {
        ...emptyOrchestration(),
        rails: [
          {
            id: "r1",
            name: "backend",
            position: 0,
            worktreePath: "/x/wt",
            pageId: "p1",
            stages: [
              {
                id: "s1",
                position: 0,
                mode: "sequence",
                steps: [
                  { id: "t1", position: 0, cardPath: "/x/a.md" },
                  { id: "t2", position: 1, cardPath: "/x/b.md" },
                ],
              },
            ],
          },
          { id: "r2", name: "frontend", position: 1, worktreePath: "/y/wt", pageId: "p2", stages: [] },
        ],
      },
    });
  });

  it("setStageModeAction persists the flip", async () => {
    expect(await setStageModeAction("ws-1", "s1", "parallel")).toBeNull();
    expect(stageMode(findStage(get(orchestrations)["ws-1"], "s1") as Stage)).toBe("parallel");
  });

  it("renameStageAction persists a name and clears it", async () => {
    await renameStageAction("ws-1", "s1", "Merge and push");
    expect(findStage(get(orchestrations)["ws-1"], "s1")?.name).toBe("Merge and push");
    await renameStageAction("ws-1", "s1", null);
    expect(findStage(get(orchestrations)["ws-1"], "s1")?.name).toBeNull();
  });

  it("moveStageToIndexAction moves the group and its run state", async () => {
    await moveStageToIndexAction("ws-1", "s1", "r2", 0);
    const o = get(orchestrations)["ws-1"];
    expect(o.rails.find((r) => r.id === "r2")?.stages[0].id).toBe("s1");
  });

  it("ungroupStageAction leaves one stage per step", async () => {
    await ungroupStageAction("ws-1", "s1");
    expect(get(orchestrations)["ws-1"].rails[0].stages).toHaveLength(2);
  });

  it("addStepToStageAction inserts at the given index", async () => {
    await addStepToStageAction("ws-1", "s1", "/x/c.md", 0);
    const stage = findStage(get(orchestrations)["ws-1"], "s1") as Stage;
    expect(stage.steps[0].cardPath).toBe("/x/c.md");
  });
});

describe("template actions", () => {
  beforeEach(() => {
    vi.mocked(backend.setOrchestration).mockResolvedValue(undefined);
    orchestrations.set({
      "ws-1": {
        ...emptyOrchestration(),
        rails: [
          {
            id: "r1",
            name: "backend",
            position: 0,
            worktreePath: "/x/wt",
            pageId: "p1",
            stages: [
              {
                id: "s1",
                position: 0,
                mode: "sequence",
                steps: [
                  { id: "t1", position: 0, cardPath: "", toolId: "builtin:merge-into", toolParams: {} },
                ],
              },
            ],
          },
        ],
      },
    });
  });

  it("addTemplateAsStageAction places the template as its own group", async () => {
    const t: GroupTemplate = {
      id: "g1",
      name: "Merge and push",
      description: "",
      mode: "sequence",
      scope: "workspace",
      steps: [
        { toolId: "builtin:merge-into", toolParams: {} },
        { toolId: "builtin:push", toolParams: {} },
      ],
    };
    expect(await addTemplateAsStageAction("ws-1", "r1", 0, t)).toBeNull();
    const stage = get(orchestrations)["ws-1"].rails[0].stages[0];
    expect(stage.name).toBe("Merge and push");
    expect(stageMode(stage)).toBe("sequence");
    expect(stage.steps.map((s) => s.toolId)).toEqual(["builtin:merge-into", "builtin:push"]);
  });

  it("addTemplateToStageAction merges the members into an existing group at the index, each carrying its own params", async () => {
    // seeded: s1 holds t1 at position 0. Two members with DIFFERENT
    // toolIds and DIFFERENT params, dropped at index 1 (after t1): a
    // one-member template can't tell `index + i` apart from
    // `index + minted.indexOf(step)` (both collapse to `index` when
    // there is only one step to place), and a single shared param set
    // can't tell a correct id->params pairing from one that grabbed the
    // wrong member's overrides. This pins both in one test.
    const t: GroupTemplate = {
      id: "g1",
      name: "Merge and push",
      description: "",
      mode: "sequence",
      scope: "workspace",
      steps: [
        { toolId: "builtin:push", toolParams: { remote: "origin" } },
        { toolId: "builtin:merge", toolParams: { strategy: "squash" } },
      ],
    };
    expect(await addTemplateToStageAction("ws-1", "s1", 1, t)).toBeNull();
    const stage = findStage(get(orchestrations)["ws-1"], "s1") as Stage;
    const ordered = [...stage.steps].sort((a, b) => a.position - b.position);
    expect(ordered.map((s) => s.toolId)).toEqual([
      "builtin:merge-into",
      "builtin:push",
      "builtin:merge",
    ]);
    expect(ordered[1].toolParams).toEqual({ remote: "origin" });
    expect(ordered[2].toolParams).toEqual({ strategy: "squash" });
    // Joining a single-step stage forms a sequence group (G3).
    expect(stageMode(stage)).toBe("sequence");
  });

  it("addTemplateToStageAction applies each member's own param overrides, not just places the steps", async () => {
    const t: GroupTemplate = {
      id: "g1",
      name: "Merge and push",
      description: "",
      mode: "sequence",
      scope: "workspace",
      steps: [{ toolId: "builtin:push", toolParams: { remote: "upstream" } }],
    };
    await addTemplateToStageAction("ws-1", "s1", 1, t);
    const stage = findStage(get(orchestrations)["ws-1"], "s1") as Stage;
    const pushed = stage.steps.find((s) => s.toolId === "builtin:push");
    expect(pushed?.toolParams).toEqual({ remote: "upstream" });
  });
});

describe("a tick requested while one is in flight", () => {
  beforeEach(async () => {
    __resetForTesting();
    toolsResetForTesting();
    vi.clearAllMocks();
    vi.mocked(backend.setOrchestration).mockResolvedValue(undefined);
    vi.mocked(backend.setRailRun).mockResolvedValue(undefined);
    vi.mocked(backend.setStepRun).mockResolvedValue(undefined);
    vi.mocked(backend.setPlanFrontmatterField).mockImplementation(async (p) => p);
    vi.mocked(backend.readFileForViewer).mockResolvedValue({
      content: "---\ntitle: Wire the API\n---\ndo the thing",
      truncated: false,
      exists: true,
    });
    vi.mocked(layoutStateModule.setSessionName).mockResolvedValue(undefined);
    vi.mocked(layoutStateModule.createSessionOnPage).mockResolvedValue("sess-9");
    // The same rail, armed at s1 with NOTHING running yet, so one tick
    // launches its step -- and a drop can land mid-launch. t0 stays
    // done (not wiped to `[]`): it exists only to keep s1 a two-member
    // parallel stage, per midRunRail's doc comment, and a pending t0
    // would launch alongside t1 and throw off this test's call counts.
    vi.mocked(backend.getOrchestration).mockResolvedValue({
      ...midRunRail(),
      stepRuns: [{ stepId: "t0", state: "done", sessionId: null, reason: null }],
    });
    // The board lands AFTER the plan on purpose: a plan arriving ticks,
    // and this rail's step must still be unlaunched when the test runs
    // the pass it is about.
    await fetchOrchestration("ws-1");
    armWorkspace();
  });

  // The pass in flight read the plan before the new step existed, so
  // simply returning would leave it pending until some unrelated event
  // ticked the workspace again -- the very stall this card is about,
  // reached by a narrower door.
  it("is replayed once the pass in flight drains", async () => {
    vi.mocked(layoutStateModule.createSessionOnPage).mockImplementationOnce(async () => {
      orchestrations.update((m) => ({ ...m, "ws-1": addStep(m["ws-1"], "s1", "late", "/x/b.md", 2) }));
      void tick("ws-1");
      return "sess-9";
    });

    await tick("ws-1");

    expect(layoutStateModule.createSessionOnPage).toHaveBeenCalledTimes(2);
    expect(backend.setStepRun).toHaveBeenCalledWith("late", "running", "sess-9", null, null, "/x/wt", 0, "ws-1");
  });
});

// ---- An agent tool step's turn ---------------------------------------------
// The bug this fixes end to end: an agent tool's session NEVER exits, so
// the rail's only completion rule (T5's exit code) could never fire for
// one. The step sat `running` for good, and since the daemon refuses
// every plan write that drops a `running` step, the rail was wedged shut
// until the human deleted the session and the step by hand.

/// A rail parked on an agent tool (`builtin:commit`, running as sess-1)
/// with a command tool queued behind it -- so a tick that completes the
/// first has somewhere visible to go.
function agentToolRail(): Orchestration {
  return {
    ...emptyOrchestration(),
    rails: [
      {
        id: "r1",
        name: "release",
        position: 0,
        worktreePath: "/x/wt",
        pageId: "p1",
        stages: [
          {
            id: "s1",
            position: 0,
            steps: [{ id: "t1", position: 0, cardPath: "", toolId: "builtin:commit", toolParams: {} }],
          },
          {
            id: "s2",
            position: 1,
            steps: [{ id: "t2", position: 0, cardPath: "", toolId: "builtin:push", toolParams: {} }],
          },
        ],
      },
    ],
    railRuns: [{ railId: "r1", state: "running", currentStageId: "s1" }],
    stepRuns: [{ stepId: "t1", state: "running", sessionId: "sess-1", reason: null }],
  };
}

describe("an agent tool step whose turn has ended", () => {
  beforeEach(async () => {
    __resetForTesting();
    toolsResetForTesting();
    vi.clearAllMocks();
    armWorkspace();
    toolRecords.set({ "ws-1": [] });
    vi.mocked(backend.setRailRun).mockResolvedValue(undefined);
    vi.mocked(backend.setStepRun).mockResolvedValue(undefined);
    vi.mocked(layoutStateModule.setSessionName).mockResolvedValue(undefined);
    vi.mocked(layoutStateModule.createSessionOnPage).mockResolvedValue("sess-9");
    vi.mocked(backend.getOrchestration).mockResolvedValue(agentToolRail());
    await fetchOrchestration("ws-1");
  });

  const status = (v: Record<string, string>) =>
    layoutStore.update((s) => {
      const sessionsSeenWorking = new Set(s.sessionsSeenWorking ?? []);
      for (const [id, st] of Object.entries(v)) {
        if (st === "working" || st === "waiting_for_input") sessionsSeenWorking.add(id);
      }
      return { ...s, sessionStatusById: v, sessionsSeenWorking };
    });

  it("is filed done and lets the rail move on, though its session is still live", async () => {
    status({ "sess-1": "working" });
    status({ "sess-1": "idle" });
    await tick("ws-1");
    expect(backend.setStepRun).toHaveBeenCalledWith("t1", "done", "sess-1", null, null, null, null, "ws-1");
    // The next stage actually started: without that this is a green test
    // over a rail that is still stuck.
    expect(layoutStateModule.createSessionOnPage).toHaveBeenCalledWith(
      "ws-1",
      "p1",
      "/x/wt",
      expect.stringContaining("git push -u origin HEAD")
    );
  });

  it("keeps running while the agent is still working", async () => {
    status({ "sess-1": "working" });
    await tick("ws-1");
    expect(backend.setStepRun).not.toHaveBeenCalled();
    expect(layoutStateModule.createSessionOnPage).not.toHaveBeenCalled();
  });

  // The agent is asking the human something. Advancing past a question
  // would answer it by walking away.
  it("keeps running while the agent waits for input", async () => {
    status({ "sess-1": "waiting_for_input" });
    await tick("ws-1");
    expect(backend.setStepRun).not.toHaveBeenCalled();
  });

  // The daemon registers every new session `idle`, so an absent status
  // is "nothing reported yet" -- believing it would file a step done the
  // instant it launched.
  it("keeps running while its session has reported nothing", async () => {
    await tick("ws-1");
    expect(backend.setStepRun).not.toHaveBeenCalled();
  });

  it("keeps running through the shell's first idle, before the agent has worked", async () => {
    status({ "sess-1": "idle" });
    await tick("ws-1");
    expect(backend.setStepRun).not.toHaveBeenCalled();
  });
});

// ---- The scheduler's own trigger -------------------------------------------
// A rail used to advance only while the Orchestration tab was on screen:
// the one self-firing tick was an $effect in OrchestrationHubView, and
// +page renders a single hub view at a time (a terminal page renders none
// of them at all). Go and watch the agent work on its page -- the natural
// thing to do -- and nothing moved until you navigated back.

/// Long enough for a tick to have run: the subscription fires
/// synchronously but `tick` is async, so a negative assertion made in the
/// same task would pass whether the scheduler was listening or not.
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("the scheduler's trigger, with no hub view mounted", () => {
  let stop: (() => void) | null = null;

  beforeEach(async () => {
    __resetForTesting();
    toolsResetForTesting();
    vi.clearAllMocks();
    armWorkspace();
    toolRecords.set({ "ws-1": [] });
    vi.mocked(backend.setRailRun).mockResolvedValue(undefined);
    vi.mocked(backend.setStepRun).mockResolvedValue(undefined);
    vi.mocked(backend.setOrchestration).mockResolvedValue(undefined);
    vi.mocked(layoutStateModule.setSessionName).mockResolvedValue(undefined);
    vi.mocked(layoutStateModule.createSessionOnPage).mockResolvedValue("sess-9");
    vi.mocked(backend.getOrchestration).mockResolvedValue(agentToolRail());
    await fetchOrchestration("ws-1");
    stop = startScheduler();
  });

  afterEach(() => {
    stop?.();
    stop = null;
  });

  it("advances the rail when the running agent goes idle", async () => {
    layoutStore.update((s) => ({ ...s, sessionStatusById: { "sess-1": "idle" }, sessionsSeenWorking: new Set(["sess-1"]) }));
    await vi.waitFor(() =>
      expect(backend.setStepRun).toHaveBeenCalledWith("t1", "done", "sess-1", null, null, null, null, "ws-1")
    );
    // The next stage actually started: without this the rail is merely
    // ticking, not running.
    await vi.waitFor(() =>
      expect(layoutStateModule.createSessionOnPage).toHaveBeenCalledWith(
        "ws-1",
        "p1",
        "/x/wt",
        expect.stringContaining("git push -u origin HEAD")
      )
    );
  });

  // The point of a rail is that it runs while you are somewhere else,
  // and "somewhere else" includes another WORKSPACE. This used to tick
  // the active one only, so a rail in the workspace not on screen froze
  // mid-run -- and froze INVISIBLY, because stepAttentions is computed
  // for every workspace: the step's agent badge kept tracking the
  // session live while the step it belonged to never moved. Opening
  // that session was the cure, and only because activating its
  // workspace was what let the scheduler see the rail at all.
  it("advances a rail in a workspace the human is not in", async () => {
    layoutStore.update((s) => ({
      ...s,
      activeWorkspaceId: "ws-2",
      sessionStatusById: { "sess-1": "idle" }, sessionsSeenWorking: new Set(["sess-1"]),
    }));
    await vi.waitFor(() =>
      expect(backend.setStepRun).toHaveBeenCalledWith("t1", "done", "sess-1", null, null, null, null, "ws-1")
    );
  });

  // And every loaded workspace, not just whichever one happens to hold
  // the tick. Two rails in two workspaces is the ordinary shape here --
  // one repo's rail running while you work in another -- and the one
  // that made the freeze look like a bug in the rail rather than in
  // which workspace the scheduler was looking at.
  it("advances rails in two workspaces at once", async () => {
    boardStore.update((b) => ({ ...b, "ws-2": b["ws-1"] }));
    layoutStore.update((s) => ({
      ...s,
      workspaces: [
        ...s.workspaces,
        {
          id: "ws-2",
          pages: [{ id: "p1", name: "backend", layout: { type: "leaf", tabs: ["sess-2", "sess-9"] } }],
        },
      ],
    }));
    toolRecords.update((t) => ({ ...t, "ws-2": [] }));
    vi.mocked(backend.getOrchestration).mockResolvedValue({
      ...agentToolRail(),
      stepRuns: [{ stepId: "t1", state: "running", sessionId: "sess-2", reason: null }],
    });
    await fetchOrchestration("ws-2");
    vi.mocked(backend.setStepRun).mockClear();

    layoutStore.update((s) => ({
      ...s,
      sessionStatusById: { "sess-1": "idle", "sess-2": "idle" },
      sessionsSeenWorking: new Set(["sess-1", "sess-2"]),
    }));
    await vi.waitFor(() => {
      expect(backend.setStepRun).toHaveBeenCalledWith("t1", "done", "sess-1", null, null, null, null, "ws-1");
      expect(backend.setStepRun).toHaveBeenCalledWith("t1", "done", "sess-2", null, null, null, null, "ws-2");
    });
  });

  // The plan is the one input the scheduler cannot subscribe to, so its
  // arrival ticks by hand. Without that, a rail left running across a
  // restart sits still until some unrelated push happens along -- the
  // same stall through a different door, and the one a human meets first
  // after reopening the app.
  it("picks up a rail whose plan lands last", async () => {
    __resetForTesting();
    stop = startScheduler();
    layoutStore.update((s) => ({ ...s, sessionStatusById: { "sess-1": "idle" }, sessionsSeenWorking: new Set(["sess-1"]) }));
    await settle();
    expect(backend.setStepRun).not.toHaveBeenCalled();

    await fetchOrchestration("ws-1");

    expect(backend.setStepRun).toHaveBeenCalledWith("t1", "done", "sess-1", null, null, null, null, "ws-1");
  });

  // The daemon's push is the third plan arrival, and the one an agent
  // editing rails over MCP comes in on. A step added to the stage a rail
  // is running has to start, not wait for the human to come back.
  it("picks up a plan the daemon pushes", async () => {
    stop?.();
    __resetForTesting();
    const unlisten = await initOrchestrationListeners();
    stop = unlisten;
    layoutStore.update((s) => ({ ...s, sessionStatusById: { "sess-1": "idle" }, sessionsSeenWorking: new Set(["sess-1"]) }));
    await settle();
    expect(backend.setStepRun).not.toHaveBeenCalled();

    tauriEvents.handlers.get("orchestration-changed")?.({
      payload: ["ws-1", agentToolRail()],
    });

    await vi.waitFor(() =>
      expect(backend.setStepRun).toHaveBeenCalledWith("t1", "done", "sess-1", null, null, null, null, "ws-1")
    );
  });

  // The tool library was the one scheduler input only a TAB loaded: the
  // Orchestration and Tools views fetched it, nothing else did, and every
  // test above seeds it by hand. An agent tool step reads its kind from
  // that library, so after an app start its agent could finish and the
  // step sit `running` until the human opened the Orchestration tab --
  // Grimoria's Fixes rail, 2026-09-26, parked on a finished Commit.
  it("loads the tool library itself, so an agent tool step finishes without the tab", async () => {
    vi.mocked(backend.getTools).mockResolvedValue([]);
    toolsResetForTesting();
    layoutStore.update((s) => ({ ...s, sessionStatusById: { "sess-1": "idle" }, sessionsSeenWorking: new Set(["sess-1"]) }));
    await vi.waitFor(() =>
      expect(backend.setStepRun).toHaveBeenCalledWith("t1", "done", "sess-1", null, null, null, null, "ws-1")
    );
    expect(backend.getTools).toHaveBeenCalledWith("ws-1");
  });

  // Every emission of ten stores ticks every loaded workspace, and the
  // fetch is a daemon round trip on the drawing thread. A library that
  // is still on its way must not be asked for again by each pass that
  // runs meanwhile.
  it("asks for a missing library once while it is on its way", async () => {
    let land: (rows: never[]) => void = () => {};
    vi.mocked(backend.getTools).mockReturnValue(new Promise((resolve) => (land = resolve)));
    toolsResetForTesting();
    for (let i = 0; i < 5; i++) layoutStore.update((s) => ({ ...s }));
    await settle();
    expect(backend.getTools).toHaveBeenCalledTimes(1);
    land([]);
    await vi.waitFor(() => expect(get(toolRecords)["ws-1"]).toEqual([]));
  });

  it("stops when the app tears it down", async () => {
    stop?.();
    stop = null;
    layoutStore.update((s) => ({ ...s, sessionStatusById: { "sess-1": "idle" }, sessionsSeenWorking: new Set(["sess-1"]) }));
    await settle();
    expect(backend.setStepRun).not.toHaveBeenCalled();
  });

  // The launch wall, at the same seam the pause uses and with the same
  // shape of proof. A rail step is NOT queued -- the scheduler is the
  // rail's queue -- so the whole of "resume" is that `launchHolding` is
  // a tick input: the pass that runs when a slot frees emits the very
  // action the held pass skipped.
  //
  // The bookkeeping still happens while the gate holds. Marking a
  // finished step done is not a start, and holding it would leave the
  // rail describing a state it is no longer in.
  it("skips a launch the wall refuses and emits it again when a slot frees", async () => {
    gateMock.allowed.value = false;
    try {
      layoutStore.update((s) => ({ ...s, sessionStatusById: { "sess-1": "idle" }, sessionsSeenWorking: new Set(["sess-1"]) }));
      await vi.waitFor(() =>
        expect(backend.setStepRun).toHaveBeenCalledWith("t1", "done", "sess-1", null, null, null, null, "ws-1")
      );
      expect(layoutStateModule.createSessionOnPage).not.toHaveBeenCalled();

      gateMock.allowed.value = true;
      // The flip a lifted hold makes: the deduped flag goes true while
      // starts are held and false when they may resume, and it is that
      // second emission the scheduler ticks on.
      gateMock.launchHolding.set(true);
      gateMock.launchHolding.set(false);
      await vi.waitFor(() =>
        expect(layoutStateModule.createSessionOnPage).toHaveBeenCalledWith(
          "ws-1",
          "p1",
          "/x/wt",
          expect.stringContaining("git push -u origin HEAD")
        )
      );
    } finally {
      gateMock.allowed.value = true;
    }
  });
});

// The other half of `gavin_start_rail`: the daemon writes the row and
// pushes it, and this app has to ADOPT it. The push handler keeps its own
// run state on purpose (the daemon's copy lags every optimistic local
// write), so before this the pushed `running` row was dropped on arrival
// and the rail went on reading idle -- exactly the half-adopted state the
// five socket-armed rails were left in on 2026-09-03.
describe("a rail armed from outside the app (a push carrying run state)", () => {
  let stop: (() => void) | null = null;

  const armed = (): Orchestration => ({
    ...boundRail(),
    railRuns: [{ railId: "r1", state: "running", currentStageId: "s1" }],
  });

  beforeEach(async () => {
    __resetForTesting();
    toolsResetForTesting();
    vi.clearAllMocks();
    armWorkspace();
    toolRecords.set({ "ws-1": [] });
    vi.mocked(backend.setRailRun).mockResolvedValue(undefined);
    vi.mocked(backend.setStepRun).mockResolvedValue(undefined);
    vi.mocked(backend.setOrchestration).mockResolvedValue(undefined);
    vi.mocked(backend.setPlanFrontmatterField).mockImplementation(async (p) => p);
    vi.mocked(backend.readFileForViewer).mockResolvedValue({
      content: "---\ntitle: Wire the API\n---\ndo the thing",
      truncated: false,
      exists: true,
    });
    vi.mocked(layoutStateModule.setSessionName).mockResolvedValue(undefined);
    vi.mocked(layoutStateModule.createSessionOnPage).mockResolvedValue("sess-9");
    // The rail is idle here, and stays idle unless the push is adopted.
    vi.mocked(backend.getOrchestration).mockResolvedValue(boundRail());
    await fetchOrchestration("ws-1");
    stop = await initOrchestrationListeners();
  });

  afterEach(() => {
    stop?.();
    stop = null;
  });

  it("adopts the running row and launches the rail's first step", async () => {
    // The re-read is what adopts it -- the payload is not trusted, the
    // daemon is asked again -- so the mock has to answer with the row too.
    vi.mocked(backend.getOrchestration).mockResolvedValue(armed());
    tauriEvents.handlers.get("orchestration-changed")?.({ payload: ["ws-1", armed()] });

    await vi.waitFor(() =>
      expect(get(orchestrations)["ws-1"].railRuns).toEqual([
        { railId: "r1", state: "running", currentStageId: "s1" },
      ])
    );
    await vi.waitFor(() =>
      expect(layoutStateModule.createSessionOnPage).toHaveBeenCalledWith(
        "ws-1",
        "p1",
        "/x/wt",
        expect.stringContaining("claude")
      )
    );
    expect(backend.setStepRun).toHaveBeenCalledWith("t1", "running", "sess-9", null, null, "/x/wt", 0, "ws-1");
  });

  // The scheduler ticks the ACTIVE workspace and nothing else, so in any
  // other workspace the handler's own tick is the only thing that can
  // start the rail. An agent arming a rail in the workspace the human is
  // not looking at is the ordinary case, not the exotic one.
  it("starts it in a workspace the scheduler is not ticking", async () => {
    layoutStore.update((s) => ({ ...s, activeWorkspaceId: "ws-2" }));
    vi.mocked(backend.getOrchestration).mockResolvedValue(armed());
    tauriEvents.handlers.get("orchestration-changed")?.({ payload: ["ws-1", armed()] });

    await vi.waitFor(() =>
      expect(backend.setStepRun).toHaveBeenCalledWith(
        "t1",
        "running",
        "sess-9",
        null,
        null,
        "/x/wt",
        0,
        "ws-1"
      )
    );
  });

  // The merge guard is still the rule, and this is what says it survived:
  // a push that agrees about run state must not send the app back to the
  // daemon, or every plan write an agent makes would cost a re-read and
  // the daemon's lagging copy would get a chance to overwrite a local
  // optimistic write between the two.
  it("does not re-read when the push says nothing new about run state", async () => {
    vi.mocked(backend.getOrchestration).mockClear();
    tauriEvents.handlers.get("orchestration-changed")?.({ payload: ["ws-1", boundRail()] });
    await settle();
    expect(backend.getOrchestration).not.toHaveBeenCalled();
  });
});

// ---- What a running step says about itself ---------------------------------
// A card step is done when its card reaches the done column, and stalled
// when its session dies first. But an interactive agent does not die: it
// finishes its turn and sits at its prompt. So an agent that answered,
// got confused, or decided the work was not for it left the step
// `running` with a LIVE session and the rail waiting on it forever --
// no stall, no reason, and nothing on screen saying anything was wrong.
// It looked busy.

describe("stepAttentionsByWorkspace", () => {
  beforeEach(async () => {
    __resetForTesting();
    toolsResetForTesting();
    vi.clearAllMocks();
    armWorkspace();
    toolRecords.set({ "ws-1": [] });
    vi.mocked(backend.getOrchestration).mockResolvedValue({
      ...boundRail(),
      stepRuns: [{ stepId: "t1", state: "running", sessionId: "sess-1", reason: null }],
    });
    await fetchOrchestration("ws-1");
  });

  const status = (v: Record<string, string>) =>
    layoutStore.update((s) => ({ ...s, sessionStatusById: v }));

  // /x/a.md is stubbed To Do, so the card never reached Done.
  it("marks the step whose agent stopped short of the done column", () => {
    status({ "sess-1": "idle" });
    expect(get(stepAttentionsByWorkspace)["ws-1"].get("t1")).toBe("turn-ended");
  });

  it("marks the step whose agent is asking the human something", () => {
    status({ "sess-1": "waiting_for_input" });
    expect(get(stepAttentionsByWorkspace)["ws-1"].get("t1")).toBe("asking");
  });

  it("says nothing while the agent is working", () => {
    status({ "sess-1": "working" });
    expect(get(stepAttentionsByWorkspace)["ws-1"].get("t1")).toBeUndefined();
  });

  // The map has to move with the session, not lag it: it is a live read
  // of the same stores the scheduler ticks on, which is the whole reason
  // it is derived rather than stored.
  it("clears itself the moment the agent picks the work back up", () => {
    status({ "sess-1": "idle" });
    expect(get(stepAttentionsByWorkspace)["ws-1"].get("t1")).toBe("turn-ended");
    status({ "sess-1": "working" });
    expect(get(stepAttentionsByWorkspace)["ws-1"].get("t1")).toBeUndefined();
  });

  // A workspace whose board has not arrived cannot say what "done"
  // means, so it says nothing at all rather than marking every step.
  it("skips a workspace with no board", () => {
    boardStore.set({});
    status({ "sess-1": "idle" });
    expect(get(stepAttentionsByWorkspace)["ws-1"]).toBeUndefined();
  });
});

// The sweep behind the `decoy-edit` mark: one `git_run_changes` per
// running card step, against the baseline its run started on. The
// baseline is the point -- a status call would go quiet the moment the
// agent committed the wrong file, while the rail stayed just as wedged.
describe("refreshDecoyEdits", () => {
  const CARD = "/ws/.gavin-root/plans/a.md";

  function decoyRail(): Orchestration {
    return {
      ...emptyOrchestration(),
      rails: [
        {
          id: "r1",
          name: "backend",
          position: 0,
          worktreePath: "/x/wt",
          pageId: "p1",
          stages: [
            { id: "s1", position: 0, steps: [{ id: "t1", position: 0, cardPath: CARD }] },
          ],
        },
      ],
      stepRuns: [{ stepId: "t1", state: "running", sessionId: "sess-1", reason: null }],
    };
  }

  function bind(baseSha: string | null): void {
    boardStore.update((all) => ({
      ...all,
      "ws-1": {
        ...(all["ws-1"] as Record<string, unknown>),
        cardSessions: [
          { path: CARD, sessionId: "sess-1", cwd: "/x/wt", command: null, launchCwd: "/x/wt", baseSha },
        ],
      },
    }));
  }

  const changed = (files: Array<{ path: string; oldPath?: string }>) => ({
    baseSha: "base",
    notARepo: false,
    baseMissing: false,
    root: "/x/wt",
    baseSubject: null,
    files: files.map((f) => ({ ...f, status: "M" as const })),
    added: 0,
    removed: 0,
    commits: 0,
    untilSha: null,
  });

  beforeEach(async () => {
    __resetForTesting();
    toolsResetForTesting();
    vi.clearAllMocks();
    armWorkspace();
    toolRecords.set({ "ws-1": [] });
    vi.mocked(backend.getOrchestration).mockResolvedValue(decoyRail());
    await fetchOrchestration("ws-1");
    bind("base");
  });

  it("records the step whose card the run changed inside the worktree", async () => {
    vi.mocked(backend.gitRunChanges).mockResolvedValue(changed([{ path: ".gavin-root/plans/a.md" }]));
    await refreshDecoyEdits("ws-1");
    expect([...(get(decoyEditsByWorkspace)["ws-1"] ?? [])]).toEqual(["t1"]);
  });

  it("asks the run's own checkout, against the baseline it started on", async () => {
    vi.mocked(backend.gitRunChanges).mockResolvedValue(changed([]));
    await refreshDecoyEdits("ws-1");
    expect(backend.gitRunChanges).toHaveBeenCalledWith("/x/wt", "base");
  });

  it("records nothing for a run that only touched code", async () => {
    vi.mocked(backend.gitRunChanges).mockResolvedValue(changed([{ path: "app/src/lib/git.ts" }]));
    await refreshDecoyEdits("ws-1");
    expect(get(decoyEditsByWorkspace)["ws-1"]?.size).toBe(0);
  });

  // Every unknown is silence rather than a mark: a run with no baseline
  // (pre-v26, outside a repo, unborn HEAD) simply cannot be asked.
  it("makes no call at all without a baseline", async () => {
    bind(null);
    await refreshDecoyEdits("ws-1");
    expect(backend.gitRunChanges).not.toHaveBeenCalled();
  });

  // ...and neither can a rail with no checkout of its own, which has no
  // second copy of anything to confuse.
  it("makes no call for an unbound rail", async () => {
    orchestrations.update((all) => ({
      ...all,
      "ws-1": {
        ...all["ws-1"],
        rails: all["ws-1"].rails.map((r) => ({ ...r, worktreePath: null })),
      },
    }));
    await refreshDecoyEdits("ws-1");
    expect(backend.gitRunChanges).not.toHaveBeenCalled();
  });

  it("survives a git call that fails, leaving nothing marked", async () => {
    vi.mocked(backend.gitRunChanges).mockRejectedValue(new Error("no such worktree"));
    await refreshDecoyEdits("ws-1");
    expect(get(decoyEditsByWorkspace)["ws-1"]?.size).toBe(0);
  });

  // The mark is about a LIVE step. A finished run's decoy edit is a
  // merge problem, not a rail waiting on somebody.
  it("clears the set once nothing is running", async () => {
    vi.mocked(backend.gitRunChanges).mockResolvedValue(changed([{ path: ".gavin-root/plans/a.md" }]));
    await refreshDecoyEdits("ws-1");
    expect(get(decoyEditsByWorkspace)["ws-1"]?.size).toBe(1);
    orchestrations.update((all) => ({
      ...all,
      "ws-1": {
        ...all["ws-1"],
        stepRuns: [{ stepId: "t1", state: "done", sessionId: "sess-1", reason: null }],
      },
    }));
    await refreshDecoyEdits("ws-1");
    expect(get(decoyEditsByWorkspace)["ws-1"]?.size).toBe(0);
  });

  // What the whole sweep is for: the mark reaches the chips, the rail
  // header and the hub through the map every surface already reads.
  it("puts the mark on the step, even while its agent is still working", async () => {
    vi.mocked(backend.gitRunChanges).mockResolvedValue(changed([{ path: ".gavin-root/plans/a.md" }]));
    await refreshDecoyEdits("ws-1");
    layoutStore.update((s) => ({ ...s, sessionStatusById: { "sess-1": "working" } }));
    expect(get(stepAttentionsByWorkspace)["ws-1"].get("t1")).toBe("decoy-edit");
  });
});

describe("railStatusVoice", () => {
  beforeEach(async () => {
    __resetForTesting();
    toolsResetForTesting();
    vi.clearAllMocks();
    armWorkspace();
    toolRecords.set({ "ws-1": [] });
    vi.mocked(backend.getOrchestration).mockResolvedValue({
      ...boundRail(),
      stepRuns: [{ stepId: "t1", state: "running", sessionId: "sess-1", reason: null }],
    });
    await fetchOrchestration("ws-1");
  });

  const status = (v: Record<string, string>) =>
    layoutStore.update((s) => ({ ...s, sessionStatusById: v }));

  // The correction this card is really about. Without it the human gets
  // "Wire the API finished" for an agent that finished nothing -- worse
  // than the silence, because it is confidently wrong.
  it("names the card, and says it did NOT finish", () => {
    status({ "sess-1": "idle" });
    expect(railStatusVoice("sess-1", "idle")).toBe("Wire the API stopped without finishing its card");
  });

  it("says nothing about a session no rail step owns", () => {
    status({ "sess-1": "idle", "sess-2": "idle" });
    expect(railStatusVoice("sess-2", "idle")).toBeNull();
  });

  // waiting_for_input already notifies as "needs your input", which is
  // right; and a non-idle transition is not this rule's business at all.
  it("says nothing about a status other than idle", () => {
    status({ "sess-1": "waiting_for_input" });
    expect(railStatusVoice("sess-1", "waiting_for_input")).toBeNull();
    expect(railStatusVoice("sess-1", "working")).toBeNull();
  });

  it("says nothing about a step that is merely working", () => {
    status({ "sess-1": "working" });
    expect(railStatusVoice("sess-1", "idle")).toBeNull();
  });
});
