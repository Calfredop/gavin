// The reactive half of orchestration: the per-workspace store, its
// persistence, and the tick that executes nextActions. Every decision
// lives in orchestration.ts; this module only holds state and performs
// effects. Shaped after kanbanState.ts on purpose -- same optimistic
// mutate, same rollback-unless-superseded, same pendingSaves guard
// against a refresh clobbering an in-flight save.

import { writable, get } from "svelte/store";
import * as backend from "./backend";
import type { Orchestration, RailState, StepState } from "./orchestration";

export const orchestrations = writable<Record<string, Orchestration>>({});

export const saveErrors = writable<Record<string, string>>({});

export function dismissSaveError(workspaceId: string): void {
  saveErrors.update((e) => {
    if (!(workspaceId in e)) return e;
    const { [workspaceId]: _removed, ...rest } = e;
    return rest;
  });
}

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
export async function mutatePlan(
  workspaceId: string,
  mutate: (orch: Orchestration) => Orchestration
): Promise<void> {
  const current = get(orchestrations)[workspaceId];
  if (!current) return;
  const updated = mutate(current);
  orchestrations.update((s) => ({ ...s, [workspaceId]: updated }));
  pendingSaves.set(workspaceId, (pendingSaves.get(workspaceId) ?? 0) + 1);
  try {
    await backend.setOrchestration(workspaceId, updated.rails, updated.conflictNotes);
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

/** @internal test-only reset for module-level state */
export function __resetForTesting(): void {
  orchestrations.set({});
  saveErrors.set({});
  pendingSaves.clear();
}
