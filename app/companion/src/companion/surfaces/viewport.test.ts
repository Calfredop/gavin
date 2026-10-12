// The screen the page can use, with and without the soft keyboard, and
// what tells a press from a swipe.
import { describe, expect, it } from "vitest";
import { drifted, SLOP_PX, tap } from "$companion/surfaces/press";
import { trackVisibleArea, visibleArea } from "$companion/surfaces/viewport";

describe("the visible area", () => {
  it("is the whole window where there is no visual viewport to ask", () => {
    expect(visibleArea(null, 844)).toEqual({ height: 844, top: 0, keyboard: false });
  });

  it("leaves out the keyboard, and says it is up", () => {
    // An iPhone 17 in portrait with the keyboard raised.
    expect(visibleArea({ height: 508, offsetTop: 0 }, 844)).toEqual({ height: 508, top: 0, keyboard: true });
  });

  it("follows the page down as far as iOS scrolled it to show a field", () => {
    expect(visibleArea({ height: 508, offsetTop: 120 }, 844).top).toBe(120);
    // A rubber-band past the top is not a scroll to undo.
    expect(visibleArea({ height: 844, offsetTop: -30 }, 844).top).toBe(0);
  });

  it("does not take the browser's own bars for a keyboard", () => {
    expect(visibleArea({ height: 780, offsetTop: 0 }, 844).keyboard).toBe(false);
  });

  it("is never taller than the window", () => {
    expect(visibleArea({ height: 900, offsetTop: 0 }, 844).height).toBe(844);
  });
});

describe("tracking it", () => {
  function scope(viewport: { height: number; offsetTop: number }) {
    const listeners = new Map<string, () => void>();
    const style = new Map<string, string>();
    const attributes = new Set<string>();
    const target = {
      ...viewport,
      addEventListener: (type: string, listener: () => void) => void listeners.set(`vv:${type}`, listener),
      removeEventListener: (type: string) => void listeners.delete(`vv:${type}`),
      dispatchEvent: () => true,
    };
    return {
      listeners,
      style,
      attributes,
      viewport: target,
      value: {
        innerHeight: 844,
        visualViewport: target,
        addEventListener: (type: string, listener: () => void) => void listeners.set(`window:${type}`, listener),
        removeEventListener: (type: string) => void listeners.delete(`window:${type}`),
        document: {
          documentElement: {
            style: { setProperty: (name: string, value: string) => void style.set(name, value) },
            toggleAttribute: (name: string, on: boolean) => void (on ? attributes.add(name) : attributes.delete(name)),
          } as unknown as HTMLElement,
        },
      },
    };
  }

  it("writes the area where the page's styles read it, and keeps it current", () => {
    const s = scope({ height: 844, offsetTop: 0 });
    const stop = trackVisibleArea(s.value);
    expect(s.style.get("--visible-height")).toBe("844px");
    expect(s.attributes.has("data-keyboard")).toBe(false);

    s.viewport.height = 508;
    s.listeners.get("vv:resize")?.();
    expect(s.style.get("--visible-height")).toBe("508px");
    expect(s.attributes.has("data-keyboard")).toBe(true);

    stop();
    expect([...s.listeners.keys()]).toEqual([]);
  });
});

describe("a press", () => {
  it("is still a press within a thumb's slop, and a swipe past it", () => {
    const from = { x: 100, y: 100 };
    expect(drifted(from, { x: 100 + SLOP_PX, y: 100 - SLOP_PX })).toBe(false);
    expect(drifted(from, { x: 100 + SLOP_PX + 1, y: 100 })).toBe(true);
    expect(drifted(from, { x: 100, y: 100 - SLOP_PX - 1 })).toBe(true);
  });
});

describe("a tap on a surface that is also swiped", () => {
  // The terminal: xterm 6.1 claims every touch on its screen for
  // scrolling and cancels the touchstart, so no click follows a tap there.
  function surface() {
    const listeners = new Map<string, (e: unknown) => void>();
    const node = {
      addEventListener: (type: string, listener: (e: unknown) => void) => void listeners.set(type, listener),
      removeEventListener: (type: string) => void listeners.delete(type),
    };
    let prevented = 0;
    const pointer = (type: string, x: number, y: number, button = 0) =>
      listeners.get(type)?.({ type, clientX: x, clientY: y, button, preventDefault: () => prevented++ });
    return { node: node as unknown as HTMLElement, listeners, pointer, prevented: () => prevented };
  }

  it("is a pointer that comes up where it went down", () => {
    const s = surface();
    const taps: unknown[] = [];
    tap(s.node, (e) => taps.push(e));
    s.pointer("pointerdown", 100, 100);
    s.pointer("pointermove", 100 + SLOP_PX, 100);
    s.pointer("pointerup", 100 + SLOP_PX, 100);
    expect(taps).toHaveLength(1);
  });

  it("is not the end of a swipe", () => {
    const s = surface();
    let taps = 0;
    tap(s.node, () => taps++);
    s.pointer("pointerdown", 100, 100);
    s.pointer("pointermove", 100, 100 + SLOP_PX + 1);
    s.pointer("pointermove", 100, 100);
    s.pointer("pointerup", 100, 100);
    expect(taps).toBe(0);
  });

  it("is not a touch the browser took back, nor a second button", () => {
    const s = surface();
    let taps = 0;
    tap(s.node, () => taps++);
    s.pointer("pointerdown", 100, 100);
    s.pointer("pointercancel", 100, 100);
    s.pointer("pointerup", 100, 100);
    s.pointer("pointerdown", 100, 100, 2);
    s.pointer("pointerup", 100, 100, 2);
    expect(taps).toBe(0);
  });

  it("takes nothing from the surface: no default prevented, so focus, selection and its own gestures carry on", () => {
    const s = surface();
    tap(s.node, () => {});
    s.pointer("pointerdown", 100, 100);
    s.pointer("pointermove", 104, 100);
    s.pointer("pointerup", 104, 100);
    expect(s.prevented()).toBe(0);
  });

  it("lets go of the surface", () => {
    const s = surface();
    tap(s.node, () => {}).destroy();
    expect([...s.listeners.keys()]).toEqual([]);
  });
});
