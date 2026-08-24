// The reactive half of orchestration: the per-workspace store, its
// persistence, and the tick that executes nextActions. Every decision
// lives in orchestration.ts; this module only holds state and performs
// effects. Shaped after kanbanState.ts on purpose -- same optimistic
// mutate, same rollback-unless-superseded, same pendingSaves guard
// against a refresh clobbering an in-flight save.

import { writable, get } from "svelte/store";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import * as backend from "./backend";
import {
  nextActions,
  firstUnfinishedStageId,
  cardIndex,
  doneColumn,
  addRail,
  renameRail,
  bindRail,
  deleteRail,
  addStage,
  addStep,
  addToolStep,
  removeStep,
  railStateOf,
  addCardAsStage,
  addToolAsStage,
  dropImpossibleSteps,
  setStepParams,
  moveStepIntoStage,
  moveStepToNewStage,
  splitStageIntoSequence,
  isToolStep,
  stepParams,
  findCardPlacement,
  sendCardToRail,
  railCardsToMove,
  railDoneStepIds,
  removeSteps,
} from "./orchestration";
import type { Action, Orchestration, Rail, RailState, StepState, Step } from "./orchestration";
import { findTool, resolveToolBody } from "./orchestrationTools";
import { libraryFor, toolRecords } from "./toolsState";
import { kanbanState, linkCardSessionAction } from "./kanbanState";
import { gavinTrees, patchPlanField } from "./gavinState";
import { gitStore } from "./gitState";
import { layoutState, resolvedAgentFor, createSessionOnPage, sessionExits, setSessionName } from "./layoutState";
import { allSessionIds } from "./layout";
import {
  composeTaskPrompt,
  composePlanPrompt,
  buildRunCommand,
  provisionalSessionName,
  buildToolCommand,
  runStatusNeeded,
} from "./cardRun";
import { stripFrontmatter } from "./planChecklist";
import { pasteToMainAgent } from "./cardRunActions";

export const orchestrations = writable<Record<string, Orchestration>>({});

export const saveErrors = writable<Record<string, string>>({});

export function dismissSaveError(workspaceId: string): void {
  saveErrors.update((e) => {
    if (!(workspaceId in e)) return e;
    const { [workspaceId]: _removed, ...rest } = e;
    return rest;
  });
}

/// Which conflict badge is hovered, app-wide. Hovering a box row lights
/// its chips; hovering a chip lights its rows. Ephemeral UI state, never
/// persisted -- which is why it lives here and not in the plan.
export const highlightedConflict = writable<number | null>(null);

const pendingSaves = new Map<string, number>();

export async function fetchOrchestration(workspaceId: string): Promise<void> {
  if (workspaceId in get(orchestrations)) return;
  try {
    const orch = dropImpossibleSteps(await backend.getOrchestration(workspaceId));
    orchestrations.update((s) => ({ ...s, [workspaceId]: orch }));
  } catch {
    // Leave it unset; the tab renders its loading state and the next
    // mount retries.
  }
}

/// Re-reads from SQLite. Skipped while a save is in flight, and checked
/// again afterwards for saves that started meanwhile.
export async function refreshOrchestration(workspaceId: string): Promise<void> {
  if ((pendingSaves.get(workspaceId) ?? 0) > 0) return;
  try {
    const orch = dropImpossibleSteps(await backend.getOrchestration(workspaceId));
    if ((pendingSaves.get(workspaceId) ?? 0) > 0) return;
    orchestrations.update((s) => ({ ...s, [workspaceId]: orch }));
  } catch {
    // Keep showing what we have.
  }
}

