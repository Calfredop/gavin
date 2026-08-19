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

export type DragKind = "card" | "plan" | "column";

export interface ActiveDrag {
  kind: DragKind;
  id: string; // card id / plan path / column id
  sourceColumnId: string | null; // display-column key at grab; null for column drags
  sourceIndex: number; // index within its block/strip at grab, dragged excluded
  target: DropTarget | null; // column drags use { columnId: "", index }
  pointer: Point;
  grabOffset: Point; // pointer minus item rect origin at grab
  size: { width: number; height: number };
}

export interface DragCallbacks {
  measure: () => MeasuredColumn[]; // card/plan drags
  measureColumns: () => Measured[]; // column drags, dragged excluded
  commit: (drag: ActiveDrag & { target: DropTarget }) => void;
  click: (kind: DragKind, id: string) => void;
}

export const dragState = writable<ActiveDrag | null>(null);

interface Candidate {
  kind: DragKind;
  id: string;
  sourceColumnId: string | null;
  sourceIndex: number;
  start: Point;
  grabOffset: Point;
  size: { width: number; height: number };
}

let candidate: Candidate | null = null;
let callbacks: DragCallbacks | null = null;

export function beginCandidate(
  kind: DragKind,
  id: string,
  sourceColumnId: string | null,
  sourceIndex: number,
  start: Point,
  itemRect: Rect,
  cbs: DragCallbacks
): void {
  candidate = {
    kind,
    id,
    sourceColumnId,
    sourceIndex,
    start,
    grabOffset: { x: start.x - itemRect.left, y: start.y - itemRect.top },
    size: { width: itemRect.width, height: itemRect.height },
  };
  callbacks = cbs;
}

function computeTarget(kind: DragKind, pointer: Point): DropTarget | null {
  if (!callbacks) return null;
  if (kind === "column") {
    return { columnId: "", index: computeColumnDropIndex(pointer, callbacks.measureColumns()) };
  }
  return computeDropTarget(pointer, callbacks.measure(), kind);
}

export function movePointer(p: Point): void {
  const active = get(dragState);
  if (active) {
    dragState.set({ ...active, pointer: p, target: computeTarget(active.kind, p) });
    return;
  }
  if (!candidate || !exceedsThreshold(candidate.start, p)) return;
  dragState.set({
    kind: candidate.kind,
    id: candidate.id,
    sourceColumnId: candidate.sourceColumnId,
    sourceIndex: candidate.sourceIndex,
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
    if (wasCandidate) cbs.click(wasCandidate.kind, wasCandidate.id);
    return;
  }
  if (!active.target) return;
  const noOp =
    active.kind === "column"
      ? active.target.index === active.sourceIndex
      : active.target.columnId === active.sourceColumnId && active.target.index === active.sourceIndex;
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
  drag: ActiveDrag | null,
  columnKey: string,
  kind: "card" | "plan"
): Slot<T>[] {
  if (!drag || drag.kind !== kind) return items.map((item) => ({ type: "item", item }));
  const slots: Slot<T>[] = items.filter((item) => idOf(item) !== drag.id).map((item) => ({ type: "item", item }));
  if (drag.target && drag.target.columnId === columnKey) {
    const at = Math.max(0, Math.min(drag.target.index, slots.length));
    slots.splice(at, 0, { type: "placeholder" });
  }
  return slots;
}

export function buildColumnSlots<T>(columns: T[], idOf: (t: T) => string, drag: ActiveDrag | null): Slot<T>[] {
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
}
