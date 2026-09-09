import { describe, it, expect, vi } from "vitest";
import {
  reduceHint,
  createHintTracker,
  INITIAL_HINT_STATE,
  type HintEvent,
  type HintState,
  type HintKeyEvent,
  type HintMode,
} from "$lib/core/shortcutHints";

vi.mock("$lib/core/platform", () => ({ cmdHeld: (e: HintKeyEvent) => e.metaKey }));

const mods = (cmd: boolean, shift = false, alt = false): HintEvent => ({
  type: "modifier-state",
  cmd,
  shift,
  alt,
});

function run(...events: HintEvent[]): HintState {
  return events.reduce(reduceHint, INITIAL_HINT_STATE);
}

describe("reduceHint", () => {
  it("arms on cmd down and shows nothing until the hold elapses", () => {
    const armed = run(mods(true));
    expect(armed.armed).toBe(true);
    expect(armed.mode).toBeNull();
    expect(reduceHint(armed, { type: "hold-elapsed" }).mode).toBe("cmd");
  });

  it("shows cmd-shift or cmd-alt when that modifier is down", () => {
    expect(run(mods(true, true, false), { type: "hold-elapsed" }).mode).toBe("cmd-shift");
    expect(run(mods(true, false, true), { type: "hold-elapsed" }).mode).toBe("cmd-alt");
  });

  it("shows nothing for ⌘⇧⌥, which the router refuses to act on", () => {
    expect(run(mods(true, true, true), { type: "hold-elapsed" }).mode).toBeNull();
    // and it hides badges that were already up when the combination is reached
    const shown = run(mods(true), { type: "hold-elapsed" });
    expect(reduceHint(shown, mods(true, true, true)).mode).toBeNull();
  });

  it("switches mode live while the hints are up", () => {
    const shown = run(mods(true), { type: "hold-elapsed" });
    const withShift = reduceHint(shown, mods(true, true, false));
    expect(withShift.mode).toBe("cmd-shift");
    expect(reduceHint(withShift, mods(true)).mode).toBe("cmd");
    expect(reduceHint(withShift, mods(true, false, true)).mode).toBe("cmd-alt");
  });

  it("a non-modifier key cancels the hold until cmd is released", () => {
    const cancelled = run(mods(true), { type: "other-key" });
    expect(cancelled.cancelled).toBe(true);
    expect(reduceHint(cancelled, { type: "hold-elapsed" }).mode).toBeNull();
    // still cancelled while cmd stays down, even if shift joins
    const stillDown = reduceHint(cancelled, mods(true, true, false));
    expect(reduceHint(stillDown, { type: "hold-elapsed" }).mode).toBeNull();
    // releasing cmd resets everything
    expect(reduceHint(stillDown, mods(false))).toEqual(INITIAL_HINT_STATE);
  });

  it("a key pressed while the hints are up hides them", () => {
    const shown = run(mods(true), { type: "hold-elapsed" });
    const afterKey = reduceHint(shown, { type: "other-key" });
    expect(afterKey.mode).toBeNull();
    expect(afterKey.cancelled).toBe(true);
  });

  it("releasing cmd and blur both clear a shown mode", () => {
    const shown = run(mods(true), { type: "hold-elapsed" });
    expect(reduceHint(shown, mods(false)).mode).toBeNull();
    expect(reduceHint(shown, { type: "blur" })).toEqual(INITIAL_HINT_STATE);
  });

  it("ignores hold-elapsed when cmd was never down", () => {
    expect(reduceHint(INITIAL_HINT_STATE, { type: "hold-elapsed" }).mode).toBeNull();
  });

  it("ignores a stray other-key when nothing is armed", () => {
    expect(reduceHint(INITIAL_HINT_STATE, { type: "other-key" })).toEqual(INITIAL_HINT_STATE);
  });
});

