// Deletion planning + execution for card files (card-model delete
// design). Deleting a plan cascades its NESTED children (they live
// inside it) and un-parents its free-standing children (they keep their
// own column life -- no broken chips left behind). Bindings die with the
// files daemon-side; a live agent session stays visible on the Agents
// page.

import * as backend from "./backend";
import { patchPlanRemoved, patchPlanField } from "./gavinState";
import { refreshBoard } from "./kanbanState";
import type { CardView } from "./planBoard";

export interface DeletionPlan {
  // Files to delete, dragged-in order: the card itself plus, for plans,
  // every nested child.
  files: CardView[];
  // Free-standing children (elsewhere on the board) to un-parent.
  unparent: CardView[];
}

export function deletionPlanFor(card: CardView, allCards: CardView[]): DeletionPlan {
  const files: CardView[] = [card, ...card.nestedChildren];
  const unparent =
    card.kind === "plan"
      ? allCards.filter(
          (c) =>
            c.parent === card.fileName &&
            c.contextFolder === card.contextFolder &&
            c.status !== null &&
            c.id !== card.id
        )
      : [];
  return { files, unparent };
}

// The cascade for deleting a whole column: every card in it (each with
// its own family rules), deduplicated.
export function columnDeletionPlan(planCards: CardView[], allCards: CardView[]): DeletionPlan {
  const files: CardView[] = [];
  const unparent: CardView[] = [];
  const fileIds = new Set<string>();
  const unparentIds = new Set<string>();
  for (const card of planCards) {
    const plan = deletionPlanFor(card, allCards);
    for (const f of plan.files) {
      if (!fileIds.has(f.id)) {
        fileIds.add(f.id);
        files.push(f);
      }
    }
    for (const u of plan.unparent) {
      if (!unparentIds.has(u.id)) {
        unparentIds.add(u.id);
        unparent.push(u);
      }
    }
  }
  // A card queued for deletion never needs un-parenting.
  return { files, unparent: unparent.filter((u) => !fileIds.has(u.id)) };
}

// Sequential, patch-on-success; stops on the first failure and names the
// file (the watcher reconciles whatever landed). Refreshes the board at
// the end so binding rows removed daemon-side leave the store too.
export async function executeDeletion(workspaceId: string, plan: DeletionPlan): Promise<string | null> {
  let current = "";
  try {
    for (const card of plan.files) {
      current = card.id;
      await backend.deleteCardFile(card.id);
      patchPlanRemoved(workspaceId, card.id);
    }
    for (const card of plan.unparent) {
      current = card.id;
      await backend.setPlanFrontmatterField(card.id, "parent", "");
      patchPlanField(workspaceId, card.id, "parent", "");
    }
    return null;
  } catch (e) {
    const fileName = current.split("/").at(-1) ?? current;
    return `Couldn't delete ${fileName}: ${e instanceof Error ? e.message : e}`;
  } finally {
    void refreshBoard(workspaceId);
  }
}
