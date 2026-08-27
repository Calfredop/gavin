import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { get, writable, type Writable } from "svelte/store";

vi.mock("./backend", () => ({
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
}));

// tick() reads four stores through get(), so each mock must expose a
// real store contract, not just its functions -- a bare object makes
// get() throw and the failure reads as an unrelated crash.
vi.mock("./layoutState", () => ({
  // A REAL store: tick() derives the set of LIVE session ids from it, so
  // a test that needs a running step's session to still exist has to be
  // able to put a page holding it in here.
  layoutState: writable({ workspaces: [] as unknown[], sessionStatusById: {} as Record<string, string> }),
  resolvedAgentFor: vi.fn(() => ({
    command: "claude",
    launchCommand: "claude",
    file: "CLAUDE.md",
    profile: "claude-code",
  })),
  createSessionOnPage: vi.fn(),
  createPage: vi.fn().mockResolvedValue(null),
  setSessionName: vi.fn().mockResolvedValue(undefined),
  // tick() reads this through get(), so it has to be a real store.
  sessionExits: { subscribe: (fn: (v: unknown) => void) => (fn(new Map()), () => {}) },
}));
// A REAL store, left empty by default: tick() bails early without a
// board, so the rail-control tests exercise arming without also running
// the scheduler. The drop-onto-a-running-stage tests set a board into it
// precisely because they need the scheduler to run.
vi.mock("./kanbanState", () => ({
  kanbanState: writable<Record<string, unknown>>({}),
  linkCardSessionAction: vi.fn(),
}));
vi.mock("./gavinState", () => ({
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
              ],
              docs: [],
              specs: [],
              hasPrd: true,
              configWarning: false,
            },
          ],
        },
      }),
      () => {}
    ),
  },
  patchPlanField: vi.fn(),
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
vi.mock("./gitState", () => {
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

import * as backend from "./backend";
import * as gitStateModule from "./gitState";
import * as gavinState from "./gavinState";
import * as layoutStateModule from "./layoutState";
import * as kanbanStateModule from "./kanbanState";
import { toolRecords, __resetForTesting as toolsResetForTesting } from "./toolsState";
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
  railStatusVoice,
  makeStageSequentialAction,
  setStageModeAction,
  renameStageAction,
  moveStageToIndexAction,
  ungroupStageAction,
  addTemplateAsStageAction,
  addTemplateToStageAction,
  __resetForTesting,
} from "./orchestrationState";
import { emptyOrchestration, addStep, findStage, stageMode } from "./orchestration";
import type { Orchestration, Rail, Stage } from "./orchestration";
import type { GroupTemplate } from "./orchestrationGroups";

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
  activeWorkspaceId?: string | null;
}>;

beforeEach(() => {
  vi.clearAllMocks();
  __resetForTesting();
  // Both mocked stores are module-level and shared by every test in this
  // file: a page one test puts in must not decide what the next one
  // sees. `clearAllMocks` does nothing for them.
  boardStore.set({});
  layoutStore.set({ workspaces: [], sessionStatusById: {} });
});

