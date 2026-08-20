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
