import type { Board } from "$lib/board/kanban";
import type { GavinTree } from "$lib/gavin";
import type { WorktreeInfo } from "$lib/git/git";
import { detectConflicts, isStepFinished, railStateOf, stepStateOf } from "$lib/orchestration";
import type { Orchestration, RailState } from "$lib/orchestration";
import { mergePlanCards } from "$lib/planBoard";

export interface ColumnSummary {
  name: string;
  planCount: number;
}

export interface BoardSummary {
  columns: ColumnSummary[];
  autoColumns: Array<{ status: string; count: number }>;
  totalCards: number;
}

// Built on mergePlanCards rather than re-deriving the projection, so the
// home's counts can never disagree with the board itself.
export function boardSummary(board: Board | undefined, tree: GavinTree | undefined): BoardSummary {
  if (!board) return { columns: [], autoColumns: [], totalCards: 0 };
  const merged = mergePlanCards(board, tree);
  const columns = merged.columns.map((dc) => ({
    name: dc.column.name,
    planCount: dc.planCards.length,
  }));
  const autoColumns = merged.autoColumns.map((a) => ({ status: a.status, count: a.planCards.length }));
  const totalCards =
    columns.reduce((n, c) => n + c.planCount, 0) + autoColumns.reduce((n, a) => n + a.count, 0);
  return { columns, autoColumns, totalCards };
}

export interface PlanSummary {
  total: number;
  contexts: number;
  byStatus: Array<{ status: string; count: number }>;
}

const NO_STATUS = "(no status)";

export function planSummary(tree: GavinTree | undefined): PlanSummary {
  if (!tree || tree.rootMissing) return { total: 0, contexts: 0, byStatus: [] };
  const counts = new Map<string, number>();
  let total = 0;
  for (const ctx of tree.contexts) {
    for (const plan of ctx.plans) {
      total += 1;
      const key = plan.status?.trim() ? plan.status : NO_STATUS;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  // Sorted by name: a tally that reorders itself as counts change is
  // harder to read at a glance than a stable one.
  const byStatus = [...counts.entries()]
    .map(([status, count]) => ({ status, count }))
    .sort((a, b) => a.status.localeCompare(b.status));
  return { total, contexts: tree.contexts.length, byStatus };
}

// First non-empty lines, so a PRD that opens with blank lines or a lone
// heading still shows something useful in a small panel.
/// The PRD as the home tab's panel shows it: the file's first
/// `maxLines` lines that say something, with the blank lines BETWEEN
/// them kept so the excerpt reads as prose rather than as one wall of
/// text. The panel scrolls, so the excerpt is long enough to be worth
/// scrolling -- which is exactly what makes the paragraph breaks matter.
/// Runs of blanks collapse to one, and neither end keeps a blank: an
/// empty first or last row would spend a line of the panel saying
/// nothing.
export function prdExcerpt(content: string, maxLines: number): string[] {
  const lines: string[] = [];
  let kept = 0;
  for (const raw of content.split("\n")) {
    const line = raw.trimEnd();
    if (line.trim().length === 0) {
      if (lines.length > 0 && lines[lines.length - 1] !== "") lines.push("");
      continue;
    }
    lines.push(line);
    kept += 1;
    if (kept === maxLines) break;
  }
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/// One rail, reduced to what a recap row can say: where it is and
/// whether anything needs a human.
export interface RailRecap {
  id: string;
  name: string;
  state: RailState;
  stagesTotal: number;
  /// Stages whose every step is `done`. An empty stage counts as done
  /// on the same rule the scheduler uses (firstUnfinishedStageId).
  stagesDone: number;
  /// 1-based index of the rail's current stage among its stages by
  /// position, or null when the rail is not armed.
  currentStage: number | null;
  stepsStalled: number;
}

export interface OrchestrationSummary {
  rails: RailRecap[];
  railsRunning: number;
  stepsRunning: number;
  stepsStalled: number;
  conflicts: number;
  liveConflicts: number;
}

// Built on detectConflicts rather than a cheaper re-count, so the home's
// badge can never disagree with the tab's conflicts box -- the same rule
// boardSummary follows for the board.
export function orchestrationSummary(
  orch: Orchestration | undefined,
  tree: GavinTree | undefined,
  worktrees: WorktreeInfo[] | null,
  branches: string[] | null
): OrchestrationSummary {
  if (!orch) {
    return { rails: [], railsRunning: 0, stepsRunning: 0, stepsStalled: 0, conflicts: 0, liveConflicts: 0 };
  }
  const rails: RailRecap[] = [...orch.rails]
    .sort((a, b) => a.position - b.position)
    .map((rail) => {
      const stages = [...rail.stages].sort((a, b) => a.position - b.position);
      const run = orch.railRuns.find((r) => r.railId === rail.id) ?? null;
      const at = run?.currentStageId ? stages.findIndex((s) => s.id === run.currentStageId) : -1;
      return {
        id: rail.id,
        name: rail.name,
        state: railStateOf(orch, rail.id),
        stagesTotal: stages.length,
        // Finished, not achieved: a stage the human skipped past is one
        // the rail is done with, and a recap that still counted it
        // "3 of 7" would under-report how far the rail has actually got.
        stagesDone: stages.filter((s) =>
          s.steps.every((t) => isStepFinished(stepStateOf(orch, t.id)))
        ).length,
        currentStage: at < 0 ? null : at + 1,
        stepsStalled: stages.reduce(
          (n, s) => n + s.steps.filter((t) => stepStateOf(orch, t.id) === "stalled").length,
          0
        ),
      };
    });
  const conflicts = detectConflicts(orch, tree, worktrees, branches);
  return {
    rails,
    railsRunning: rails.filter((r) => r.state === "running").length,
    // Counted off stepRuns, not the plan: a run row for a step the agent
    // has since deleted is dropped by the push listener, so the two agree.
    stepsRunning: orch.stepRuns.filter((r) => r.state === "running").length,
    stepsStalled: orch.stepRuns.filter((r) => r.state === "stalled").length,
    conflicts: conflicts.length,
    liveConflicts: conflicts.filter((c) => c.severity === "live").length,
  };
}
