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
  addCardAsStage,
  addToolAsStage,
  setStepParams,
  moveStepIntoStage,
  moveStepToNewStage,
  splitStageIntoSequence,
  isToolStep,
  stepParams,
  stepStateOf,
  findCardPlacement,
  sendCardToRail,
  pageToSpawnForRail,
} from "./orchestration";
import type {
  Action,
  CardEntry,
  Orchestration,
  Rail,
  RailState,
  StepState,
  Step,
  ToolSummary,
} from "./orchestration";
import { composeGeneratePrompt, composeRailPrompt } from "./orchestrationPrompts";
import { findTool, resolveToolBody } from "./orchestrationTools";
import { libraryFor, toolRecords } from "./toolsState";
import { kanbanState, linkCardSessionAction } from "./kanbanState";
import { gavinTrees, patchPlanField } from "./gavinState";
import { gitStore, refresh as refreshGit } from "./gitState";
import {
  layoutState,
  resolvedAgentFor,
  createSessionOnPage,
  createPage,
  sessionExits,
} from "./layoutState";
import { allSessionIds, presetSingle } from "./layout";
import {
  composeTaskPrompt,
  composePlanPrompt,
  buildRunCommand,
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
    const orch = await backend.getOrchestration(workspaceId);
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
    const orch = await backend.getOrchestration(workspaceId);
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

const spawningPages = new Set<string>();

/// Arming a rail gives it a page of its OWN, named after it (spec O16):
/// the human pressed Start, so this rail's agents get a home they can be
/// found in rather than piling into the shared Agents page with everyone
/// else's. Only when the rail has no live page binding -- an explicit
/// one is never overridden, and re-arming returns to the page the rail
/// already has.
///
/// Failing to create one is not fatal, and deliberately not a stall: the
/// rail arms anyway and its launches fall back to the Agents-page
/// posture (spec §4.3 step 4). A page is where agents land, not a
/// precondition for running them.
async function ensureRailPage(workspaceId: string, railId: string): Promise<void> {
  // One page per rail even under a double-click: creating it is an await
  // long enough for a second Start to arrive while the rail is still
  // unbound, and two pages named after one rail is exactly what
  // pageToSpawnForRail's deduping exists to prevent.
  if (spawningPages.has(railId)) return;
  const rail = get(orchestrations)[workspaceId]?.rails.find((r) => r.id === railId);
  if (!rail) return;
  const pages = get(layoutState).workspaces.find((w) => w.id === workspaceId)?.pages ?? [];
  const name = pageToSpawnForRail(rail, pages);
  if (name === null) return;
  // The page's own blank shell opens in the rail's checkout -- spelled
  // exactly as executeToolLaunch spells it -- so the page is the rail's
  // in the way that matters, not just by name. Undefined only when the
  // workspace has no root at all, and then $HOME is as good a guess as
  // any.
  const tree = get(gavinTrees)[workspaceId];
  const checkout = rail.worktreePath ?? (tree && !tree.rootMissing ? tree.rootPath : null);
  spawningPages.add(railId);
  try {
    const pageId = await createPage(
      workspaceId,
      (ids) => presetSingle(ids[0]),
      1,
      name,
      checkout ?? undefined
    );
    if (pageId) await mutatePlan(workspaceId, (orch) => bindRail(orch, railId, { pageId }));
  } finally {
    spawningPages.delete(railId);
  }
}

export async function startRail(workspaceId: string, railId: string): Promise<void> {
  const orch = get(orchestrations)[workspaceId];
  const rail = orch?.rails.find((r) => r.id === railId);
  if (!rail) return;
  const stageId = firstUnfinishedStageId(rail, orch);
  if (!stageId) return;
  // Before the rail is armed, so the first launch of the very first tick
  // already lands on it.
  await ensureRailPage(workspaceId, railId);
  await setRailRunAction(workspaceId, railId, "running", stageId);
  await tick(workspaceId);
}

export async function pauseRail(workspaceId: string, railId: string): Promise<void> {
  const orch = get(orchestrations)[workspaceId];
  const current = orch?.railRuns.find((r) => r.railId === railId)?.currentStageId ?? null;
  await setRailRunAction(workspaceId, railId, "paused", current);
}

export async function resumeRail(workspaceId: string, railId: string): Promise<void> {
  const orch = get(orchestrations)[workspaceId];
  const rail = orch?.rails.find((r) => r.id === railId);
  if (!rail) return;
  const current = orch.railRuns.find((r) => r.railId === railId)?.currentStageId ?? null;
  // Resume arms the rail too, and its page may well have been closed
  // while it sat paused.
  await ensureRailPage(workspaceId, railId);
  await setRailRunAction(workspaceId, railId, "running", current ?? firstUnfinishedStageId(rail, orch));
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
    await backend.setSessionName(sessionId, tool.name);
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

/// Put a rail's checkout on its branch (spec O15). Three steps, and the
/// first is a refusal gate.
///
/// A DIRTY checkout refuses -- deliberately stricter than git, which
/// carries non-conflicting edits across a switch. Uncommitted work
/// migrating into a rail's branch behind the human's back is worse than
/// a stalled rail, and stashing is not gavin's to do: the stash stack is
/// shared with every other checkout of this repo.
///
/// Every failure stalls the rail's current stage rather than throwing,
/// exactly as a failed launch does, so the reason lands on the chips and
/// rule 5 pauses the rail.
///
/// Returns whether the tick that ran it should run AGAIN: a switch only
/// half-finishes here, since the rail becomes launchable through the
/// refs snapshot this just moved.
async function executeSwitchBranch(
  workspaceId: string,
  railId: string,
  path: string,
  branch: string
): Promise<boolean> {
  try {
    const status = await backend.gitStatus(path);
    if (status.staged.length > 0 || status.unstaged.length > 0) {
      await stallStage(
        workspaceId,
        railId,
        `${path} has uncommitted changes — commit or stash them before this rail can switch to ${branch}`
      );
      return false;
    }
    await backend.gitCheckout(path, branch, null);
  } catch (e) {
    await stallStage(workspaceId, railId, e instanceof Error ? e.message : String(e));
    return false;
  }
  // Without this the refs snapshot still names the old branch, and the
  // scheduler would ask for this same switch on every tick.
  await refreshGit(workspaceId);
  // Ask for the follow-up ONLY once the snapshot has actually caught up.
  // A refresh that failed leaves the old one in place, and re-ticking on
  // that would re-emit this very switch -- forever, since checking out a
  // branch you are already on succeeds every time.
  const now = get(gitStore)[workspaceId]?.refs?.worktrees.find((w) => w.path === path)?.branch;
  return now === branch;
}

/// Stall every PENDING step of the rail's current stage and pause the
/// rail -- the rail-level equivalent of a failed launch. Steps that are
/// already running are left alone: a stale action must never mark a live
/// agent's step as stalled.
async function stallStage(workspaceId: string, railId: string, reason: string): Promise<void> {
  const orch = get(orchestrations)[workspaceId];
  const rail = orch?.rails.find((r) => r.id === railId);
  if (!orch || !rail) return;
  const current = orch.railRuns.find((r) => r.railId === railId)?.currentStageId ?? null;
  const stage = rail.stages.find((s) => s.id === current);
  for (const step of stage?.steps ?? []) {
    if (stepStateOf(get(orchestrations)[workspaceId], step.id) !== "pending") continue;
    await setStepRunAction(workspaceId, step.id, "stalled", null, reason);
  }
  await setRailRunAction(workspaceId, railId, "paused", current);
}

/// Returns whether the tick should run again immediately -- see
/// executeSwitchBranch, the one action that changes what the scheduler
/// reads rather than only what it has already decided.
export async function executeActions(workspaceId: string, actions: Action[]): Promise<boolean> {
  let again = false;
  for (const action of actions) {
    const orch = get(orchestrations)[workspaceId];
    if (!orch) return again;
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
      if (rail) {
        const current = orch.railRuns.find((r) => r.railId === rail.id)?.currentStageId ?? null;
        await setRailRunAction(workspaceId, rail.id, "paused", current);
      }
    } else if (action.kind === "switchBranch") {
      again =
        (await executeSwitchBranch(workspaceId, action.railId, action.path, action.branch)) || again;
    } else if (action.kind === "advance") {
      await setRailRunAction(workspaceId, action.railId, "running", action.stageId);
    } else {
      await setRailRunAction(workspaceId, action.railId, "idle", null);
    }
  }
  return again;
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
  let again = false;
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
    again = await executeActions(
      workspaceId,
      nextActions(orch, board, tree, worktrees, live, tools, get(sessionExits))
    );
  } finally {
    ticking.delete(workspaceId);
  }
  // A branch switch changes what the SCHEDULER READS, not just what it
  // has already decided, so the rail becomes launchable one pass later.
  // Re-entering tick() is guarded, which is why the follow-up runs out
  // here, after the guard is released. Bounded: a checkout already on
  // its rail's branch never asks for another.
  if (again) await tick(workspaceId);
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
  spawningPages.clear();
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
  patch: { worktreePath?: string | null; branch?: string | null; pageId?: string | null }
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

/// Hand the GENERATE request to the RUNNING workspace agent: the cards
/// nobody has placed, plus a summary of what the tab currently shows, so
/// the agent starts from the same picture the human is looking at -- it
/// still calls gavin_get_orchestration for the authoritative read.
export function requestGenerate(
  workspaceId: string,
  unplaced: CardEntry[],
  conflictSummary: string[]
): Promise<string | null> {
  const orch = get(orchestrations)[workspaceId] ?? null;
  return pasteToMainAgent(workspaceId, composeGeneratePrompt(orch, unplaced, conflictSummary));
}

/// The same agent, aimed at ONE rail (the button in its header). Reads
/// the rail out of the store rather than taking it from the caller, so a
/// rail deleted between render and click is caught here instead of
/// pasting a prompt about work that no longer exists.
export function requestRailReorganize(
  workspaceId: string,
  railId: string,
  cards: Map<string, CardEntry>,
  tools: ToolSummary[],
  conflictSummary: string[]
): Promise<string | null> {
  const orch = get(orchestrations)[workspaceId];
  const rail = orch?.rails.find((r) => r.id === railId);
  if (!orch || !rail) return Promise.resolve("That rail is gone");
  return pasteToMainAgent(
    workspaceId,
    composeRailPrompt(orch, rail, cards, tools, conflictSummary)
  );
}
