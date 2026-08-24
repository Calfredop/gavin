// The kanban drag state machine (spec §1): DOM-free, driven by plain
// points fed in from kanbanDragGlue. Owns the single app-wide drag ---
// candidate (pointer down, not yet moved 5px) -> active (dragState set,
// components render placeholder/hide the dragged item) -> drop | click |
// cancel. All geometry decisions delegate to pointerDrag.ts.

import { writable, get } from "svelte/store";
import {
  exceedsThreshold,
  computeDropTarget,
  computeColumnDropIndex,
  type Point,
  type Rect,
  type Measured,
  type MeasuredColumn,
  type DropTarget,
} from "./pointerDrag";

// "plan" is any card file drag (all cards are files, card-model spec
// §1); "column" drags the strip.
export type DragKind = "plan" | "column";

export interface ActiveDrag {
  kind: DragKind;
  id: string; // card path / column id
  sourceColumnId: string | null; // display-column key at grab; null for column drags
  sourceIndex: number; // index within its block/strip at grab, dragged excluded
  // The plan the card was nested in at grab (card-model spec §2), null
  // when it started free-standing or is a column.
  sourceNest: string | null;
  target: DropTarget | null; // column drags use { columnId: "", index }
  pointer: Point;
  grabOffset: Point; // pointer minus item rect origin at grab
  size: { width: number; height: number };
}

// What was held down when the gesture started. Shift is the board's
// multi-select modifier (boardSelection.ts): the surface selects instead
// of opening the card.
export interface ClickModifiers {
  shift: boolean;
}

export interface DragCallbacks {
  measure: () => MeasuredColumn[]; // card/plan drags
  measureColumns: () => Measured[]; // column drags, dragged excluded
  commit: (drag: ActiveDrag & { target: DropTarget }) => void;
  click: (kind: DragKind, id: string, mods: ClickModifiers) => void;
}

export const dragState = writable<ActiveDrag | null>(null);

// What the slot builders need to keep a drop's visuals in place: the
// dragged item hidden, the placeholder at the target. ActiveDrag
// satisfies it; so does a post-drop hold.
export interface DropHold {
  kind: DragKind;
  id: string;
  target: DropTarget | null;
  size?: { width: number; height: number };
}

// What the slot builders actually read -- ActiveDrag and DropHold both
// satisfy it.
type SlotDrag = DropHold | null;

// Set for the duration of a plan drop's daemon writes (spec §2:
// gavinTrees is patched only on success, so without this the card would
// flash back to its pre-drop slot until the writes resolve). Components
// render slots from `dragState ?? dropHold`.
export const dropHold = writable<DropHold | null>(null);

interface Candidate {
  kind: DragKind;
  id: string;
  sourceColumnId: string | null;
  sourceIndex: number;
  sourceNest: string | null;
  start: Point;
  grabOffset: Point;
  size: { width: number; height: number };
  // Shift was down at pointerdown: this gesture can only ever be a
  // multi-select click, never a drag.
  shift: boolean;
  // The surface is filtered (search.ts): the DOM no longer holds every
  // card, so a drop index measured over it would write the wrong order.
  // Same treatment as shift -- the gesture stays a click.
  locked: boolean;
}

let candidate: Candidate | null = null;
let callbacks: DragCallbacks | null = null;

export function beginCandidate(
  kind: DragKind,
  id: string,
  sourceColumnId: string | null,
  sourceIndex: number,
  sourceNest: string | null,
  start: Point,
  itemRect: Rect,
  cbs: DragCallbacks,
  shift = false,
  locked = false
): void {
  candidate = {
    kind,
    id,
    sourceColumnId,
    sourceIndex,
    sourceNest,
    start,
    grabOffset: { x: start.x - itemRect.left, y: start.y - itemRect.top },
    size: { width: itemRect.width, height: itemRect.height },
    shift,
    locked,
  };
  callbacks = cbs;
}

function computeTarget(kind: DragKind, pointer: Point): DropTarget | null {
  if (!callbacks) return null;
  if (kind === "column") {
    return { columnId: "", index: computeColumnDropIndex(pointer, callbacks.measureColumns()) };
  }
  return computeDropTarget(pointer, callbacks.measure());
}

