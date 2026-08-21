import { describe, it, expect } from "vitest";
import { reduceHint, INITIAL_HINT_STATE, type HintEvent, type HintState } from "./shortcutHints";

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
