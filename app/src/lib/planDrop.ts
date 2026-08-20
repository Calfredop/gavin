import * as backend from "./backend";
import { patchPlanField } from "./gavinState";
import { computeOrderWrites, type OrderedPlanCard } from "./planOrder";
import { dropHold } from "./kanbanDrag";
import type { Column } from "./kanban";
import type { DisplayColumn, AutoColumn } from "./planBoard";
import type { DropTarget } from "./pointerDrag";

export interface PlanDropSpec {
  workspaceId: string;
  path: string; // the dragged plan file
  statusTarget: string | null; // column name / auto status when the column changed
  targetColumn: OrderedPlanCard[]; // target plan block, visual order, dragged excluded
  targetIndex: number; // post-removal slot
}

// Applies a plan-card drop: status first (cross-column only), then the
// order writes. Each field is patched into gavinTrees only after its
// write resolves (the optimistic-patch contract). On failure: stop --
// the ~2.5s watcher push reconciles whatever landed -- and return an
// error naming the file that failed. Null on success.
export async function applyPlanDrop(spec: PlanDropSpec): Promise<string | null> {
  let current = spec.path;
  try {
    if (spec.statusTarget !== null) {
      await backend.setPlanFrontmatterField(spec.path, "status", spec.statusTarget);
      patchPlanField(spec.workspaceId, spec.path, "status", spec.statusTarget);
    }
    for (const w of computeOrderWrites(spec.targetColumn, spec.targetIndex, spec.path)) {
      current = w.path;
      await backend.setPlanFrontmatterField(w.path, "order", String(w.order));
      patchPlanField(spec.workspaceId, w.path, "order", String(w.order));
    }
    return null;
  } catch (e) {
    const fileName = current.split("/").at(-1) ?? current;
    return `Couldn't update ${fileName}: ${e instanceof Error ? e.message : e}`;
  }
}

export const AUTO_COLUMN_PREFIX = "auto:";

// Builds and applies the PlanDropSpec for a committed plan drag against
// the merged board view -- shared by the hub board and BoardPane so the
// auto-column key convention ("auto:<status>") and the cross-column
// detection live in exactly one place. drag.sourceColumnId is the
// display-column key at grab; a different target key means restatus.
export async function planCommitFromMerged(
  workspaceId: string,
  drag: {
    id: string;
    sourceColumnId: string | null;
    target: DropTarget;
    size?: { width: number; height: number };
  },
  columns: Column[],
  merged: { columns: DisplayColumn[]; autoColumns: AutoColumn[] }
): Promise<string | null> {
  const targetKey = drag.target.columnId;
  const isAuto = targetKey.startsWith(AUTO_COLUMN_PREFIX);
  const planCards = isAuto
    ? (merged.autoColumns.find((a) => AUTO_COLUMN_PREFIX + a.status === targetKey)?.planCards ?? [])
    : (merged.columns.find((dc) => dc.column.id === targetKey)?.planCards ?? []);
  const statusTarget =
    drag.sourceColumnId === targetKey
      ? null
      : isAuto
        ? targetKey.slice(AUTO_COLUMN_PREFIX.length)
        : (columns.find((c) => c.id === targetKey)?.name ?? null);
  // Hold the drop's visuals (card hidden, placeholder in place) while
  // the writes are in flight: gavinTrees is patched only on success, so
  // without this the card flashes back to its pre-drop slot until the
  // daemon round-trips finish. Released in finally either way -- on
  // success the patch lands in the same tick, on failure the card
  // returning to its old slot is the truthful outcome.
  dropHold.set({ kind: "plan", id: drag.id, target: drag.target, size: drag.size });
  try {
    return await applyPlanDrop({
      workspaceId,
      path: drag.id,
      statusTarget,
      targetColumn: planCards.filter((p) => p.id !== drag.id).map((p) => ({ path: p.id, order: p.order })),
      targetIndex: drag.target.index,
    });
  } finally {
    dropHold.set(null);
  }
}
