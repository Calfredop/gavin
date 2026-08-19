import * as backend from "./backend";
import { patchPlanField } from "./gavinState";
import { computeOrderWrites, type OrderedPlanCard } from "./planOrder";

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
