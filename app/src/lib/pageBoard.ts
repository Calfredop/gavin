// The in-page board's PAGE lens: the same merged projection the board
// always renders, narrowed to the cards bound to the page the pane sits
// on. A board nested in a page is that page's board -- the whole
// workspace's cards live one click away on the hub's Kanban tab, and
// projecting them here made the pane a second copy of it.
//
// Shaped exactly like boardSearch.ts's search lens, and for the same
// reason: it never mutates the projection it is given, because the drop
// path (planDrop.ts) still commits order writes against the UNFILTERED
// one. The two compose -- scope first, then search, so a column's
// "hidden" count keeps meaning "hidden by your query".
//
// "Bound to the page" has two halves, and a card qualifies on either:
//
//   - a SESSION half -- `card_sessions` reverse-looked-up against the
//     page's layout tree, which is every card the human ran into a tab
//     here; and
//   - a RAIL half -- every card carried by a rail whose `pageId` is this
//     page (spec O16: Start gives a rail a page of its own). This is
//     what puts a rail's later steps on the board before they have ever
//     run.
//
// The session half reads the LAYOUT, not the binding table, so a card
// whose agent exited leaves the board with its tab. Nothing has to
// expire a binding row for that to be true.

import { allSessionIds } from "./layout";
import { railCardPaths } from "./orchestration";
import { AUTO_KEY_PREFIX } from "./boardSearch";
import type { Orchestration, Rail } from "./orchestration";
import type { Board } from "./kanban";
import type { CardView } from "./planBoard";
import type { MergedBoard } from "./boardSearch";
import type { DropTarget } from "./pointerDrag";
import type { Page, Workspace } from "./workspace";

export interface PageScope {
  /// Card paths bound to the page, by either half.
  paths: Set<string>;
  /// The rails bound to this page, in position order. The composer
  /// files what it creates onto one of these -- a card typed on a
  /// page-scoped board has to be page-bound by construction, or it
  /// would vanish the moment it was written.
  rails: Rail[];
}

export function pageScope(
  page: Page | null,
  board: Board | undefined,
  orch: Orchestration | undefined
): PageScope {
  if (!page) return { paths: new Set(), rails: [] };

  const tabs = new Set(allSessionIds(page.layout));
  const paths = new Set<string>();
  for (const cs of board?.cardSessions ?? []) {
    if (tabs.has(cs.sessionId)) paths.add(cs.path);
  }

  const rails = (orch?.rails ?? [])
    .filter((r) => r.pageId === page.id)
    .sort((a, b) => a.position - b.position);
  for (const rail of rails) {
    for (const path of railCardPaths(rail)) paths.add(path);
  }

  return { paths, rails };
}

export interface ScopedBoard extends MergedBoard {
  /// Top-level cards kept / present, counted the way a column header
  /// has always counted them (nested children are not counted
  /// separately). The title line reads these.
  inScope: number;
  total: number;
}

/// A card in scope keeps every child; a card OUT of scope survives only
/// as a home for the children that are in scope, narrowed to them. That
/// is the same narrowing boardSearch.project applies, so a nested task a
/// rail carries is reachable here without its parent having to qualify.
function project(card: CardView, paths: ReadonlySet<string>): CardView | null {
  if (paths.has(card.id)) return card;
  const children = card.nestedChildren.filter((child) => paths.has(child.id));
  if (children.length === 0) return null;
  return { ...card, nestedChildren: children };
}

export function scopeBoardToPage(merged: MergedBoard, paths: ReadonlySet<string>): ScopedBoard {
  let inScope = 0;
  const keep = (cards: CardView[]): CardView[] => {
    const kept = cards.map((c) => project(c, paths)).filter((c): c is CardView => c !== null);
    inScope += kept.length;
    return kept;
  };

  const total =
    merged.columns.reduce((n, c) => n + c.planCards.length, 0) +
    merged.autoColumns.reduce((n, a) => n + a.planCards.length, 0);

  const columns = merged.columns.map((dc) => ({ ...dc, planCards: keep(dc.planCards) }));
  const autoColumns = merged.autoColumns.map((a) => ({ ...a, planCards: keep(a.planCards) }));
  return { columns, autoColumns, inScope, total };
}

/// Where a drop landed in the page's view of a column, expressed as a
/// slot in the WHOLE column.
///
/// The drag engine hands back a slot among the cards it can see, and
/// computeOrderWrites renumbers whatever list it is handed. Committing a
/// page-scoped drop against the page's subset would therefore rewrite
/// the visible cards' `order:` with no regard for the ones this board
/// hides -- they would come out interleaved differently on the hub
/// board, from a gesture the human made somewhere else entirely.
///
/// So the slot is translated instead: land immediately after the visible
/// card you were dropped after, or immediately before the first visible
/// one at the top. Both lists exclude the dragged card, exactly as
/// planDrop expects. Appending is the fallback whenever the neighbour
/// cannot be found in the full column -- a projection moved under the
/// drop, and the end is the one slot that is always meaningful.
export function translateDropIndex(
  scoped: readonly CardView[],
  full: readonly CardView[],
  index: number
): number {
  const clamped = Math.max(0, Math.min(index, scoped.length));
  if (scoped.length === 0) return full.length;

  if (clamped === 0) {
    const at = full.findIndex((c) => c.id === scoped[0].id);
    return at === -1 ? full.length : at;
  }
  const after = full.findIndex((c) => c.id === scoped[clamped - 1].id);
  return after === -1 ? full.length : after + 1;
}

/// The page a tab belongs to. The pane asks by its OWN tab id rather
/// than for the active page: a board is only ever rendered inside the
/// page holding it, but saying so explicitly means a pane can never
/// scope itself to somebody else's page while a switch is in flight.
/// Null when no tree holds the id -- the pane then shows the whole
/// context board, which is the behaviour that predates this lens.
export function pageHolding(workspaces: readonly Workspace[], tabId: string | null): Page | null {
  if (!tabId) return null;
  for (const ws of workspaces) {
    for (const page of ws.pages) {
      if (allSessionIds(page.layout).includes(tabId)) return page;
    }
  }
  return null;
}

/// A committed plan drop, re-expressed against the whole board.
///
/// The drop carries the slot the human saw, among the cards this page
/// shows; planDrop.ts computes its order writes over the whole column.
/// `scoped` null means the board was not page-scoped at all and the two
/// already agree. A NEST drop is left alone: a card this board shows
/// keeps every one of its children, so its slots need no translating.
export function dropAgainstWholeBoard<T extends { id: string; target: DropTarget }>(
  drag: T,
  scoped: MergedBoard | null,
  merged: MergedBoard
): T {
  if (!scoped || drag.target.nest) return drag;
  const key = drag.target.columnId;
  const column = (b: MergedBoard): CardView[] => {
    const cards = key.startsWith(AUTO_KEY_PREFIX)
      ? (b.autoColumns.find((a) => AUTO_KEY_PREFIX + a.status === key)?.planCards ?? [])
      : (b.columns.find((dc) => dc.column.id === key)?.planCards ?? []);
    // Both lists exclude the dragged card, the post-removal convention
    // the drag engine's index already follows.
    return cards.filter((c) => c.id !== drag.id);
  };
  const index = translateDropIndex(column(scoped), column(merged), drag.target.index);
  return { ...drag, target: { ...drag.target, index } };
}
