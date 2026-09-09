// The kanban board's FACET lens: the same merged projection the board
// always renders, narrowed by three dropdowns -- the card's context, its
// kind, and the orchestration rail carrying it.
//
// Shaped exactly like pageBoard.ts's page lens and boardSearch.ts's
// search lens, and for the same reason: it never mutates the projection
// it is given, because the drop path (planDrop.ts) still commits order
// writes against the UNFILTERED one. The three compose -- facets first,
// then search, so a column's "hidden" count keeps meaning "hidden by
// your query" rather than "filtered out".
//
// The facet vocabulary is the Plans tab's (planFilter.ts): ANY for an
// unset dropdown, NO_RAIL for "on no rail at all", and the same
// card-path -> rail index behind the rail facet. Two surfaces asking the
// same question must not answer it two ways.

import { ANY, NO_RAIL, underContext, type RailIndex } from "$lib/board/planFilter";
import type { GavinTree } from "$lib/core/gavin";
import type { CardView } from "$lib/core/planBoard";
import { AUTO_KEY_PREFIX } from "$lib/board/boardSearch";
import type { MergedBoard } from "$lib/board/boardSearch";

export { ANY, NO_RAIL, underContext };

export interface BoardFacets {
  /// A context's folder path, or ANY for every context. The ROOT
  /// context is offered AS ANY rather than as its own path: every
  /// context in the workspace is a subfolder of the root, so "the root"
  /// and "all cards" are the same answer, and giving it a second
  /// spelling would only let the two drift.
  context: string;
  /// A card kind ("plan" | "task" | "note"), or ANY.
  kind: string;
  /// A rail id, NO_RAIL, or ANY.
  rail: string;
}

export const NO_FACETS: BoardFacets = { context: ANY, kind: ANY, rail: ANY };

export function facetsActive(facets: BoardFacets): boolean {
  return facets.context !== ANY || facets.kind !== ANY || facets.rail !== ANY;
}

/// The kind dropdown's options, in the order the card model introduces
/// them: the multi-step plan, the unit of agent work, the reminder.
export const KIND_FACETS: { value: CardView["kind"]; label: string }[] = [
  { value: "plan", label: "Plans" },
  { value: "task", label: "Tasks" },
  { value: "note", label: "Notes" },
];

export interface ContextFacet {
  /// What the <option> carries: ANY for the root, the folder path
  /// otherwise.
  value: string;
  label: string;
  /// The folder path, for the option's title attribute -- a label is a
  /// relative path and two contexts named the same way in different
  /// trees would otherwise be indistinguishable.
  folderPath: string;
}

function relativeTo(root: string, folder: string): string | null {
  const base = root.endsWith("/") ? root : `${root}/`;
  return folder.startsWith(base) ? folder.slice(base.length) : null;
}

/// The context dropdown's options: the root first (as ANY -- "every
/// card"), then the workspace's own contexts by path, then the ones
/// outside it. Same ordering the Plans tab's navigator uses, so the two
/// lists read as the same tree.
///
/// A context OUTSIDE the workspace root is labelled by name: its folder
/// shares no prefix with the root, and a bare absolute path in a
/// dropdown is unreadable.
export function contextFacets(tree: GavinTree | undefined): ContextFacet[] {
  const all: ContextFacet[] = [{ value: ANY, label: "All contexts", folderPath: tree?.rootPath ?? "" }];
  if (!tree || tree.rootMissing) return all;

  const rest = tree.contexts.filter((c) => c.kind !== "root");
  const inside = rest.filter((c) => c.outside !== true).sort((a, b) => a.folderPath.localeCompare(b.folderPath));
  const outside = rest.filter((c) => c.outside === true).sort((a, b) => a.folderPath.localeCompare(b.folderPath));

  for (const ctx of inside) {
    all.push({
      value: ctx.folderPath,
      label: relativeTo(tree.rootPath, ctx.folderPath) ?? ctx.name,
      folderPath: ctx.folderPath,
    });
  }
  for (const ctx of outside) {
    all.push({ value: ctx.folderPath, label: `${ctx.name} (outside)`, folderPath: ctx.folderPath });
  }
  return all;
}

