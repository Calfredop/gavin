// The DOM side of the orchestration drag: one delegated pointerdown on
// the grid, rect measurement over data attributes, the auto-scroll rAF
// loop, and the window-level gesture listeners. Every decision lives in
// orchestrationDrag.ts -- this file only reads the DOM.
//
// Data-attribute contract (rendered by the orchestration components):
//   [data-orch-rail]       rail column root; value = rail id
//   [data-orch-stage]      a stage band; value = stage id
//   [data-orch-stage-pos]  a stage band; value = its position
//   [data-orch-step]       a step chip wrapper; value = step id
//   [data-orch-drawer]     the unplaced drawer root
//   [data-orch-card]       an unplaced drawer row; value = the card path
//   [data-orch-tool]       a drawer tool row; value = the tool id

import { get, writable } from "svelte/store";
import {
  orchDragState,
  beginCandidate,
  movePointer,
  refreshTarget,
  endPointer,
  cancelDrag,
  type ActiveOrchDrag,
  type OrchDragKind,
  type MeasuredRail,
  type MeasuredStage,
  type OrchDragCallbacks,
  type OrchDropTarget,
} from "./orchestrationDrag";
import { autoScrollVelocity, type Rect } from "./pointerDrag";

export const activeOrchDragRoot = writable<HTMLElement | null>(null);

export interface OrchDragOptions {
  /// The element the gesture is listened on and measured within. It must
  /// contain BOTH the rail grid and the drawer, so an unplaced card can
  /// be dragged in.
  root: HTMLElement;
  /// The element that actually scrolls (the grid). Separate from `root`
  /// because the listening element is its parent.
  scrollEl: HTMLElement;
  commit: (drag: ActiveOrchDrag & { target: OrchDropTarget }) => void;
  click: (stepId: string, cardPath: string | null) => void;
}

function toRect(el: Element): Rect {
  const r = el.getBoundingClientRect();
  return { left: r.left, top: r.top, width: r.width, height: r.height };
}

/// The dragged step is excluded from measurement, and a stage left with
/// ONLY the dragged step is excluded too -- it is about to disappear, so
/// letting it hold a slot would produce an index one too high.
function measureRails(root: HTMLElement, draggedId: string): MeasuredRail[] {
  const rails: MeasuredRail[] = [];
  for (const railEl of root.querySelectorAll("[data-orch-rail]")) {
    const stages: MeasuredStage[] = [];
    for (const stageEl of railEl.querySelectorAll("[data-orch-stage]")) {
      const steps = [...stageEl.querySelectorAll("[data-orch-step]")];
      const remaining = steps.filter((s) => s.getAttribute("data-orch-step") !== draggedId);
      if (steps.length > 0 && remaining.length === 0) continue;
      stages.push({
        id: stageEl.getAttribute("data-orch-stage") ?? "",
        position: Number(stageEl.getAttribute("data-orch-stage-pos") ?? "0"),
        rect: toRect(stageEl),
      });
    }
    rails.push({
      id: railEl.getAttribute("data-orch-rail") ?? "",
      rect: toRect(railEl),
      stages,
    });
  }
  return rails;
}

