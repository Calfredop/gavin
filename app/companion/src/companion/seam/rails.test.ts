// A workspace's rails, acted on from the phone: every action's traffic,
// read at the wire against the Demo Workstation, and what the phone hears
// back as the Workstation's desk runs what it armed.
//
// "The Companion never starts the rail scheduler. The desktop window
// stays the only place rails tick." (spec, Forwarding; ADR 0003.) Two
// things hold that here. At the wire: each press is the one row the
// human's action writes, and every launch that follows is the DESK's --
// the demo plays it (railCommands.ts), as a Workstation's desk ticks when
// its host announces a Device's write. And in the page: the scheduler's
// two doors are watched for the whole of every test below, and never
// opened.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { get } from "svelte/store";
import { answerDialog, dialogRequest } from "$lib/core/dialog";
import { kanbanState } from "$lib/board/kanbanState";
import { gavinTrees } from "$lib/core/gavinState";
import { handleSessionStatusChanged, layoutState } from "$lib/core/layoutState";
import { stepStateOf } from "$lib/orchestration/orchestration";
import * as scheduler from "$lib/orchestration/orchestrationState";
import { orchestrations, saveErrors } from "$lib/orchestration/orchestrationState";
import { allSessionIds } from "$lib/panes/layout";
import type { BundleMessage } from "$companion/channel/messages";
import { loopback } from "$companion/channel/port";
import { CARD_COMMANDS, cardNamed } from "$companion/demo/cardCommands";
import { runAllRails } from "$companion/demo/railCommands";
import { DEMO } from "$companion/demo/sampleData";
import { createDemoWorkstation, type DemoWorkstation } from "$companion/demo/workstation";
import { disconnectChannel } from "$companion/remote/connection";
import {
  addCard,
  deleteRailAsked,
  loadRails,
  moveStage,
  newRail,
  organizeRails,
  pressRail,
  removeStageAsked,
  removeStep,
  renameRail,
  reorganizeRail,
  resetRailAsked,
  setStageMode,
} from "$companion/state/rails";
import { startedHere } from "$companion/state/sessions";
import { closeTerminal, connectWorkstation, openWorkspace, showSurface, view } from "$companion/state/workstation";
import { agentPresses, cardsToPlace, railRows } from "$companion/surfaces/phoneRails";
import { settle } from "$companion/testing/demoBench";
import { deviceStorage, resetDesktopStores } from "$companion/testing/desktopStores";

// The scheduler's doors, watched. Each still does what it does -- a door
// the bundle opened would open -- so the only change is that it is seen.
vi.mock("$lib/orchestration/orchestrationState", async (importOriginal) => {
  const actual = await importOriginal<typeof import("$lib/orchestration/orchestrationState")>();
  return {
    ...actual,
    startScheduler: vi.fn(actual.startScheduler),
    initOrchestrationListeners: vi.fn(actual.initOrchestrationListeners),
  };
});

let disconnect: (() => void) | null = null;

