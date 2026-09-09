import { describe, it, expect } from "vitest";
import { doubleClickAction, createDoubleClickTracker, createDragIntent } from "$lib/titleBarGesture";

describe("doubleClickAction", () => {
  // Values of the macOS global default `AppleActionOnDoubleClick`
  // (System Settings > Desktop & Dock > "Double-click a window's title
  // bar to"). Missing key means the OS default, which is Zoom.
  it("maps Maximize (Zoom) to toggleMaximize", () => {
    expect(doubleClickAction("Maximize")).toBe("toggleMaximize");
  });
  it("maps Fill to toggleMaximize", () => {
    expect(doubleClickAction("Fill")).toBe("toggleMaximize");
  });
  it("maps Minimize to minimize", () => {
    expect(doubleClickAction("Minimize")).toBe("minimize");
  });
  it("maps None to none", () => {
    expect(doubleClickAction("None")).toBe("none");
  });
  it("falls back to the OS default (zoom) when the key is unset or unknown", () => {
    expect(doubleClickAction(null)).toBe("toggleMaximize");
    expect(doubleClickAction(undefined)).toBe("toggleMaximize");
    expect(doubleClickAction("SomethingNew")).toBe("toggleMaximize");
  });
});

const ev = (detail: number, x = 10, y = 10, button = 0) => ({ button, detail, clientX: x, clientY: y });

describe("createDoubleClickTracker", () => {
  it("asks to drag on a single left mousedown", () => {
    const t = createDoubleClickTracker();
    expect(t.mousedown(ev(1))).toBe("drag");
  });
  it("ignores non-left buttons", () => {
    const t = createDoubleClickTracker();
    expect(t.mousedown(ev(1, 10, 10, 2))).toBe("ignore");
    expect(t.mousedown(ev(2, 10, 10, 1))).toBe("ignore");
  });
  it("arms (does not drag) on the second mousedown of a double-click", () => {
    const t = createDoubleClickTracker();
    t.mousedown(ev(1));
    expect(t.mousedown(ev(2))).toBe("arm");
  });
  it("fires on the mouseup of an unmoved double-click", () => {
    const t = createDoubleClickTracker();
    t.mousedown(ev(1));
    t.mousedown(ev(2, 40, 12));
    expect(t.mouseup(ev(2, 40, 12))).toBe(true);
  });
  it("cancels when the cursor moved between the second mousedown and mouseup", () => {
    const t = createDoubleClickTracker();
    t.mousedown(ev(1));
    t.mousedown(ev(2, 40, 12));
    expect(t.mouseup(ev(2, 45, 12))).toBe(false);
  });
  it("does not fire on a mouseup that was never armed", () => {
    const t = createDoubleClickTracker();
    expect(t.mouseup(ev(2, 10, 10))).toBe(false);
    t.mousedown(ev(1));
    expect(t.mouseup(ev(1))).toBe(false);
  });
  it("fires at most once per arm", () => {
    const t = createDoubleClickTracker();
    t.mousedown(ev(1));
    t.mousedown(ev(2));
    expect(t.mouseup(ev(2))).toBe(true);
    expect(t.mouseup(ev(2))).toBe(false);
  });
});

// A press on the modal backdrop is two gestures in one: a click that
// dismisses the dialog, and a drag that moves the window out from under
// it. What separates them is travel, and nothing else -- the dismissal
// cannot be decided on mousedown (it is not one yet) and the drag cannot
// wait for mouseup (a native drag swallows it).
describe("createDragIntent", () => {
  const at = (x: number, y: number, button = 0) => ({ button, detail: 1, clientX: x, clientY: y });

  it("reads a press that never moves as a click", () => {
    const g = createDragIntent();
    expect(g.down(at(100, 100))).toBe(true);
    expect(g.move(at(100, 100))).toBe(false);
    expect(g.up(at(100, 100))).toBe(true);
  });

  it("tolerates the hand-shake inside a click", () => {
    const g = createDragIntent();
    g.down(at(100, 100));
    expect(g.move(at(103, 102))).toBe(false);
    expect(g.up(at(103, 102))).toBe(true);
  });

  it("becomes a drag once the press travels past the slop", () => {
    const g = createDragIntent();
    g.down(at(100, 100));
    expect(g.move(at(120, 100))).toBe(true);
    // Once, so a press cannot ask the window manager twice.
    expect(g.move(at(140, 100))).toBe(false);
  });

  it("never clicks after it has dragged", () => {
    const g = createDragIntent();
    g.down(at(100, 100));
    g.move(at(100, 140));
    expect(g.up(at(100, 140))).toBe(false);
  });

  it("ignores a press that is not the left button", () => {
    const g = createDragIntent();
    expect(g.down(at(100, 100, 2))).toBe(false);
    expect(g.move(at(140, 100))).toBe(false);
    expect(g.up(at(140, 100, 2))).toBe(false);
  });

  it("reports no click for a mouseup that was never armed", () => {
    const g = createDragIntent();
    expect(g.up(at(100, 100))).toBe(false);
  });

  it("forgets a press it was told to cancel", () => {
    const g = createDragIntent();
    g.down(at(100, 100));
    g.cancel();
    expect(g.up(at(100, 100))).toBe(false);
  });

  it("takes the slop as a parameter, so a surface can be stricter", () => {
    const g = createDragIntent(0);
    g.down(at(100, 100));
    expect(g.move(at(101, 100))).toBe(true);
  });
});
