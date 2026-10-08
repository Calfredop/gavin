// The rail editor fits a phone: nothing in it is wider than the column,
// every control is a fingertip's size, and no field is small enough for
// iOS to zoom the page into it when it takes focus.
//
// On an iPhone 16 Pro (402px) the Add-a-card picker was 469px wide -- as
// wide as its longest card title -- and the editor scrolled sideways. Its
// selects were 29px tall under a 44px rule, because WebKit sizes a native
// select to its font, and the rail's name field was 13px.
//
// The suites have no page to lay out, so this reads PhoneRails.svelte:
// every control it draws, and what the rules for its classes declare.
// The floor under every field in the bundle is seam/fieldFontSize.test.ts.
import { describe, expect, it } from "vitest";
import { companionSource } from "$companion/testing/companionSources";
import { floorPx, rulesOf } from "$companion/testing/styleRules";

const SOURCE = companionSource("companion/surfaces/PhoneRails.svelte");
const RULES = rulesOf(/<style>([\s\S]*)<\/style>/.exec(SOURCE)?.[1] ?? "");
const MARKUP = SOURCE.replace(/<script[\s\S]*?<\/script>/, "").replace(/<style>[\s\S]*<\/style>/, "");

interface Control {
  tag: string;
  classes: string[];
  /// The classes of the `<span>` it sits in, if any.
  within: string[];
}

/// The attributes of the tag opening at `from`: up to the first `>`
/// outside a `{...}`, since an arrow function has one of its own.
function attributesAt(markup: string, from: number): string {
  let depth = 0;
  for (let i = from; i < markup.length; i++) {
    const ch = markup[i];
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    else if (ch === ">" && depth === 0) return markup.slice(from, i);
  }
  return markup.slice(from);
}

function classesOf(attributes: string): string[] {
  return (/\bclass="([^"]*)"/.exec(attributes)?.[1] ?? "").split(/\s+/).filter(Boolean);
}

/// Every select, input and button the editor draws.
function controls(markup: string): Control[] {
  return [...markup.matchAll(/<(select|input|button)\b/g)].map((match) => {
    const before = markup.slice(0, match.index);
    const span = before.lastIndexOf("<span");
    const inSpan = span >= 0 && !before.slice(span).includes("</span>");
    return {
      tag: match[1],
      classes: classesOf(attributesAt(markup, match.index + match[0].length)),
      within: inSpan ? classesOf(attributesAt(markup, span + "<span".length)) : [],
    };
  });
}

/// What the rules for these classes declare, later rules winning. The
/// sheet sizes a control by its bare class, so a rule naming one class is
/// the one that counts.
function declared(classes: string[], property: string): string | undefined {
  let value: string | undefined;
  for (const rule of RULES) {
    if (rule.within.length > 0) continue;
    if (!classes.some((c) => rule.selectors.includes(`.${c}`))) continue;
    value = rule.declarations.get(property) ?? value;
  }
  return value;
}

function name(control: Control): string {
  return `${control.tag}.${control.classes.join(".")}`;
}

const CONTROLS = controls(MARKUP);
const FIELDS = CONTROLS.filter((c) => c.tag !== "button");
const SELECTS = CONTROLS.filter((c) => c.tag === "select");

describe("the rail editor at a phone's width", () => {
  it("sees the editor's controls", () => {
    const names = CONTROLS.map(name);
    // The name field, the group's mode and the two add-a-card pickers.
    expect(names).toContain("input.name-field");
    expect(SELECTS).toHaveLength(3);
    // Move, remove and add.
    expect(names).toContain("button.icon");
    expect(names).toContain("button.action");
  });

  it("has every control 44px tall, and an icon 44px wide as well", () => {
    const short = CONTROLS.filter((c) => (floorPx(declared(c.classes, "min-height") ?? "") ?? 0) < 44);
    expect(short.map(name)).toEqual([]);
    const narrow = CONTROLS.filter(
      (c) => c.classes.includes("icon") && (floorPx(declared(c.classes, "min-width") ?? "") ?? 0) < 44
    );
    expect(narrow.map(name)).toEqual([]);
  });

  it("has every field take the column, never its content's width", () => {
    for (const field of FIELDS) {
      expect({ field: name(field), fit: fit(field.classes) }).toEqual({
        field: name(field),
        fit: { width: "100%", "min-width": "0", "max-width": "100%", "box-sizing": "border-box" },
      });
    }
  });

  it("puts every select in a box that shrinks with the column too", () => {
    for (const select of SELECTS) {
      expect(select.within).toContain("choice");
      expect({ "min-width": declared(select.within, "min-width"), "max-width": declared(select.within, "max-width") }).toEqual({
        "min-width": "0",
        "max-width": "100%",
      });
    }
  });

  it("cuts a long card title short in a closed select instead of widening it", () => {
    for (const select of SELECTS) {
      expect([declared(select.classes, "white-space"), declared(select.classes, "text-overflow")]).toEqual([
        "nowrap",
        "ellipsis",
      ]);
    }
  });

  it("draws every select's box itself, so WebKit keeps the height asked of it", () => {
    expect(SELECTS.filter((s) => declared(s.classes, "appearance") !== "none").map(name)).toEqual([]);
  });

  it("sets no field under 16px of its own", () => {
    const small = FIELDS.filter((f) => (floorPx(declared(f.classes, "font-size") ?? "") ?? 0) < 16);
    expect(small.map(name)).toEqual([]);
  });

  it("wraps every row of controls rather than pushing it past the edge", () => {
    for (const row of ["presses", "stage-head", "adding"]) {
      expect({ row, wrap: declared([row], "flex-wrap") }).toEqual({ row, wrap: "wrap" });
    }
  });
});

function fit(classes: string[]): Record<string, string | undefined> {
  return Object.fromEntries(
    ["width", "min-width", "max-width", "box-sizing"].map((property) => [property, declared(classes, property)])
  );
}
