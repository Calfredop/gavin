// The DOM side of the kanban drag engine (spec §1): one delegated
// pointerdown per board surface, rect measurement over data attributes,
// and the auto-scroll rAF loop. Every decision lives in kanbanDrag /
// pointerDrag -- this file only reads the DOM and forwards plain shapes.
//
// Data-attribute contract (rendered by the board components):
//   [data-kb-col]      column root; value = column id or "auto:<status>"
//   [data-kb-auto]     present on auto columns (plan drags only)
//   [data-kb-cards]    the scrollable card-list element inside a column
//   [data-kb-card]     free-form card wrapper; value = card id
//   [data-kb-plan]     plan card wrapper; value = plan path
//   [data-kb-colgrab]  column drag handle (header); value = column id

import { get, writable } from "svelte/store";
import {
  dragState,
  beginCandidate,
  movePointer,
  refreshTarget,
  endPointer,
  cancelDrag,
  type ActiveDrag,
  type DragKind,
  type DragCallbacks,
} from "./kanbanDrag";
import { autoScrollVelocity, type Measured, type MeasuredColumn, type DropTarget } from "./pointerDrag";

// The board root that owns the current (or most recent) drag. Both
// surfaces can show the same workspace simultaneously; each surface's
// preview layer renders only when it is the owner, and scopes its
// settle-target queries to this root.
export const activeDragRoot = writable<HTMLElement | null>(null);

export interface BoardDragOptions {
  root: HTMLElement; // also the horizontal scroll container of the column strip
  allowCards: boolean; // free-form card dragging (hub only)
  allowColumns: boolean; // column dragging (hub only)
  commit: (drag: ActiveDrag & { target: DropTarget }) => void;
  click: (kind: DragKind, id: string) => void;
}

function toRect(el: Element): { left: number; top: number; width: number; height: number } {
  const r = el.getBoundingClientRect();
  return { left: r.left, top: r.top, width: r.width, height: r.height };
}

function measureBoard(root: HTMLElement, draggedId: string): MeasuredColumn[] {
  const columns: MeasuredColumn[] = [];
  for (const colEl of root.querySelectorAll("[data-kb-col]")) {
    const id = colEl.getAttribute("data-kb-col") ?? "";
    const collect = (attr: string): Measured[] => {
      const out: Measured[] = [];
      for (const el of colEl.querySelectorAll(`[${attr}]`)) {
        const itemId = el.getAttribute(attr) ?? "";
        if (itemId !== draggedId) out.push({ id: itemId, rect: toRect(el) });
      }
      return out;
    };
    columns.push({
      id,
      rect: toRect(colEl),
      auto: colEl.hasAttribute("data-kb-auto"),
      cards: collect("data-kb-card"),
      planCards: collect("data-kb-plan"),
    });
  }
  return columns;
}

function measureColumnStrip(root: HTMLElement, draggedId: string): Measured[] {
  const out: Measured[] = [];
  for (const colEl of root.querySelectorAll("[data-kb-col]:not([data-kb-auto])")) {
    const id = colEl.getAttribute("data-kb-col") ?? "";
    if (id !== draggedId) out.push({ id, rect: toRect(colEl) });
  }
  return out;
}

// Index of `el` among the elements matching `attr` inside the same
// column -- the dragged item's own slot, which is already a post-removal
// index (items before it are unaffected by its removal).
function indexAmongSiblings(colEl: Element, attr: string, el: Element): number {
  let i = 0;
  for (const sibling of colEl.querySelectorAll(`[${attr}]`)) {
    if (sibling === el) return i;
    i += 1;
  }
  return i;
}

