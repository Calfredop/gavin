// What the Demo Workstation answers to a workspace's orchestration
// commands -- and what its desk then does about them.
//
// A Device never runs a rail (ADR 0003). Start on a phone writes one run
// row, `running`, and it is the DESK's scheduler that then launches the
// rail's steps, marks them done as their cards reach the done column, and
// moves the rail on. So the demo plays both halves a Workstation has: the
// store that takes the phone's writes, and a desk that ticks after each
// one, announcing what it wrote the way the desktop host does
// (`orchestration-written`, `forwarding::announce_orchestration_written`).
//
// The desk here is the scheduler's rules cut down to what the demo's
// rails hold -- card steps, sequential stages and groups, the done
// column -- read through the desktop's own joins (`cardIndex`,
// `effectiveStatus`, `doneColumn`). A tool step has nothing to run on a
// machine that runs nothing, and stalls saying so.
import type { Board } from "$lib/board/kanban";
import { slugStatus } from "$lib/core/planBoard";
import * as workspace from "$lib/core/workspace";
import {
  cardIndex,
  doneColumn,
  effectiveStatus,
  firstUnfinishedStageId,
  isStepFinished,
  isToolStep,
  planIndex,
  stageMode,
  stepStateOf,
  type CardEntry,
  type Orchestration,
  type Rail,
  type RailRun,
  type RailState,
  type Stage,
  type StepRun,
  type StepState,
} from "$lib/orchestration/orchestration";
import * as layout from "$lib/panes/layout";
import { DemoFailure, text, type Answer, type DemoCommand, type DemoContext } from "$companion/demo/answer";
import { CARD_COMMANDS } from "$companion/demo/cardCommands";
import { launch } from "$companion/demo/sessions";

/// Who wrote, as the host names it: the desk's window, or a Device.
export const DESK_ORIGIN = "main";
export const DEVICE_ORIGIN = "companion";

const RAIL_STATES: readonly RailState[] = ["idle", "running", "paused"];
const STEP_STATES: readonly StepState[] = ["pending", "running", "done", "skipped", "stalled"];

/// A workspace's plan, by the id a command names.
function planOf(demo: DemoContext, workspaceId: unknown): Orchestration {
  const plan = typeof workspaceId === "string" ? demo.state.orchestrations[workspaceId] : undefined;
  if (!plan) throw new DemoFailure(`the Demo Workstation has no workspace ${JSON.stringify(workspaceId)}`);
  return plan;
}

/// The workspace a rail or step id belongs to. The wire's run writes name
/// one (`workspaceId`), but the daemon keys runs by id alone, and so does
/// this.
function workspaceHolding(demo: DemoContext, holds: (plan: Orchestration) => boolean): string | null {
  return Object.entries(demo.state.orchestrations).find(([, plan]) => holds(plan))?.[0] ?? null;
}

