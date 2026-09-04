// Sideways scrolling for the app's two tab strips.
//
// A tab strip is the one surface in the app that scrolls horizontally
// and has no room to admit it: it is one row tall, its trailing actions
// are pinned OUTSIDE the scroller so they never scroll away, and its
// scrollbar is hidden (a 34px-tall overlay bar would sit on the active
// tab's indicator). A tab pushed past the right edge is therefore
// invisible and, with a plain mouse wheel -- which reports a vertical
// delta -- unreachable. This turns that vertical delta into the
// horizontal scroll the strip can actually use.
//
// deltaX is handed straight back to the browser: a trackpad's two-finger
// sideways swipe already scrolls the strip natively, and re-applying it
// here would move every horizontal gesture twice.

export interface WheelLike {
  deltaX: number;
  deltaY: number;
}

/// How far a wheel event should move a horizontal strip.
export function horizontalDelta(event: WheelLike): number {
  return event.deltaX !== 0 ? 0 : event.deltaY;
}

/// Where a strip lands after `delta`, clamped to its own extent. Equal
/// to `scrollLeft` means the strip is already at that end and the
/// gesture belongs to whatever is under it.
export function nextScrollLeft(
  el: { scrollLeft: number; scrollWidth: number; clientWidth: number },
  delta: number
): number {
  const max = el.scrollWidth - el.clientWidth;
  if (max <= 0) return el.scrollLeft;
  return Math.max(0, Math.min(max, el.scrollLeft + delta));
}

/// The minimum an element has to be for the action below to drive it --
/// declared so the tests can drive a plain object rather than a DOM node.
export interface Scroller {
  scrollLeft: number;
  readonly scrollWidth: number;
  readonly clientWidth: number;
  addEventListener(type: "wheel", handler: (e: WheelEvent) => void, options: { passive: boolean }): void;
  removeEventListener(type: "wheel", handler: (e: WheelEvent) => void): void;
}

/// Svelte action, applied to the scroller itself: `use:wheelScrollsSideways`.
///
/// preventDefault fires only once the strip has actually moved. A strip
/// already at its end must let the wheel through -- swallowing it there
/// would make the gesture die over a tab bar instead of reaching the
/// surface the human meant.
export function wheelScrollsSideways(node: Scroller): { destroy: () => void } {
  function onWheel(event: WheelEvent): void {
    const delta = horizontalDelta(event);
    if (delta === 0) return;
    const next = nextScrollLeft(node, delta);
    if (next === node.scrollLeft) return;
    event.preventDefault();
    node.scrollLeft = next;
  }
  node.addEventListener("wheel", onWheel, { passive: false });
  return {
    destroy: () => node.removeEventListener("wheel", onWheel),
  };
}
