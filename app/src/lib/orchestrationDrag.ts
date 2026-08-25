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

export interface MeasuredStep {
  id: string;
  rect: Rect;
}

export interface MeasuredStage {
  id: string;
  position: number;
  rect: Rect;
  /// The stage's member chips, in render order, with the dragged one
  /// excluded -- which is what makes the index this module computes the
  /// post-removal index the mutators expect.
  steps: MeasuredStep[];
}

export interface MeasuredRail {
  id: string;
  rect: Rect;
  stages: MeasuredStage[];
}

export type OrchDropTarget =
  | { kind: "new-stage"; railId: string; index: number }
  /// `index` is the slot AMONG the stage's members, by the same midpoint
  /// rule the gaps between stages use.
  | { kind: "into-stage"; stageId: string; index: number }
  | { kind: "unplace" };

/// For a SINGLE-STEP stage the middle band means "group with it" and the
/// outer bands keep meaning before/after, which agrees with the midpoint
/// rule used for the gaps. Same shape as the board's nest interaction, so
/// the app has one drag language.
///
/// A GROUP does not use these at all -- see computeOrchDropTarget.
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
  maxSnapPx = 100,
  /// A GROUP cannot be dropped into a group: nested groups are out of
  /// scope, so a "stage" drag skips the stage loop entirely and reads
  /// every stage as a gap.
  kind: OrchDragKind = "step"
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

  if (kind !== "stage") {
    for (const stage of stages) {
      if (pointer.y < stage.rect.top || pointer.y > stage.rect.top + stage.rect.height) continue;

      if (stage.steps.length >= 2) {
        // A GROUP is all "into", and the slot comes from the MEMBER the
        // pointer is over. The three-band rule cannot serve a group: its
        // members tile it, so the outer bands would swallow the first and
        // last slots and there would be no gesture for either. Before and
        // after the group stay reachable through the connector gaps and
        // through the group's own header strip and padding, which are
        // inside the stage rect but over no member -- the `break` below.
        const overAMember = stage.steps.some(
          (m) => pointer.y >= m.rect.top && pointer.y <= m.rect.top + m.rect.height
        );
        if (!overAMember) break;
      } else {
        // A single-step stage keeps the three bands: the outer ones are
        // the only thing distinguishing "before/after this stage" from
        // "group with it".
        const y = (pointer.y - stage.rect.top) / stage.rect.height;
        if (y < STAGE_BAND_LO || y > STAGE_BAND_HI) break;
      }

      // The slot, by the same midpoint rule the gaps between stages use.
      let index = 0;
      for (const step of stage.steps) {
        if (pointer.y > step.rect.top + step.rect.height / 2) index += 1;
      }
      return { kind: "into-stage", stageId: stage.id, index };
    }
  }

  let index = 0;
  for (const stage of stages) {
    // >= rather than strict >: a "stage" drag skips the loop above
    // outright, so the pointer sitting exactly on another stage's own
    // midpoint is a real, reachable position here (not just a tie no
    // other kind can produce) and has to resolve to a side. "After" is
    // consistent with the gaps: a pointer that has fully crossed a
    // stage's midpoint has left "before" behind.
    if (pointer.y >= stage.rect.top + stage.rect.height / 2) index += 1;
  }
  return { kind: "new-stage", railId: best.id, index };
}

// ---- The controller --------------------------------------------------------

/// "step" moves an existing step; "stage" moves a whole GROUP and every
/// member it holds; "card", "tool" and "template" place something from
/// the drawer, whose `id` is a card path, a tool id or a template id.
export type OrchDragKind = "step" | "card" | "tool" | "stage" | "template";

/// True for the drawer kinds -- the ones that have no step id yet, so
/// nothing to detach and nowhere to be "dropped back".
export function isPlacementDrag(kind: OrchDragKind): boolean {
  return kind === "card" || kind === "tool" || kind === "template";
}