/// Every plan edit goes through here: apply optimistically, persist the
/// whole plan, roll back on failure unless a later mutation already
/// replaced it (reference check -- and that later save carries this
/// change anyway, since the plan is persisted wholesale).
///
/// Returns the failure message as well as recording it in `saveErrors`:
/// the tab reads the store, but a caller on ANOTHER tab (a card menu on
/// the board) has its own error strip and would otherwise fail silently.
export async function mutatePlan(
  workspaceId: string,
  mutate: (orch: Orchestration) => Orchestration
): Promise<string | null> {
  const current = get(orchestrations)[workspaceId];
  if (!current) return null;
  const updated = mutate(current);
  orchestrations.update((s) => ({ ...s, [workspaceId]: updated }));
  pendingSaves.set(workspaceId, (pendingSaves.get(workspaceId) ?? 0) + 1);
  try {
    await backend.setOrchestration(workspaceId, updated.rails, updated.conflictNotes);
    dismissSaveError(workspaceId);
    return null;
  } catch (e) {
    orchestrations.update((s) => (s[workspaceId] === updated ? { ...s, [workspaceId]: current } : s));
    const message = String(e instanceof Error ? e.message : e);
    saveErrors.update((err) => ({ ...err, [workspaceId]: message }));
    return message;
  } finally {
    pendingSaves.set(workspaceId, (pendingSaves.get(workspaceId) ?? 1) - 1);
  }
}

async function mutateRunState(
  workspaceId: string,
  apply: (orch: Orchestration) => Orchestration,
  persist: () => Promise<void>
): Promise<void> {
  const current = get(orchestrations)[workspaceId];
  if (!current) return;
  const updated = apply(current);
  orchestrations.update((s) => ({ ...s, [workspaceId]: updated }));
  pendingSaves.set(workspaceId, (pendingSaves.get(workspaceId) ?? 0) + 1);
  try {
    await persist();
    dismissSaveError(workspaceId);
  } catch (e) {
    orchestrations.update((s) => (s[workspaceId] === updated ? { ...s, [workspaceId]: current } : s));
    saveErrors.update((err) => ({
      ...err,
      [workspaceId]: String(e instanceof Error ? e.message : e),
    }));
  } finally {
    pendingSaves.set(workspaceId, (pendingSaves.get(workspaceId) ?? 1) - 1);
  }
}

export function setRailRunAction(
  workspaceId: string,
  railId: string,
  state: RailState,
  currentStageId: string | null
): Promise<void> {
  return mutateRunState(
    workspaceId,
    (orch) => ({
      ...orch,
      railRuns: [
        ...orch.railRuns.filter((r) => r.railId !== railId),
        { railId, state, currentStageId },
      ],
    }),
    () => backend.setRailRun(railId, state, currentStageId)
  );
}

export function setStepRunAction(
  workspaceId: string,
  stepId: string,
  state: StepState,
  sessionId: string | null,
  reason: string | null
): Promise<void> {
  return mutateRunState(
    workspaceId,
    (orch) => ({
      ...orch,
      stepRuns: [
        ...orch.stepRuns.filter((r) => r.stepId !== stepId),
        { stepId, state, sessionId, reason },
      ],
    }),
    () => backend.setStepRun(stepId, state, sessionId, reason)
  );
}

function railOwning(orch: Orchestration, stepId: string): Rail | null {
  return orch.rails.find((r) => r.stages.some((s) => s.steps.some((t) => t.id === stepId))) ?? null;
}

export async function startRail(workspaceId: string, railId: string): Promise<void> {
  const orch = get(orchestrations)[workspaceId];
  const rail = orch?.rails.find((r) => r.id === railId);
  if (!rail) return;
  const stageId = firstUnfinishedStageId(rail, orch);
  if (!stageId) return;
  await setRailRunAction(workspaceId, railId, "running", stageId);
  await tick(workspaceId);
}

export async function pauseRail(workspaceId: string, railId: string): Promise<void> {
  const orch = get(orchestrations)[workspaceId];
  const current = orch?.railRuns.find((r) => r.railId === railId)?.currentStageId ?? null;
  await setRailRunAction(workspaceId, railId, "paused", current);
}

/// Resume picks up where the pause left off -- but only if that stage is
/// still there. A stage swept out from under a PAUSED rail (an edit, a
/// reorganize, a "Clear done" that landed while it was paused) leaves
/// `currentStageId` naming nothing, and nextActions, finding no stage to
/// point at, would call the rail COMPLETE and idle it. So a stale id is
/// dropped and the rail re-arms at the first unfinished stage, exactly
/// as Start would. `clearDoneStepsAction` does the same repair for the
/// running case, where it can do it at the moment of the write.
export async function resumeRail(workspaceId: string, railId: string): Promise<void> {
  const orch = get(orchestrations)[workspaceId];
  const rail = orch?.rails.find((r) => r.id === railId);
  if (!rail) return;
  const current = orch.railRuns.find((r) => r.railId === railId)?.currentStageId ?? null;
  const stageId =
    current && rail.stages.some((s) => s.id === current)
      ? current
      : firstUnfinishedStageId(rail, orch);
  await setRailRunAction(workspaceId, railId, "running", stageId);
  await tick(workspaceId);
}