export function attachBoardDrag(opts: BoardDragOptions): () => void {
  const { root } = opts;

  function onPointerDown(e: PointerEvent): void {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.closest("button, input, a, textarea")) return;

    const cardEl = target.closest("[data-kb-card]");
    const planEl = target.closest("[data-kb-plan]");
    const grabEl = target.closest("[data-kb-colgrab]");

    let kind: DragKind;
    let itemEl: Element;
    let id: string;
    let sourceColumnId: string | null;
    let sourceIndex: number;

    if (cardEl) {
      if (!opts.allowCards) return;
      kind = "card";
      itemEl = cardEl;
      id = cardEl.getAttribute("data-kb-card") ?? "";
      const colEl = cardEl.closest("[data-kb-col]");
      sourceColumnId = colEl?.getAttribute("data-kb-col") ?? null;
      sourceIndex = colEl ? indexAmongSiblings(colEl, "data-kb-card", cardEl) : 0;
    } else if (planEl) {
      kind = "plan";
      itemEl = planEl;
      id = planEl.getAttribute("data-kb-plan") ?? "";
      const colEl = planEl.closest("[data-kb-col]");
      sourceColumnId = colEl?.getAttribute("data-kb-col") ?? null;
      sourceIndex = colEl ? indexAmongSiblings(colEl, "data-kb-plan", planEl) : 0;
    } else if (grabEl) {
      if (!opts.allowColumns) return;
      kind = "column";
      const colEl = grabEl.closest("[data-kb-col]");
      if (!colEl) return;
      itemEl = colEl;
      id = grabEl.getAttribute("data-kb-colgrab") ?? "";
      sourceColumnId = null;
      let i = 0;
      for (const c of root.querySelectorAll("[data-kb-col]:not([data-kb-auto])")) {
        if (c === colEl) break;
        i += 1;
      }
      sourceIndex = i;
    } else {
      return;
    }

    const cbs: DragCallbacks = {
      measure: () => measureBoard(root, id),
      measureColumns: () => measureColumnStrip(root, id),
      commit: opts.commit,
      click: opts.click,
    };
    activeDragRoot.set(root);
    beginCandidate(kind, id, sourceColumnId, sourceIndex, { x: e.clientX, y: e.clientY }, toRect(itemEl), cbs);
    // The gesture is tracked on WINDOW listeners, not on root: the
    // dragged card's wrapper leaves the DOM at activation, and WKWebView
    // then drops the pointerup instead of retargeting it (Chromium
    // retargets to the capture element). Window-level capture-phase
    // listeners receive the release wherever it lands. setPointerCapture
    // stays as a best-effort extra for engines that honor it.
    activePointerId = e.pointerId;
    attachGestureListeners();
    try {
      root.setPointerCapture(e.pointerId);
    } catch {
      // Capture is an enhancement, never a requirement.
    }
  }

  let activePointerId: number | null = null;

  function onGestureMove(e: PointerEvent): void {
    if (e.pointerId !== activePointerId) return;
    // buttons === 0 means the release was eaten by the platform; the
    // controller treats this move as the drop (lost-pointerup recovery).
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
    if (e.key === "Escape" && get(dragState)) {
      cancelDrag();
      detachGestureListeners();
    }
  }

  // Auto-scroll: while a drag is active, nudge the horizontal strip
  // (root) and the card list of the column under the pointer, then
  // re-hit-test -- content moves under a stationary pointer.
  let rafId: number | null = null;
  function frame(): void {
    rafId = null;
    const drag = get(dragState);
    if (!drag) return;
    let scrolled = false;

    const rootRect = root.getBoundingClientRect();
    const dx = autoScrollVelocity(drag.pointer.x, rootRect.left, rootRect.right);
    if (dx !== 0) {
      const before = root.scrollLeft;
      root.scrollLeft += dx;
      scrolled ||= root.scrollLeft !== before;
    }

    for (const colEl of root.querySelectorAll("[data-kb-col]")) {
      const r = colEl.getBoundingClientRect();
      if (drag.pointer.x < r.left || drag.pointer.x > r.right) continue;
      const list = colEl.querySelector("[data-kb-cards]");
      if (list) {
        const lr = list.getBoundingClientRect();
        const dy = autoScrollVelocity(drag.pointer.y, lr.top, lr.bottom);
        if (dy !== 0) {
          const before = list.scrollTop;
          list.scrollTop += dy;
          scrolled ||= list.scrollTop !== before;
        }
      }
      break;
    }

    if (scrolled) refreshTarget();
    rafId = requestAnimationFrame(frame);
  }

  const unsubscribe = dragState.subscribe((drag) => {
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