/// `sourceStageId` is what makes "dropped back where it started"
/// detectable, so a click-like drag commits nothing. Null for a card, a
/// tool or a template, which came from no stage.
///
/// `sourceIndex` is the dragged chip's slot among ALL of its own stage's
/// members, measured BEFORE it was picked up. It is what turns that same
/// guard index-aware: within a group, dropping back into the stage is
/// not automatically a no-op, only dropping back into the SAME slot is.
/// Null for the drawer kinds and for a "stage" drag, neither of which
/// has a member slot to speak of.
export interface ActiveOrchDrag {
  kind: OrchDragKind;
  id: string;
  sourceStageId: string | null;
  sourceIndex: number | null;
  target: OrchDropTarget | null;
  pointer: Point;
  grabOffset: Point;
  size: { width: number; height: number };
}

export interface OrchDragCallbacks {
  measure: () => MeasuredRail[];
  measureDrawer: () => Rect | null;
  commit: (drag: ActiveOrchDrag & { target: OrchDropTarget }) => void;
  /// `cardPath` is the card the press actually landed ON, which differs
  /// from the step's own card only inside an expanded plan: a nested
  /// child is its own card and must open as itself, not as its parent.
  /// Null whenever the press was not on a card at all.
  click: (stepId: string, cardPath: string | null) => void;
}

export const orchDragState = writable<ActiveOrchDrag | null>(null);

interface Candidate {
  kind: OrchDragKind;
  id: string;
  sourceStageId: string | null;
  sourceIndex: number | null;
  start: Point;
  grabOffset: Point;
  size: { width: number; height: number };
  /// The card under the press, for the click path only -- see
  /// OrchDragCallbacks.click. Never consulted by a drag.
  clickCardPath: string | null;
}

let candidate: Candidate | null = null;
let callbacks: OrchDragCallbacks | null = null;

export function beginCandidate(
  kind: OrchDragKind,
  id: string,
  sourceStageId: string | null,
  sourceIndex: number | null,
  start: Point,
  itemRect: Rect,
  cbs: OrchDragCallbacks,
  clickCardPath: string | null = null
): void {
  candidate = {
    kind,
    id,
    sourceStageId,
    sourceIndex,
    start,
    grabOffset: { x: start.x - itemRect.left, y: start.y - itemRect.top },
    size: { width: itemRect.width, height: itemRect.height },
    clickCardPath,
  };
  callbacks = cbs;
}

function computeTarget(pointer: Point, kind: OrchDragKind): OrchDropTarget | null {
  if (!callbacks) return null;
  return computeOrchDropTarget(pointer, callbacks.measure(), callbacks.measureDrawer(), 100, kind);
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
    orchDragState.set({ ...active, pointer: p, target: computeTarget(p, active.kind) });
    return;
  }
  if (!candidate || !exceedsThreshold(candidate.start, p)) return;
  orchDragState.set({
    kind: candidate.kind,
    id: candidate.id,
    sourceStageId: candidate.sourceStageId,
    sourceIndex: candidate.sourceIndex,
    target: computeTarget(p, candidate.kind),
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
  orchDragState.set({ ...active, target: computeTarget(active.pointer, active.kind) });
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
    if (wasCandidate) cbs.click(wasCandidate.id, wasCandidate.clickCardPath);
    return;
  }
  if (!active.target) return;
  // Dropping a member back in its OWN slot changes nothing. Any other
  // slot in the same stage is a real reorder, which is the whole of
  // within-group ordering -- the old stage-level guard refused that too.
  // `index` is measured with the dragged chip EXCLUDED, so re-inserting
  // at `sourceIndex` is exactly the identity and nothing else is.
  if (
    active.target.kind === "into-stage" &&
    active.target.stageId === active.sourceStageId &&
    active.target.index === active.sourceIndex
  )
    return;
  // A card, tool or template dropped back on the drawer was never placed.
  if (isPlacementDrag(active.kind) && active.target.kind === "unplace") return;
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