/// Clears run state for the rail. Never touches card statuses -- the
/// board is the human's record, not the scheduler's scratch space.
export async function resetRail(workspaceId: string, railId: string): Promise<void> {
  const orch = get(orchestrations)[workspaceId];
  const rail = orch?.rails.find((r) => r.id === railId);
  if (!rail) return;
  for (const stage of rail.stages) {
    for (const step of stage.steps) {
      await setStepRunAction(workspaceId, step.id, "pending", null, null);
    }
  }
  await setRailRunAction(workspaceId, railId, "idle", null);
}

/// A stalled step returns to pending with its reason cleared; the next
/// tick re-reads the card and re-checks the worktree rather than
/// replaying the old command (spec §6.2).
export async function retryStep(workspaceId: string, stepId: string): Promise<void> {
  await setStepRunAction(workspaceId, stepId, "pending", null, null);
  await tick(workspaceId);
}

/// Launch a TOOL step (tools spec §3). Nothing card-shaped happens here:
/// no card_sessions binding and no "In Progress" write, because a tool
/// is not a card and has no status to keep.
async function executeToolLaunch(
  workspaceId: string,
  rail: Rail,
  step: Step
): Promise<void> {
  // null is "not fetched yet", NOT "empty" -- stalling here would turn a
  // cold start into a stalled rail. Leaving the step `pending` and
  // writing nothing is safe: the tab re-ticks when the library lands
  // (its $effect watches toolRecords), and nextActions will re-issue
  // this same launch. nextActions makes the matching choice, passing a
  // null library through launchBlocker rather than blocking on it.
  const library = libraryFor(get(toolRecords), workspaceId);
  if (library === null) return;

  const tool = findTool(library, step.toolId as string);
  if (!tool) {
    await setStepRunAction(workspaceId, step.id, "stalled", null, "tool is no longer in the library");
    return;
  }

  // The rail's checkout, NOT a card's contextFolder -- there is no card.
  const tree = get(gavinTrees)[workspaceId];
  const cwd = rail.worktreePath ?? (tree && !tree.rootMissing ? tree.rootPath : null);
  if (!cwd) {
    await setStepRunAction(
      workspaceId,
      step.id,
      "stalled",
      null,
      "no worktree bound and the workspace has no root"
    );
    return;
  }

  const body = resolveToolBody(tool, stepParams(step));
  const command =
    tool.kind === "agent"
      ? buildRunCommand(resolvedAgentFor(workspaceId).command, body)
      : buildToolCommand(tool.kind, body, tool.name);

  const sessionId = await createSessionOnPage(workspaceId, rail.pageId, cwd, command);
  if (!sessionId) {
    await setStepRunAction(workspaceId, step.id, "stalled", null, `could not start ${tool.name}`);
    return;
  }
  // A command tool's PTY can close in well under a second, so the tab
  // needs a name the moment it appears or it is unidentifiable. Best
  // effort: a nameless tab is cosmetic, not a reason to stall a step
  // whose session is already running.
  try {
    // The store, not backend.setSessionName: the backend command only
    // persists the name to config and pushes nothing back, so a tab named
    // that way keeps its cwd label until the app restarts.
    await setSessionName(sessionId, tool.name);
  } catch {
    // Cosmetic only.
  }
  await setStepRunAction(workspaceId, step.id, "running", sessionId, null);
}

