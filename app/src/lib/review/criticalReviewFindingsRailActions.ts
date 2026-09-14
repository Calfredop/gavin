// Side-effecting half of criticalReviewFindingsRail.ts: open the cull
// dialog, persist a new rail, and honour the per-run auto-build toggle
// once every reviewer session has finished.

import { get, writable, type Readable } from "svelte/store";
import { flattenCardViews, mergePlanCards, type CardView } from "$lib/core/planBoard";
import { showAlert } from "$lib/core/dialog";
import { gavinTrees } from "$lib/core/gavinState";
import { layoutState } from "$lib/core/layoutState";
import { kanbanState, fetchBoard } from "$lib/board/kanbanState";
import { allSessionIds } from "$lib/panes/layout";
import {
  fetchOrchestration,
  mutatePlan,
  orchestrations,
} from "$lib/orchestration/orchestrationState";
import { critiqueSessionsComplete } from "$lib/review/criticalReview";
import {
  NO_FINDINGS_ERROR,
  buildFindingsRail,
  collectFindingsForRun,
  cullFindings,
  findingsRailName,
  type FindingCardRef,
} from "$lib/review/criticalReviewFindingsRail";
import {
  criticalReviewRuns,
  dropRun,
  putRun,
  runForPage,
  runsNeedingFindingsRail,
  type CriticalReviewRun,
} from "$lib/review/criticalReviewState";

export interface FindingsRailRequest {
  workspaceId: string;
  pageId: string;
}

const pending = writable<FindingsRailRequest | null>(null);

export const findingsRailRequest: Readable<FindingsRailRequest | null> = {
  subscribe: pending.subscribe,
};

export function cancelFindingsRail(): void {
  pending.set(null);
}

/// Explicit path: open the cull dialog for this run.
export function requestFindingsRail(workspaceId: string, pageId: string): string | null {
  const run = runForPage(get(criticalReviewRuns)[workspaceId], pageId);
  if (!run) return "That critical review is gone";
  pending.set({ workspaceId, pageId });
  return null;
}

function subjectOf(workspaceId: string, run: CriticalReviewRun): {
  fileName: string;
  kind: "plan" | "task" | "note";
} | null {
  if (!run.cardPath) return null;
  const board = get(kanbanState)[workspaceId];
  const tree = get(gavinTrees)[workspaceId];
  if (!board || !tree) return null;
  const card = flattenCardViews(mergePlanCards(board, tree)).find((c) => c.id === run.cardPath);
  if (!card) return null;
  return { fileName: card.fileName, kind: card.kind };
}

function cardsAsFindings(cards: readonly CardView[]): FindingCardRef[] {
  return cards.map((c) => ({
    path: c.id,
    title: c.title,
    fileName: c.fileName,
    modifiedAt: c.modifiedAt ?? null,
    parent: c.parent,
    order: c.order,
  }));
}

export function findingsForRun(workspaceId: string, run: CriticalReviewRun): FindingCardRef[] {
  const board = get(kanbanState)[workspaceId];
  const tree = get(gavinTrees)[workspaceId];
  if (!board || !tree) return [];
  return collectFindingsForRun(
    run,
    cardsAsFindings(flattenCardViews(mergePlanCards(board, tree))),
    subjectOf(workspaceId, run)
  );
}

function runSessionsComplete(run: CriticalReviewRun): boolean {
  const layout = get(layoutState);
  // Same live set the orchestration scheduler builds: every session id
  // still in a page layout. A reviewer that closed its tab counts as
  // finished (critiqueSessionsComplete).
  const liveSessionIds = new Set<string>();
  for (const ws of layout.workspaces) {
    for (const page of ws.pages) {
      for (const id of allSessionIds(page.layout)) liveSessionIds.add(id);
    }
  }
  const sessionStatuses = new Map(Object.entries(layout.sessionStatusById));
  const seenWorking = layout.sessionsSeenWorking ?? new Set<string>();
  return critiqueSessionsComplete({
    sessionIds: run.sessionIds,
    liveSessionIds,
    sessionStatuses,
    sessionsSeenWorking: seenWorking,
  });
}

