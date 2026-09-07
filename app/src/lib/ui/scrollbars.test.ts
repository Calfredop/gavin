import { describe, it, expect } from "vitest";

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
  ...(import.meta.glob("../**/*.svelte", { query: "?raw", import: "default", eager: true }) as Record<
    string,
    string
  >),
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
    expect(strips.map((rule) => rule.file).sort()).toEqual(["../../routes/+page.svelte", "../Pane.svelte"]);
    for (const { file, body } of strips) {
      const decls = declarations(body);
      expect(decls.width, `${file} — the strip's bar is back`).toBe("0");
      expect(decls.height, `${file} — the strip's bar is back`).toBe("0");
    }
  });
});
