import { describe, it, expect } from "vitest";
import { resolveTheme, parseThemePref, type ThemePref } from "./theme";

describe("resolveTheme", () => {
  it("returns an explicit preference regardless of the system appearance", () => {
    for (const system of ["light", "dark", null] as const) {
      expect(resolveTheme("light", system)).toBe("light");
      expect(resolveTheme("dark", system)).toBe("dark");
    }
  });

  it("follows the system appearance when the preference is system", () => {
    expect(resolveTheme("system", "light")).toBe("light");
    expect(resolveTheme("system", "dark")).toBe("dark");
  });

  it("falls back to dark when system is unavailable", () => {
    expect(resolveTheme("system", null)).toBe("dark");
  });
});

describe("parseThemePref", () => {
  it("accepts the three valid literals", () => {
    for (const pref of ["light", "dark", "system"] as ThemePref[]) {
      expect(parseThemePref(pref)).toBe(pref);
    }
  });

  it("falls back to system for anything else", () => {
    for (const bad of ["", "  ", "Dark", "auto", "#fff", "light; x"]) {
      expect(parseThemePref(bad)).toBe("system");
    }
    expect(parseThemePref(null)).toBe("system");
    expect(parseThemePref(undefined)).toBe("system");
  });
});