/// Deliberately the EXISTING card-run path, so the board and the tab can
/// never disagree about what is running (spec §4.3).
async function executeLaunch(workspaceId: string, stepId: string): Promise<void> {
  const orch = get(orchestrations)[workspaceId];
  const rail = railOwning(orch, stepId);
  const step = rail?.stages.flatMap((s) => s.steps).find((t) => t.id === stepId);
  if (!rail || !step) return;

  if (isToolStep(step)) {
    await executeToolLaunch(workspaceId, rail, step);
    return;
  }

  const entry = cardIndex(get(gavinTrees)[workspaceId]).get(step.cardPath);
  if (!entry) {
    await setStepRunAction(workspaceId, stepId, "stalled", null, "card file is missing");
    return;
  }

  let prompt: string;
  if (entry.plan.kind === "task") {
    const file = await backend.readFileForViewer(step.cardPath);
    if (!file.exists) {
      await setStepRunAction(workspaceId, stepId, "stalled", null, "card file is missing");
      return;
    }
    prompt = composeTaskPrompt(step.cardPath, entry.plan.title, stripFrontmatter(file.content).trim());
  } else {
    prompt = composePlanPrompt(step.cardPath);
  }

  const command = buildRunCommand(resolvedAgentFor(workspaceId).command, prompt);
  const cwd = rail.worktreePath ?? entry.contextFolder;
  const sessionId = await createSessionOnPage(workspaceId, rail.pageId, cwd, command);
  if (!sessionId) {
    await setStepRunAction(workspaceId, stepId, "stalled", null, "could not start the agent");
    return;
  }

  // Named before the agent has drawn a frame, same as a board Run and the
  // tool step above: the agent's own gavin_name_session refines this, but
  // it is the first call it makes and the first to break when the gavin
  // tools are unreachable. Best effort -- the agent is already running,
  // so a failed rename is not worth stalling a live step over.
  const provisional = provisionalSessionName(entry.plan.title);
  if (provisional) {
    try {
      await setSessionName(sessionId, provisional);
    } catch {
      // Cosmetic only.
    }
  }
  await linkCardSessionAction(workspaceId, { path: step.cardPath, sessionId, cwd, command });
  await setStepRunAction(workspaceId, stepId, "running", sessionId, null);
  if (runStatusNeeded(entry.plan.status)) {
    try {
      await backend.setPlanFrontmatterField(step.cardPath, "status", "In Progress");
      patchPlanField(workspaceId, step.cardPath, "status", "In Progress");
    } catch {
      // The agent is running; a failed status write is not worth
      // stalling the step over. The card's own agent will set it.
    }
  }
}

export async function executeActions(workspaceId: string, actions: Action[]): Promise<void> {
  for (const action of actions) {
    const orch = get(orchestrations)[workspaceId];
    if (!orch) return;
    if (action.kind === "launch") {
      await executeLaunch(workspaceId, action.stepId);
    } else if (action.kind === "markDone") {
      const sessionId = orch.stepRuns.find((r) => r.stepId === action.stepId)?.sessionId ?? null;
      // The session id is kept deliberately: the step is finished, but
      // its transcript stays reachable from the chip.
      await setStepRunAction(workspaceId, action.stepId, "done", sessionId, null);
    } else if (action.kind === "stall") {
      await setStepRunAction(workspaceId, action.stepId, "stalled", null, action.reason);
      const rail = railOwning(orch, action.stepId);
      // Rule 5 stops a rail that is ADVANCING. A rail that is idle or
      // paused has nothing to stop, and the reconciling stalls nextActions
      // now issues for a dead session on such a rail must not relabel a
      // rail nobody started as "paused".
      if (rail && railStateOf(orch, rail.id) === "running") {
        const current = orch.railRuns.find((r) => r.railId === rail.id)?.currentStageId ?? null;
        await setRailRunAction(workspaceId, rail.id, "paused", current);
      }
    } else if (action.kind === "advance") {
      await setRailRunAction(workspaceId, action.railId, "running", action.stageId);
    } else {
      await setRailRunAction(workspaceId, action.railId, "idle", null);
    }
  }
}

/// The board's done column name, for the rail header's "nothing can
/// complete" warning. Null when the board has no columns at all.
export function doneColumnName(workspaceId: string): string | null {
  const board = get(kanbanState)[workspaceId];
  return board ? (doneColumn(board)?.name ?? null) : null;
}

// One tick at a time per workspace: executing an action mutates the very
// state the next nextActions call reads, so overlapping ticks would
// double-launch.
const ticking = new Set<string>();

