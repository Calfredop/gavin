// The kanban board's FACET lens: the same merged projection the board
// always renders, narrowed by four checkbox dropdowns -- the card's
// context, its kind, the orchestration rail carrying it, and its labels.
// Each dropdown is a set: empty means "any", more than one means OR
// inside that facet, and the four facets AND together. Each option has
// its own NOT switch: inverted values are forbidden, included values
// still OR, and a mix is (any include) AND (no invert).
//
// Shaped exactly like pageBoard.ts's page lens and boardSearch.ts's
// search lens, and for the same reason: it never mutates the projection
// it is given, because the drop path (planDrop.ts) still commits order
// writes against the UNFILTERED one. The three compose -- facets first,
// then search, so a column's "hidden" count keeps meaning "hidden by
// your query" rather than "filtered out".
//
// The facet vocabulary is the Plans tab's (planFilter.ts): NO_RAIL for
// "on no rail at all", and the same card-path -> rail index behind the
// rail facet. Two surfaces asking the same question must not answer it
// two ways.

import { ANY, NO_RAIL, facetMatches, underContext, type RailIndex } from "$lib/board/planFilter";
import type { ContextMenuEntry } from "$lib/core/contextMenu";
import type { GavinTree } from "$lib/core/gavin";
import { slugStatus, type CardView } from "$lib/core/planBoard";
import { AUTO_KEY_PREFIX } from "$lib/board/boardSearch";
import type { MergedBoard } from "$lib/board/boardSearch";

export { ANY, NO_RAIL, underContext };

/// One facet's selected values. Empty is unset -- every card still
/// answers. Several values OR: a card that matches any of them passes
/// that facet.
export type FacetSelection = string[];

export interface FacetOption {
  value: string;
  label: string;
}

/// The selected values whose NOT switch is on, per dropdown. Empty is
/// include (the historic default). A value listed here but not in the
/// matching selection is ignored.
export interface FacetExclude {
  context: FacetSelection;
  kind: FacetSelection;
  rail: FacetSelection;
  label: FacetSelection;
}

export interface BoardFacets {
  /// Context folder paths. Empty is every context. The ROOT context is
  /// never offered as a path: every context in the workspace is a
  /// subfolder of the root, so "the root" and "all cards" are the same
  /// answer, and giving it a second spelling would only let the two
  /// drift.
  context: FacetSelection;
  /// Card kinds ("plan" | "task" | "note"). Empty is every kind.
  kind: FacetSelection;
  /// Rail ids and/or NO_RAIL. Empty is every rail (and the unplaced).
  rail: FacetSelection;
  /// Label names. Empty is every card, labeled or not.
  label: FacetSelection;
  /// Per-option invert, flipped by the NOT switch on each row.
  exclude: FacetExclude;
}

export function emptyExclude(): FacetExclude {
  return { context: [], kind: [], rail: [], label: [] };
}

export function emptyFacets(): BoardFacets {
  return { context: [], kind: [], rail: [], label: [], exclude: emptyExclude() };
}

export const NO_FACETS: BoardFacets = emptyFacets();

export const ALL_CONTEXTS_LABEL = "All contexts";
export const ANY_KIND_LABEL = "Any kind";
export const ANY_RAIL_LABEL = "Any rail";
export const ANY_LABEL_LABEL = "Any label";
export const ANY_STATUS_LABEL = "Any status";

function sameSelection(a: FacetSelection, b: FacetSelection): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function sameExclude(a: FacetExclude, b: FacetExclude): boolean {
  return (
    sameSelection(a.context, b.context) &&
    sameSelection(a.kind, b.kind) &&
    sameSelection(a.rail, b.rail) &&
    sameSelection(a.label, b.label)
  );
}

export function facetsEqual(a: BoardFacets, b: BoardFacets): boolean {
  return (
    sameSelection(a.context, b.context) &&
    sameSelection(a.kind, b.kind) &&
    sameSelection(a.rail, b.rail) &&
    sameSelection(a.label, b.label) &&
    sameExclude(a.exclude ?? emptyExclude(), b.exclude ?? emptyExclude())
  );
}

