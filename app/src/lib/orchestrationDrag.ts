// Pure geometry and the state machine for dragging steps around the
// Orchestration grid. Deliberately NOT the kanban hit-tester: rails are
// columns but stages are rows, and the meaningful gesture is "gap
// between stages" vs "middle of a stage". The primitives (threshold,
// auto-scroll) are reused from pointerDrag.ts; only the hit-testing and
// the target vocabulary are new.
//
// Like the kanban engine, every index here is computed against a list
// with the DRAGGED STEP EXCLUDED, which is exactly the post-removal
// index moveStepToNewStage expects.

import { writable, get } from "svelte/store";
import { exceedsThreshold, type Point, type Rect } from "./pointerDrag";

export interface MeasuredStage {
  id: string;
  position: number;
  rect: Rect;
}

export interface MeasuredRail {
  id: string;
  rect: Rect;
  stages: MeasuredStage[];
}

export type OrchDropTarget =
  | { kind: "new-stage"; railId: string; index: number }
  | { kind: "into-stage"; stageId: string }
  | { kind: "unplace" };

/// The middle band of a stage means "join it" (parallel); the outer
/// bands keep meaning before/after, which agrees with the midpoint rule
/// used for the gaps. Same shape as the board's nest interaction, so the
/// app has one drag language, widened slightly because stage bands are
/// shorter than cards.
export const STAGE_BAND_LO = 0.3;
export const STAGE_BAND_HI = 0.7;

function within(rect: Rect, p: Point): boolean {
  return (
    p.x >= rect.left &&
    p.x <= rect.left + rect.width &&
    p.y >= rect.top &&
    p.y <= rect.top + rect.height
  );
}

function horizontalDistance(rect: Rect, x: number): number {
  if (x < rect.left) return rect.left - x;
  const right = rect.left + rect.width;
  return x > right ? x - right : 0;
}

/// The drawer wins outright when the pointer is inside it; otherwise the
/// nearest rail by HORIZONTAL distance only, so dragging above or below
/// a rail still targets it (the board's rule, and the one that makes
/// long drags forgiving).
export function computeOrchDropTarget(
  pointer: Point,
  rails: MeasuredRail[],
  drawerRect: Rect | null,
  maxSnapPx = 100
): OrchDropTarget | null {
  if (drawerRect && within(drawerRect, pointer)) return { kind: "unplace" };

  let best: MeasuredRail | null = null;
  let bestDist = Infinity;
  for (const rail of rails) {
    const d = horizontalDistance(rail.rect, pointer.x);
    if (d < bestDist) {
      bestDist = d;
      best = rail;
    }
  }
  if (!best || bestDist > maxSnapPx) return null;

  const stages = [...best.stages].sort((a, b) => a.position - b.position);

  for (const stage of stages) {
    if (pointer.y < stage.rect.top || pointer.y > stage.rect.top + stage.rect.height) continue;
    const y = (pointer.y - stage.rect.top) / stage.rect.height;
    if (y >= STAGE_BAND_LO && y <= STAGE_BAND_HI) return { kind: "into-stage", stageId: stage.id };
    break;
  }

  let index = 0;
  for (const stage of stages) {
    if (pointer.y > stage.rect.top + stage.rect.height / 2) index += 1;
  }
  return { kind: "new-stage", railId: best.id, index };
}

// ---- The controller --------------------------------------------------------

/// What is being dragged. "step" moves an existing step between stages
/// and rails; "card" places an unplaced card from the drawer, which has
/// no step id yet -- its `id` is the card path.
export type OrchDragKind = "step" | "card";

/// `sourceStageId` is what makes "dropped back where it started"
/// detectable, so a click-like drag commits nothing. Null for a card,
/// which came from no stage.
export interface ActiveOrchDrag {
  kind: OrchDragKind;
  id: string;
  sourceStageId: string | null;
  target: OrchDropTarget | null;
  pointer: Point;
  grabOffset: Point;
  size: { width: number; height: number };
}

export interface OrchDragCallbacks {
  measure: () => MeasuredRail[];
  measureDrawer: () => Rect | null;
  commit: (drag: ActiveOrchDrag & { target: OrchDropTarget }) => void;
  click: (stepId: string) => void;
}

export const orchDragState = writable<ActiveOrchDrag | null>(null);

interface Candidate {
  kind: OrchDragKind;
  id: string;
  sourceStageId: string | null;
  start: Point;
  grabOffset: Point;
  size: { width: number; height: number };
}

let candidate: Candidate | null = null;
let callbacks: OrchDragCallbacks | null = null;

export function beginCandidate(
  kind: OrchDragKind,
  id: string,
  sourceStageId: string | null,
  start: Point,
  itemRect: Rect,
  cbs: OrchDragCallbacks
): void {
  candidate = {
    kind,
    id,
    sourceStageId,
    start,
    grabOffset: { x: start.x - itemRect.left, y: start.y - itemRect.top },
    size: { width: itemRect.width, height: itemRect.height },
  };
  callbacks = cbs;
}

function computeTarget(pointer: Point): OrchDropTarget | null {
  if (!callbacks) return null;
  return computeOrchDropTarget(pointer, callbacks.measure(), callbacks.measureDrawer());
}

/// `buttons` is PointerEvent.buttons. A tracked move with no buttons
/// pressed means the platform never delivered the pointerup -- WKWebView
/// drops it when the pointerdown target left the DOM mid-gesture -- so
/// that move stands in for the release. Same recovery the board uses.
export function movePointer(p: Point, buttons?: number): void {
  if (buttons === 0 && (candidate || get(orchDragState))) {
    endPointer();
    return;
  }
  const active = get(orchDragState);
  if (active) {
    orchDragState.set({ ...active, pointer: p, target: computeTarget(p) });
    return;
  }
  if (!candidate || !exceedsThreshold(candidate.start, p)) return;
  orchDragState.set({
    kind: candidate.kind,
    id: candidate.id,
    sourceStageId: candidate.sourceStageId,
    target: computeTarget(p),
    pointer: p,
    grabOffset: candidate.grabOffset,
    size: candidate.size,
  });
}

/// Re-hit-test at the current pointer with fresh measurements, after an
/// auto-scroll frame moved content under a stationary pointer.
export function refreshTarget(): void {
  const active = get(orchDragState);
  if (!active) return;
  orchDragState.set({ ...active, target: computeTarget(active.pointer) });
}

export function endPointer(): void {
  const active = get(orchDragState);
  const cbs = callbacks;
  const wasCandidate = candidate;
  candidate = null;
  callbacks = null;
  orchDragState.set(null);
  if (!cbs) return;
  if (!active) {
    if (wasCandidate) cbs.click(wasCandidate.id);
    return;
  }
  if (!active.target) return;
  // Dropping back into the stage it came from changes nothing.
  if (active.target.kind === "into-stage" && active.target.stageId === active.sourceStageId) return;
  // A card dropped on the drawer is already unplaced.
  if (active.kind === "card" && active.target.kind === "unplace") return;
  cbs.commit(active as ActiveOrchDrag & { target: OrchDropTarget });
}

export function cancelDrag(): void {
  candidate = null;
  callbacks = null;
  orchDragState.set(null);
}

/** @internal test-only reset for module-level state */
export function __resetForTesting(): void {
  candidate = null;
  callbacks = null;
  orchDragState.set(null);
}
