// A workspace's rails, acted on from the phone (spec, stories 49 and 50).
//
// Every write is the desk's own action from `orchestrationState.ts`, so a
// plan edited on the phone is the plan the desk would have written: the
// same optimistic apply, the same wholesale save, the same rollback. What
// none of them does here is RUN anything. Start, Resume and a card added
// to a running stage each end in a pass of the desk's scheduler, and that
// pass is gated on whose window this is (`runsRailsFor`): in the bundle it
// is nobody's, so each of them writes its one row and stops. The desk
// hears the write (`orchestration-written`, announced by its host), and
// its own scheduler launches the steps -- which the phone then hears the
// same way, and draws.
import { get } from "svelte/store";
import { fetchBoard } from "$lib/board/kanbanState";
import { askConfirm } from "$lib/core/dialog";
import { gavinTrees, refreshGavinTree } from "$lib/core/gavinState";
import { cardIndex, findStage, type Orchestration, type StageMode } from "$lib/orchestration/orchestration";
import {
  addRailAction,
  addStepAsStageAction,
  addStepToStageAction,
  deleteRailAction,
  dismissSaveError,
  fetchOrchestration,
  moveStageToIndexAction,
  orchestrations,
  pauseRail,
  refreshOrchestration,
  removeStageAction,
  removeStepAction,
  renameRailAction,
  resetRail,
  resumeRail,
  saveErrors,
  setStageModeAction,
  startRail,
} from "$lib/orchestration/orchestrationState";
import { groupRemoveConfirm, railDeleteConfirm } from "$lib/orchestration/railConfirm";
import { isReachabilityError } from "$companion/state/reachability";
import type { RailPress } from "$companion/surfaces/phoneRails";

function planOf(workspaceId: string): Orchestration | null {
  return get(orchestrations)[workspaceId] ?? null;
}

/// What the Rails surface draws from: the plan, the board and the tree.
/// A plan already in hand is read again -- one left from an earlier visit
/// is as old as that visit -- and a board or tree in hand is left to the
/// pushes that keep it current.
export async function loadRails(workspaceId: string): Promise<void> {
  const reads: Promise<void>[] = [fetchBoard(workspaceId)];
  if (!(workspaceId in get(gavinTrees))) reads.push(refreshGavinTree(workspaceId));
  reads.push(planOf(workspaceId) ? refreshOrchestration(workspaceId) : fetchOrchestration(workspaceId));
  await Promise.all(reads);
}

/// What the Rails surface does when the connection comes back: a save that
/// failed only for want of a connection stops saying so, and the plan and
/// its cards are read again -- what the desk ran meanwhile was pushed to
/// nobody.
export function recoverRails(workspaceId: string): Promise<void> {
  if (isReachabilityError(get(saveErrors)[workspaceId])) dismissSaveError(workspaceId);
  return loadRails(workspaceId);
}

/// A rail's one press. Start and Resume ARM the rail; the desk runs it.
export function pressRail(workspaceId: string, railId: string, press: RailPress): Promise<void> {
  switch (press) {
    case "start":
      return startRail(workspaceId, railId);
    case "resume":
      return resumeRail(workspaceId, railId);
    case "pause":
      return pauseRail(workspaceId, railId);
  }
}

/// Every step back to not started, the rail idle. The cards keep their
/// columns: the board is the human's record, not the scheduler's.
export async function resetRailAsked(workspaceId: string, railId: string): Promise<void> {
  const rail = planOf(workspaceId)?.rails.find((r) => r.id === railId);
  if (!rail) return;
  const confirmed = await askConfirm({
    title: `Reset rail "${rail.name}"?`,
    lines: [
      "Every step goes back to not started, and the rail stops.",
      "The cards keep their columns, and an agent still running keeps running.",
    ],
    confirmLabel: "Reset rail",
    danger: true,
  });
  if (confirmed) await resetRail(workspaceId, railId);
}

/// A new rail, at the end. Resolves with its id, for the surface to open
/// straight into naming it.
export function newRail(workspaceId: string): Promise<string> {
  return addRailAction(workspaceId, "New rail");
}

/// Resolves with the refusal, or null.
export function renameRail(workspaceId: string, railId: string, name: string): Promise<string | null> {
  const trimmed = name.trim();
  const rail = planOf(workspaceId)?.rails.find((r) => r.id === railId);
  if (!trimmed || !rail || rail.name === trimmed) return Promise.resolve(null);
  return renameRailAction(workspaceId, railId, trimmed);
}

export async function deleteRailAsked(workspaceId: string, railId: string): Promise<string | null> {
  const plan = planOf(workspaceId);
  const rail = plan?.rails.find((r) => r.id === railId);
  if (!plan || !rail) return null;
  const confirm = railDeleteConfirm(rail, plan);
  if (!(await askConfirm({ ...confirm, danger: true }))) return null;
  return deleteRailAction(workspaceId, railId);
}

/// A card onto a rail: as a stage of its own at the end, the desk's safe
/// default, or into a stage, making it a group. Into the stage the rail
/// is running, it is the desk that starts it.
export function addCard(
  workspaceId: string,
  railId: string,
  cardPath: string,
  stageId: string | null
): Promise<string | null> {
  if (stageId === null) return addStepAsStageAction(workspaceId, railId, cardPath);
  const stage = planOf(workspaceId) ? findStage(planOf(workspaceId)!, stageId) : null;
  return addStepToStageAction(workspaceId, stageId, cardPath, stage?.steps.length ?? 0);
}

/// A step off its rail. The card stays: a step is only a reference.
export function removeStep(workspaceId: string, stepId: string): Promise<string | null> {
  return removeStepAction(workspaceId, stepId);
}

/// A stage off its rail. A group takes every step it holds with it, so
/// that asks first, as the desk does.
export async function removeStageAsked(workspaceId: string, stageId: string): Promise<string | null> {
  const plan = planOf(workspaceId);
  const stage = plan ? findStage(plan, stageId) : null;
  if (!stage) return null;
  if (stage.steps.length > 1) {
    const confirm = groupRemoveConfirm(stage, cardIndex(get(gavinTrees)[workspaceId]));
    if (!(await askConfirm({ ...confirm, danger: true }))) return null;
  }
  return removeStageAction(workspaceId, stageId);
}

export function setStageMode(workspaceId: string, stageId: string, mode: StageMode): Promise<string | null> {
  return setStageModeAction(workspaceId, stageId, mode);
}

/// A stage one place earlier or later on its rail -- the phone's stand-in
/// for the desk's drag.
export function moveStage(workspaceId: string, railId: string, stageId: string, by: -1 | 1): Promise<string | null> {
  const rail = planOf(workspaceId)?.rails.find((r) => r.id === railId);
  const stages = [...(rail?.stages ?? [])].sort((a, b) => a.position - b.position);
  const at = stages.findIndex((s) => s.id === stageId);
  const to = at + by;
  if (at < 0 || to < 0 || to >= stages.length) return Promise.resolve(null);
  // The index counts the rail's stages with this one taken out.
  return moveStageToIndexAction(workspaceId, stageId, railId, to);
}
