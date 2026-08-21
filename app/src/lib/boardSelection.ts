// Board multi-select: shift+click accumulates cards into one selection,
// and the selection bar runs them exactly like a column's "Run all" --
// same sequential spawn, same unbound-only rule -- but restricted to
// what the human picked, across columns.
//
// The selection is APP-WIDE, like dragState: the hub board and a
// context BoardPane can be mounted at the same time, and a card picked
// on either is the same file. Each surface intersects the selection
// with its own projection (selectedCards), so a hub selection never
// haunts a context board that doesn't render those cards, and a deleted
// card's leftover id simply stops counting.

import { writable, get } from "svelte/store";
import type { CardView } from "./planBoard";

/// Card paths, in the order they were picked.
export const boardSelection = writable<string[]>([]);

export function toggleCardSelected(id: string): void {
  boardSelection.update((selection) => toggleSelection(selection, id));
}

export function clearBoardSelection(): void {
  // Setting an empty array over an empty array would wake every
  // subscriber for nothing -- plain clicks clear constantly.
  if (get(boardSelection).length > 0) boardSelection.set([]);
}

// --- pure helpers ----------------------------------------------------

export function toggleSelection(selection: string[], id: string): string[] {
  return selection.includes(id) ? selection.filter((s) => s !== id) : [...selection, id];
}

/// The picked cards this surface actually shows, in BOARD order (not
/// click order): a run walks them the way the human reads them.
export function selectedCards(allCards: CardView[], selection: string[]): CardView[] {
  if (selection.length === 0) return [];
  const picked = new Set(selection);
  const seen = new Set<string>();
  return allCards.filter((c) => {
    if (!picked.has(c.id) || seen.has(c.id)) return false;
    seen.add(c.id);
    return true;
  });
}

/// What "Run selected" would actually spawn: the same rule the column's
/// Run all uses -- notes can't run, and a card with a live session
/// binding is already running (Run would only jump to it).
export function runnableSelection(cards: CardView[], isBound: (id: string) => boolean): CardView[] {
  return cards.filter((c) => c.kind !== "note" && !isBound(c.id));
}