export async function tick(workspaceId: string): Promise<void> {
  if (ticking.has(workspaceId)) return;
  ticking.add(workspaceId);
  try {
    const orch = get(orchestrations)[workspaceId];
    const board = get(kanbanState)[workspaceId];
    if (!orch || !board) return;
    const tree = get(gavinTrees)[workspaceId];
    // null, not [] -- an unloaded refs snapshot must not look like "every
    // worktree is gone" and stall every bound rail on a cold start.
    const worktrees = get(gitStore)[workspaceId]?.refs?.worktrees ?? null;
    const live = new Set<string>();
    for (const ws of get(layoutState).workspaces) {
      for (const page of ws.pages) for (const id of allSessionIds(page.layout)) live.add(id);
    }
    // null, not [], for the same reason as worktrees above: an unloaded
    // tool library must not read as "every tool was deleted".
    const tools = libraryFor(get(toolRecords), workspaceId);
    await executeActions(
      workspaceId,
      nextActions(orch, board, tree, worktrees, live, tools, get(sessionExits))
    );
  } finally {
    ticking.delete(workspaceId);
  }
}

/// Must be registered BEFORE the first watchGavinRoot call: Tauri events
/// emitted with no listener are lost, not buffered. layoutState.bootstrap()
/// registers this beside initGavinListeners.
///
/// The payload REPLACES the plan but preserves whatever run state this
/// app already holds: the daemon's copy can lag an optimistic local write
/// by a round trip, and the agent never authors run state anyway.
export async function initOrchestrationListeners(): Promise<UnlistenFn> {
  return listen<[string, Orchestration]>("orchestration-changed", (event) => {
    const [workspaceId, incoming] = event.payload;
    orchestrations.update((m) => {
      const current = m[workspaceId];
      if (!current) return { ...m, [workspaceId]: incoming };
      // The preserved run state may name steps the agent just deleted.
      // The daemon has already dropped those rows; this keeps the
      // in-memory copy honest without waiting for the next fetch.
      const railIds = new Set(incoming.rails.map((r) => r.id));
      const stepIds = new Set(
        incoming.rails.flatMap((r) => r.stages.flatMap((s) => s.steps.map((t) => t.id)))
      );
      return {
        ...m,
        [workspaceId]: {
          rails: incoming.rails,
          conflictNotes: incoming.conflictNotes,
          railRuns: current.railRuns.filter((r) => railIds.has(r.railId)),
          stepRuns: current.stepRuns.filter((r) => stepIds.has(r.stepId)),
        },
      };
    });
  });
}

/** @internal test-only reset for module-level state */
export function __resetForTesting(): void {
  orchestrations.set({});
  saveErrors.set({});
  pendingSaves.clear();
  ticking.clear();
  highlightedConflict.set(null);
}

// ---- Plan-edit actions -----------------------------------------------------

/// Returns the new rail's id so the caller can drop it straight into
/// rename mode -- a rail called "New rail" is a placeholder, not a name.
export async function addRailAction(workspaceId: string, name: string): Promise<string> {
  const railId = crypto.randomUUID();
  await mutatePlan(workspaceId, (o) => addRail(o, railId, name));
  return railId;
}

export function renameRailAction(workspaceId: string, railId: string, name: string): Promise<string | null> {
  return mutatePlan(workspaceId, (o) => renameRail(o, railId, name));
}

export function bindRailAction(
  workspaceId: string,
  railId: string,
  patch: { worktreePath?: string | null; pageId?: string | null }
): Promise<string | null> {
  return mutatePlan(workspaceId, (o) => bindRail(o, railId, patch));
}

export function deleteRailAction(workspaceId: string, railId: string): Promise<string | null> {
  return mutatePlan(workspaceId, (o) => deleteRail(o, railId));
}

/// Adds the card as its OWN new stage -- a sequential beat, the safe
/// default. Parallel is the deliberate act of dropping onto an existing
/// stage (SP2).
export function addStepAsStageAction(workspaceId: string, railId: string, cardPath: string): Promise<string | null> {
  return mutatePlan(workspaceId, (o) => {
    const stageId = crypto.randomUUID();
    return addStep(addStage(o, railId, stageId), stageId, crypto.randomUUID(), cardPath);
  });
}

export function addStepToStageAction(
  workspaceId: string,
  stageId: string,
  cardPath: string
): Promise<string | null> {
  return mutatePlan(workspaceId, (o) => addStep(o, stageId, crypto.randomUUID(), cardPath));
}

export function removeStepAction(workspaceId: string, stepId: string): Promise<string | null> {
  return mutatePlan(workspaceId, (o) => removeStep(o, stepId));
}

