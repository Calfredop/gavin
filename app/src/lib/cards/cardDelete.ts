// Removal flows for cards and columns (card-model delete design):
// deleting card files, or relocating a column's cards before the column
// itself goes. Deleting a plan cascades its NESTED children (they live
// inside it) and un-parents its free-standing children (they keep their
// own column life -- no broken chips left behind). Bindings die with the
// files daemon-side; a live agent session stays visible on the Agents
// page.

import * as backend from "$lib/core/backend";
import { patchPlanRemoved, patchPlanField } from "$lib/core/gavinState";
import { refreshBoard } from "$lib/board/kanbanState";
import type { CardView } from "$lib/core/planBoard";

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
//
// `token` is the caller's grant from `confirmGate.ts`, minted over every
// path in `plan.files` -- one prompt, because deleting a plan card takes
// its nested tasks with it and the human answered for all of them. Each
// file spends it once; a token that names a different set is refused by
// the host, so this cannot be handed a plan it was not shown.
/// What deleting ONE card takes with it, as the confirmation states it.
/// Counted rather than carried, so the prompt can be checked without a
/// board: the caller has already resolved the DeletionPlan and knows
/// whether any of its files still holds a session.
export interface CardDeleteFacts {
  /// The card's own file name -- the prompt names the file, not the
  /// title, because the file is what stops existing.
  fileName: string;
  /// Files the plan deletes: the card plus every nested child.
  files: number;
  /// Free-standing children elsewhere on the board that lose their
  /// `parent:` line and keep their column.
  unparent: number;
  /// Whether any file going still has a live agent session bound. A
  /// boolean, not a count: the sentence is about the surface the session
  /// survives on, and one is as much of a surprise as three.
  boundSession: boolean;
}

/// The confirmation's lines, certain consequence first. Every line after
/// the first is a consequence the card itself does not show, which is
/// the whole reason the prompt exists.
export function cardDeleteLines(facts: CardDeleteFacts): string[] {
  const lines = [`Deletes ${facts.fileName} permanently.`];
  // The card's own file is in the count, so the nested tasks are what is
  // left over -- a card with no children says nothing here.
  const nested = facts.files - 1;
  if (nested > 0) lines.push(`Also deletes ${nested} nested ${nested === 1 ? "task" : "tasks"}.`);
  if (facts.unparent > 0)
    lines.push(
      `${facts.unparent} free-standing ${facts.unparent === 1 ? "task keeps" : "tasks keep"} their column (un-parented).`
    );
  if (facts.boundSession) lines.push("A bound agent session keeps running on the Agents page.");
  return lines;
}

export async function executeDeletion(
  workspaceId: string,
  plan: DeletionPlan,
  token: string
): Promise<string | null> {
  let current = "";
  try {
    for (const card of plan.files) {
      current = card.id;
      await backend.deleteCardFile(card.id, token);
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

// Relocates a column's cards to another column by writing each card's
// `status:` -- the "move cards where?" branch of deleting a custom
// column. Only top-level cards are listed: a plan's nested children
// have no status and travel with their parent. Same sequential,
// patch-on-success, stop-on-failure contract as executeDeletion.
export async function executeMoveCards(
  workspaceId: string,
  cards: CardView[],
  destinationName: string
): Promise<string | null> {
  let current = "";
  try {
    for (const card of cards) {
      current = card.id;
      await backend.setPlanFrontmatterField(card.id, "status", destinationName);
      patchPlanField(workspaceId, card.id, "status", destinationName);
    }
    return null;
  } catch (e) {
    const fileName = current.split("/").at(-1) ?? current;
    return `Couldn't move ${fileName}: ${e instanceof Error ? e.message : e}`;
  }
}
