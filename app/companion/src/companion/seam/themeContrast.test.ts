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
  inklessFills,
  isOnFillRole,
  isTextRole,
  themeColours,
  untextedColours,
  type Theme,
} from "$companion/testing/textColours";
import { allSources } from "$lib/sources";
import phoneCss from "$companion/surfaces/phone.css?raw";
import themeCss from "$lib/ui/theme.css?raw";

/// WCAG 2 AA, text under 18px (14px bold).
const AA_TEXT = 4.5;

/// The coloured fills text is drawn on: a filled button, a badge, a
/// checkbox tick. Each takes its own ink, `--on-<fill>`.
const FILLS = ["--accent", "--success", "--warning", "--danger"];

/// Inks under 4.5:1 on their fill today, each waiting on the owner's
/// choice between darker fills under white and a dark ink on the fills as
/// they are (the Decision on theme-text-on-fills-and-literal-colours-
/// contrast.md). Whichever lands clears these, and the test below fails
/// until the entry goes with it.
const PENDING_FILL_DECISION = [
  "dark: --on-accent on --accent",
  "dark: --on-success on --success",
  "dark: --on-danger on --danger",
  "light: --on-accent on --accent",
];

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
      for (const text of rolesOf(theme, isTextRole)) {
        for (const surface of surfaces) {
          const ratio = contrastRatio(COLOURS[theme][text], COLOURS[theme][surface]);
          if (ratio < AA_TEXT) low.push(`${theme}: ${text} on ${surface} is ${ratio.toFixed(2)}:1`);
        }
      }
    }
    expect(low).toEqual([]);
  });

});

describe("theme.css's inks on the coloured fills", () => {
  const pairs = (theme: Theme) =>
    FILLS.map((fill) => {
      const ink = `--on-${fill.slice(2)}`;
      return { name: `${theme}: ${ink} on ${fill}`, ratio: contrastRatio(COLOURS[theme][ink], COLOURS[theme][fill]) };
    });

  it("are one per fill, in both themes, and nothing else is named as an ink", () => {
    for (const theme of THEMES) {
      expect(rolesOf(theme, isOnFillRole), theme).toEqual(FILLS.map((f) => `--on-${f.slice(2)}`).sort());
      for (const fill of FILLS) expect(COLOURS[theme][fill], `${theme} ${fill}`).toBeDefined();
    }
  });

  it("clear 4.5:1 on their fill", () => {
    const low = THEMES.flatMap(pairs).filter((p) => p.ratio < AA_TEXT && !PENDING_FILL_DECISION.includes(p.name));
    expect(low.map((p) => `${p.name} is ${p.ratio.toFixed(2)}:1`)).toEqual([]);
  });

  it("leave pending only pairs that still fall short", () => {
    const passing = THEMES.flatMap(pairs).filter((p) => p.ratio >= AA_TEXT).map((p) => p.name);
    expect(PENDING_FILL_DECISION.filter((name) => passing.includes(name))).toEqual([]);
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
    expect(inklessFills(drawn, FILLS)).toEqual([]);
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
    expect(untextedColours(style(".a { background: var(--accent); color: var(--on-accent); }"))).toEqual([]);
  });

  it("is caught when it sits on a fill in anything but that fill's ink", () => {
    const style = (css: string) => ({ "X.svelte": `<div></div>\n<style>${css}</style>` });
    expect(inklessFills(style(".a { background: var(--accent); color: var(--on-accent); }"), FILLS)).toEqual([]);
    expect(inklessFills(style(".a { background: var(--accent); color: var(--text); }"), FILLS)).toEqual(["X.svelte: .a"]);
    expect(inklessFills(style(".a { background-color: var(--warning); color: var(--on-accent); }"), FILLS)).toHaveLength(1);
    // A fill with no text colour of its own: a bar, an LED.
    expect(inklessFills(style(".a { background: var(--success); }"), FILLS)).toEqual([]);
    // A tint is a surface, not a fill.
    expect(inklessFills(style(".a { background: var(--surface-accent); color: var(--accent-text); }"), FILLS)).toEqual([]);
  });
});

/// Text the desktop paints outside the text roles on purpose, with why.
/// Each entry is a `file: color: value` the sweep below would otherwise
/// report.
const PLATFORM_COLOURS: Record<string, string> = {
  "WindowControls.svelte: color: rgba(0, 0, 0, 0.5)":
    "the glyphs on macOS's traffic lights, drawn as the platform draws them on its own fixed fills",
  "WindowControls.svelte: color: #fff":
    "Windows' close button, white on its own fixed red (#e81123), 4.63:1 -- measured below",
};

describe("the desktop's text", () => {
  // The Companion suite is the one that can read theme.css as text, so
  // the desktop's half of the rule is held here too: every component
  // under $lib, not only the ones a phone draws.
  const desktop = Object.fromEntries(Object.entries(allSources()).filter(([path]) => path.endsWith(".svelte")));

  it("is painted in text roles, in every $lib component", () => {
    // A sweep over nothing passes.
    expect(Object.keys(desktop).length).toBeGreaterThan(100);
    const found = untextedColours(desktop);
    expect(found.filter((line) => !(line in PLATFORM_COLOURS))).toEqual([]);
  });

  it("sits on a coloured fill only in that fill's ink, in every $lib component", () => {
    expect(inklessFills(desktop, FILLS)).toEqual([]);
  });

  it("leaves out only the platform colours named above, each still drawn", () => {
    expect(untextedColours(desktop)).toEqual(expect.arrayContaining(Object.keys(PLATFORM_COLOURS)));
    expect(contrastRatio("#fff", "#e81123")).toBeGreaterThan(AA_TEXT);
  });
});
