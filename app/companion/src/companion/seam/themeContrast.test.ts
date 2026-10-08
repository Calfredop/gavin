// Every text role reads at 4.5:1 on every surface, in both themes, and
// the phone paints its text in nothing but those roles.
//
// On an iPhone 16 Pro (iOS 27) the Git rows' folder prefixes measured
// 3.54:1 in the light theme and 2.90:1 in the dark, the Sessions captions
// the same, and the Board's count on the shown column 2.37:1. WCAG AA is
// 4.5:1 for text under about 18px, and every one of those is 11px. Two
// causes, neither of them an opacity: `--text-subtle` was #888 on white
// and #666 on #1e1e1e, under the bar on every surface it was drawn on;
// and the Board's count took the column's tone from `--accent`, a fill,
// which is #4a9eff on white whatever the text role beside it says.
//
// So this holds both halves: the ratio of every text role against every
// surface theme.css defines, computed from theme.css itself, and that
// every `color:` the phone draws -- its own surfaces and each desktop
// component they import -- comes from a text role, directly or through a
// custom property the component sets. A literal or a fill role is a
// colour nothing here measures.
import { describe, expect, it } from "vitest";
import { companionSources } from "$companion/testing/companionSources";
import {
  contrastRatio,
  drawnComponents,
  isTextRole,
  themeColours,
  untextedColours,
  type Theme,
} from "$companion/testing/textColours";
import phoneCss from "$companion/surfaces/phone.css?raw";
import themeCss from "$lib/ui/theme.css?raw";

/// WCAG 2 AA, text under 18px (14px bold).
const AA_TEXT = 4.5;

/// Text roles drawn on something other than a surface, with what holds
/// them instead.
const OFF_SURFACE: Record<string, string> = {
  "--text-inverted":
    "white on a coloured fill (an accent or danger button, a badge), never on a surface: theme-text-on-fills-and-literal-colours-contrast.md",
};

const THEMES: Theme[] = ["dark", "light"];
const COLOURS = themeColours(themeCss);

function rolesOf(theme: Theme, keep: (name: string) => boolean): string[] {
  return Object.keys(COLOURS[theme]).filter(keep).sort();
}

describe("theme.css's text roles", () => {
  it("are measured the way WCAG measures them", () => {
    expect(contrastRatio("#000", "#fff")).toBeCloseTo(21, 5);
    expect(contrastRatio("#fff", "#000")).toBeCloseTo(21, 5);
    // The two greys either side of 4.5:1 on white.
    expect(contrastRatio("#767676", "#fff")).toBeGreaterThan(AA_TEXT);
    expect(contrastRatio("#777", "#fff")).toBeLessThan(AA_TEXT);
  });

  it("are read from the stylesheet, every role in both themes", () => {
    for (const theme of THEMES) {
      // A stylesheet the parse misread would hold nothing and pass.
      expect(rolesOf(theme, isTextRole), theme).toEqual(
        expect.arrayContaining(["--text", "--text-muted", "--text-subtle", "--accent-text", "--danger-text"])
      );
      expect(rolesOf(theme, (n) => n.startsWith("--surface-")), theme).toEqual(
        expect.arrayContaining(["--surface-base", "--surface-raised", "--surface-overlay", "--surface-selected"])
      );
    }
    expect(COLOURS.light["--surface-base"]).not.toBe(COLOURS.dark["--surface-base"]);
  });

  it("clear 4.5:1 on every surface of their theme", () => {
    const low: string[] = [];
    for (const theme of THEMES) {
      const surfaces = rolesOf(theme, (n) => n.startsWith("--surface-"));
      for (const text of rolesOf(theme, (n) => isTextRole(n) && !(n in OFF_SURFACE))) {
        for (const surface of surfaces) {
          const ratio = contrastRatio(COLOURS[theme][text], COLOURS[theme][surface]);
          if (ratio < AA_TEXT) low.push(`${theme}: ${text} on ${surface} is ${ratio.toFixed(2)}:1`);
        }
      }
    }
    expect(low).toEqual([]);
  });

  it("leave out only the roles named above, each of which theme.css still defines", () => {
    for (const theme of THEMES) {
      for (const name of Object.keys(OFF_SURFACE)) expect(COLOURS[theme][name], `${theme} ${name}`).toBeDefined();
    }
  });
});

describe("the phone's text", () => {
  it("is painted in text roles, on its own surfaces and in every desktop component they draw", () => {
    const drawn = { ...drawnComponents(companionSources()), "companion/surfaces/phone.css": phoneCss };
    // The walk reaching the desktop at all, or a sweep over nothing passes.
    expect(Object.keys(drawn)).toEqual(
      expect.arrayContaining(["$lib/git/GitFileRow.svelte", "$lib/board/BoardCard.svelte"])
    );
    expect(untextedColours(drawn)).toEqual([]);
  });

  it("is caught when a colour comes from a fill or a literal", () => {
    const style = (css: string) => ({ "X.svelte": `<div></div>\n<style>${css}</style>` });
    expect(untextedColours(style(".a { color: var(--text-muted); }"))).toEqual([]);
    expect(untextedColours(style(".a { color: var(--accent); }"))).toHaveLength(1);
    expect(untextedColours(style(".a { color: #888; }"))).toHaveLength(1);
    expect(untextedColours(style(".a { color: var(--warn-fg, #b8860b); }"))).toHaveLength(1);
    // Through a custom property the component sets: each value it takes.
    expect(untextedColours(style(".a { --tone: var(--accent-text); } .b { color: var(--tone, var(--text)); }"))).toEqual([]);
    expect(untextedColours(style(".a { --tone: var(--accent); } .b { color: var(--tone, var(--text)); }"))).toHaveLength(1);
    // Not a text colour, so not this guard's.
    expect(untextedColours(style(".a { background-color: #888; border-color: var(--accent); }"))).toEqual([]);
  });
});
