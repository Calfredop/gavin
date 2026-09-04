import { describe, it, expect } from "vitest";
import { horizontalDelta, nextScrollLeft, wheelScrollsSideways, type Scroller } from "./wheelScroll";

/// A strip standing in for the DOM node: enough surface for the action,
/// and a handle on the listener it registered so a test can fire one.
function strip(over: { scrollLeft?: number; scrollWidth?: number; clientWidth?: number } = {}) {
  let handler: ((e: WheelEvent) => void) | null = null;
  let passive: boolean | null = null;
  const node = {
    scrollLeft: over.scrollLeft ?? 0,
    scrollWidth: over.scrollWidth ?? 400,
    clientWidth: over.clientWidth ?? 100,
    addEventListener(_type: "wheel", h: (e: WheelEvent) => void, options: { passive: boolean }) {
      handler = h;
      passive = options.passive;
    },
    removeEventListener(_type: "wheel", h: (e: WheelEvent) => void) {
      if (handler === h) handler = null;
    },
  };
  function wheel(deltaY: number, deltaX = 0): { prevented: boolean } {
    let prevented = false;
    handler?.({ deltaX, deltaY, preventDefault: () => (prevented = true) } as unknown as WheelEvent);
    return { prevented };
  }
  return {
    node: node as unknown as Scroller & { scrollLeft: number },
    wheel,
    get listening(): boolean {
      return handler !== null;
    },
    get passive(): boolean | null {
      return passive;
    },
  };
}

describe("horizontalDelta", () => {
  it("reads a plain wheel's vertical delta as sideways travel", () => {
    expect(horizontalDelta({ deltaX: 0, deltaY: 40 })).toBe(40);
    expect(horizontalDelta({ deltaX: 0, deltaY: -40 })).toBe(-40);
  });

  // A trackpad swipe already scrolls the strip natively; adding to it
  // here would move the row twice per gesture.
  it("declines an event the browser will scroll horizontally itself", () => {
    expect(horizontalDelta({ deltaX: 12, deltaY: 40 })).toBe(0);
    expect(horizontalDelta({ deltaX: -12, deltaY: 0 })).toBe(0);
  });
});

describe("nextScrollLeft", () => {
  it("clamps to the strip's own extent at both ends", () => {
    const el = { scrollLeft: 10, scrollWidth: 400, clientWidth: 100 };
    expect(nextScrollLeft(el, 1000)).toBe(300);
    expect(nextScrollLeft({ ...el, scrollLeft: 10 }, -1000)).toBe(0);
    expect(nextScrollLeft(el, 40)).toBe(50);
  });

  it("stays put when the strip is not overflowing at all", () => {
    expect(nextScrollLeft({ scrollLeft: 0, scrollWidth: 100, clientWidth: 100 }, 40)).toBe(0);
  });
});

describe("wheelScrollsSideways", () => {
  it("registers a non-passive wheel listener and drops it on destroy", () => {
    const s = strip();
    const action = wheelScrollsSideways(s.node);
    expect(s.listening).toBe(true);
    // Passive would make preventDefault a no-op, and the page under the
    // strip would scroll as well as the strip.
    expect(s.passive).toBe(false);
    action.destroy();
    expect(s.listening).toBe(false);
  });

  it("moves the strip sideways by a vertical wheel, claiming the event", () => {
    const s = strip({ scrollLeft: 0 });
    wheelScrollsSideways(s.node);
    expect(s.wheel(40).prevented).toBe(true);
    expect(s.node.scrollLeft).toBe(40);
  });

  // The gesture belongs to whatever is under the strip once the strip
  // itself cannot use it -- an end-stop that swallowed the wheel would
  // make scrolling die over a tab bar.
  it("lets the wheel through at either end, and when nothing overflows", () => {
    const atEnd = strip({ scrollLeft: 300 });
    wheelScrollsSideways(atEnd.node);
    expect(atEnd.wheel(40).prevented).toBe(false);
    expect(atEnd.node.scrollLeft).toBe(300);

    const atStart = strip({ scrollLeft: 0 });
    wheelScrollsSideways(atStart.node);
    expect(atStart.wheel(-40).prevented).toBe(false);

    const short = strip({ scrollWidth: 100, clientWidth: 100 });
    wheelScrollsSideways(short.node);
    expect(short.wheel(40).prevented).toBe(false);
  });

  it("leaves a horizontal gesture entirely to the browser", () => {
    const s = strip({ scrollLeft: 10 });
    wheelScrollsSideways(s.node);
    expect(s.wheel(40, 12).prevented).toBe(false);
    expect(s.node.scrollLeft).toBe(10);
  });
});