function setLayoutState(value: { workspaces: unknown[] }): void {
  layoutStore.set({ ...value, sessionStatusById: {} });
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
    expect(backend.setRailRun).toHaveBeenCalledWith("r1", "running", "s1");

    await setRailRunAction("ws-1", "r1", "paused", "s1");
    expect(get(orchestrations)["ws-1"].railRuns).toHaveLength(1);
    expect(get(orchestrations)["ws-1"].railRuns[0].state).toBe("paused");
  });

  it("upserts a step run in the store and persists it", async () => {
    await setStepRunAction("ws-1", "t1", "running", "sess-1", null);
    expect(get(orchestrations)["ws-1"].stepRuns).toEqual([
      { stepId: "t1", state: "running", sessionId: "sess-1", reason: null },
    ]);
    expect(backend.setStepRun).toHaveBeenCalledWith("t1", "running", "sess-1", null);
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
  function refsSay(branch: string): void {
    (gitStateModule as unknown as { __setGitStore: (v: unknown) => void }).__setGitStore({
      "ws-1": {
        refs: {
          worktrees: [
            { path: "/x/wt", head: "a", branch, isMain: false, locked: false, prunable: false },
          ],
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
      expect.stringContaining("uncommitted")
    );
    expect(backend.setRailRun).toHaveBeenCalledWith("r1", "paused", "s1");
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
      expect.stringContaining("already checked out")
    );
  });

  it("stalls every pending step of the current stage, not just the first", async () => {
    vi.mocked(backend.gitStatus).mockResolvedValue({ staged: [], unstaged: [] });
    vi.mocked(backend.gitCheckout).mockRejectedValue(new Error("nope"));

    await executeActions("ws-1", [SWITCH]);

    const stalled = vi.mocked(backend.setStepRun).mock.calls.map((c) => c[0]);
    expect(stalled).toEqual(["t1", "t2"]);
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
    expect(backend.setRailRun).toHaveBeenCalledWith("r1", "running", "s1");
  });

  it("Start is a no-op for a rail whose every stage is done", async () => {
    await setStepRunAction("ws-1", "t1", "done", null, null);
    vi.mocked(backend.setRailRun).mockClear();
    await startRail("ws-1", "r1");
    expect(backend.setRailRun).not.toHaveBeenCalled();
  });

  it("Pause keeps the current stage", async () => {
    await startRail("ws-1", "r1");
    await pauseRail("ws-1", "r1");
    expect(backend.setRailRun).toHaveBeenLastCalledWith("r1", "paused", "s1");
  });

  it("Resume picks up at the stage the pause left the rail on", async () => {
    await startRail("ws-1", "r1");
    await pauseRail("ws-1", "r1");
    vi.mocked(backend.setRailRun).mockClear();
    await resumeRail("ws-1", "r1");
    expect(backend.setRailRun).toHaveBeenCalledWith("r1", "running", "s1");
  });

  // An edit, a reorganize or a Clear done that lands while a rail is
  // paused can take the very stage it is parked on. Handing that id back
  // to the scheduler finds no stage and calls the rail COMPLETE, so
  // pressing Play would idle the rail instead of running it.
  it("Resume re-arms when the stage it was paused on is gone", async () => {
    await setRailRunAction("ws-1", "r1", "paused", "swept-stage");
    vi.mocked(backend.setRailRun).mockClear();
    await resumeRail("ws-1", "r1");
    expect(backend.setRailRun).toHaveBeenCalledWith("r1", "running", "s1");
  });

  it("Resume on a rail with nothing left to run lets the tick complete it", async () => {
    await setStepRunAction("ws-1", "t1", "done", null, null);
    await setRailRunAction("ws-1", "r1", "paused", "swept-stage");
    vi.mocked(backend.setRailRun).mockClear();
    await resumeRail("ws-1", "r1");
    expect(backend.setRailRun).toHaveBeenCalledWith("r1", "running", null);
  });

  // Spec O16. `boundRail` names page "p1", and the mocked layoutState
  // holds no workspaces at all, so the rail's binding is exactly the
  // stale one an unbound rail and a closed page both look like.
  it("Start gives the rail a page of its own, in the rail's checkout", async () => {
    vi.mocked(layoutStateModule.createPage).mockResolvedValue("p-new");
    await startRail("ws-1", "r1");
    expect(layoutStateModule.createPage).toHaveBeenCalledWith(
      "ws-1",
      expect.any(Function),
      1,
      "backend",
      // activate: false -- Start must not throw the human off the
      // Orchestration tab they pressed it in.
      { cwd: "/x/wt", activate: false }
    );
    expect(get(orchestrations)["ws-1"].rails[0].pageId).toBe("p-new");
  });

  it("Start leaves a rail whose page still exists on it", async () => {
    layoutStore.set({
      workspaces: [{ id: "ws-1", pages: [{ id: "p1", name: "backend" }] }],
      sessionStatusById: {},
    });
    await startRail("ws-1", "r1");
    expect(layoutStateModule.createPage).not.toHaveBeenCalled();
  });

  // A page is where agents land, not a precondition for running them:
  // the rail arms onto the Agents-page fallback instead of stalling.
  it("Start still arms the rail when the page cannot be created", async () => {
    vi.mocked(layoutStateModule.createPage).mockResolvedValue(null);
    await startRail("ws-1", "r1");
    expect(get(orchestrations)["ws-1"].rails[0].pageId).toBe("p1");
    expect(backend.setRailRun).toHaveBeenCalledWith("r1", "running", "s1");
  });

  it("Resume spawns the page too — it may have been closed while paused", async () => {
    vi.mocked(layoutStateModule.createPage).mockResolvedValue("p-new");
    await setRailRunAction("ws-1", "r1", "paused", "s1");
    await resumeRail("ws-1", "r1");
    expect(layoutStateModule.createPage).toHaveBeenCalledTimes(1);
    expect(get(orchestrations)["ws-1"].rails[0].pageId).toBe("p-new");
  });

  it("Retry returns a stalled step to pending and clears its reason", async () => {
    await setStepRunAction("ws-1", "t1", "stalled", "sess-1", "card file is missing");
    await retryStep("ws-1", "t1");
    expect(backend.setStepRun).toHaveBeenLastCalledWith("t1", "pending", null, null);
  });

  // The escape hatch. A step whose completion signal never arrives used
  // to cost the human the session AND the step -- the only way to get a
  // `running` row out of the daemon's way.
  it("Mark done files a running step done, keeping its session", async () => {
    await setStepRunAction("ws-1", "t1", "running", "sess-1", null);
    await markStepDone("ws-1", "t1");
    expect(backend.setStepRun).toHaveBeenLastCalledWith("t1", "done", "sess-1", null);
  });

  it("Mark done clears a stalled step's reason with it", async () => {
    await setStepRunAction("ws-1", "t1", "stalled", null, "Push branch exited with code 1");
    await markStepDone("ws-1", "t1");
    expect(backend.setStepRun).toHaveBeenLastCalledWith("t1", "done", null, null);
  });
});

describe("a rail spawns its own page when armed (spec O16)", () => {
  beforeEach(async () => {
    vi.mocked(backend.getOrchestration).mockResolvedValue(boundRail());
    vi.mocked(backend.setRailRun).mockResolvedValue(undefined);
    vi.mocked(backend.setOrchestration).mockResolvedValue(undefined);
    vi.mocked(layoutStateModule.createPage).mockResolvedValue("pg-new");
    setLayoutState({ workspaces: [{ id: "ws-1", pages: [] }] });
    await fetchOrchestration("ws-1");
  });



  // The Start button is still showing while the page is being created,
  // so a second click lands on an unbound rail.
  it("a double Start spawns one page, not two", async () => {
    let finish: (id: string | null) => void = () => {};
    vi.mocked(layoutStateModule.createPage).mockImplementation(
      () => new Promise<string | null>((resolve) => (finish = resolve))
    );
    const first = startRail("ws-1", "r1");
    const second = startRail("ws-1", "r1");
    finish("pg-new");
    await Promise.all([first, second]);
    expect(layoutStateModule.createPage).toHaveBeenCalledTimes(1);
  });




  it("a rail with nothing left to run spawns no page", async () => {
    vi.mocked(backend.setStepRun).mockResolvedValue(undefined);
    await setStepRunAction("ws-1", "t1", "done", null, null);
    vi.mocked(layoutStateModule.createPage).mockClear();
    await startRail("ws-1", "r1");
    expect(layoutStateModule.createPage).not.toHaveBeenCalled();
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
    await fetchOrchestration("ws-1");
  });

  it("a stall records the reason and pauses the owning rail", async () => {
    await executeActions("ws-1", [{ kind: "stall", stepId: "t1", reason: "card file is missing" }]);
    expect(backend.setStepRun).toHaveBeenCalledWith("t1", "stalled", null, "card file is missing");
    expect(backend.setRailRun).toHaveBeenCalledWith("r1", "paused", "s1");
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
      "agent exited before the card reached Done"
    );
    expect(backend.setRailRun).not.toHaveBeenCalled();
  });

  it("markDone keeps the session id so the transcript stays reachable", async () => {
    await setStepRunAction("ws-1", "t1", "running", "sess-1", null);
    await executeActions("ws-1", [{ kind: "markDone", stepId: "t1" }]);
    expect(backend.setStepRun).toHaveBeenLastCalledWith("t1", "done", "sess-1", null);
  });

  it("advance moves the rail's current stage", async () => {
    await executeActions("ws-1", [{ kind: "advance", railId: "r1", stageId: "s2" }]);
    expect(backend.setRailRun).toHaveBeenLastCalledWith("r1", "running", "s2");
  });

  it("complete returns the rail to idle", async () => {
    await executeActions("ws-1", [{ kind: "complete", railId: "r1" }]);
    expect(backend.setRailRun).toHaveBeenLastCalledWith("r1", "idle", null);
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
      expect.stringContaining("could not start")
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

    expect(backend.setStepRun).toHaveBeenCalledWith("t1", "running", "sess-9", null);
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
    });
    expect(backend.setStepRun).toHaveBeenCalledWith("t1", "running", "sess-9", null);
    expect(backend.setPlanFrontmatterField).toHaveBeenCalledWith("/x/a.md", "status", "In Progress");
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
    expect(backend.setRailRun).toHaveBeenCalledWith("r1", "running", "s3");
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
    expect(backend.setStepRun).toHaveBeenCalledWith("t1", "running", "sess-9", null);
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
    expect(backend.setStepRun).toHaveBeenCalledWith("t1", "running", "sess-9", null);
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
      "tool is no longer in the library"
    );
  });

  it("stalls when the session cannot be created, naming the tool", async () => {
    vi.mocked(layoutStateModule.createSessionOnPage).mockResolvedValue(null);
    await executeActions("ws-1", [{ kind: "launch", stepId: "t1" }]);
    expect(backend.setStepRun).toHaveBeenCalledWith(
      "t1",
      "stalled",
      null,
      "could not start Push branch"
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
    expect(backend.setStepRun).toHaveBeenCalledWith("t1", "running", "sess-9", null);
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
    workspaces: [{ pages: [{ layout: { type: "leaf", tabs: ["sess-1", "sess-9"] } }] }],
    // No status reported for either: a session the daemon has said
    // nothing about is not a finished one.
    sessionStatusById: {},
    // The scheduler ticks the workspace the human is looking at, so a
    // workspace nothing has activated is one it leaves alone.
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
    });
  });

  // The sibling was already running when the drop landed; re-running the
  // scheduler must not spawn a second session for it.
  it("leaves the step already running on that stage alone", async () => {
    await addStepToStageAction("ws-1", "s1", "/x/b.md", 2);
    expect(layoutStateModule.createSessionOnPage).toHaveBeenCalledTimes(1);
    expect(backend.setStepRun).not.toHaveBeenCalledWith("t1", expect.anything(), expect.anything(), expect.anything());
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
    expect(backend.setStepRun).toHaveBeenCalledWith("t2", "running", "sess-9", null);
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
    expect(backend.setStepRun).toHaveBeenCalledWith("late", "running", "sess-9", null);
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
    layoutStore.update((s) => ({ ...s, sessionStatusById: v }));

  it("is filed done and lets the rail move on, though its session is still live", async () => {
    status({ "sess-1": "idle" });
    await tick("ws-1");
    expect(backend.setStepRun).toHaveBeenCalledWith("t1", "done", "sess-1", null);
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
    layoutStore.update((s) => ({ ...s, sessionStatusById: { "sess-1": "idle" } }));
    await vi.waitFor(() =>
      expect(backend.setStepRun).toHaveBeenCalledWith("t1", "done", "sess-1", null)
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

  // One workspace, the one on screen -- which is what a single mounted
  // hub view amounted to. Running the rails of a workspace the human is
  // not in is a separate change, not a side effect of this one.
  it("leaves a workspace the human is not in alone", async () => {
    layoutStore.update((s) => ({
      ...s,
      activeWorkspaceId: "ws-2",
      sessionStatusById: { "sess-1": "idle" },
    }));
    await settle();
    expect(backend.setStepRun).not.toHaveBeenCalled();
  });

  // The plan is the one input the scheduler cannot subscribe to, so its
  // arrival ticks by hand. Without that, a rail left running across a
  // restart sits still until some unrelated push happens along -- the
  // same stall through a different door, and the one a human meets first
  // after reopening the app.
  it("picks up a rail whose plan lands last", async () => {
    __resetForTesting();
    stop = startScheduler();
    layoutStore.update((s) => ({ ...s, sessionStatusById: { "sess-1": "idle" } }));
    await settle();
    expect(backend.setStepRun).not.toHaveBeenCalled();

    await fetchOrchestration("ws-1");

    expect(backend.setStepRun).toHaveBeenCalledWith("t1", "done", "sess-1", null);
  });

  // The daemon's push is the third plan arrival, and the one an agent
  // editing rails over MCP comes in on. A step added to the stage a rail
  // is running has to start, not wait for the human to come back.
  it("picks up a plan the daemon pushes", async () => {
    stop?.();
    __resetForTesting();
    const unlisten = await initOrchestrationListeners();
    stop = unlisten;
    layoutStore.update((s) => ({ ...s, sessionStatusById: { "sess-1": "idle" } }));
    await settle();
    expect(backend.setStepRun).not.toHaveBeenCalled();

    tauriEvents.handlers.get("orchestration-changed")?.({
      payload: ["ws-1", agentToolRail()],
    });

    await vi.waitFor(() =>
      expect(backend.setStepRun).toHaveBeenCalledWith("t1", "done", "sess-1", null)
    );
  });

  it("stops when the app tears it down", async () => {
    stop?.();
    stop = null;
    layoutStore.update((s) => ({ ...s, sessionStatusById: { "sess-1": "idle" } }));
    await settle();
    expect(backend.setStepRun).not.toHaveBeenCalled();
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