// `buttons` (when the caller has it) is the PointerEvent.buttons bitmask.
// A tracked move with no buttons pressed means the platform never
// delivered the pointerup -- WKWebView drops the release when the
// pointerdown target left the DOM mid-gesture -- so the move stands in
// for the drop, committing at the last computed target.
export function movePointer(p: Point, buttons?: number): void {
  if (buttons === 0 && (candidate || get(dragState))) {
    endPointer();
    return;
  }
  const active = get(dragState);
  if (active) {
    dragState.set({ ...active, pointer: p, target: computeTarget(active.kind, p) });
    return;
  }
  // A shift gesture is a selection click and nothing else -- promoting
  // it to a drag would fling the card the human was only picking. A
  // locked (filtered) surface is the same: clicks still open cards.
  if (!candidate || candidate.shift || candidate.locked || !exceedsThreshold(candidate.start, p)) return;
  dragState.set({
    kind: candidate.kind,
    id: candidate.id,
    sourceColumnId: candidate.sourceColumnId,
    sourceIndex: candidate.sourceIndex,
    sourceNest: candidate.sourceNest,
    target: computeTarget(candidate.kind, p),
    pointer: p,
    grabOffset: candidate.grabOffset,
    size: candidate.size,
  });
}

// Re-hit-tests at the current pointer with fresh measurements -- called
// by the glue after auto-scroll frames, where content moves under a
// stationary pointer.
export function refreshTarget(): void {
  const active = get(dragState);
  if (!active) return;
  dragState.set({ ...active, target: computeTarget(active.kind, active.pointer) });
}

export function endPointer(): void {
  const active = get(dragState);
  const cbs = callbacks;
  const wasCandidate = candidate;
  candidate = null;
  callbacks = null;
  dragState.set(null);
  if (!cbs) return;
  if (!active) {
    if (wasCandidate) cbs.click(wasCandidate.kind, wasCandidate.id, { shift: wasCandidate.shift });
    return;
  }
  if (!active.target) return;
  const noOp =
    active.kind === "column"
      ? active.target.index === active.sourceIndex
      : active.target.nest
        ? active.target.nest === active.sourceNest && active.target.index === active.sourceIndex
        : active.sourceNest === null &&
          active.target.columnId === active.sourceColumnId &&
          active.target.index === active.sourceIndex;
  if (noOp) return;
  cbs.commit(active as ActiveDrag & { target: DropTarget });
}

export function cancelDrag(): void {
  candidate = null;
  callbacks = null;
  dragState.set(null);
}

// --- display-slot builders -------------------------------------------
// What a column actually renders while a drag is live: the dragged item
// hidden, a placeholder occupying the current target slot. Keyed each
// blocks over these slots + animate:flip give the Trello reflow.

export type Slot<T> = { type: "item"; item: T } | { type: "placeholder" };

export function buildDisplaySlots<T>(
  items: T[],
  idOf: (t: T) => string,
  drag: SlotDrag,
  columnKey: string
): Slot<T>[] {
  if (!drag || drag.kind !== "plan") return items.map((item) => ({ type: "item", item }));
  const slots: Slot<T>[] = items.filter((item) => idOf(item) !== drag.id).map((item) => ({ type: "item", item }));
  // A nest target suppresses every column placeholder -- the card is
  // leaving column flow; buildNestedSlots renders the gap instead.
  if (drag.target && !drag.target.nest && drag.target.columnId === columnKey) {
    const at = Math.max(0, Math.min(drag.target.index, slots.length));
    slots.splice(at, 0, { type: "placeholder" });
  }
  return slots;
}

// The nested area's slots (card-model spec §2): the dragged card hidden
// from the children, a placeholder at the target slot while this plan
// is the nest target.
export function buildNestedSlots<T>(
  children: T[],
  idOf: (t: T) => string,
  drag: SlotDrag,
  planId: string
): Slot<T>[] {
  if (!drag || drag.kind !== "plan") return children.map((item) => ({ type: "item", item }));
  const slots: Slot<T>[] = children
    .filter((item) => idOf(item) !== drag.id)
    .map((item) => ({ type: "item", item }));
  if (drag.target?.nest === planId) {
    const at = Math.max(0, Math.min(drag.target.index, slots.length));
    slots.splice(at, 0, { type: "placeholder" });
  }
  return slots;
}

export function buildColumnSlots<T>(columns: T[], idOf: (t: T) => string, drag: SlotDrag): Slot<T>[] {
  if (!drag || drag.kind !== "column") return columns.map((item) => ({ type: "item", item }));
  const slots: Slot<T>[] = columns
    .filter((item) => idOf(item) !== drag.id)
    .map((item) => ({ type: "item", item }));
  if (drag.target) {
    const at = Math.max(0, Math.min(drag.target.index, slots.length));
    slots.splice(at, 0, { type: "placeholder" });
  }
  return slots;
}

/** @internal test-only reset for module-level state */
export function __resetForTesting(): void {
  candidate = null;
  callbacks = null;
  dragState.set(null);
  dropHold.set(null);
}