export function attachOrchestrationDrag(opts: OrchDragOptions): () => void {
  const { root, scrollEl } = opts;
  let activePointerId: number | null = null;

  function measureDrawer(): Rect | null {
    const el = document.querySelector("[data-orch-drawer]");
    return el ? toRect(el) : null;
  }

  function onPointerDown(e: PointerEvent): void {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;

    // Drawer rows are checked FIRST and are exempt from the button guard
    // below: the whole row IS a button, and it is also the drag subject.
    // A press with no movement still fires its own onclick, so
    // click-to-add keeps working. Cards and tools are the same gesture
    // and differ only in which attribute carries the id.
    const cardEl = target.closest("[data-orch-card]");
    const toolEl = cardEl ? null : target.closest("[data-orch-tool]");
    let kind: OrchDragKind;
    let itemEl: Element;
    let draggedId: string;
    let sourceStageId: string | null;
    let clickCardPath: string | null = null;

    if (cardEl) {
      kind = "card";
      itemEl = cardEl;
      draggedId = cardEl.getAttribute("data-orch-card") ?? "";
      sourceStageId = null;
    } else if (toolEl) {
      kind = "tool";
      itemEl = toolEl;
      draggedId = toolEl.getAttribute("data-orch-tool") ?? "";
      sourceStageId = null;
    } else {
      if (target.closest("button, input, a, textarea, select")) return;
      const stepEl = target.closest("[data-orch-step]");
      if (!stepEl) return;
      kind = "step";
      itemEl = stepEl;
      draggedId = stepEl.getAttribute("data-orch-step") ?? "";
      sourceStageId = stepEl.closest("[data-orch-stage]")?.getAttribute("data-orch-stage") ?? "";
      // Innermost first, and only when it is inside THIS step -- a
      // press on the step's own card matches nothing and falls back to
      // the step's card path.
      const kbEl = target.closest("[data-kb-plan]");
      clickCardPath = kbEl && stepEl.contains(kbEl) ? kbEl.getAttribute("data-kb-plan") : null;
    }

    const cbs: OrchDragCallbacks = {
      measure: () => measureRails(root, draggedId),
      measureDrawer,
      commit: opts.commit,
      click: opts.click,
    };
    activeOrchDragRoot.set(root);
    beginCandidate(
      kind,
      draggedId,
      sourceStageId,
      { x: e.clientX, y: e.clientY },
      toRect(itemEl),
      cbs,
      clickCardPath
    );
    // Window-level, capture-phase: the dragged chip's wrapper leaves the
    // DOM at activation and WKWebView then drops the pointerup instead
    // of retargeting it. setPointerCapture stays a best-effort extra.
    activePointerId = e.pointerId;
    attachGestureListeners();
    try {
      root.setPointerCapture(e.pointerId);
    } catch {
      // Capture is an enhancement, never a requirement.
    }
  }

  function onGestureMove(e: PointerEvent): void {
    if (e.pointerId !== activePointerId) return;
    movePointer({ x: e.clientX, y: e.clientY }, e.buttons);
    if (e.buttons === 0) detachGestureListeners();
  }

  function onGestureUp(e: PointerEvent): void {
    if (e.pointerId !== activePointerId) return;
    endPointer();
    detachGestureListeners();
  }

  function onGestureCancel(e: PointerEvent): void {
    if (e.pointerId !== activePointerId) return;
    cancelDrag();
    detachGestureListeners();
  }

  function attachGestureListeners(): void {
    window.addEventListener("pointermove", onGestureMove, true);
    window.addEventListener("pointerup", onGestureUp, true);
    window.addEventListener("pointercancel", onGestureCancel, true);
  }

  function detachGestureListeners(): void {
    activePointerId = null;
    window.removeEventListener("pointermove", onGestureMove, true);
    window.removeEventListener("pointerup", onGestureUp, true);
    window.removeEventListener("pointercancel", onGestureCancel, true);
  }

  function onKeyDown(e: KeyboardEvent): void {
    if (e.key === "Escape" && get(orchDragState)) {
      cancelDrag();
      detachGestureListeners();
    }
  }

  // The grid scrolls in BOTH axes (unlike the board, where each column
  // scrolls its own card list), so this nudges root on x and y.
  let rafId: number | null = null;
  function frame(): void {
    rafId = null;
    const drag = get(orchDragState);
    if (!drag) return;
    let scrolled = false;

    const gridRect = scrollEl.getBoundingClientRect();
    const dx = autoScrollVelocity(drag.pointer.x, gridRect.left, gridRect.right);
    if (dx !== 0) {
      const before = scrollEl.scrollLeft;
      scrollEl.scrollLeft += dx;
      scrolled ||= scrollEl.scrollLeft !== before;
    }
    const dy = autoScrollVelocity(drag.pointer.y, gridRect.top, gridRect.bottom);
    if (dy !== 0) {
      const before = scrollEl.scrollTop;
      scrollEl.scrollTop += dy;
      scrolled ||= scrollEl.scrollTop !== before;
    }

    if (scrolled) refreshTarget();
    rafId = requestAnimationFrame(frame);
  }

  const unsubscribe = orchDragState.subscribe((drag) => {
    if (drag && rafId === null) {
      rafId = requestAnimationFrame(frame);
    } else if (!drag && rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
  });

  root.addEventListener("pointerdown", onPointerDown);
  window.addEventListener("keydown", onKeyDown);

  return () => {
    unsubscribe();
    if (rafId !== null) cancelAnimationFrame(rafId);
    root.removeEventListener("pointerdown", onPointerDown);
    window.removeEventListener("keydown", onKeyDown);
    detachGestureListeners();
    cancelDrag();
  };
}
