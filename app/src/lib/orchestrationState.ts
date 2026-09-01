// The reactive half of orchestration: the per-workspace store, its
// persistence, and the tick that executes nextActions. Every decision
// lives in orchestration.ts; this module only holds state and performs
// effects. Shaped after kanbanState.ts on purpose -- same optimistic
// mutate, same rollback-unless-superseded, same pendingSaves guard
// against a refresh clobbering an in-flight save.

import { writable, derived, get, type Readable } from "svelte/store";
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
  setStageMode,
  renameStage,
  moveStageToIndex,
  removeStage,
  isToolStep,
  stepParams,
  stepStateOf,
  findCardPlacement,
  sendCardToRail,
  pageToSpawnForRail,
  railCardsToMove,
  railDoneStepIds,
  removeSteps,
  isStageRunning,
  stepAttentions,
  findStep,
  insertStageWithSteps,
} from "./orchestration";
import type {
  Action,
  CardEntry,
  Orchestration,
  Rail,
  RailState,
  StageMode,
  StepAttention,
  StepState,
  Step,
  ToolSummary,
} from "./orchestration";
import { composeGeneratePrompt, composeRailPrompt } from "./orchestrationPrompts";
import { findTool, resolveToolBody } from "./orchestrationTools";
import { stepsFromTemplate } from "./orchestrationGroups";
import type { GroupTemplate } from "./orchestrationGroups";
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
  setSessionName,
} from "./layoutState";
import { allSessionIds, presetSingle } from "./layout";
import {
  composeTaskPrompt,
  composePlanPrompt,
  buildRunCommand,
  provisionalSessionName,
  buildToolCommand,
  runStatusNeeded,
} from "./cardRun";
import { stripFrontmatter } from "./planChecklist";
import { setRailNotificationVoice, type SessionStatus } from "./notifications";
import { pasteToMainAgent, resolveAttachmentsForRun } from "./cardRunActions";

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

/// Every running step that wants a human, per workspace (see
/// stepAttentions). Derived rather than stored: it is a live read of the
/// scheduler's own inputs, so it can never drift from what the rail is
/// actually doing, and it costs nothing when it turns out to be wrong.
///
/// Four surfaces read this one computation -- the step chip and card,
/// the rail header, the sidebar recap and the Orchestration hub tab --
/// which is the reason it lives here rather than in whichever of them
/// happens to be mounted. That is the same mistake startScheduler was
/// written to undo.
///
/// Every workspace, not just the active one: the sidebar shows a recap
/// per workspace, and a rail that needs you in the workspace you are not
/// looking at is exactly the one you would otherwise miss.
export const stepAttentionsByWorkspace: Readable<Record<string, Map<string, StepAttention>>> =
  derived(
    [orchestrations, kanbanState, gavinTrees, toolRecords, layoutState],
    ([$orchestrations, $kanban, $trees, $tools, $layout]) => {
      const statuses = new Map(Object.entries($layout.sessionStatusById));
      const out: Record<string, Map<string, StepAttention>> = {};
      for (const [workspaceId, orch] of Object.entries($orchestrations)) {
        const board = $kanban[workspaceId];
        if (!board) continue;
        out[workspaceId] = stepAttentions(
          orch,
          board,
          $trees[workspaceId],
          libraryFor($tools, workspaceId),
          statuses
        );
      }
      return out;
    }
  );

const pendingSaves = new Map<string, number>();

export async function fetchOrchestration(workspaceId: string): Promise<void> {
  if (workspaceId in get(orchestrations)) return;
  try {
    const orch = dropImpossibleSteps(await backend.getOrchestration(workspaceId));
    orchestrations.update((s) => ({ ...s, [workspaceId]: orch }));
  } catch {
    // Leave it unset; the tab renders its loading state and the next
    // mount retries.
    return;
  }
  // Outside the catch, so a scheduler failure is never mistaken for a
  // failed load. The plan is the one scheduler input the scheduler does
  // not subscribe to (see tickInputStores), so its arrival has to say so
  // itself -- without this, a rail left running across a restart waits
  // for some unrelated push before it notices it has work.
  await tick(workspaceId);
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
    return;
  }
  await tick(workspaceId);
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
    const pageId = await createPage(workspaceId, (ids) => presetSingle(ids[0]), 1, name, {
      cwd: checkout ?? undefined,
      // The human is on the Orchestration tab -- they pressed Start
      // there. The page appears in the sidebar and the rail's chip names
      // it; taking the screen as well would be a jump they did not ask
      // for, and unbearable when arming several rails in a row.
      activate: false,
    });
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
  // Resume arms the rail too, and its page may well have been closed
  // while it sat paused.
  await ensureRailPage(workspaceId, railId);
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