function optional(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/// Says a workspace's orchestration was written, as the host says it.
function announce(demo: DemoContext, origin: string, workspaceId: string): void {
  demo.emit("orchestration-written", { origin, payload: workspaceId });
}

// ---- The store ------------------------------------------------------

/// The daemon's guard on a plan write: a step whose agent is live cannot
/// be taken off the plan from under it (`replace_plan`).
function refuseDroppingALiveStep(demo: DemoContext, plan: Orchestration, rails: Rail[]): void {
  const kept = new Set(rails.flatMap((r) => r.stages.flatMap((s) => s.steps.map((t) => t.id))));
  const live = new Set(demo.state.sessions.map((s) => s.id));
  for (const rail of plan.rails) {
    for (const stage of rail.stages) {
      for (const step of stage.steps) {
        const run = plan.stepRuns.find((r) => r.stepId === step.id);
        if (kept.has(step.id) || run?.state !== "running" || !run.sessionId || !live.has(run.sessionId)) continue;
        throw new DemoFailure(
          `step ${step.id} (${step.cardPath}) is running — pause or let it finish before removing it`
        );
      }
    }
  }
}

function writeRailRun(plan: Orchestration, run: RailRun): void {
  plan.railRuns = [...plan.railRuns.filter((r) => r.railId !== run.railId), run];
}

/// The daemon's COALESCE: a null conversation, launch folder or budget
/// leaves the stored one alone.
function writeStepRun(plan: Orchestration, run: StepRun): void {
  const before = plan.stepRuns.find((r) => r.stepId === run.stepId);
  plan.stepRuns = [
    ...plan.stepRuns.filter((r) => r.stepId !== run.stepId),
    {
      ...run,
      conversationId: run.conversationId ?? before?.conversationId ?? null,
      launchCwd: run.launchCwd ?? before?.launchCwd ?? null,
      resumeAttempts: run.resumeAttempts ?? before?.resumeAttempts ?? null,
    },
  ];
}

// ---- The desk -------------------------------------------------------

/// Where a rail's step runs: the rail's checkout, else the card's context.
function cwdFor(rail: Rail, entry: CardEntry): string {
  return rail.worktreePath ?? entry.contextFolder;
}

/// Puts a step's session on its rail's page, making the page -- named
/// after the rail, and bound to it -- when the rail has none. Without
/// taking the desk there: the human who started it is somewhere else.
function placeOnRailPage(demo: DemoContext, workspaceId: string, rail: Rail, sessionId: string): void {
  const ws = demo.state.workspaces.workspaces.find((w) => w.id === workspaceId);
  if (!ws) return;
  const page = ws.pages.find((p) => p.id === rail.pageId);
  let data = demo.state.workspaces;
  if (page) {
    const anchor = layout.allSessionIds(page.layout)[0];
    data = workspace.updatePageLayout(data, ws.id, page.id, layout.addTab(page.layout, anchor, sessionId));
  } else {
    const pageId = `p-demo-rail-${rail.id}`;
    data = workspace.createPage(data, ws.id, pageId, rail.name, { type: "leaf", tabs: [sessionId], activeTabIndex: 0 });
    if (ws.activePageId) data = workspace.switchPage(data, ws.id, ws.activePageId);
    rail.pageId = pageId;
  }
  demo.state.workspaces = data;
  demo.emit("workspaces-synced", { origin: DESK_ORIGIN, data });
}

/// A card step's launch: an agent on the rail's page, bound to the card,
/// the card moved to In Progress, the step running.
function launchStep(demo: DemoContext, workspaceId: string, rail: Rail, stepId: string, entry: CardEntry): void {
  const plan = demo.state.orchestrations[workspaceId];
  const cwd = cwdFor(rail, entry);
  const sessionId = launch(demo, {
    cwd,
    command: `claude "Work the card ${entry.plan.path}"`,
    place: (id) => placeOnRailPage(demo, workspaceId, rail, id),
  });
  demo.state.sessionNames[sessionId] = entry.plan.title;
  demo.emit("session-named", [sessionId, entry.plan.title]);
  CARD_COMMANDS.link_card_session({ workspaceId, path: entry.plan.path, sessionId, cwd }, demo);
  CARD_COMMANDS.set_plan_frontmatter_field({ path: entry.plan.path, key: "status", value: "In Progress" }, demo);
  writeStepRun(plan, { stepId, state: "running", sessionId, reason: null, launchCwd: cwd, resumeAttempts: 0 });
}

/// The steps of a stage the rail may launch now: all of a parallel
/// stage's, and the first unfinished one of a sequence.
function launchable(plan: Orchestration, stage: Stage): string[] {
  const steps = [...stage.steps].sort((a, b) => a.position - b.position);
  if (stageMode(stage) === "parallel") return steps.map((s) => s.id);
  const next = steps.find((s) => !isStepFinished(stepStateOf(plan, s.id)));
  return next ? [next.id] : [];
}

function isDone(entry: CardEntry | undefined, plans: Map<string, CardEntry>, board: Board | undefined): boolean {
  const done = board ? doneColumn(board) : null;
  if (!entry || !done) return false;
  return slugStatus(effectiveStatus(entry, plans) ?? "") === slugStatus(done.name);
}

/// One pass over one rail. Returns whether it wrote anything.
function runRail(demo: DemoContext, workspaceId: string, rail: Rail): boolean {
  const plan = demo.state.orchestrations[workspaceId];
  const board = demo.state.boards[workspaceId];
  let wrote = false;
  // Bounded: each round either writes and moves on, or stops.
  for (let round = 0; round <= rail.stages.length; round++) {
    const run = plan.railRuns.find((r) => r.railId === rail.id);
    if (run?.state !== "running") return wrote;
    const cards = cardIndex(demo.state.trees[workspaceId]);
    const plans = planIndex(cards);
    const stage = rail.stages.find((s) => s.id === run.currentStageId);

    if (stage) {
      // A running step whose card reached the done column is done.
      for (const step of stage.steps) {
        if (stepStateOf(plan, step.id) !== "running" || isToolStep(step)) continue;
        if (!isDone(cards.get(step.cardPath), plans, board)) continue;
        writeStepRun(plan, { stepId: step.id, state: "done", sessionId: null, reason: null });
        wrote = true;
      }
      for (const stepId of launchable(plan, stage)) {
        const step = stage.steps.find((s) => s.id === stepId)!;
        if (stepStateOf(plan, stepId) !== "pending") continue;
        const entry = cards.get(step.cardPath);
        if (isToolStep(step)) {
          writeStepRun(plan, { stepId, state: "stalled", sessionId: null, reason: "the Demo Workstation runs no tools" });
        } else if (!entry) {
          writeStepRun(plan, { stepId, state: "stalled", sessionId: null, reason: "card file is missing" });
        } else if (isDone(entry, plans, board)) {
          // Rule 1: a card already done is not run again.
          writeStepRun(plan, { stepId, state: "done", sessionId: null, reason: null });
        } else {
          launchStep(demo, workspaceId, rail, stepId, entry);
        }
        wrote = true;
      }
      // A stalled step pauses its rail, for a human to look at.
      if (stage.steps.some((s) => stepStateOf(plan, s.id) === "stalled")) {
        writeRailRun(plan, { railId: rail.id, state: "paused", currentStageId: stage.id });
        return true;
      }
      if (!stage.steps.every((s) => isStepFinished(stepStateOf(plan, s.id)))) return wrote;
    }
    // The stage is finished, or gone: on to the next with work in it, or
    // the rail is complete.
    const next = firstUnfinishedStageId(rail, plan);
    writeRailRun(plan, { railId: rail.id, state: next ? "running" : "idle", currentStageId: next });
    wrote = true;
    if (!next) return wrote;
  }
  return wrote;
}

/// One pass of the desk's scheduler over a workspace, announced when it
/// wrote anything.
export function runRails(demo: DemoContext, workspaceId: string): void {
  const plan = demo.state.orchestrations[workspaceId];
  if (!plan) return;
  let wrote = false;
  for (const rail of [...plan.rails].sort((a, b) => a.position - b.position)) {
    if (runRail(demo, workspaceId, rail)) wrote = true;
  }
  if (wrote) announce(demo, DESK_ORIGIN, workspaceId);
}

/// ...over every workspace: what the desk does as time passes.
export function runAllRails(demo: DemoContext): void {
  for (const workspaceId of Object.keys(demo.state.orchestrations)) runRails(demo, workspaceId);
}

/// A Device's write taken: said to everyone, and then the desk ticks, as
/// the desk's window does when it hears one.
function taken(demo: DemoContext, workspaceId: string): void {
  announce(demo, DEVICE_ORIGIN, workspaceId);
  runRails(demo, workspaceId);
}

export const RAIL_COMMANDS: Record<string, DemoCommand> = {
  get_orchestration: (args, demo): Answer<"getOrchestration"> => planOf(demo, args.workspaceId),

  set_orchestration: (args, demo): Answer<"setOrchestration"> => {
    const workspaceId = text(args, "workspaceId");
    const plan = planOf(demo, workspaceId);
    const rails = (Array.isArray(args.rails) ? args.rails : []) as Rail[];
    refuseDroppingALiveStep(demo, plan, rails);
    const railIds = new Set(rails.map((r) => r.id));
    const stepIds = new Set(rails.flatMap((r) => r.stages.flatMap((s) => s.steps.map((t) => t.id))));
    plan.rails = rails;
    plan.conflictNotes = Array.isArray(args.conflictNotes) ? args.conflictNotes : [];
    plan.railRuns = plan.railRuns.filter((r) => railIds.has(r.railId));
    plan.stepRuns = plan.stepRuns.filter((r) => stepIds.has(r.stepId));
    taken(demo, workspaceId);
  },

  set_rail_run: (args, demo): Answer<"setRailRun"> => {
    const railId = text(args, "railId");
    const state = text(args, "stateValue") as RailState;
    if (!RAIL_STATES.includes(state)) throw new DemoFailure(`unknown rail state: ${state}`);
    const workspaceId =
      optional(args.workspaceId) ?? workspaceHolding(demo, (p) => p.rails.some((r) => r.id === railId));
    if (!workspaceId) throw new DemoFailure(`no rail ${railId}`);
    writeRailRun(planOf(demo, workspaceId), { railId, state, currentStageId: optional(args.currentStageId) });
    taken(demo, workspaceId);
  },

  set_step_run: (args, demo): Answer<"setStepRun"> => {
    const stepId = text(args, "stepId");
    const state = text(args, "stateValue") as StepState;
    if (!STEP_STATES.includes(state)) throw new DemoFailure(`unknown step state: ${state}`);
    const workspaceId =
      optional(args.workspaceId) ??
      workspaceHolding(demo, (p) => p.rails.some((r) => r.stages.some((s) => s.steps.some((t) => t.id === stepId))));
    if (!workspaceId) throw new DemoFailure(`no step ${stepId}`);
    writeStepRun(planOf(demo, workspaceId), {
      stepId,
      state,
      sessionId: optional(args.sessionId),
      reason: optional(args.reason),
      conversationId: optional(args.conversationId),
      launchCwd: optional(args.launchCwd),
      resumeAttempts: typeof args.resumeAttempts === "number" ? args.resumeAttempts : null,
    });
    taken(demo, workspaceId);
  },
};
