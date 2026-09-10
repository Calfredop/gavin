import { describe, it, expect } from "vitest";

import { xtermTheme } from "$lib/ui/terminalTheme";
import { svelteSources } from "$lib/sources";

// theme.css gives every scroller the app's own grey handle with the two
// STANDARD properties, `scrollbar-color` and `scrollbar-width`, and the
// choice is not a stylistic one. Measured in WKWebView (the engine the
// app actually runs in, and the only one that matters here):
//
//   scroller               overlay mode   legacy mode
//   plain                  0px gutter     17px gutter
//   scrollbar-width: thin  0px gutter     13px gutter
//   ::-webkit-scrollbar
//     { width: 8px }       8px gutter      8px gutter
//
// A custom WebKit scrollbar is never an overlay one. Give it a width and
// the platform's disappearing bar becomes a permanent 8px column, on
// every scroller the rule reaches, for every human without a mouse
// plugged in. The author sees nothing: with a mouse attached macOS is
// already in legacy mode, so the gutter was there anyway.
//
// So the pseudo-element stays available for HIDING a bar -- which is
// what the two tab strips use it for, zero-width beside their
// `scrollbar-width: none`, because an overlay bar would land on the
// active tab's indicator -- and for nothing else. Anything that gives it
// a size is reserving space the standard properties would not have.
//
// This has to read sources rather than the DOM: a component <style> is
// compiled away, and vite hands SSR an empty string for a CSS import
// (`?raw` included -- theme.css itself is unreachable from here, the
// same constraint appHeader.test.ts and chevronSharpening.test.ts work
// around).
const SOURCES = {
  ...svelteSources(),
  ...(import.meta.glob("../../routes/**/*.svelte", { query: "?raw", import: "default", eager: true }) as Record<
    string,
    string
  >),
};

/// Every `::-webkit-scrollbar…{…}` block in a source, as (file, selector,
/// declarations). Crude on purpose: these rules are flat, one level of
/// braces, and a block this test cannot parse is a block worth reading.
function webkitScrollbarRules(): { file: string; selector: string; body: string }[] {
  const found: { file: string; selector: string; body: string }[] = [];
  for (const [file, text] of Object.entries(SOURCES)) {
    const css = text.replace(/\/\*[\s\S]*?\*\//g, "");
    for (const match of css.matchAll(/([^{}]*::-webkit-scrollbar[^{}]*)\{([^{}]*)\}/g)) {
      found.push({ file, selector: match[1].trim(), body: match[2] });
    }
  }
  return found;
}

/// The declarations of one block as a trimmed map.
function declarations(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of body.split(";")) {
    const at = line.indexOf(":");
    if (at === -1) continue;
    out[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return out;
}

describe("custom WebKit scrollbars", () => {
  it("only ever hide a bar, never size one", () => {
    for (const { file, selector, body } of webkitScrollbarRules()) {
      const decls = declarations(body);
      const sizes = [decls.width, decls.height].filter((v) => v !== undefined);
      const hidden = decls.display === "none" || (sizes.length > 0 && sizes.every((v) => /^0(px)?$/.test(v)));
      expect(
        hidden,
        `${file} — \`${selector}\` reserves space (${body.trim()}). A sized ::-webkit-scrollbar turns ` +
          `the platform's overlay bar into a permanent gutter in WKWebView; use scrollbar-width/scrollbar-color.`,
      ).toBe(true);
    }
  });

  it("still covers the two tab strips, whose bars must not reach the indicator", () => {
    const strips = webkitScrollbarRules().filter((rule) => rule.selector.includes(".tab-strip"));
    expect(strips.map((rule) => rule.file).sort()).toEqual(["../../routes/+page.svelte", "Pane.svelte"]);
    for (const { file, body } of strips) {
      const decls = declarations(body);
      expect(decls.width, `${file} — the strip's bar is back`).toBe("0");
      expect(decls.height, `${file} — the strip's bar is back`).toBe("0");
    }
  });
});

// theme.css hides every handle at rest and brings it back under the
// pointer, as two rules on the universal selector -- `scrollbar-color:
// transparent transparent` at zero specificity, then the app's grey on
// `*:hover`. Both halves live on selectors ANY component rule outranks:
// svelte scopes a component's `.foo` with its own hash, so `.foo {
// scrollbar-color: ... }` is 0,2,0 against the hover rule's 0,1,0 and
// pins that scroller's bar to one state for good -- permanently on if
// the colour is opaque, permanently gone if it is not.
//
// Nothing about that is visible: the scroller still scrolls, the suites
// still pass, and the bar simply stops behaving like every other bar in
// the window. So `scrollbar-color` belongs to theme.css alone, and this
// is the rule that says so. A component that genuinely needs its own
// handle colour has to say it there, beside the fade it has to keep.
describe("the pointer-driven fade", () => {
  it("leaves scrollbar-color to theme.css, which no component rule may outrank", () => {
    const offenders: string[] = [];
    for (const [file, text] of Object.entries(SOURCES)) {
      const css = text.replace(/\/\*[\s\S]*?\*\//g, "");
      if (/(^|[;{\s])scrollbar-color\s*:/.test(css)) offenders.push(file);
    }
    expect(
      offenders,
      `${offenders.join(", ")} — a scoped rule beats theme.css's \`*:hover\`, so this scroller's ` +
        `handle is stuck on or stuck off instead of fading with the pointer.`,
    ).toEqual([]);
  });
});

// The terminal's handle is the one theme.css cannot reach with either
// property above: xterm hides the viewport's native bar and draws its own
// in the DOM, colouring it from a <style> block it injects at runtime.
// Left alone that block reads `background: #eeeeee33` -- ITheme.foreground
// at 20%, measured #484848 over the dark background -- so the one scroller
// inside a terminal wore a translucent near-white block while every other
// scroller in the window wore --scrollbar-thumb.
//
// The fix has to be split, and this is the half a suite can hold: colour
// goes through xterm's own ITheme (out-specifying an injected rule that
// also carries :hover and .active is not a fight worth having), while the
// SHAPE stays in theme.css, which insets the slider's paint 3px a side --
// the platform's own inset -- without narrowing the lane it is grabbed by.
//
// Nothing else notices if these three slots go missing. The terminal just
// quietly wears the near-white block again.
describe("the terminal's own scroll handle", () => {
  // theme.css's --scrollbar-thumb per theme, restated: the stylesheet is
  // unreadable from here, and xterm needs a resolved string anyway.
  const THUMB = { dark: "#555", light: "#bbb" } as const;

  for (const theme of ["dark", "light"] as const) {
    it(`wears --scrollbar-thumb on the ${theme} theme, with a step for hover and one for press`, () => {
      const { scrollbarSliderBackground, scrollbarSliderHoverBackground, scrollbarSliderActiveBackground } =
        xtermTheme(theme);

      expect(
        scrollbarSliderBackground,
        `the ${theme} terminal handle is not --scrollbar-thumb — it will not match the app's other scrollers`,
      ).toBe(THUMB[theme]);

      // Without these two the slot still defaults to foreground-at-40%/50%
      // on hover and press, so the handle would flash near-white under the
      // pointer even with the resting colour fixed.
      for (const [name, value] of [
        ["hover", scrollbarSliderHoverBackground],
        ["active", scrollbarSliderActiveBackground],
      ] as const) {
        expect(value, `the ${theme} terminal handle has no ${name} colour — xterm falls back to foreground`).toBeTruthy();
        expect(value, `the ${theme} terminal handle does not react on ${name}`).not.toBe(scrollbarSliderBackground);
      }
    });
  }
});
