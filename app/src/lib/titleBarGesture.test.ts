import { describe, it, expect } from "vitest";
import { doubleClickAction, createDoubleClickTracker } from "./titleBarGesture";

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