/// The human's override for a step whose completion signal never
/// arrives: file it done and let the rail move on, rather than deleting
/// the session and the step to unwedge the rail (which is what this bug
/// cost before there was a button for it).
///
/// The session id is kept, exactly as executeActions' own markDone keeps
/// it: the step is finished, but its transcript stays reachable from the
/// chip. Nothing is killed either -- a live session the human has judged
/// finished is still theirs to read, and to keep using.
export async function markStepDone(workspaceId: string, stepId: string): Promise<void> {
  const sessionId =
    get(orchestrations)[workspaceId]?.stepRuns.find((r) => r.stepId === stepId)?.sessionId ?? null;
  await setStepRunAction(workspaceId, stepId, "done", sessionId, null);
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
      ? buildRunCommand(resolvedAgentFor(workspaceId).launchCommand, body)
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

  // The same gate a board Run uses, and for the same reason -- but here
  // the refusal STALLS the step instead of starting it. A rail that ran
  // a card with a dead attachment would carry the damage into every
  // stage after it, so the reason lands on the chip and rule 5 pauses
  // the rail, exactly as a failed launch does.
  const resolved = await resolveAttachmentsForRun(workspaceId, entry.plan.attachments ?? []);
  if ("error" in resolved) {
    await setStepRunAction(workspaceId, stepId, "stalled", null, resolved.error);
    return;
  }

  let prompt: string;
  if (entry.plan.kind === "task") {
    const file = await backend.readFileForViewer(step.cardPath);
    if (!file.exists) {
      await setStepRunAction(workspaceId, stepId, "stalled", null, "card file is missing");
      return;
    }
    prompt = composeTaskPrompt(
      step.cardPath,
      entry.plan.title,
      stripFrontmatter(file.content).trim(),
      resolved.paths
    );
  } else {
    prompt = composePlanPrompt(step.cardPath, resolved.paths);
  }

  const command = buildRunCommand(resolvedAgentFor(workspaceId).launchCommand, prompt);
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
      // Rule 5 stops a rail that is ADVANCING. A rail that is idle or
      // paused has nothing to stop, and the reconciling stalls nextActions
      // now issues for a dead session on such a rail must not relabel a
      // rail nobody started as "paused".
      if (rail && railStateOf(orch, rail.id) === "running") {
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
// ...but a request that arrives DURING a tick must not be dropped. The
// tick in flight read the plan before that caller's change existed, so
// simply returning would leave the change unscheduled until some
// unrelated event ticked again -- exactly the stall a card dropped onto
// a running stage used to sit in. So the request is remembered and
// replayed once the current pass drains.
const tickAgain = new Set<string>();

export async function tick(workspaceId: string): Promise<void> {
  if (ticking.has(workspaceId)) {
    tickAgain.add(workspaceId);
    return;
  }
  ticking.add(workspaceId);
  let again = false;
  try {
    again = await runTick(workspaceId);
  } finally {
    ticking.delete(workspaceId);
  }
  // Outside the guard, so the replay is a full tick of its own. It
  // terminates: the pass that just ran left every step it launched
  // `running`, so a replay that finds nothing new emits no actions and
  // asks for nothing further.
  // `again` is the branch-switch follow-up: switching a checkout changes
  // what the scheduler READS, not just what it has already decided, so
  // the rail becomes launchable one pass later. Bounded for the same
  // reason the replay is -- a checkout already on its rail's branch asks
  // for no further pass.
  if (tickAgain.delete(workspaceId) || again) await tick(workspaceId);
}

async function runTick(workspaceId: string): Promise<boolean> {
  const orch = get(orchestrations)[workspaceId];
  const board = get(kanbanState)[workspaceId];
  if (!orch || !board) return false;
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
  // An agent tool's session never exits, so its verdict is not in
  // sessionExits and never will be -- the daemon's live status is the
  // only thing that says its turn is over (see agentTurnEnded).
  const statuses = new Map(Object.entries(get(layoutState).sessionStatusById));
  // A session the daemon put back as a bare shell is IN `live` above --
  // same id, back in the layout -- so without this the scheduler waits on
  // a shell that will never finish a card. See nextActions rule 3c.
  const interrupted = get(layoutState).interruptedSessionIds;
  return await executeActions(
    workspaceId,
    nextActions(orch, board, tree, worktrees, live, tools, get(sessionExits), statuses, interrupted)
  );
}

// ---- What makes the scheduler run ------------------------------------------
// Until this existed, the only self-firing tick was an $effect in
// OrchestrationHubView. `+page.svelte` renders one hub view at a time,
// and a terminal page renders none of them at all -- so a rail advanced
// only while the Orchestration tab was the active view. Start a rail and
// then go and watch its agent work on its page, which is the natural
// thing to do, and nothing moved: the step's exit landed in
// `sessionExits` and its status in `sessionStatusById` (both listeners
// are global), but nothing read them until the human navigated back,
// where the whole rail caught up at once.
//
// So the trigger lives here instead, subscribed at module level the way
// layoutState.ts rides `gavinTrees` -- owned by the module that owns the
// tick, not by whichever component happens to be mounted.

/// Every store `runTick` reads EXCEPT `orchestrations`. Listing the rest
/// in full rather than a chosen subset is the point: a scheduler that
/// misses an input is exactly the bug above in a subtler form. Ticking on
/// an emission that changed nothing costs one pure `nextActions` pass,
/// and a burst of them collapses -- the `ticking` guard turns every
/// emission raised while a pass is in flight into the single replay
/// `tickAgain` already performs.
///
/// `orchestrations` is left out because it is the tick's OUTPUT as well
/// as its input: a save that keeps failing (a daemon refusing writes
/// across a version skew) rolls the plan back, and a tick riding that
/// rollback would re-emit the same action and retry forever. The plan
/// ARRIVING ticks explicitly instead, from each of the three places it
/// can arrive: a fetch, a refresh, and the daemon's push.
///
/// Read when the scheduler starts, not at module scope: importing this
/// module must not require every store it will eventually subscribe to
/// to exist yet.
function tickInputStores(): Readable<unknown>[] {
  return [kanbanState, gavinTrees, gitStore, toolRecords, layoutState, sessionExits];
}

let stopScheduler: (() => void) | null = null;

/// Ticks the ACTIVE workspace whenever anything the scheduler reads
/// changes. Deliberately still one workspace: a single mounted hub view
/// is what this replaces, and ticking every loaded workspace -- running
/// rails in workspaces the human is not looking at -- is a separate
/// change to make deliberately. Returns its own teardown; started by
/// initOrchestrationListeners, which bootstrap registers and teardown
/// unwinds.
export function startScheduler(): () => void {
  stopScheduler?.();
  const unsubscribes = tickInputStores().map((store) =>
    store.subscribe(() => {
      // Null while the app is still connecting, and on a window with no
      // workspace at all; either way there is nothing to tick.
      const workspaceId = get(layoutState).activeWorkspaceId;
      // Not recursion, even though a pass writes to `layoutState` itself
      // when it creates a step's session: an emission raised while a
      // pass is in flight collapses into `tick`'s single replay.
      if (workspaceId) void tick(workspaceId);
    })
  );
  const stop = () => {
    for (const unsubscribe of unsubscribes) unsubscribe();
    // Guarded: a later start owns the field, and this teardown arriving
    // afterwards must not clear the live scheduler out of it.
    if (stopScheduler === stop) stopScheduler = null;
  };
  stopScheduler = stop;
  return stop;
}

/// The rail's own words for one of its step's sessions, when the
/// generic notification body would be wrong (see setRailNotificationVoice).
///
/// The one case: a CARD step whose agent went idle without ever moving
/// its card to the done column. That transition already notified, as
/// "<label> finished" -- and "finished" is exactly what did not happen.
/// The agent stopped; the work is still undone and the rail is still
/// waiting on it.
///
/// Only `turn-ended`. `asking` already says "needs your input", which is
/// right, and an agent TOOL step going idle really has finished, because
/// agentTurnEnded marks it done on that same tick.
export function railStatusVoice(sessionId: string, status: SessionStatus): string | null {
  if (status !== "idle") return null;
  // Reads the same derived map the chips do, and the layout store it
  // rides has already been updated with this very status by the time
  // handleSessionStatusChanged calls the notifier -- so the mark here is
  // the one the human is about to see on the rail.
  const byWorkspace = get(stepAttentionsByWorkspace);
  for (const [workspaceId, marks] of Object.entries(byWorkspace)) {
    const orch = get(orchestrations)[workspaceId];
    if (!orch) continue;
    for (const run of orch.stepRuns) {
      if (run.sessionId !== sessionId) continue;
      if (marks.get(run.stepId) !== "turn-ended") continue;
      const step = findStep(orch, run.stepId);
      const label = step ? cardTitleFor(workspaceId, step) : null;
      return `${label ?? "a rail step"} stopped without finishing its card`;
    }
  }
  return null;
}

/// The card's own title for a notification body -- the session's name is
/// a shell label and would not tell the human which card stalled. Falls
/// back to the file name, which is the only honest thing left when the
/// tree has not loaded.
function cardTitleFor(workspaceId: string, step: Step): string | null {
  if (isToolStep(step)) return null;
  const entry = cardIndex(get(gavinTrees)[workspaceId]).get(step.cardPath);
  return entry?.plan.title ?? step.cardPath.split("/").pop() ?? null;
}

/// Must be registered BEFORE the first watchGavinRoot call: Tauri events
/// emitted with no listener are lost, not buffered. layoutState.bootstrap()
/// registers this beside initGavinListeners, and starts the scheduler
/// with it -- both belong to the app, not to a tab.
///
/// The payload REPLACES the plan but preserves whatever run state this
/// app already holds: the daemon's copy can lag an optimistic local write
/// by a round trip, and the agent never authors run state anyway.
export async function initOrchestrationListeners(): Promise<UnlistenFn> {
  const unlisten = await listen<[string, Orchestration]>("orchestration-changed", (event) => {
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
    // A plan arrival like any other (an agent editing rails over MCP),
    // so it ticks like the other two: a step added to the stage a rail
    // is running must start, not wait for the human to come back.
    void tick(workspaceId);
  });
  const stop = startScheduler();
  setRailNotificationVoice(railStatusVoice);
  return () => {
    stop();
    setRailNotificationVoice(null);
    unlisten();
  };
}

/** @internal test-only reset for module-level state */
export function __resetForTesting(): void {
  orchestrations.set({});
  saveErrors.set({});
  pendingSaves.clear();
  ticking.clear();
  tickAgain.clear();
  // A scheduler left running would tick the next test's stores.
  stopScheduler?.();
  setRailNotificationVoice(null);
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
/// default. Dropping onto an existing stage instead is the deliberate
/// act of joining it or forming a group with it (SP2, grouping spec G3).
export function addStepAsStageAction(workspaceId: string, railId: string, cardPath: string): Promise<string | null> {
  return mutatePlan(workspaceId, (o) => {
    const stageId = crypto.randomUUID();
    return addStep(addStage(o, railId, stageId), stageId, crypto.randomUUID(), cardPath, 0);
  });
}

/// The GROUPING drop: the card joins an existing stage at `index`,
/// making it a sequence group if it held one step. If that stage is the
/// one its rail is running right now, the card starts immediately --
/// unless the group is sequential and something ahead of it is still
/// running, in which case the tick correctly leaves it queued.
export async function addStepToStageAction(
  workspaceId: string,
  stageId: string,
  cardPath: string,
  index: number
): Promise<string | null> {
  const error = await mutatePlan(workspaceId, (o) => addStep(o, stageId, crypto.randomUUID(), cardPath, index));
  if (!error) await startIfStageRunning(workspaceId, stageId);
  return error;
}

export function setStageModeAction(
  workspaceId: string,
  stageId: string,
  mode: StageMode
): Promise<string | null> {
  return mutatePlan(workspaceId, (o) => setStageMode(o, stageId, mode));
}

export function renameStageAction(
  workspaceId: string,
  stageId: string,
  name: string | null
): Promise<string | null> {
  return mutatePlan(workspaceId, (o) => renameStage(o, stageId, name));
}

/// Moving a whole group. Nothing to start afterwards: a group that lands
/// on a running rail is a later beat unless it IS the current stage, and
/// it cannot be -- the rail was running a stage this move did not touch.
export function moveStageToIndexAction(
  workspaceId: string,
  stageId: string,
  railId: string,
  index: number
): Promise<string | null> {
  return mutatePlan(workspaceId, (o) => moveStageToIndex(o, stageId, railId, index));
}

/// Drops the group and every step it held. The cards are untouched: only
/// the steps that pointed at them leave.
export function removeStageAction(workspaceId: string, stageId: string): Promise<string | null> {
  return mutatePlan(workspaceId, (o) => removeStage(o, stageId));
}

/// One stage per member, in order -- the deliberate destruction of a
/// group, as opposed to the conflict repair, which keeps it whole.
export function ungroupStageAction(workspaceId: string, stageId: string): Promise<string | null> {
  return mutatePlan(workspaceId, (o) => splitStageIntoSequence(o, stageId));
}

/// A step dropped onto the stage a rail is CURRENTLY running belongs to a
/// beat already in flight, so it starts at once rather than sitting
/// `pending` until some unrelated change happens to tick the workspace.
/// That wait was the whole bug: the drop looked inert, and the human's
/// only recourse was Pause/Resume.
///
/// The tick is what starts it -- nextActions already launches a pending
/// step on the current stage -- so there is still exactly one launch
/// path, with the same blockers, the same stall reasons and the same
/// rule 1 that skips a card already sitting in the done column. Every
/// other drop target stays queued: a new stage is a later beat, and an
/// idle or paused rail spawns nothing at all (O1).
async function startIfStageRunning(workspaceId: string, stageId: string): Promise<void> {
  const orch = get(orchestrations)[workspaceId];
  if (orch && isStageRunning(orch, stageId)) await tick(workspaceId);
}

export function removeStepAction(workspaceId: string, stepId: string): Promise<string | null> {
  return mutatePlan(workspaceId, (o) => removeStep(o, stepId));
}

/// Moving an existing step onto a running stage is the same gesture as
/// dropping a card there, so it starts the same way. Reading the target
/// AFTER the move is what keeps that safe: were the target the current
/// stage, the step's old stage cannot also have been, so nothing this
/// move emptied can have left the rail parked on a stage that is gone.
export async function moveStepIntoStageAction(
  workspaceId: string,
  stepId: string,
  stageId: string,
  index: number
): Promise<string | null> {
  const error = await mutatePlan(workspaceId, (o) => moveStepIntoStage(o, stepId, stageId, index));
  if (!error) await startIfStageRunning(workspaceId, stageId);
  return error;
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
// it or forms a group with it (grouping spec G3).

/// Appends the tool to the rail as its own stage -- what clicking a tool
/// row in the drawer means.
export function addToolAsStepAction(
  workspaceId: string,
  railId: string,
  toolId: string
): Promise<string | null> {
  return mutatePlan(workspaceId, (o) => {
    const stageId = crypto.randomUUID();
    return addToolStep(addStage(o, railId, stageId), stageId, crypto.randomUUID(), toolId, 0);
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

export async function addToolToStageAction(
  workspaceId: string,
  stageId: string,
  toolId: string,
  index: number
): Promise<string | null> {
  const error = await mutatePlan(workspaceId, (o) => addToolStep(o, stageId, crypto.randomUUID(), toolId, index));
  if (!error) await startIfStageRunning(workspaceId, stageId);
  return error;
}

/// A template dropped into a gap: its members become a group of their
/// own, carrying the template's name and mode -- the same sequential
/// drop addToolAsStageAction is for one tool, minting every member at
/// once instead of one step at a time.
export function addTemplateAsStageAction(
  workspaceId: string,
  railId: string,
  index: number,
  template: GroupTemplate
): Promise<string | null> {
  return mutatePlan(workspaceId, (o) =>
    insertStageWithSteps(o, railId, index, {
      id: crypto.randomUUID(),
      position: index,
      mode: template.mode,
      name: template.name,
      steps: stepsFromTemplate(template, () => crypto.randomUUID()),
    })
  );
}

/// A template dropped ONTO a stage: its members join that group at
/// `index`, in order. The group's own name and mode win -- the human
/// arranged that group, and a template merged into it is an addition,
/// not a replacement.
export async function addTemplateToStageAction(
  workspaceId: string,
  stageId: string,
  index: number,
  template: GroupTemplate
): Promise<string | null> {
  const error = await mutatePlan(workspaceId, (o) => {
    const minted = stepsFromTemplate(template, () => crypto.randomUUID());
    // Two passes because addToolStep places a step and setStepParams gives
    // it its overrides -- one mutatePlan, so it is still one write.
    const placed = minted.reduce(
      (acc, step, i) => addToolStep(acc, stageId, step.id, step.toolId as string, index + i),
      o
    );
    return minted.reduce((acc, step) => setStepParams(acc, step.id, step.toolParams ?? {}), placed);
  });
  if (!error) await startIfStageRunning(workspaceId, stageId);
  return error;
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

/// The repair for a parallel-stage conflict: tell the group to run its
/// members one at a time. A mode flip rather than the old split, so the
/// group the human built survives the fix -- ungrouping is a separate,
/// deliberate act.
export function makeStageSequentialAction(workspaceId: string, stageId: string): Promise<string | null> {
  return mutatePlan(workspaceId, (o) => setStageMode(o, stageId, "sequence"));
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
