import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHoverIntent } from "$lib/hoverIntent";

describe("createHoverIntent", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function harness(delay = 250) {
    const seen: (string | null)[] = [];
    const intent = createHoverIntent(delay, (key) => seen.push(key));
    return { intent, seen };
  }

  it("says nothing at all until the delay is up", () => {
    const { intent, seen } = harness();
    intent.enter("ws1");
    vi.advanceTimersByTime(249);
    expect(seen).toEqual([]);
  });

  it("settles once the delay is up", () => {
    const { intent, seen } = harness();
    intent.enter("ws1");
    vi.advanceTimersByTime(250);
    expect(seen).toEqual(["ws1"]);
  });

  // The exact bug tooltip.ts records having hit: a pending show that
  // fires AFTER the pointer has already left, and then has nothing left
  // to take it back down.
  it("never settles when the pointer leaves before the delay is up", () => {
    const { intent, seen } = harness();
    intent.enter("ws1");
    vi.advanceTimersByTime(200);
    intent.leave();
    vi.advanceTimersByTime(1000);
    expect(seen).toEqual([]);
  });

  it("clears a settled target when the pointer leaves", () => {
    const { intent, seen } = harness();
    intent.enter("ws1");
    vi.advanceTimersByTime(250);
    intent.leave();
    expect(seen).toEqual(["ws1", null]);
  });

  // Crossing the strip on the way somewhere else is the whole reason the
  // delay exists: every target is touched, none of them long enough.
  it("settles nothing when the pointer sweeps across several targets", () => {
    const { intent, seen } = harness();
    for (const id of ["ws1", "ws2", "ws3"]) {
      intent.enter(id);
      vi.advanceTimersByTime(80);
      intent.leave();
    }
    vi.advanceTimersByTime(1000);
    expect(seen).toEqual([]);
  });

  it("re-arms on a new target, and only the one dwelt on settles", () => {
    const { intent, seen } = harness();
    intent.enter("ws1");
    vi.advanceTimersByTime(200);
    intent.enter("ws2");
    vi.advanceTimersByTime(250);
    expect(seen).toEqual(["ws2"]);
  });

  // Without this guard a stray re-entry on the target already showing
  // would take it down and bring it back 250ms later -- a flicker caused
  // by the very timer meant to prevent one.
  it("ignores a re-entry on the target already settled", () => {
    const { intent, seen } = harness();
    intent.enter("ws1");
    vi.advanceTimersByTime(250);
    intent.enter("ws1");
    vi.advanceTimersByTime(1000);
    expect(seen).toEqual(["ws1"]);
  });

  // Keyboard focus is already deliberate -- there is no accidental
  // arrival to guard against, so there is no delay to serve.
  it("settles focus immediately, with no delay", () => {
    const { intent, seen } = harness();
    intent.focusNow("ws1");
    expect(seen).toEqual(["ws1"]);
  });

  it("drops a pending hover when focus overtakes it", () => {
    const { intent, seen } = harness();
    intent.enter("ws1");
    vi.advanceTimersByTime(100);
    intent.focusNow("ws2");
    vi.advanceTimersByTime(1000);
    expect(seen).toEqual(["ws2"]);
  });

  it("cancels a pending timer on destroy", () => {
    const { intent, seen } = harness();
    intent.enter("ws1");
    vi.advanceTimersByTime(100);
    intent.destroy();
    vi.advanceTimersByTime(1000);
    expect(seen).toEqual([]);
  });

  it("leaves with nothing armed without announcing a change", () => {
    const { intent, seen } = harness();
    intent.leave();
    expect(seen).toEqual([]);
  });

  it("honours a delay other than the default", () => {
    const { intent, seen } = harness(500);
    intent.enter("ws1");
    vi.advanceTimersByTime(250);
    expect(seen).toEqual([]);
    vi.advanceTimersByTime(250);
    expect(seen).toEqual(["ws1"]);
  });
});