/// One card's verdict, so the board and the archive grid ask the same
/// question of the same card.
export function cardPasses(card: CardView, facets: BoardFacets, rails: RailIndex): boolean {
  if (facets.context !== ANY && !underContext(card.contextFolder, facets.context)) return false;
  if (facets.kind !== ANY && card.kind !== facets.kind) return false;
  if (facets.rail !== ANY) {
    const on = rails.byCard.get(card.id);
    if (facets.rail === NO_RAIL ? on !== undefined : on !== facets.rail) return false;
  }
  return true;
}

/// A card that passes keeps every child; one that does not survives only
/// as a home for the children that pass, narrowed to them. That is the
/// narrowing both other lenses apply, and it is what makes a rail facet
/// reach a nested task whose parent plan is on no rail.
function project(card: CardView, facets: BoardFacets, rails: RailIndex): CardView | null {
  if (cardPasses(card, facets, rails)) return card;
  const children = card.nestedChildren.filter((child) => cardPasses(child, facets, rails));
  if (children.length === 0) return null;
  return { ...card, nestedChildren: children };
}

/// The archive grid's half: the same lens over a flat list of cards.
export function filterCards(cards: CardView[], facets: BoardFacets, rails: RailIndex): CardView[] {
  if (!facetsActive(facets)) return cards;
  return cards.map((c) => project(c, facets, rails)).filter((c): c is CardView => c !== null);
}

export interface FacetedBoard extends MergedBoard {
  /// Top-level cards kept / present, counted the way a column header has
  /// always counted them (nested children are not counted separately).
  shown: number;
  total: number;
  /// Cards a column no longer shows; 0 for an unknown key. Keyed exactly
  /// as boardSearch keys its own -- a column id, or AUTO_KEY_PREFIX plus
  /// the auto column's status.
  ///
  /// A column header reads this to say "3 / 11", and its DESTRUCTIVE
  /// actions refuse to run while it is non-zero. That is why the facet
  /// lens has to report it and not merely narrow: a column standing at
  /// three cards out of eleven, saying three, would offer to clear or
  /// delete itself against the eight the human cannot see.
  hiddenIn: (columnKey: string) => number;
}

export function filterBoardByFacets(
  merged: MergedBoard,
  facets: BoardFacets,
  rails: RailIndex
): FacetedBoard {
  const total =
    merged.columns.reduce((n, c) => n + c.planCards.length, 0) +
    merged.autoColumns.reduce((n, a) => n + a.planCards.length, 0);

  if (!facetsActive(facets)) return { ...merged, shown: total, total, hiddenIn: () => 0 };

  const hidden = new Map<string, number>();
  let shown = 0;
  const keep = (cards: CardView[], key: string): CardView[] => {
    const kept = cards.map((c) => project(c, facets, rails)).filter((c): c is CardView => c !== null);
    hidden.set(key, cards.length - kept.length);
    shown += kept.length;
    return kept;
  };

  const columns = merged.columns.map((dc) => ({ ...dc, planCards: keep(dc.planCards, dc.column.id) }));
  const autoColumns = merged.autoColumns.map((a) => ({
    ...a,
    planCards: keep(a.planCards, AUTO_KEY_PREFIX + a.status),
  }));
  return { columns, autoColumns, shown, total, hiddenIn: (key) => hidden.get(key) ?? 0 };
}

/// Reset a facet whose option is gone -- the rail was deleted, the
/// context folder renamed. Without this the board silently shows nothing
/// and the dropdown reads as its first option while filtering on a value
/// no longer in the list.
///
/// UNKNOWN IS NOT ABSENT: a null vocabulary means that half has not
/// loaded yet, and the facet is left exactly alone. The tree and the
/// orchestration each arrive on their own schedule, and pruning against
/// an empty stand-in would clear the human's filter every time either
/// store blinked.
export function pruneFacets(
  facets: BoardFacets,
  contexts: ContextFacet[] | null,
  rails: RailIndex | null
): BoardFacets {
  const context =
    contexts !== null && facets.context !== ANY && !contexts.some((c) => c.value === facets.context)
      ? ANY
      : facets.context;
  const rail =
    rails !== null &&
    facets.rail !== ANY &&
    facets.rail !== NO_RAIL &&
    !rails.rails.some((r) => r.id === facets.rail)
      ? ANY
      : facets.rail;
  return context === facets.context && rail === facets.rail ? facets : { ...facets, context, rail };
}
