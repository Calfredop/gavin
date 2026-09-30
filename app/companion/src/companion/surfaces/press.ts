// A button pressed with a thumb while the soft keyboard is up.
//
// A plain `click` does two things the typing dock cannot have. It moves
// focus to the button, which on a phone puts the keyboard away under the
// human's thumb; and it fires at the end of a swipe that started on it,
// so scrolling the quick replies sideways would send one. This acts on
// the pointer coming UP where it went down, and keeps focus where it was.
// A key that repeats (an arrow) repeats while it is held, as a
// keyboard's does. The typing bench (ticket 01) worked this out; this is
// its `bindTap`.

/// How far a finger may drift before a press is a swipe instead.
export const SLOP_PX = 10;
const REPEAT_AFTER_MS = 380;
const REPEAT_EVERY_MS = 90;

export interface PressOptions {
  onPress: () => void;
  repeats?: boolean;
}

/// Whether a pointer that went down at one point and is now at another
/// has moved far enough to be a swipe.
export function drifted(from: { x: number; y: number }, to: { x: number; y: number }): boolean {
  return Math.abs(to.x - from.x) > SLOP_PX || Math.abs(to.y - from.y) > SLOP_PX;
}

/// Svelte action: `use:press={{ onPress, repeats }}`.
export function press(node: HTMLElement, options: PressOptions): { update(next: PressOptions): void; destroy(): void } {
  let current = options;
  let start: { x: number; y: number } | null = null;
  let delay: ReturnType<typeof setTimeout> | undefined;
  let repeat: ReturnType<typeof setInterval> | undefined;
  let repeated = false;

  const stop = (): void => {
    clearTimeout(delay);
    clearInterval(repeat);
    node.classList.remove("pressed");
  };
  const down = (e: PointerEvent): void => {
    if (e.button > 0) return;
    // Keeps focus -- and the keyboard -- where they are.
    e.preventDefault();
    start = { x: e.clientX, y: e.clientY };
    repeated = false;
    node.classList.add("pressed");
    if (current.repeats) {
      delay = setTimeout(() => {
        repeated = true;
        current.onPress();
        repeat = setInterval(() => current.onPress(), REPEAT_EVERY_MS);
      }, REPEAT_AFTER_MS);
    }
  };
  const move = (e: PointerEvent): void => {
    if (start && drifted(start, { x: e.clientX, y: e.clientY })) {
      start = null;
      stop();
    }
  };
  const up = (): void => {
    if (!start) return;
    start = null;
    stop();
    if (!repeated) current.onPress();
  };
  const cancel = (): void => {
    start = null;
    stop();
  };
  // A keyboard or a screen reader presses with a click and no pointer.
  const click = (e: MouseEvent): void => {
    if (e.detail === 0) current.onPress();
  };
  const menu = (e: Event): void => e.preventDefault();

  node.addEventListener("pointerdown", down);
  node.addEventListener("pointermove", move);
  node.addEventListener("pointerup", up);
  node.addEventListener("pointercancel", cancel);
  node.addEventListener("click", click);
  node.addEventListener("contextmenu", menu);
  return {
    update(next) {
      current = next;
    },
    destroy() {
      stop();
      node.removeEventListener("pointerdown", down);
      node.removeEventListener("pointermove", move);
      node.removeEventListener("pointerup", up);
      node.removeEventListener("pointercancel", cancel);
      node.removeEventListener("click", click);
      node.removeEventListener("contextmenu", menu);
    },
  };
}
