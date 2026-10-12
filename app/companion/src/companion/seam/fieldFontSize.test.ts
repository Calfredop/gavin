// No text field the phone draws is under 16px. iOS zooms the whole page
// into a smaller one the moment it takes focus, and leaves it zoomed after
// the keyboard goes -- the terminal's compose field did, at 13px, and so
// did the rail editor's name.
//
// The suites have no page to compute a style on, so this reads the
// stylesheets. The floor is one rule in phone.css over every field the
// bundle draws, its own and the desktop components'; what is held here is
// that the rule reaches every kind of field the bundle has, floors at 16px
// on every screen, and that nothing the bundle ships can out-rank it.
import { describe, expect, it } from "vitest";
import { allSources } from "$lib/sources";
import { companionSources } from "$companion/testing/companionSources";
import { floorPx, rulesOf, splitList, type StyleRule } from "$companion/testing/styleRules";
import phoneCss from "$companion/surfaces/phone.css?raw";
import themeCss from "$lib/ui/theme.css?raw";
import xtermCss from "@xterm/xterm/css/xterm.css?raw";

/// The input types nothing is typed into, so iOS never zooms for them.
const UNTYPED_INPUTS = new Set(["checkbox", "radio", "range", "color", "file", "button", "submit", "reset", "image", "hidden"]);

/// For `input` or `input:not([type="..."], ...)`, the types it leaves
/// out; for any other selector, null.
function inputTypesLeftOut(selector: string): string[] | null {
  if (selector === "input") return [];
  const not = /^input:not\((.*)\)$/.exec(selector);
  if (!not) return null;
  return splitList(not[1]).map((s) => /^\[type="?([a-z-]+)"?\]$/.exec(s)?.[1] ?? s);
}

function covers(rule: StyleRule, field: { tag: string; type: string }): boolean {
  if (field.tag !== "input") return rule.selectors.includes(field.tag);
  return rule.selectors.some((s) => {
    const leftOut = inputTypesLeftOut(s);
    return leftOut !== null && !leftOut.includes(field.type);
  });
}

/// Every kind of field in the sources the bundle ships: its own, and the
/// desktop's library it draws from (all of it, a superset of what it
/// imports). An input with no type, or one set from code, is typed into.
function fieldsIn(sources: Record<string, string>): { tag: string; type: string }[] {
  const kinds = new Map<string, { tag: string; type: string }>();
  for (const text of Object.values(sources)) {
    for (const [, tag, attrs] of text.matchAll(/<(input|textarea|select)\b([^>]*)>/g)) {
      const type = tag === "input" ? (/\btype="([a-z-]+)"/.exec(attrs)?.[1] ?? "text") : "";
      kinds.set(`${tag} ${type}`, { tag, type });
    }
  }
  return [...kinds.values()];
}

const SHIPPED = { ...companionSources(), ...allSources() };
const floorRule = rulesOf(phoneCss).find((rule) => rule.selectors.includes("textarea"));

describe("the floor under every field", () => {
  it("is a rule of the page's stylesheet", () => {
    expect(floorRule).toBeDefined();
  });

  it("is 16px or more, and important, so a component's own smaller size does not win", () => {
    const size = floorRule?.declarations.get("font-size") ?? "";
    expect(size).toMatch(/!important$/);
    expect(floorPx(size.replace(/\s*!important$/, ""))).toBeGreaterThanOrEqual(16);
  });

  it("holds on every screen, inside no media query", () => {
    expect(floorRule?.within).toEqual([]);
  });

  it("leaves out only inputs nothing is typed into", () => {
    const leftOut = (floorRule?.selectors ?? []).flatMap((s) => inputTypesLeftOut(s) ?? []);
    expect(leftOut.filter((type) => !UNTYPED_INPUTS.has(type))).toEqual([]);
  });

  it("reaches every kind of field the bundle draws", () => {
    const fields = fieldsIn(SHIPPED);
    // The guard sees fields at all: the compose box, selects, a number.
    expect(fields).toContainEqual({ tag: "textarea", type: "" });
    expect(fields).toContainEqual({ tag: "select", type: "" });
    expect(fields).toContainEqual({ tag: "input", type: "number" });
    const typed = fields.filter((f) => !(f.tag === "input" && UNTYPED_INPUTS.has(f.type)));
    expect(typed.filter((f) => floorRule === undefined || !covers(floorRule, f))).toEqual([]);
  });

  it("is out-ranked by nothing the bundle ships: no other font size is important", () => {
    const sheets: Record<string, string> = {
      ...SHIPPED,
      "$lib/ui/theme.css": themeCss,
      "@xterm/xterm/css/xterm.css": xtermCss,
    };
    const important = [
      /font(-size)?\s*:[^;{}"]*!important/i,
      /style:font(-size)?\|important/,
      /setProperty\(\s*["']font(-size)?["'][^)]*["']important["']/,
    ];
    const outranking = Object.entries(sheets)
      .filter(([, text]) => important.some((pattern) => pattern.test(text)))
      .map(([path]) => path);
    expect(outranking).toEqual([]);
    // The floor is the one important size in phone.css as well.
    const importantSizes = rulesOf(phoneCss).filter((rule) =>
      ["font-size", "font"].some((property) => /!important$/.test(rule.declarations.get(property) ?? ""))
    );
    expect(importantSizes).toEqual([floorRule]);
  });
});

describe("reading a stylesheet", () => {
  it("finds a rule's at-rules and its declarations", () => {
    const [outer, inner] = rulesOf(`
      @import "x.css";
      /* a { font-size: 1px } */
      a, b:not(.c, .d) { font-size: max(16px, 1em) !important; color: red }
      @media (pointer: coarse) { e { font-size: 12px } }
    `);
    expect(outer.selectors).toEqual(["a", "b:not(.c, .d)"]);
    expect(outer.declarations.get("font-size")).toBe("max(16px, 1em) !important");
    expect(outer.within).toEqual([]);
    expect(inner.within).toEqual(["@media (pointer: coarse)"]);
  });

  it("knows a size's floor only where it is a px length", () => {
    expect(floorPx("16px")).toBe(16);
    expect(floorPx("max(16px, 1em)")).toBe(16);
    expect(floorPx("max(1em, 12px, 18px)")).toBe(18);
    expect(floorPx("1rem")).toBeNull();
    expect(floorPx("max(1em, 1rem)")).toBeNull();
  });
});