// A hand-cranked clock: nothing here waits on real time, and a pending
// timer that should have been cancelled shows up as a leftover entry.
function fakeClock() {
  const pending = new Map<number, () => void>();
  let next = 1;
  return {
    pending,
    clock: {
      setTimeout: (fn: () => void) => {
        const handle = next++;
        pending.set(handle, fn);
        return handle as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimeout: (handle: ReturnType<typeof setTimeout>) => {
        pending.delete(handle as unknown as number);
      },
    },
    /// Fires every armed timer, as the real clock would after the delay.
    tick() {
      const fns = [...pending.values()];
      pending.clear();
      fns.forEach((fn) => fn());
    },
  };
}

const key = (k: string, over: Partial<HintKeyEvent> = {}): HintKeyEvent => ({
  key: k,
  metaKey: k === "Meta",
  ctrlKey: false,
  shiftKey: k === "Shift",
  altKey: k === "Alt",
  ...over,
});

function tracker() {
  const modes: (HintMode | null)[] = [];
  const { clock, tick, pending } = fakeClock();
  const t = createHintTracker((mode) => modes.push(mode), clock, 500);
  return { t, modes, tick, pending, last: () => modes[modes.length - 1] ?? null };
}

describe("createHintTracker", () => {
  it("shows the badges only once the hold elapses", () => {
    const { t, tick, last } = tracker();
    t.keydown(key("Meta"));
    expect(last()).toBeNull();
    tick();
    expect(last()).toBe("cmd");
  });

  it("shows nothing when the key comes up before the hold elapses", () => {
    const { t, tick, last, pending } = tracker();
    t.keydown(key("Meta"));
    t.keyup(key("Meta", { metaKey: false }));
    expect(pending.size).toBe(0);
    tick();
    expect(last()).toBeNull();
  });

  it("a shortcut typed during the hold never flashes hints", () => {
    const { t, tick, last, pending } = tracker();
    t.keydown(key("Meta"));
    t.keydown(key("t", { metaKey: true }));
    expect(pending.size).toBe(0);
    tick();
    expect(last()).toBeNull();
  });

  it("adding Shift mid-hold does not restart the timer", () => {
    const { t, tick, last } = tracker();
    t.keydown(key("Meta"));
    t.keydown(key("Shift", { metaKey: true, shiftKey: true }));
    tick();
    expect(last()).toBe("cmd-shift");
  });

  it("modifier key repeat does not restart the timer either", () => {
    const { t, tick, last } = tracker();
    t.keydown(key("Meta"));
    t.keydown(key("Meta"));
    t.keydown(key("Meta"));
    tick();
    expect(last()).toBe("cmd");
  });

  it("blur clears the badges and any pending timer", () => {
    const { t, tick, last, pending } = tracker();
    t.keydown(key("Meta"));
    tick();
    expect(last()).toBe("cmd");
    t.blur();
    expect(last()).toBeNull();
    expect(pending.size).toBe(0);
  });

  it("dispose cancels a pending hold so no badge appears afterwards", () => {
    const { t, tick, last, pending } = tracker();
    t.keydown(key("Meta"));
    t.dispose();
    expect(pending.size).toBe(0);
    tick();
    expect(last()).toBeNull();
  });

  it("ignores a non-modifier keyup, so a cancel outlives the key that caused it", () => {
    const { t, tick, last } = tracker();
    t.keydown(key("Meta"));
    t.keydown(key("t", { metaKey: true }));
    t.keyup(key("t", { metaKey: true }));
    tick();
    expect(last()).toBeNull();
  });
});

describe("default clock", () => {
  // Regression: the default clock used to be `{ setTimeout, clearTimeout }`,
  // so calling `clock.setTimeout(...)` invoked it with `this === clock`.
  // WebKit rejects that ("Can only call Window.setTimeout on instances of
  // Window"), which threw on every ⌘ keydown and meant the badges never
  // appeared in the app -- while every test passed, because Node's timers
  // do not care about `this`. This stub makes Node behave like WebKit.
  it("schedules through the global timer without rebinding it", () => {
    const realSetTimeout = globalThis.setTimeout;
    const realClearTimeout = globalThis.clearTimeout;
    const scheduled: (() => void)[] = [];
    try {
      globalThis.setTimeout = function (this: unknown, fn: () => void) {
        if (this !== undefined && this !== globalThis) {
          throw new TypeError("Can only call Window.setTimeout on instances of Window");
        }
        scheduled.push(fn);
        return 1;
      } as unknown as typeof globalThis.setTimeout;
      globalThis.clearTimeout = function (this: unknown) {
        if (this !== undefined && this !== globalThis) {
          throw new TypeError("Can only call Window.clearTimeout on instances of Window");
        }
      } as unknown as typeof globalThis.clearTimeout;

      const modes: (HintMode | null)[] = [];
      const t = createHintTracker((mode) => modes.push(mode));
      t.keydown({ key: "Meta", metaKey: true, ctrlKey: false, shiftKey: false, altKey: false });
      expect(scheduled).toHaveLength(1);
      scheduled[0]();
      expect(modes[modes.length - 1]).toBe("cmd");
      t.dispose();
    } finally {
      globalThis.setTimeout = realSetTimeout;
      globalThis.clearTimeout = realClearTimeout;
    }
  });
});