beforeEach(() => {
  // The desk's re-read waits out a burst of writes on a timer.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});

afterEach(() => {
  expect(scheduler.startScheduler, "the bundle started the rail scheduler").not.toHaveBeenCalled();
  expect(scheduler.initOrchestrationListeners, "the bundle opened the desk's rail duties").not.toHaveBeenCalled();
  disconnect?.();
  disconnect = null;
  disconnectChannel();
  resetDesktopStores();
  vi.clearAllMocks();
  vi.useRealTimers();
});

const ATLAS_PLANS = `${DEMO.atlasRoot}/.gavin-root/plans`;

/// What a scheduler writes, and what a launch is made of. From the phone,
/// only a human's own action may send one of these, and the tests say
/// which.
const DESK_WORK = [
  "set_step_run",
  "create_session",
  "link_card_session",
  "set_plan_frontmatter_field",
  "get_tools",
  "git_checkout",
  "git_worktree_add",
];

async function visit(demo: DemoWorkstation = createDemoWorkstation()): Promise<DemoWorkstation> {
  disconnect = await connectWorkstation(loopback(demo), deviceStorage());
  await settle();
  openWorkspace(DEMO.atlas);
  showSurface("rails");
  await loadRails(DEMO.atlas);
  await settle();
  return demo;
}

/// Lets the phone hear what the desk did: the announcement, the re-read
/// it waits for, and the answer.
async function heard(): Promise<void> {
  await settle();
  await vi.advanceTimersByTimeAsync(300);
  await settle();
}

/// What the phone asked the Workstation to change from a point on, with
/// the arguments. Reads are the phone catching up, not something it did.
function wroteSince(demo: DemoWorkstation, from: number): { cmd: string; args: Record<string, unknown> }[] {
  return demo
    .received()
    .slice(from)
    .flatMap((m: BundleMessage) => (m.type === "invoke" ? [{ cmd: m.cmd, args: m.args }] : []))
    .filter((s) => !s.cmd.startsWith("get_") && s.cmd !== "worktree_setup");
}

const plan = () => get(orchestrations)[DEMO.atlas];
const rail = (name: string) => railRows({ orch: plan(), tree: undefined, board: undefined }).find((r) => r.name === name)!;
const run = (stepId: string) => plan().stepRuns.find((r) => r.stepId === stepId);

async function answer(confirmed: boolean): Promise<void> {
  await settle();
  const request = get(dialogRequest);
  if (!request) throw new Error("no dialog is up");
  answerDialog(request.id, confirmed, false);
}

/// The desk's agent finishing a card: the card to Done, then a pass of
/// the desk's scheduler.
function finishedAtDesk(demo: DemoWorkstation, fileName: string): void {
  CARD_COMMANDS.set_plan_frontmatter_field({ path: cardNamed(demo, fileName)!, key: "status", value: "Done" }, demo);
  runAllRails(demo);
}

describe("the scheduler's doors", () => {
  it("are watched: a call to either would be seen", () => {
    const stop = scheduler.startScheduler();
    stop();
    expect(scheduler.startScheduler).toHaveBeenCalledTimes(1);
    vi.clearAllMocks();
  });
});

describe("starting a rail from the phone", () => {
  it("arms it with one write, and the desk runs it", async () => {
    const demo = await visit();
    const at = demo.received().length;
    await pressRail(DEMO.atlas, "rail-fixes", "start");
    await heard();

    expect(wroteSince(demo, at)).toEqual([
      {
        cmd: "set_rail_run",
        args: { railId: "rail-fixes", stateValue: "running", currentStageId: "stage-fixes-1", workspaceId: DEMO.atlas },
      },
    ]);
    // The desk launched the first stage's card, on a page of the rail's
    // own, and the phone heard all of it.
    const sessionId = run("step-flaky-expiry")?.sessionId;
    expect(run("step-flaky-expiry")).toMatchObject({ state: "running", sessionId: "s-demo-1" });
    expect(rail("fixes")).toMatchObject({ state: "running", press: "pause" });
    const page = get(layoutState).workspaces.find((w) => w.id === DEMO.atlas)!.pages.find((p) => p.name === "fixes");
    expect(page && allSessionIds(page.layout)).toEqual([sessionId]);
    expect(plan().rails.find((r) => r.id === "rail-fixes")!.pageId).toBe(page!.id);
    const card = get(gavinTrees)[DEMO.atlas].contexts[0].plans.find((p) => p.fileName === "flaky-expiry-test.md");
    expect(card?.status).toBe("In Progress");
  });

  it("is left to the desk even as everything a scheduler wakes for moves on the phone", async () => {
    const demo = await visit();
    await pressRail(DEMO.atlas, "rail-fixes", "start");
    await heard();
    // The desk's agent finishes; the next stage is owed a launch, and the
    // phone hears about all of it before the desk has acted on it.
    CARD_COMMANDS.set_plan_frontmatter_field(
      { path: cardNamed(demo, "flaky-expiry-test.md")!, key: "status", value: "Done" },
      demo
    );
    handleSessionStatusChanged(run("step-flaky-expiry")!.sessionId!, "idle");
    layoutState.update((s) => ({ ...s }));
    const at = demo.received().length;
    await heard();

    expect(wroteSince(demo, at).map((s) => s.cmd).filter((cmd) => DESK_WORK.includes(cmd))).toEqual([]);
    expect(stepStateOf(plan(), "step-proration")).toBe("pending");

    // ...and the desk does it on its next pass.
    runAllRails(demo);
    await heard();
    expect(run("step-flaky-expiry")?.state).toBe("done");
    expect(run("step-proration")).toMatchObject({ state: "running", sessionId: "s-demo-2" });
    expect(rail("fixes").stages.map((s) => s.current)).toEqual([false, true]);
  });
});

describe("pausing and resuming", () => {
  it("are one write each; a paused rail is not moved on, and a resumed one is, by the desk", async () => {
    const demo = await visit();
    await pressRail(DEMO.atlas, "rail-fixes", "start");
    await heard();

    let at = demo.received().length;
    await pressRail(DEMO.atlas, "rail-fixes", "pause");
    await heard();
    expect(wroteSince(demo, at)).toEqual([
      {
        cmd: "set_rail_run",
        args: { railId: "rail-fixes", stateValue: "paused", currentStageId: "stage-fixes-1", workspaceId: DEMO.atlas },
      },
    ]);
    expect(rail("fixes")).toMatchObject({ state: "paused", press: "resume" });

    finishedAtDesk(demo, "flaky-expiry-test.md");
    await heard();
    expect(stepStateOf(plan(), "step-proration")).toBe("pending");
    expect(rail("fixes").state).toBe("paused");

    at = demo.received().length;
    await pressRail(DEMO.atlas, "rail-fixes", "resume");
    await heard();
    expect(wroteSince(demo, at)).toEqual([
      {
        cmd: "set_rail_run",
        args: { railId: "rail-fixes", stateValue: "running", currentStageId: "stage-fixes-1", workspaceId: DEMO.atlas },
      },
    ]);
    // The desk marked the finished step done, moved on and launched.
    expect(run("step-flaky-expiry")?.state).toBe("done");
    expect(run("step-proration")?.state).toBe("running");
  });

  it("hears the desk finish a rail, and offers nothing more", async () => {
    const demo = await visit();
    await pressRail(DEMO.atlas, "rail-fixes", "start");
    await heard();
    finishedAtDesk(demo, "flaky-expiry-test.md");
    finishedAtDesk(demo, "proration.md");
    await heard();
    expect(rail("fixes")).toMatchObject({ state: "idle", finished: true, press: null });
  });
});

describe("resetting a rail", () => {
  it("asks, then writes every step back and the rail idle -- and launches nothing", async () => {
    const demo = await visit();
    await pressRail(DEMO.atlas, "rail-fixes", "start");
    await heard();
    await pressRail(DEMO.atlas, "rail-fixes", "pause");
    await heard();
    const at = demo.received().length;
    const reset = resetRailAsked(DEMO.atlas, "rail-fixes");
    await answer(true);
    await reset;
    await heard();

    expect(wroteSince(demo, at).map((s) => [s.cmd, s.args.stepId ?? s.args.railId, s.args.stateValue])).toEqual([
      ["set_step_run", "step-flaky-expiry", "pending"],
      ["set_step_run", "step-proration", "pending"],
      ["set_rail_run", "rail-fixes", "idle"],
    ]);
    expect(rail("fixes")).toMatchObject({ state: "idle", press: "start" });
  });

  it("writes nothing when the question is declined", async () => {
    const demo = await visit();
    const at = demo.received().length;
    const reset = resetRailAsked(DEMO.atlas, "rail-auth");
    await answer(false);
    await reset;
    expect(wroteSince(demo, at)).toEqual([]);
  });
});

describe("editing orchestration", () => {
  it("makes, names and fills a rail, each a plan write the phone hears back", async () => {
    const demo = await visit();
    const at = demo.received().length;
    const id = await newRail(DEMO.atlas);
    expect(await renameRail(DEMO.atlas, id, "  billing ")).toBeNull();
    expect(await addCard(DEMO.atlas, id, `${ATLAS_PLANS}/oauth-upgrade.md`, null)).toBeNull();
    const stageId = plan().rails.find((r) => r.id === id)!.stages[0].id;
    expect(await addCard(DEMO.atlas, id, `${DEMO.atlasRoot}/services/billing/.gavin/plans/invoice-pdf.md`, stageId)).toBeNull();
    expect(await setStageMode(DEMO.atlas, stageId, "sequence")).toBeNull();
    await heard();

    expect(wroteSince(demo, at).map((s) => s.cmd)).toEqual(Array(5).fill("set_orchestration"));
    const stored = demo.state.orchestrations[DEMO.atlas].rails.find((r) => r.id === id)!;
    expect(stored).toMatchObject({ name: "billing", position: 2 });
    expect(stored.stages).toHaveLength(1);
    expect(stored.stages[0]).toMatchObject({ mode: "sequence" });
    expect(stored.stages[0].steps.map((s) => s.cardPath.slice(s.cardPath.lastIndexOf("/") + 1))).toEqual([
      "oauth-upgrade.md",
      "invoice-pdf.md",
    ]);
    // A plan edit arms nothing.
    expect(rail("billing")).toMatchObject({ state: "idle", press: "start" });
    expect(stored.stages[0].steps.every((s) => stepStateOf(demo.state.orchestrations[DEMO.atlas], s.id) === "pending")).toBe(true);
  });

  it("moves a stage, takes a step off, and deletes a rail after asking", async () => {
    const demo = await visit();
    const at = demo.received().length;
    expect(await moveStage(DEMO.atlas, "rail-fixes", "stage-fixes-2", -1)).toBeNull();
    expect(demo.state.orchestrations[DEMO.atlas].rails[1].stages.map((s) => [s.id, s.position])).toEqual([
      ["stage-fixes-2", 0],
      ["stage-fixes-1", 1],
    ]);
    // Already first: nothing to send.
    expect(await moveStage(DEMO.atlas, "rail-fixes", "stage-fixes-2", -1)).toBeNull();
    expect(await removeStep(DEMO.atlas, "step-proration")).toBeNull();
    const deleting = deleteRailAsked(DEMO.atlas, "rail-fixes");
    await answer(true);
    expect(await deleting).toBeNull();
    await heard();

    expect(wroteSince(demo, at).map((s) => s.cmd)).toEqual(Array(3).fill("set_orchestration"));
    expect(demo.state.orchestrations[DEMO.atlas].rails.map((r) => r.name)).toEqual(["auth"]);
    expect(plan().rails.map((r) => r.name)).toEqual(["auth"]);
  });

  it("adds a card to the stage a rail is running, and it is the desk that starts it", async () => {
    const demo = await visit();
    const at = demo.received().length;
    expect(await addCard(DEMO.atlas, "rail-auth", `${ATLAS_PLANS}/oauth-upgrade.md`, "stage-auth-1")).toBeNull();
    await heard();

    expect(wroteSince(demo, at).map((s) => s.cmd)).toEqual(["set_orchestration"]);
    // Joining a one-step stage makes a sequence group: it queues behind
    // the step still running...
    const stage = plan().rails[0].stages[0];
    expect(stage.mode).toBe("sequence");
    const added = stage.steps.find((s) => s.cardPath.endsWith("/oauth-upgrade.md"))!;
    expect(stepStateOf(plan(), added.id)).toBe("pending");
    // ...and the desk starts it once that one is done.
    finishedAtDesk(demo, "token-refresh.md");
    await heard();
    expect(wroteSince(demo, at).map((s) => s.cmd)).toEqual(["set_orchestration"]);
    expect(run(added.id)).toMatchObject({ state: "running", sessionId: "s-demo-1" });
  });

  it("is refused taking off a step whose agent is live, and the phone puts it back", async () => {
    const demo = await visit();
    const at = demo.received().length;
    const refusal = await removeStageAsked(DEMO.atlas, "stage-auth-1");
    await heard();

    expect(wroteSince(demo, at).map((s) => s.cmd)).toEqual(["set_orchestration"]);
    expect(refusal).toMatch(/step-token-refresh .* is running — pause or let it finish before removing it/);
    expect(get(saveErrors)[DEMO.atlas]).toBe(refusal);
    expect(plan().rails[0].stages.map((s) => s.id)).toEqual(["stage-auth-1", "stage-auth-2"]);
  });

  it("asks before taking off a group, and sends nothing when declined", async () => {
    const demo = await visit();
    await addCard(DEMO.atlas, "rail-fixes", `${ATLAS_PLANS}/oauth-upgrade.md`, "stage-fixes-1");
    await heard();
    const at = demo.received().length;
    const removing = removeStageAsked(DEMO.atlas, "stage-fixes-1");
    await answer(false);
    expect(await removing).toBeNull();
    expect(wroteSince(demo, at)).toEqual([]);
  });
});

describe("organizing with an agent from the phone", () => {
  /// The presses as the surface reads them, from what the phone holds now.
  function presses() {
    const workspace = get(layoutState).workspaces.find((w) => w.id === DEMO.atlas)!;
    const unplaced = cardsToPlace({
      orch: plan(),
      tree: get(gavinTrees)[DEMO.atlas],
      board: get(kanbanState)[DEMO.atlas],
    });
    return agentPresses({ workspace, daemonBlocked: null, unplacedCount: unplaced.length });
  }
  const run = () => get(layoutState).workspaces.find((w) => w.id === DEMO.atlas)!.orchestrationAgent;

  it("is the desk's Organize: an agent in the root, recorded as the workspace's run, shown here", async () => {
    const demo = await visit();
    const at = demo.received().length;
    expect(await organizeRails(DEMO.atlas, presses().organize)).toBeNull();
    await heard();

    const sent = wroteSince(demo, at);
    const created = sent.find((s) => s.cmd === "create_session")!;
    expect(created.args).toMatchObject({ cwd: DEMO.atlasRoot, workspaceRoot: DEMO.atlasRoot });
    expect(String(created.args.command)).toContain("UNPLACED cards on rails");
    const sessionId = run()?.sessionId;
    expect(run()).toEqual({ sessionId, label: "Organize", railId: null });
    expect(sent).toContainEqual({
      cmd: "set_workspace_settings",
      args: { workspaceId: DEMO.atlas, patch: { orchestrationAgent: { sessionId, label: "Organize", railId: null } } },
    });
    // The run is the phone's to show and the desk's to place: its
    // terminal opens here, and the phone only notes it started it.
    expect(get(view)).toMatchObject({ workspaceId: DEMO.atlas, sessionId });
    expect(get(startedHere)).toEqual({ [sessionId!]: DEMO.atlas });
    // An agent was asked to change the plan; the phone changed none of it.
    expect(sent.map((s) => s.cmd).filter((cmd) => cmd !== "create_session" && DESK_WORK.includes(cmd))).toEqual([]);
  });

  it("shows the run holding the slot instead of starting a second, from any press", async () => {
    const demo = await visit();
    await organizeRails(DEMO.atlas, presses().organize);
    await heard();
    const sessionId = run()!.sessionId;
    closeTerminal();
    expect(get(view).sessionId).toBeNull();

    const at = demo.received().length;
    expect(presses().reorganize("rail-fixes").kind).toBe("jump");
    expect(await reorganizeRail(DEMO.atlas, "rail-fixes", presses().reorganize("rail-fixes"))).toBeNull();
    expect(await organizeRails(DEMO.atlas, presses().organize)).toBeNull();
    await heard();
    expect(wroteSince(demo, at).map((s) => s.cmd)).not.toContain("create_session");
    expect(get(view)).toMatchObject({ sessionId });
  });

  it("is a rail's Reorganize from its editor, the run named after the rail", async () => {
    const demo = await visit();
    const at = demo.received().length;
    expect(await reorganizeRail(DEMO.atlas, "rail-fixes", presses().reorganize("rail-fixes"))).toBeNull();
    await heard();
    expect(run()).toMatchObject({ label: "Reorganize “fixes”", railId: "rail-fixes" });
    expect(String(wroteSince(demo, at).find((s) => s.cmd === "create_session")!.args.command)).toContain('reorganize the rail "fixes" — that rail only');
  });

  it("says why it cannot start, and asks the Workstation nothing", async () => {
    const demo = await visit();
    const at = demo.received().length;
    const blocked = { kind: "blocked", tip: "Nothing is left to place" } as const;
    expect(await organizeRails(DEMO.atlas, blocked)).toBe("Nothing is left to place");
    expect(wroteSince(demo, at)).toEqual([]);
  });
});