async function ensureBoardAndOrch(workspaceId: string): Promise<void> {
  await Promise.all([fetchBoard(workspaceId), fetchOrchestration(workspaceId)]);
}

/// Persist a rail from the chosen finding paths. Returns an error string.
export async function buildFindingsRailAction(
  workspaceId: string,
  run: CriticalReviewRun,
  findingPaths: readonly string[]
): Promise<string | null> {
  if (findingPaths.length === 0) return NO_FINDINGS_ERROR;
  await ensureBoardAndOrch(workspaceId);
  if (!get(orchestrations)[workspaceId]) {
    return "This workspace has no orchestration plan loaded yet";
  }
  const findings = findingPaths.map((cardPath) => ({
    stepId: crypto.randomUUID(),
    cardPath,
  }));
  const name = findingsRailName(run.subjectLabel);
  const railId = crypto.randomUUID();
  let refused: string | null = null;
  const error = await mutatePlan(workspaceId, (o) => {
    const built = buildFindingsRail(o, { railId, name, findings });
    if (!built.ok) {
      refused = built.error;
      return o;
    }
    return built.orch;
  });
  if (refused) return refused;
  if (error) return error;
  dropRun(workspaceId, run.pageId);
  return null;
}

/// Dialog confirm: cull then build. Stays open (returns error) on refuse.
export async function confirmFindingsRail(keptPaths: ReadonlySet<string>): Promise<string | null> {
  const request = get(pending);
  if (!request) return null;
  const run = runForPage(get(criticalReviewRuns)[request.workspaceId], request.pageId);
  if (!run) {
    pending.set(null);
    return "That critical review is gone";
  }
  await ensureBoardAndOrch(request.workspaceId);
  const culled = cullFindings(findingsForRun(request.workspaceId, run), keptPaths);
  if (culled.length === 0) return NO_FINDINGS_ERROR;
  const err = await buildFindingsRailAction(
    request.workspaceId,
    run,
    culled.map((f) => f.path)
  );
  if (err) return err;
  pending.set(null);
  return null;
}

/// Auto-build path: no cull dialog. Clears the toggle after a clean
/// refuse so the watcher does not re-alert forever.
export async function autoBuildFindingsRail(
  workspaceId: string,
  run: CriticalReviewRun
): Promise<void> {
  await ensureBoardAndOrch(workspaceId);
  const findings = findingsForRun(workspaceId, run);
  if (findings.length === 0) {
    putRun(workspaceId, { ...run, alsoBuildFindingsRail: false });
    await showAlert({
      title: "No findings to build a rail from",
      lines: [
        `Critical review of “${run.subjectLabel}” finished without filing any finding cards.`,
        "Nothing was added to Orchestration.",
      ],
      dismissLabel: "Dismiss",
    });
    return;
  }
  const err = await buildFindingsRailAction(
    workspaceId,
    run,
    findings.map((f) => f.path)
  );
  if (err) {
    putRun(workspaceId, { ...run, alsoBuildFindingsRail: false });
    await showAlert({
      title: "Couldn't build the findings rail",
      lines: [err],
      dismissLabel: "Dismiss",
    });
  }
}

let sweeping = false;
let sweepAgain = false;

async function sweepAutoBuild(): Promise<void> {
  if (sweeping) {
    sweepAgain = true;
    return;
  }
  sweeping = true;
  try {
    do {
      sweepAgain = false;
      const all = get(criticalReviewRuns);
      for (const workspaceId of Object.keys(all)) {
        for (const run of runsNeedingFindingsRail(workspaceId)) {
          if (!runSessionsComplete(run)) continue;
          await autoBuildFindingsRail(workspaceId, run);
        }
      }
    } while (sweepAgain);
  } finally {
    sweeping = false;
  }
}

/// Module-level watcher: when a run with the auto-build toggle finishes
/// its reviewers, build the rail without asking. Started once from the
/// app root so it does not depend on Orchestration being the open tab.
export function startFindingsRailAutoBuild(): () => void {
  const unsubs = [
    criticalReviewRuns.subscribe(() => {
      void sweepAutoBuild();
    }),
    layoutState.subscribe(() => {
      void sweepAutoBuild();
    }),
  ];
  return () => {
    for (const u of unsubs) u();
  };
}
