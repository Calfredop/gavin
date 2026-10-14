import { describe, it, expect } from "vitest";
import {
  DOUBLE_CLICK_MS,
  MAX_PUNCH,
  MAX_REROLL_AGENTS,
  PUNCH_MS,
  REROLLS_PER_AGENT,
  cursorOn,
  flashAlpha,
  fleetIconStatus,
  isDoubleClick,
  nextPunchPower,
  punchEnvelope,
  rerollsDue,
  rowTear,
  staticAt,
} from "./appIconMotion";

describe("fleetIconStatus", () => {
  it("folds the hub's figures into the icon's four states", () => {
    expect(fleetIconStatus({ running: 3, failed: 0, inbox: 0, paused: 0 })).toEqual({
      working: 3,
      waiting: false,
      failed: false,
      paused: false,
    });
    expect(fleetIconStatus({ running: 0, failed: 2, inbox: 1, paused: 1 })).toEqual({
      working: 0,
      waiting: true,
      failed: true,
      paused: true,
    });
  });
});

describe("rerollsDue", () => {
  it("re-rolls nothing for an idle fleet", () => {
    expect(rerollsDue(0, 0, 1000)).toEqual({ count: 0, debt: 0 });
  });

  it("carries the fraction to the next frame rather than dropping it", () => {
    // One agent at 15 fps owes 0.6 of a cell per frame.
    let debt = 0;
    let total = 0;
    for (let frame = 0; frame < 15; frame++) {
      const due = rerollsDue(debt, 1, 1000 / 15);
      debt = due.debt;
      total += due.count;
    }
    expect(total + debt).toBeCloseTo(REROLLS_PER_AGENT);
  });

  it("caps a busy fleet, so it shimmers rather than boils", () => {
    expect(rerollsDue(0, 100, 1000).count).toBe(MAX_REROLL_AGENTS * REROLLS_PER_AGENT);
  });
});

describe("flashAlpha", () => {
  it("lands a fresh glyph at full brightness and settles back", () => {
    expect(flashAlpha(0.4, 0)).toBe(1);
    expect(flashAlpha(0.4, 200)).toBeGreaterThan(0.4);
    expect(flashAlpha(0.4, 10_000)).toBe(0.4);
  });
});

describe("cursorOn", () => {
  it("blinks, and holds steady under Reduce Motion", () => {
    expect(cursorOn(0, false)).not.toBe(cursorOn(600, false));
    expect(cursorOn(600, true)).toBe(true);
  });
});

describe("the punch", () => {
  it("is a double click, not two clicks a while apart", () => {
    expect(isDoubleClick(null, 1000)).toBe(false);
    expect(isDoubleClick(1000, 1000 + DOUBLE_CLICK_MS - 1)).toBe(true);
    expect(isDoubleClick(1000, 1000 + DOUBLE_CLICK_MS)).toBe(false);
  });

  it("eases in rather than popping, then dies away to nothing", () => {
    expect(punchEnvelope(-1, 1)).toBe(0);
    expect(punchEnvelope(0, 1)).toBe(0);
    expect(punchEnvelope(20, 1)).toBeLessThan(punchEnvelope(60, 1));
    let previous = punchEnvelope(60, 1);
    for (let t = 80; t < PUNCH_MS; t += 20) {
      const now = punchEnvelope(t, 1);
      expect(now).toBeLessThan(previous);
      previous = now;
    }
    expect(punchEnvelope(PUNCH_MS, 1)).toBe(0);
  });

  it("is close to settled before it is cut, so the cut does not show", () => {
    expect(punchEnvelope(PUNCH_MS - 1, MAX_PUNCH)).toBeLessThan(0.02);
  });

  it("hits harder when struck again while it still rings, up to a cap", () => {
    expect(nextPunchPower(0)).toBe(1);
    expect(nextPunchPower(0.4)).toBeCloseTo(1.4);
    expect(nextPunchPower(5)).toBe(MAX_PUNCH);
  });

  it("tears rows smoothly: no row jumps more than two cells between frames", () => {
    expect(rowTear(5, 24, 100, 0)).toBe(0);
    for (const row of [0, 5, 12, 23]) {
      for (let t = 0; t < PUNCH_MS; t += 16) {
        const step = Math.abs(rowTear(row, 24, t + 16, 1) - rowTear(row, 24, t, 1));
        expect(step, `row ${row} at ${t} ms`).toBeLessThan(2);
      }
    }
  });

  it("holds its static still between ticks", () => {
    expect(staticAt(3, 4, 7)).toBe(staticAt(3, 4, 7));
    expect(staticAt(3, 4, 7)).not.toBe(staticAt(3, 4, 8));
  });
});
