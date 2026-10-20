// A long press on a hub card: the gesture that asks to remove a paired
// Workstation, since the card's own tap opens it (or tries it now).
//
// Touch events, not pointer events: a card that cannot be tapped is a
// disabled button, which WebKit sends no pointer or mouse events to, but
// a finger's touches still arrive. `contextmenu` is the same gesture
// where the platform has its own long press (Android's WebView) or a
// right click (a browser): it fires the press once and its menu never
// shows.
//
// The click that ends a press that fired is swallowed, or lifting the
// finger off a long press would also open the Workstation.

/// How long the finger stays down: past a tap, short of feeling stuck.
export const LONG_PRESS_MS = 550;
/// How far the finger may wander before it is a scroll, not a press.
export const LONG_PRESS_SLOP_PX = 10;

export interface Timers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

// Wrapped, never `window.setTimeout` handed on: WKWebView throws on a
// detached one.
const GLOBAL_TIMERS: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface LongPress {
  down(x: number, y: number): void;
  move(x: number, y: number): void;
  /// The finger lifted, or the platform took the touch back.
  up(): void;
  /// The platform's own long press (`contextmenu`): fires now, once per
  /// press.
  trigger(): void;
  /// Whether the click arriving now ends a press that fired; it is
  /// swallowed, once.
  takeClick(): boolean;
}

export function createLongPress(onLongPress: () => void, timers: Timers = GLOBAL_TIMERS): LongPress {
  let timer: unknown = null;
  let start: { x: number; y: number } | null = null;
  let fired = false;

  function stopTimer(): void {
    if (timer !== null) timers.clear(timer);
    timer = null;
  }
  function fire(): void {
    stopTimer();
    start = null;
    if (fired) return;
    fired = true;
    onLongPress();
  }

  return {
    down(x, y) {
      stopTimer();
      fired = false;
      start = { x, y };
      timer = timers.set(fire, LONG_PRESS_MS);
    },
    move(x, y) {
      if (!start) return;
      if (Math.hypot(x - start.x, y - start.y) > LONG_PRESS_SLOP_PX) {
        stopTimer();
        start = null;
      }
    },
    up() {
      stopTimer();
      start = null;
    },
    trigger: fire,
    takeClick() {
      const swallow = fired;
      fired = false;
      return swallow;
    },
  };
}

/// The gesture on an element, as a Svelte action: `use:longPress={fn}`.
/// Null leaves the element without one.
export function longPress(node: HTMLElement, onLongPress: (() => void) | null) {
  let handler = onLongPress;
  const press = createLongPress(() => handler?.());
  const touch = (e: TouchEvent) => e.touches[0] ?? e.changedTouches[0];
  const listeners: [string, EventListener][] = [
    [
      "touchstart",
      ((e: TouchEvent) => {
        const t = touch(e);
        if (handler && t && e.touches.length === 1) press.down(t.clientX, t.clientY);
        else press.up();
      }) as EventListener,
    ],
    [
      "touchmove",
      ((e: TouchEvent) => {
        const t = touch(e);
        if (t) press.move(t.clientX, t.clientY);
      }) as EventListener,
    ],
    ["touchend", () => press.up()],
    ["touchcancel", () => press.up()],
    [
      "contextmenu",
      (e) => {
        if (!handler) return;
        e.preventDefault();
        press.trigger();
      },
    ],
    // Capture, so the swallowed click never reaches the card's own.
    [
      "click",
      (e) => {
        if (!press.takeClick()) return;
        e.preventDefault();
        e.stopPropagation();
      },
    ],
  ];
  for (const [type, fn] of listeners) node.addEventListener(type, fn, { capture: type === "click", passive: type.startsWith("touch") });
  return {
    update(next: (() => void) | null) {
      handler = next;
    },
    destroy() {
      press.up();
      for (const [type, fn] of listeners) node.removeEventListener(type, fn, { capture: type === "click" });
    },
  };
}
