import type { Board } from "./kanban";
import type { GavinTree } from "./gavin";
import { mergePlanCards } from "./planBoard";

export interface ColumnSummary {
  name: string;
  freeFormCount: number;
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
    freeFormCount: dc.column.cards.length,
    planCount: dc.planCards.length,
  }));
  const autoColumns = merged.autoColumns.map((a) => ({ status: a.status, count: a.planCards.length }));
  const totalCards =
    columns.reduce((n, c) => n + c.freeFormCount + c.planCount, 0) +
    autoColumns.reduce((n, a) => n + a.count, 0);
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
export function prdExcerpt(content: string, maxLines: number): string[] {
  return content
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)
    .slice(0, maxLines);
}
