// The archive's projection: the cards the human filed into their
// context's `plans/archive/`, ordered for the kanban tab's grid and
// searchable with the same lens the board uses.
//
// Pure, like boardSearch.ts and for the same reason -- the grid is a
// second rendering of cards the merge already built, and the archive
// actions commit against paths, never against this projection.

import { project } from "$lib/boardSearch";
import { queryTokens } from "$lib/search";
import type { CardView } from "$lib/planBoard";

export interface ArchiveView {
  cards: CardView[];
  /// False when the query was blank -- the grid re-labels its count.
  filtering: boolean;
  /// Cards shown / archived in total. Nested children are not counted
  /// separately, matching what a board column has always shown.
  shown: number;
  total: number;
}

/// Newest first, by the card file's mtime -- for an archived card that
/// is when it was archived, since the move rewrites it.
///
/// A card with NO mtime (a pre-v13 daemon, or a file that vanished
/// between the scan and the stat) sorts last rather than first: an
/// unknown date is not a recent one, and putting it at the top would be
/// the grid's most visible position given to its least certain row.
/// Path is the tie-break, so the order is total and stable.
export function chronological(cards: CardView[]): CardView[] {
  return [...cards].sort((a, b) => {
    const at = a.modifiedAt ?? null;
    const bt = b.modifiedAt ?? null;
    if (at !== bt) {
      if (at === null) return 1;
      if (bt === null) return -1;
      return bt - at;
    }
    return a.id.localeCompare(b.id);
  });
}

/// The grid's projection: chronological, then narrowed by the search
/// box. Matching is the board's -- a plan also matches through its
/// nested children, and one that matched only through a child shows just
/// the children that matched.
export function archiveView(archived: CardView[], query: string): ArchiveView {
  const ordered = chronological(archived);
  const tokens = queryTokens(query);
  if (tokens.length === 0) {
    return { cards: ordered, filtering: false, shown: ordered.length, total: ordered.length };
  }
  const cards = ordered.map((c) => project(c, tokens)).filter((c): c is CardView => c !== null);
  return { cards, filtering: true, shown: cards.length, total: ordered.length };
}

/// "23 Aug 2026" — the date stamp a grid card wears. Short and
/// unambiguous across locales (a bare numeric date is read differently
/// on either side of the Atlantic, and this one is a timestamp the human
/// scans, not one they parse).
export function archivedOn(modifiedAt: number | null | undefined): string | null {
  if (modifiedAt === null || modifiedAt === undefined) return null;
  const date = new Date(modifiedAt * 1000);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}
