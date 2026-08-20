// Pure geometry for the kanban pointer-drag engine (spec §1). Operates
// on plain rect/point shapes measured by kanbanDragGlue -- never on DOM
// types -- so every decision here is unit-testable. All indices are
// computed against lists WITH THE DRAGGED ITEM EXCLUDED (it is hidden
// while dragging), which is exactly the post-removal index that
// kanban.moveCard / reorderColumn expect.

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface Measured {
  id: string;
  rect: Rect;
}

// A measured plan card may carry nest info while a task drags: its
// presence marks the plan as a valid nest target (the glue emits it only
// for same-context plans), `rect` is the expanded nested area (null when
// collapsed), `children` the nested cards' rects in visual order.
export interface MeasuredCard extends Measured {
  nest?: { rect: Rect | null; children: Measured[] } | null;
}

export interface MeasuredColumn {
  id: string; // real column id, or "auto:<status>"
  rect: Rect;
  auto: boolean;
  planCards: MeasuredCard[];
}

export interface DropTarget {
  columnId: string;
  index: number;
  // Set when the drop nests into a plan card: the plan's id (path);
  // `index` is then the slot among its nested children.
  nest?: string;
}

export const DRAG_THRESHOLD_PX = 5;

export function exceedsThreshold(start: Point, current: Point): boolean {
  return Math.hypot(current.x - start.x, current.y - start.y) >= DRAG_THRESHOLD_PX;
}

function horizontalDistance(rect: Rect, x: number): number {
  if (x < rect.left) return rect.left - x;
  const right = rect.left + rect.width;
  return x > right ? x - right : 0;
}

function within(rect: Rect, p: Point): boolean {
  return p.x >= rect.left && p.x <= rect.left + rect.width && p.y >= rect.top && p.y <= rect.top + rect.height;
}

// The column under (or nearest to, within maxSnapPx of) the pointer,
// and the slot within it: the count of cards whose vertical midpoint
// the pointer has passed. Only horizontal position picks the column --
// dragging above or below a column still targets it, like Trello.
//
// Nesting (card-model spec §2): when a measured plan card carries nest
// info, its expanded nested area slots among the children, and the
// card's middle band (25%-75% of its height) targets "into this plan"
// at index 0 -- the outer bands keep meaning before/after in the
// column, which agrees with the midpoint rule below.
export function computeDropTarget(
  pointer: Point,
  columns: MeasuredColumn[],
  maxSnapPx = 100
): DropTarget | null {
  let best: MeasuredColumn | null = null;
  let bestDist = Infinity;
  for (const col of columns) {
    const d = horizontalDistance(col.rect, pointer.x);
    if (d < bestDist) {
      bestDist = d;
      best = col;
    }
  }
  if (!best || bestDist > maxSnapPx) return null;

  for (const card of best.planCards) {
    if (!card.nest) continue;
    if (card.nest.rect && within(card.nest.rect, pointer)) {
      let idx = 0;
      for (const child of card.nest.children) {
        if (pointer.y > child.rect.top + child.rect.height / 2) idx += 1;
      }
      return { columnId: best.id, index: idx, nest: card.id };
    }
    if (pointer.x >= card.rect.left && pointer.x <= card.rect.left + card.rect.width) {
      const y = (pointer.y - card.rect.top) / card.rect.height;
      if (y >= 0.25 && y <= 0.75) {
        return { columnId: best.id, index: 0, nest: card.id };
      }
    }
  }

  let index = 0;
  for (const item of best.planCards) {
    if (pointer.y > item.rect.top + item.rect.height / 2) index += 1;
  }
  return { columnId: best.id, index };
}

// Slot in the column strip (dragged column excluded): the count of
// columns whose horizontal midpoint the pointer has passed. Unlike
// cards, a column drag always has a target -- far pointers clamp to the
// strip's ends.
export function computeColumnDropIndex(pointer: Point, columns: Measured[]): number {
  let index = 0;
  for (const col of columns) {
    if (pointer.x > col.rect.left + col.rect.width / 2) index += 1;
  }
  return index;
}

// Signed px/frame: negative scrolls toward the start edge. Ramps
// linearly from 0 at edgePx inside the rect to maxPxPerFrame at (or
// past) the edge itself.
export function autoScrollVelocity(
  pointerCoord: number,
  rectStart: number,
  rectEnd: number,
  edgePx = 40,
  maxPxPerFrame = 12
): number {
  const fromStart = pointerCoord - rectStart;
  const fromEnd = rectEnd - pointerCoord;
  if (fromStart < fromEnd && fromStart < edgePx) {
    return -Math.round(((edgePx - Math.max(fromStart, 0)) / edgePx) * maxPxPerFrame);
  }
  if (fromEnd < edgePx) {
    return Math.round(((edgePx - Math.max(fromEnd, 0)) / edgePx) * maxPxPerFrame);
  }
  return 0;
}