export function moveStepIntoStageAction(
  workspaceId: string,
  stepId: string,
  stageId: string
): Promise<string | null> {
  return mutatePlan(workspaceId, (o) => moveStepIntoStage(o, stepId, stageId));
}

export function moveStepToNewStageAction(
  workspaceId: string,
  stepId: string,
  railId: string,
  index: number
): Promise<string | null> {
  return mutatePlan(workspaceId, (o) => moveStepToNewStage(o, stepId, railId, index));
}

/// Drop an unplaced card into a rail as its own stage at `index`.
export function addCardAsStageAction(
  workspaceId: string,
  railId: string,
  index: number,
  cardPath: string
): Promise<string | null> {
  return mutatePlan(workspaceId, (o) => addCardAsStage(o, railId, index, crypto.randomUUID(), cardPath));
}

/// Send a card to a rail from a KANBAN surface -- the composer, a card's
/// context menu, its detail modal. Those surfaces never mount the
/// Orchestration tab, so the plan may not have been fetched yet; fetching
/// here is what makes "send to rail" work on a cold app that has only ever
/// shown the board.
///
/// Returns an error string for the caller's own error strip: the tab's
/// `saveErrors` banner is on a different tab, and a card that quietly
/// failed to land is worse than one that says so.
export async function sendCardToRailAction(
  workspaceId: string,
  railId: string,
  cardPath: string
): Promise<string | null> {
  if (!get(orchestrations)[workspaceId]) await fetchOrchestration(workspaceId);
  if (!get(orchestrations)[workspaceId]) {
    return "Couldn't reach this workspace's orchestration plan";
  }
  return mutatePlan(workspaceId, (o) => sendCardToRail(o, railId, cardPath, crypto.randomUUID()));
}

/// Take a card OFF whatever rail it sits on -- the inverse of
/// sendCardToRailAction, offered from the same surfaces so a mis-send is
/// undone where it was made. A card on no rail is a no-op.
export async function removeCardFromRailAction(
  workspaceId: string,
  cardPath: string
): Promise<string | null> {
  const orch = get(orchestrations)[workspaceId];
  const placement = orch ? findCardPlacement(orch, cardPath) : null;
  if (!placement) return null;
  return mutatePlan(workspaceId, (o) => removeStep(o, placement.stepId));
}

/// Move every card a rail carries into ONE kanban column -- a card's own
/// "Move to …" one rung up, for the human who just watched a rail finish
/// and wants its whole pipeline filed at once. Tool steps have no card
/// and sit it out; a card already in that column is not rewritten.
///
/// Writes are sequential and stop at the first failure, exactly as a
/// plan drop does (planDrop.ts): the watcher push reconciles whatever
/// landed, and the message names the file that refused. Null on success,
/// and on a rail with nothing to move.
export async function moveRailCardsAction(
  workspaceId: string,
  railId: string,
  columnName: string
): Promise<string | null> {
  const rail = get(orchestrations)[workspaceId]?.rails.find((r) => r.id === railId);
  if (!rail) return null;
  const paths = railCardsToMove(rail, cardIndex(get(gavinTrees)[workspaceId]), columnName);
  let current = "";
  try {
    for (const path of paths) {
      current = path;
      await backend.setPlanFrontmatterField(path, "status", columnName);
      patchPlanField(workspaceId, path, "status", columnName);
    }
    return null;
  } catch (e) {
    const fileName = current.split("/").at(-1) ?? current;
    return `Couldn't move ${fileName} to ${columnName}: ${e instanceof Error ? e.message : e}`;
  }
}

