import { describe, it, expect } from "vitest";
import {
  DEFAULT_TERMINAL_FONT_SIZE,
  MIN_TERMINAL_FONT_SIZE,
  MAX_TERMINAL_FONT_SIZE,
  TERMINAL_FONT_SIZES,
  normalizeTerminalFontSize,
  resolveTerminalFontSize,
  fontSizeOptions,
} from "./terminalFont";

describe("normalizeTerminalFontSize", () => {
  it("accepts an in-range number, and the string a <select> hands back", () => {
    expect(normalizeTerminalFontSize(13)).toBe(13);
    expect(normalizeTerminalFontSize("13")).toBe(13);
    expect(normalizeTerminalFontSize(" 16 ")).toBe(16);
  });

  it("rounds a fractional size rather than passing it to xterm", () => {
    expect(normalizeTerminalFontSize(13.4)).toBe(13);
    expect(normalizeTerminalFontSize(13.6)).toBe(14);
  });

  it("reads anything unusable as no choice, not as the default", () => {
    for (const bad of ["", "  ", "big", null, undefined, NaN, Infinity, {}, []]) {
      expect(normalizeTerminalFontSize(bad)).toBeNull();
    }
  });

  it("refuses a size outside the range — a terminal with no usable rows is not a preference", () => {
    expect(normalizeTerminalFontSize(0)).toBeNull();
    expect(normalizeTerminalFontSize(MIN_TERMINAL_FONT_SIZE - 1)).toBeNull();
    expect(normalizeTerminalFontSize(MAX_TERMINAL_FONT_SIZE + 1)).toBeNull();
    expect(normalizeTerminalFontSize(2000)).toBeNull();
    expect(normalizeTerminalFontSize(MIN_TERMINAL_FONT_SIZE)).toBe(MIN_TERMINAL_FONT_SIZE);
    expect(normalizeTerminalFontSize(MAX_TERMINAL_FONT_SIZE)).toBe(MAX_TERMINAL_FONT_SIZE);
  });
});

describe("resolveTerminalFontSize", () => {
  it("prefers the workspace's own size", () => {
    expect(resolveTerminalFontSize(16, 11)).toBe(16);
  });

  it("falls through to the app-wide size, then to gavin's default", () => {
    expect(resolveTerminalFontSize(undefined, 11)).toBe(11);
    expect(resolveTerminalFontSize(undefined, undefined)).toBe(DEFAULT_TERMINAL_FONT_SIZE);
  });

  it("does not let an unusable workspace value skip the app-wide one", () => {
    // The whole reason normalize returns null rather than the default:
    // a garbage override must fall to the next LEVEL, not past it.
    expect(resolveTerminalFontSize(0, 11)).toBe(11);
    expect(resolveTerminalFontSize("", 11)).toBe(11);
  });

  it("ships smaller than xterm's own default of 15", () => {
    expect(DEFAULT_TERMINAL_FONT_SIZE).toBeLessThan(15);
  });
});

describe("fontSizeOptions", () => {
  it("leads with an inherit row that names the size it inherits", () => {
    const options = fontSizeOptions(13);
    expect(options[0]).toEqual({ value: "", label: "Default (13)" });
    expect(fontSizeOptions(15)[0].label).toBe("Default (15)");
  });

  it("offers the ladder, all of it inside the accepted range", () => {
    const values = fontSizeOptions(13)
      .slice(1)
      .map((o) => Number(o.value));
    expect(values).toEqual([...TERMINAL_FONT_SIZES]);
    for (const size of values) {
      expect(normalizeTerminalFontSize(size)).toBe(size);
    }
  });

  it("keeps a hand-edited size that is off the ladder, in order", () => {
    const values = fontSizeOptions(13, 17)
      .slice(1)
      .map((o) => Number(o.value));
    expect(values).toContain(17);
    expect(values.indexOf(17)).toBe(values.indexOf(16) + 1);
  });

  it("does not duplicate a current size that is already on the ladder", () => {
    const values = fontSizeOptions(13, 14)
      .slice(1)
      .map((o) => Number(o.value));
    expect(values.filter((v) => v === 14)).toHaveLength(1);
  });

  it("ignores an unusable current size rather than listing it", () => {
    const values = fontSizeOptions(13, 900)
      .slice(1)
      .map((o) => Number(o.value));
    expect(values).toEqual([...TERMINAL_FONT_SIZES]);
  });
});