export function facetsActive(facets: BoardFacets): boolean {
  return (
    facets.context.length > 0 ||
    facets.kind.length > 0 ||
    facets.rail.length > 0 ||
    facets.label.length > 0
  );
}

/// Add `value` if it is missing, drop it if it is already selected.
export function toggleFacet(selected: FacetSelection, value: string): FacetSelection {
  return selected.includes(value) ? selected.filter((v) => v !== value) : [...selected, value];
}

/// Flip one option's invert. Unticked + NOT selects it as inverted;
/// include becomes invert; invert becomes include and stays ticked.
export function toggleFacetExclude(
  selected: FacetSelection,
  exclude: FacetSelection,
  value: string
): { selected: FacetSelection; exclude: FacetSelection } {
  if (!selected.includes(value)) {
    return { selected: [...selected, value], exclude: [...exclude, value] };
  }
  if (!exclude.includes(value)) {
    return { selected, exclude: [...exclude, value] };
  }
  return { selected, exclude: exclude.filter((v) => v !== value) };
}

/// Drop a value from the selection and from invert together -- unticking
/// the checkbox clears its NOT rather than leaving a dangling invert.
export function dropFacetValue(
  selected: FacetSelection,
  exclude: FacetSelection,
  value: string
): { selected: FacetSelection; exclude: FacetSelection } {
  const nextSelected = toggleFacet(selected, value);
  if (nextSelected.includes(value)) return { selected: nextSelected, exclude };
  const nextExclude = exclude.filter((v) => v !== value);
  return { selected: nextSelected, exclude: sameSelection(nextExclude, exclude) ? exclude : nextExclude };
}

/// What the dropdown button reads. Empty is the unset label; otherwise
/// the selected options in option order, so "Plans, Tasks" does not
/// reshuffle when the human ticks them the other way round. An inverted
/// option is prefixed; the empty label stays the empty label.
export function facetSummary(
  selected: FacetSelection,
  options: FacetOption[],
  empty: string,
  exclude: FacetSelection = []
): string {
  if (selected.length === 0) return empty;
  const labels = options
    .filter((o) => selected.includes(o.value))
    .map((o) => (exclude.includes(o.value) ? "Not " + o.label : o.label));
  return labels.length > 0 ? labels.join(", ") : empty;
}

/// Checkbox rows for one facet. Each pick keeps the menu open so a
/// second tick is one click away, not a reopen. Each row carries its
/// own NOT switch -- invert is per option, not a second value.
export function facetMenuEntries(
  options: FacetOption[],
  selected: FacetSelection,
  exclude: FacetSelection,
  onToggle: (value: string) => void,
  onToggleExclude: (value: string) => void
): ContextMenuEntry[] {
  return options.map((o) => ({
    label: o.label,
    checked: selected.includes(o.value),
    keepOpen: true,
    onPick: () => onToggle(o.value),
    switch: {
      label: "NOT",
      active: exclude.includes(o.value),
      onPick: () => onToggleExclude(o.value),
    },
  }));
}

/// The kind dropdown's options, in the order the card model introduces
/// them: the multi-step plan, the unit of agent work, the reminder.
export const KIND_FACETS: FacetOption[] = [
  { value: "plan", label: "Plans" },
  { value: "task", label: "Tasks" },
  { value: "note", label: "Notes" },
];

export interface ContextFacet extends FacetOption {
  /// The folder path, for the option's title attribute -- a label is a
  /// relative path and two contexts named the same way in different
  /// trees would otherwise be indistinguishable.
  folderPath: string;
}

function relativeTo(root: string, folder: string): string | null {
  const base = root.endsWith("/") ? root : `${root}/`;
  return folder.startsWith(base) ? folder.slice(base.length) : null;
}

