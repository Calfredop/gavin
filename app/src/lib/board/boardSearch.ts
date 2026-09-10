// The board's search lens: the same merged projection the board always
// renders, with non-matching cards taken out and a record of how many
// each column lost. Pure -- the surfaces only bind an input to it.
//
// It never mutates the projection it is given: the drop path
// (planDrop.ts) commits order writes against the UNFILTERED projection,
// so the two must be able to coexist.

import { matchesFields, queryTokens, type Field } from "$lib/core/search";
import type { AutoColumn, CardView, DisplayColumn } from "$lib/core/planBoard";

/// How an auto column is keyed for hidden-count lookups. Matches the
/// convention planDrop.ts uses for drop targets.
export const AUTO_KEY_PREFIX = "auto:";

export interface MergedBoard {
  columns: DisplayColumn[];
  autoColumns: AutoColumn[];
}

export interface FilteredBoard extends MergedBoard {
  /// False when the query was blank -- surfaces read this to decide
  /// whether to lock drags and re-label counts.
  filtering: boolean;
  /// Top-level cards kept / present. Nested children are not counted
  /// separately, matching what a column header has always shown.
  shown: number;
  total: number;
  /// Cards a column no longer shows; 0 for an unknown key.
  hiddenIn: (columnKey: string) => number;
}

/// Anything that hides cards from a column and can say how many: the
/// facet lens and the search lens both answer this shape.
export interface ColumnLens {
  hiddenIn: (columnKey: string) => number;
}

/// What a column is NOT showing, across every lens standing over it. A
/// column header reads this to say "3 / 11", and its Clear, Delete and
/// Archive-all refuse while it is non-zero -- so it has to count every
/// card the column is holding back, not only the ones the last lens hid.
///
/// Summing is EXACT rather than approximate, and only because the lenses
/// compose: each one filtered what the one before it left, so no card is
/// hidden twice and the counts are disjoint. Stack two lenses over the
/// same unfiltered board and this over-counts.
export function hiddenAcross(
  lenses: readonly (ColumnLens | null | undefined)[],
  columnKey: string
): number {
  return lenses.reduce((sum, lens) => sum + (lens?.hiddenIn(columnKey) ?? 0), 0);
}

function ownFields(card: CardView): Field[] {
  return [card.title, card.fileName, card.status, card.kind, card.contextName, card.parentTitle, ...card.labels];
}

/// A card matches on anything visible on it -- and a plan also matches
/// through its nested children, so searching for a nested task still
/// finds the plan that holds it.
export function cardMatches(card: CardView, tokens: string[]): boolean {
  if (matchesFields(tokens, ownFields(card))) return true;
  return card.nestedChildren.some((child) => matchesFields(tokens, ownFields(child)));
}

// A plan that matches on its own keeps every child (the human asked for
// that plan, and its children are part of it); one that only matches
// through a child narrows to the children that matched.
export function project(card: CardView, tokens: string[]): CardView | null {
  if (matchesFields(tokens, ownFields(card))) return card;
  const children = card.nestedChildren.filter((child) => matchesFields(tokens, ownFields(child)));
  if (children.length === 0) return null;
  return { ...card, nestedChildren: children };
}

export function filterBoard(merged: MergedBoard, query: string): FilteredBoard {
  const tokens = queryTokens(query);
  const total =
    merged.columns.reduce((n, c) => n + c.planCards.length, 0) +
    merged.autoColumns.reduce((n, a) => n + a.planCards.length, 0);

  if (tokens.length === 0) {
    return { ...merged, filtering: false, shown: total, total, hiddenIn: () => 0 };
  }

  const hidden = new Map<string, number>();
  let shown = 0;

  const keep = (cards: CardView[], key: string): CardView[] => {
    const kept = cards.map((c) => project(c, tokens)).filter((c): c is CardView => c !== null);
    hidden.set(key, cards.length - kept.length);
    shown += kept.length;
    return kept;
  };

  const columns = merged.columns.map((dc) => ({ ...dc, planCards: keep(dc.planCards, dc.column.id) }));
  const autoColumns = merged.autoColumns.map((a) => ({
    ...a,
    planCards: keep(a.planCards, AUTO_KEY_PREFIX + a.status),
  }));

  return {
    columns,
    autoColumns,
    filtering: true,
    shown,
    total,
    hiddenIn: (key) => hidden.get(key) ?? 0,
  };
}
