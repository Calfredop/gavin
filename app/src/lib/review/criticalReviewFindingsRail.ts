// Build an orchestration rail whose steps are finding cards from a
// critical-review run.
//
// Pure. The dialog that lets the human cull cards, the auto-build that
// honours the per-run toggle, and the Review-tab entry live in
// criticalReviewFindingsRailActions.ts / FindingsRailDialog.svelte.

import {
  addCardAsStage,
  addRail,
  type Orchestration,
} from "$lib/orchestration/orchestration";
import type { CriticalReviewRun } from "$lib/review/criticalReviewState";

/// What the filing prompt names: `file_name` kebab-case, prefixed
/// `review-`. Nested findings under a plan keep that prefix too.
export function isReviewFindingFileName(fileName: string): boolean {
  const base = fileName.replace(/\.md$/i, "");
  return base.startsWith("review-");
}

export interface FindingCardRef {
  path: string;
  title: string;
  fileName: string;
  /// Unix seconds, matching CardView.modifiedAt. Null when unknown.
  modifiedAt: number | null;
  parent: string | null;
  order: number | null;
}

/// A finding belongs to this run when it was filed under the reviewed
/// plan (nested, parent = plan fileName) or its mtime is at/after the
/// run's start. Old `review-*` cards from earlier passes stay out unless
/// they nest under this subject.
export function collectFindingsForRun(
  run: Pick<CriticalReviewRun, "startedAt" | "cardPath">,
  cards: readonly FindingCardRef[],
  subject: { fileName: string; kind: "plan" | "task" | "note" } | null = null
): FindingCardRef[] {
  const startedAtSec = Math.floor(run.startedAt / 1000);
  const planFile =
    subject?.kind === "plan" ? subject.fileName : null;

  const matched = cards.filter((card) => {
    if (!isReviewFindingFileName(card.fileName)) return false;
    if (planFile && card.parent === planFile) return true;
    if (card.modifiedAt != null && card.modifiedAt >= startedAtSec) return true;
    return false;
  });

  return [...matched].sort((a, b) => {
    const ao = a.order;
    const bo = b.order;
    if (ao != null && bo != null && ao !== bo) return ao - bo;
    if (ao != null && bo == null) return -1;
    if (ao == null && bo != null) return 1;
    const am = a.modifiedAt;
    const bm = b.modifiedAt;
    if (am != null && bm != null && am !== bm) return am - bm;
    if (am != null && bm == null) return -1;
    if (am == null && bm != null) return 1;
    return a.title.localeCompare(b.title);
  });
}

/// Explicit path: keep the human's selection, preserve collect order.
export function cullFindings(
  findings: readonly FindingCardRef[],
  keptPaths: ReadonlySet<string>
): FindingCardRef[] {
  return findings.filter((f) => keptPaths.has(f.path));
}

export function findingsRailName(subjectLabel: string): string {
  const collapsed = subjectLabel.split(/\s+/).filter(Boolean).join(" ");
  return collapsed ? `Findings: ${collapsed}` : "Findings";
}

export const NO_FINDINGS_ERROR = "No finding cards to build a rail from";

export type BuildFindingsRailResult =
  | { ok: true; orch: Orchestration; railId: string }
  | { ok: false; error: string };

/// One stage per finding, in the order given. Refuses an empty list so
/// an auto-build never creates a nameless empty rail.
export function buildFindingsRail(
  orch: Orchestration,
  input: {
    railId: string;
    name: string;
    findings: readonly { stepId: string; cardPath: string }[];
  }
): BuildFindingsRailResult {
  if (input.findings.length === 0) {
    return { ok: false, error: NO_FINDINGS_ERROR };
  }
  let next = addRail(orch, input.railId, input.name);
  for (let i = 0; i < input.findings.length; i++) {
    const f = input.findings[i];
    next = addCardAsStage(next, input.railId, i, f.stepId, f.cardPath);
  }
  return { ok: true, orch: next, railId: input.railId };
}