/// Take a rail's finished steps OFF it in one plan write -- the header's
/// "Clear done", for the human who wants the rail to show only what is
/// still ahead. What counts as done is railDoneStepIds' business (run
/// state, or the card's own column); the cards themselves are never
/// touched, only the steps that pointed at them.
///
/// A RUNNING rail whose current stage was cleared away would look
/// finished on the next tick -- nextActions has no stage to point at and
/// calls the rail complete -- so the run is repointed at the first
/// unfinished stage that survived, and ticked from there. Null on
/// success, and on a rail with nothing to clear.
export async function clearDoneStepsAction(
  workspaceId: string,
  railId: string
): Promise<string | null> {
  const orch = get(orchestrations)[workspaceId];
  const rail = orch?.rails.find((r) => r.id === railId);
  if (!rail) return null;
  const ids = railDoneStepIds(
    rail,
    orch,
    cardIndex(get(gavinTrees)[workspaceId]),
    doneColumnName(workspaceId)
  );
  if (ids.length === 0) return null;
  const err = await mutatePlan(workspaceId, (o) => removeSteps(o, ids));
  if (err) return err;

  const after = get(orchestrations)[workspaceId];
  const railAfter = after?.rails.find((r) => r.id === railId);
  const run = after?.railRuns.find((r) => r.railId === railId);
  if (!railAfter || !run?.currentStageId) return null;
  if (railAfter.stages.some((s) => s.id === run.currentStageId)) return null;
  await setRailRunAction(workspaceId, railId, run.state, firstUnfinishedStageId(railAfter, after));
  await tick(workspaceId);
  return null;
}

// ---- Tool step actions -----------------------------------------------------
// The card pair's exact shape, one rung over: a tool dropped into a gap
// becomes its own stage (sequential), a tool dropped onto a stage joins
// it (parallel).

/// Appends the tool to the rail as its own stage -- what clicking a tool
/// row in the drawer means.
export function addToolAsStepAction(
  workspaceId: string,
  railId: string,
  toolId: string
): Promise<string | null> {
  return mutatePlan(workspaceId, (o) => {
    const stageId = crypto.randomUUID();
    return addToolStep(addStage(o, railId, stageId), stageId, crypto.randomUUID(), toolId);
  });
}

export function addToolAsStageAction(
  workspaceId: string,
  railId: string,
  index: number,
  toolId: string
): Promise<string | null> {
  return mutatePlan(workspaceId, (o) =>
    addToolAsStage(o, railId, index, crypto.randomUUID(), toolId)
  );
}

export function addToolToStageAction(
  workspaceId: string,
  stageId: string,
  toolId: string
): Promise<string | null> {
  return mutatePlan(workspaceId, (o) => addToolStep(o, stageId, crypto.randomUUID(), toolId));
}

/// The overrides arrive already pruned of values equal to the tool's own
/// defaults (StepParamsDialog does it), so a later edit to a default
/// still reaches a step that never deliberately overrode it.
export function setStepParamsAction(
  workspaceId: string,
  stepId: string,
  params: Record<string, string>
): Promise<string | null> {
  return mutatePlan(workspaceId, (o) => setStepParams(o, stepId, params));
}

export function makeStageSequentialAction(workspaceId: string, stageId: string): Promise<string | null> {
  return mutatePlan(workspaceId, (o) => splitStageIntoSequence(o, stageId));
}

/// Hand the reorganize request to the RUNNING workspace agent. A summary
/// of what the tab currently shows rides along so the agent starts from
/// the same picture the human is looking at -- it still calls
/// gavin_get_orchestration for the authoritative read.
export async function requestReorganize(
  workspaceId: string,
  conflictSummary: string[]
): Promise<string | null> {
  const orch = get(orchestrations)[workspaceId];
  const railLine = (rail: Rail): string =>
    `- ${rail.name} (${rail.worktreePath ?? "no worktree"}): ` +
    `${rail.stages.length} stage${rail.stages.length === 1 ? "" : "s"}, ` +
    `${rail.stages.reduce((n, s) => n + s.steps.length, 0)} steps`;

  const prompt = [
    "Use the gavin-orchestrate skill to reorganize this workspace's orchestration.",
    "",
    orch && orch.rails.length > 0
      ? `The tab currently shows:\n${orch.rails.map(railLine).join("\n")}`
      : "The tab has no rails yet — create them.",
    conflictSummary.length > 0
      ? `\nGavin currently flags:\n${conflictSummary.map((c) => `- ${c}`).join("\n")}`
      : "\nGavin currently flags no conflicts.",
    "",
    "Read gavin_get_orchestration for the authoritative picture before writing anything.",
    "It also lists this workspace's TOOLS — a step can run a tool (toolId) instead of a card,",
    "and rewriting a rail must carry every existing step's toolId and toolParams through.",
  ].join("\n");

  return pasteToMainAgent(workspaceId, prompt);
}
