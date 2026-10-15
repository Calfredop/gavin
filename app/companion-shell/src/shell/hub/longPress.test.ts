import { describe, expect, it } from "vitest";
import { createLongPress, LONG_PRESS_MS, LONG_PRESS_SLOP_PX, type Timers } from "$shell/hub/longPress";

function bench() {
  const pending = new Map<number, () => void>();
  let next = 0;
  const timers: Timers = {
    set: (fn) => (pending.set(++next, fn), next),
    clear: (handle) => void pending.delete(handle as number),
  };
  let fired = 0;
  const press = createLongPress(() => fired++, timers);
  return {
    press,
    fired: () => fired,
    elapse: () => {
      const due = [...pending.values()];
      pending.clear();
      for (const fn of due) fn();
    },
    pending: () => pending.size,
  };
}

describe("long press", () => {
  it("fires once the finger has stayed down, and swallows the click that ends it", () => {
    const b = bench();
    b.press.down(10, 10);
    expect(b.fired()).toBe(0);
    b.elapse();
    expect(b.fired()).toBe(1);
    b.press.up();
    expect(b.press.takeClick()).toBe(true);
    // Once: the next click is the owner's own.
    expect(b.press.takeClick()).toBe(false);
  });

  it("is a tap when the finger lifts first, and the click goes through", () => {
    const b = bench();
    b.press.down(10, 10);
    b.press.up();
    expect(b.pending()).toBe(0);
    expect(b.fired()).toBe(0);
    expect(b.press.takeClick()).toBe(false);
  });

  it("is a scroll once the finger wanders past the slop, and a wobble inside it is not", () => {
    const b = bench();
    b.press.down(10, 10);
    b.press.move(10 + LONG_PRESS_SLOP_PX - 1, 10);
    expect(b.pending()).toBe(1);
    b.press.move(10, 10 + LONG_PRESS_SLOP_PX + 1);
    expect(b.pending()).toBe(0);
    b.elapse();
    expect(b.fired()).toBe(0);
  });

  it("fires once when the platform's own long press arrives during the hold", () => {
    const b = bench();
    b.press.down(10, 10);
    b.press.trigger();
    expect(b.pending()).toBe(0);
    b.elapse();
    b.press.trigger();
    expect(b.fired()).toBe(1);
  });

  it("starts each press afresh: a fired press that brought no click does not swallow the next tap's", () => {
    const b = bench();
    b.press.down(10, 10);
    b.elapse();
    b.press.up();
    b.press.down(10, 10);
    b.press.up();
    expect(b.press.takeClick()).toBe(false);
  });

  it("holds long enough to be a press, not a tap", () => {
    expect(LONG_PRESS_MS).toBeGreaterThanOrEqual(400);
  });
});
