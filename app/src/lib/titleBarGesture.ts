// Title-bar double-click handling for the custom (decorations: false)
// window. Pure logic; TitleBar.svelte wires it to DOM events.

/** What a title-bar double-click should do, per the user's macOS setting. */
export type TitleBarAction = "toggleMaximize" | "minimize" | "none";

/**
 * Map the macOS global default `AppleActionOnDoubleClick` (System
 * Settings > Desktop & Dock > "Double-click a window's title bar to") to
 * an action. "Maximize" is what the setting stores for Zoom; "Fill" is
 * the newer fill-the-screen option -- both are `toggleMaximize` for a
 * borderless window, whose maximize already fills the visible screen.
 * A missing or unknown value falls back to the OS default, Zoom.
 */
export function doubleClickAction(pref: string | null | undefined): TitleBarAction {
  switch (pref) {
    case "Minimize":
      return "minimize";
    case "None":
      return "none";
    default:
      return "toggleMaximize";
  }
}

export interface PointerLike {
  button: number;
  detail: number;
  clientX: number;
  clientY: number;
}

export type MousedownVerdict = "drag" | "arm" | "ignore";

export interface DoubleClickTracker {
  /** Call from mousedown. "drag" -> start a native window drag; "arm" ->
   *  this is the second click of a double-click, do NOT start a drag
   *  (it would swallow the mouseup); "ignore" -> not a left click we care about. */
  mousedown(e: PointerLike): MousedownVerdict;
  /** Call from mouseup. True exactly once per armed, unmoved double-click. */
  mouseup(e: PointerLike): boolean;
}

/**
 * Tracks a title-bar double-click the way macOS does: the action fires
 * on the *mouseup* of the second click, and only if the cursor did not
 * move since that click's mousedown -- moving cancels it.
 */
export function createDoubleClickTracker(): DoubleClickTracker {
  let armed: { x: number; y: number } | null = null;
  return {
    mousedown(e) {
      if (e.button !== 0) return "ignore";
      if (e.detail === 1) {
        armed = null;
        return "drag";
      }
      if (e.detail === 2) {
        armed = { x: e.clientX, y: e.clientY };
        return "arm";
      }
      return "ignore";
    },
    mouseup(e) {
      if (!armed || e.button !== 0 || e.detail !== 2) return false;
      const hit = e.clientX === armed.x && e.clientY === armed.y;
      armed = null;
      return hit;
    },
  };
}

/// How far a press has to travel before it is a window drag rather than
/// a click. Small enough that a deliberate drag starts at once, large
/// enough that the hand-shake in a click never moves the window.
export const DRAG_INTENT_SLOP = 4;

export interface DragIntent {
  /** Call from mousedown. True when this press is one the surface owns
   *  -- it may still end as either a click or a drag. */
  down(e: PointerLike): boolean;
  /** Call from mousemove. True exactly once per press, on the move that
   *  takes it past the slop: that is the moment to hand the pointer to
   *  the window manager. */
  move(e: PointerLike): boolean;
  /** Call from mouseup. True when the press ended without ever
   *  travelling -- a click, and nothing else. */
  up(e: PointerLike): boolean;
  /** Forget the press without deciding anything. */
  cancel(): void;
}

/**
 * A press that is a click OR a window drag, decided by whether it moves.
 *
 * The title bar does not need this: nothing in its empty run is
 * clickable, so its mousedown can start a native drag outright. A
 * surface that also ACTS on a click cannot -- `startDragging()` takes
 * the pointer from the webview immediately and the mouseup never
 * arrives, so arming the drag on mousedown would cost the click
 * entirely. Waiting for the slop is what lets one surface offer both,
 * and it is what lets the modal backdrop move the window without the
 * press that dismisses the modal moving anything.
 */
export function createDragIntent(slop: number = DRAG_INTENT_SLOP): DragIntent {
  let origin: { x: number; y: number } | null = null;
  let travelled = false;
  return {
    down(e) {
      if (e.button !== 0) return false;
      origin = { x: e.clientX, y: e.clientY };
      travelled = false;
      return true;
    },
    move(e) {
      if (!origin || travelled) return false;
      const far = Math.abs(e.clientX - origin.x) > slop || Math.abs(e.clientY - origin.y) > slop;
      if (!far) return false;
      travelled = true;
      return true;
    },
    up(e) {
      const click = origin !== null && !travelled && e.button === 0;
      origin = null;
      travelled = false;
      return click;
    },
    cancel() {
      origin = null;
      travelled = false;
    },
  };
}
