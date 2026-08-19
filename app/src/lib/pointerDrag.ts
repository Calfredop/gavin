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

export interface MeasuredColumn {
  id: string; // real column id, or "auto:<status>"
  rect: Rect;
  auto: boolean; // auto columns accept only plan drags
  cards: Measured[];
  planCards: Measured[];
}

export interface DropTarget {
  columnId: string;
  index: number;
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

// The column under (or nearest to, within maxSnapPx of) the pointer,
// and the slot within its kind-matching block: the count of items whose
// vertical midpoint the pointer has passed. Only horizontal position
// picks the column -- dragging above or below a column still targets it,
// like Trello.
export function computeDropTarget(
  pointer: Point,
  columns: MeasuredColumn[],
  dragKind: "card" | "plan",
  maxSnapPx = 100
): DropTarget | null {
  let best: MeasuredColumn | null = null;
  let bestDist = Infinity;
  for (const col of columns) {
    if (dragKind === "card" && col.auto) continue;
    const d = horizontalDistance(col.rect, pointer.x);
    if (d < bestDist) {
      bestDist = d;
      best = col;
    }
  }
  if (!best || bestDist > maxSnapPx) return null;
  const list = dragKind === "card" ? best.cards : best.planCards;
  let index = 0;
  for (const item of list) {
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
