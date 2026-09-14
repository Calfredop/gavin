// Where a critical-review run is remembered between launch and any later
// "build findings rail" action.
//
// Machine-local, like bestOfNRuns: the sessions and the toggle live on
// this install, and putting them on the daemon would cost a protocol bump
// for a feature that needs neither. localStorage per workspace; absence
// and corruption are forgiven.

import { get, writable } from "svelte/store";
import type { CriticalReviewSubjectKind } from "$lib/review/criticalReview";

export interface CriticalReviewRun {
  pageId: string;
  startedAt: number;
  subjectKind: CriticalReviewSubjectKind;
  subjectLabel: string;
  cardPath: string | null;
  railId: string | null;
  /// The dialog's per-run toggle. The findings-rail card reads this to
  /// decide whether to auto-build; default was off at launch.
  alsoBuildFindingsRail: boolean;
  sessionIds: string[];
  /// When this run was started by `builtin:critical-review` on a rail,
  /// the step that owns it — the scheduler completes that step once
  /// every sessionIds entry has finished. Null for a dialog launch.
  stepId: string | null;
}

type MaybeStorage = Pick<Storage, "getItem" | "setItem" | "removeItem"> | undefined;

function defaultStorage(): MaybeStorage {
  return typeof localStorage === "undefined" ? undefined : localStorage;
}

export function runsStorageKey(workspaceId: string): string {
  return `gavin.criticalReviewRuns.${workspaceId}`;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function parseRuns(raw: string | null | undefined): CriticalReviewRun[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const runs: CriticalReviewRun[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const pageId = str(e.pageId);
    if (!pageId) continue;
    const sessionIds = Array.isArray(e.sessionIds)
      ? e.sessionIds.filter((s): s is string => typeof s === "string" && s.length > 0)
      : [];
    runs.push({
      pageId,
      startedAt: typeof e.startedAt === "number" ? e.startedAt : 0,
      subjectKind: e.subjectKind === "rail" ? "rail" : "card",
      subjectLabel: str(e.subjectLabel),
      cardPath: str(e.cardPath) || null,
      railId: str(e.railId) || null,
      alsoBuildFindingsRail: e.alsoBuildFindingsRail === true,
      sessionIds,
      stepId: str(e.stepId) || null,
    });
  }
  return runs;
}

/// workspaceId -> runs still in flight (or awaiting a findings-rail build).
export const criticalReviewRuns = writable<Record<string, CriticalReviewRun[]>>({});

export function putRun(workspaceId: string, run: CriticalReviewRun, storage: MaybeStorage = defaultStorage()): void {
  criticalReviewRuns.update((all) => {
    const next = { ...all, [workspaceId]: [...(all[workspaceId] ?? []).filter((r) => r.pageId !== run.pageId), run] };
    try {
      storage?.setItem(runsStorageKey(workspaceId), JSON.stringify(next[workspaceId]));
    } catch {
      // localStorage full or unavailable — the run still lives in memory.
    }
    return next;
  });
}

export function dropRun(workspaceId: string, pageId: string, storage: MaybeStorage = defaultStorage()): void {
  criticalReviewRuns.update((all) => {
    const nextList = (all[workspaceId] ?? []).filter((r) => r.pageId !== pageId);
    const next = { ...all, [workspaceId]: nextList };
    try {
      if (nextList.length === 0) storage?.removeItem(runsStorageKey(workspaceId));
      else storage?.setItem(runsStorageKey(workspaceId), JSON.stringify(nextList));
    } catch {
      /* ignore */
    }
    return next;
  });
}

export function hydrateRuns(workspaceId: string, storage: MaybeStorage = defaultStorage()): void {
  const runs = parseRuns(storage?.getItem(runsStorageKey(workspaceId)));
  criticalReviewRuns.update((all) => ({ ...all, [workspaceId]: runs }));
}

export function runForPage(runs: CriticalReviewRun[] | undefined, pageId: string): CriticalReviewRun | null {
  return runs?.find((r) => r.pageId === pageId) ?? null;
}

export function runsNeedingFindingsRail(workspaceId: string): CriticalReviewRun[] {
  return (get(criticalReviewRuns)[workspaceId] ?? []).filter((r) => r.alsoBuildFindingsRail);
}

/// stepId → reviewer session ids, for the scheduler. Dialog-only runs
/// (no stepId) are omitted.
export function critiqueSessionIdsByStep(
  runs: readonly CriticalReviewRun[] | undefined
): Map<string, readonly string[]> {
  const map = new Map<string, readonly string[]>();
  for (const run of runs ?? []) {
    if (run.stepId) map.set(run.stepId, run.sessionIds);
  }
  return map;
}
