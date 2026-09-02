import * as backend from "./backend";
import { composeSlot } from "./cardCompose";
import { patchPlanField } from "./gavinState";
import { computeOrderWrites, type OrderedPlanCard } from "./planOrder";
import { dropHold } from "./kanbanDrag";
import type { MergedBoard } from "./boardSearch";
import type { Column } from "./kanban";
import type { CardView, DisplayColumn, AutoColumn } from "./planBoard";
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
// the watcher push (~170ms) reconciles whatever landed -- and return an
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

/// A card the app has just filed, given the `order:` that puts it at the
/// END of the column it was filed into.
///
/// Card creation writes no `order:` at all, and the board's sort key
/// puts unordered cards in an alphabetical tail -- so a card the human
/// had just typed landed wherever its file name fell, halfway up a
/// column they were not looking at. This is deliberately the SAME write
/// set as dragging it to the foot of that column: one rule for where a
/// card sits, whether it got there by gesture or by being typed.
///
/// Null on success and when there is nothing to place against (no board
/// projection yet, or a status no column on it carries). The card
/// exists either way -- placement is the last step of filing it, never
/// a reason to refuse.
export async function placeCardAtColumnEnd(
  workspaceId: string,
  path: string,
  status: string,
  merged: MergedBoard | null,
  scoped: MergedBoard | null = null
): Promise<string | null> {
  const slot = merged ? composeSlot(merged, scoped, status, path) : null;
  if (!slot) return null;
  return applyPlanDrop({
    workspaceId,
    path,
    statusTarget: null, // the card was created carrying this status
    targetColumn: slot.cards,
    targetIndex: slot.index,
  });
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
  const all = [
    ...merged.columns.flatMap((c) => c.planCards),
    ...merged.autoColumns.flatMap((a) => a.planCards),
  ].flatMap((c) => [c, ...c.nestedChildren]);
  const dragged = all.find((c) => c.id === drag.id);
  if (!dragged) return "Couldn't resolve the dragged card";

  // Hold the drop's visuals (card hidden, placeholder in place) while
  // the writes are in flight: gavinTrees is patched only on success, so
  // without this the card flashes back to its pre-drop slot until the
  // daemon round-trips finish. Released in finally either way -- on
  // success the patch lands in the same tick, on failure the card
  // returning to its old slot is the truthful outcome.
  dropHold.set({ kind: "plan", id: drag.id, target: drag.target, size: drag.size });
  try {
    if (drag.target.nest) {
      return await applyNestDrop(workspaceId, dragged, drag.target.nest, drag.target.index, all);
    }

    const targetKey = drag.target.columnId;
    const isAuto = targetKey.startsWith(AUTO_COLUMN_PREFIX);
    const planCards = isAuto
      ? (merged.autoColumns.find((a) => AUTO_COLUMN_PREFIX + a.status === targetKey)?.planCards ?? [])
      : (merged.columns.find((dc) => dc.column.id === targetKey)?.planCards ?? []);
    // A nested child being freed (status null) always gets the column's
    // name -- even its parent's own column (card-model spec §2).
    const statusTarget =
      drag.sourceColumnId === targetKey && dragged.status !== null
        ? null
        : isAuto
          ? targetKey.slice(AUTO_COLUMN_PREFIX.length)
          : (columns.find((c) => c.id === targetKey)?.name ?? null);
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

// Nest drop (card-model spec §2): parent write (when changed), status
// removal (when present), then order writes among the plan's nested
// children. Same patch-on-success/stop-on-failure contract as
// applyPlanDrop; the watcher push (~170ms) reconciles partial landings.
async function applyNestDrop(
  workspaceId: string,
  dragged: CardView,
  planPath: string,
  targetIndex: number,
  all: CardView[]
): Promise<string | null> {
  const plan = all.find((c) => c.id === planPath);
  if (!plan || plan.kind !== "plan" || dragged.kind !== "task" || plan.contextFolder !== dragged.contextFolder) {
    return "Only a task can nest into a plan in its own context";
  }
  let current = dragged.id;
  try {
    if (dragged.parent !== plan.fileName) {
      await backend.setPlanFrontmatterField(dragged.id, "parent", plan.fileName);
      patchPlanField(workspaceId, dragged.id, "parent", plan.fileName);
    }
    if (dragged.status !== null) {
      await backend.setPlanFrontmatterField(dragged.id, "status", "");
      patchPlanField(workspaceId, dragged.id, "status", "");
    }
    const siblings = plan.nestedChildren
      .filter((c) => c.id !== dragged.id)
      .map((c) => ({ path: c.id, order: c.order }));
    for (const w of computeOrderWrites(siblings, targetIndex, dragged.id)) {
      current = w.path;
      await backend.setPlanFrontmatterField(w.path, "order", String(w.order));
      patchPlanField(workspaceId, w.path, "order", String(w.order));
    }
    return null;
  } catch (e) {
    const fileName = current.split("/").at(-1) ?? current;
    return `Couldn't update ${fileName}: ${e instanceof Error ? e.message : e}`;
  }
}