/// The context dropdown's options: the workspace's own contexts by
/// path, then the ones outside it. The root is not listed -- empty
/// selection already means every card, and offering the root as a path
/// would give "all cards" a second spelling.
///
/// A context OUTSIDE the workspace root is labelled by name: its folder
/// shares no prefix with the root, and a bare absolute path in a
/// dropdown is unreadable.
export function contextFacets(tree: GavinTree | undefined): ContextFacet[] {
  if (!tree || tree.rootMissing) return [];

  const rest = tree.contexts.filter((c) => c.kind !== "root");
  const inside = rest.filter((c) => c.outside !== true).sort((a, b) => a.folderPath.localeCompare(b.folderPath));
  const outside = rest.filter((c) => c.outside === true).sort((a, b) => a.folderPath.localeCompare(b.folderPath));

  const all: ContextFacet[] = [];
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

export type LabelFacet = FacetOption;

/// The label dropdown: each vocabulary name, nothing else. Empty
/// selection is "any label" (unlabeled cards included). Invert is the
/// option's NOT switch, not a second option per name.
export function labelFacets(labels: { name: string }[]): LabelFacet[] {
  return labels.map((l) => ({ value: l.name, label: l.name }));
}

/// The rail dropdown: unplaced first, then each rail in orchestration
/// order. Empty selection is every card; ticking both a rail and "on no
/// rail" is the OR of those two answers.
export function railFacets(rails: RailIndex): FacetOption[] {
  return [{ value: NO_RAIL, label: "On no rail" }, ...rails.rails.map((r) => ({ value: r.id, label: r.name }))];
}

function cardHasLabel(card: CardView, name: string): boolean {
  const want = slugStatus(name);
  return card.labels.some((l) => slugStatus(l) === want);
}

/// One card's verdict, so the board and the archive grid ask the same
/// question of the same card.
export function cardPasses(card: CardView, facets: BoardFacets, rails: RailIndex): boolean {
  if (!facetMatches(facets.context, facets.exclude?.context, (folder) => underContext(card.contextFolder, folder))) {
    return false;
  }
  if (!facetMatches(facets.kind, facets.exclude?.kind, (k) => k === card.kind)) return false;
  if (facets.rail.length > 0) {
    const on = rails.byCard.get(card.id);
    if (!facetMatches(facets.rail, facets.exclude?.rail, (r) => (r === NO_RAIL ? on === undefined : on === r))) {
      return false;
    }
  }
  if (facets.label.length > 0) {
    if (!facetMatches(facets.label, facets.exclude?.label, (name) => cardHasLabel(card, name))) return false;
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

function pruneSelected(selected: FacetSelection, keep: (value: string) => boolean): FacetSelection {
  const next = selected.filter(keep);
  return sameSelection(next, selected) ? selected : next;
}

/// Reset a facet whose option is gone -- the rail was deleted, the
/// context folder renamed. Without this the board silently shows nothing
/// and the dropdown reads as its first option while filtering on a value
/// no longer in the list. A multi-select drops only the dead values and
/// keeps the live ones.
///
/// UNKNOWN IS NOT ABSENT: a null vocabulary means that half has not
/// loaded yet, and the facet is left exactly alone. The tree and the
/// orchestration each arrive on their own schedule, and pruning against
/// an empty stand-in would clear the human's filter every time either
/// store blinked.
export function pruneFacets(
  facets: BoardFacets,
  contexts: ContextFacet[] | null,
  rails: RailIndex | null,
  labels: { name: string }[] | null = null
): BoardFacets {
  const exclude = facets.exclude ?? emptyExclude();
  const context =
    contexts !== null ? pruneSelected(facets.context, (v) => contexts.some((c) => c.value === v)) : facets.context;
  const rail =
    rails !== null
      ? pruneSelected(facets.rail, (v) => v === NO_RAIL || rails.rails.some((r) => r.id === v))
      : facets.rail;
  const label =
    labels !== null
      ? pruneSelected(facets.label, (v) => labels.some((l) => slugStatus(l.name) === slugStatus(v)))
      : facets.label;
  const nextExclude: FacetExclude = {
    context: pruneSelected(exclude.context ?? [], (v) => context.includes(v)),
    kind: pruneSelected(exclude.kind ?? [], (v) => facets.kind.includes(v)),
    rail: pruneSelected(exclude.rail ?? [], (v) => rail.includes(v)),
    label: pruneSelected(exclude.label ?? [], (v) => label.includes(v)),
  };
  return context === facets.context &&
    rail === facets.rail &&
    label === facets.label &&
    sameExclude(nextExclude, exclude)
    ? facets
    : { ...facets, context, rail, label, exclude: nextExclude };
}
