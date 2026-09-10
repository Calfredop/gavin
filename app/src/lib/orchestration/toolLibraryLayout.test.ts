import { describe, it, expect } from "vitest";
import { svelteSources } from "$lib/sources";

// The tool library and its tool-creation form are two modes of ONE modal,
// and both scrolled sideways. Modal's panel caps at 480px of content box
// unless the child asks for `wide`, and ToolLibraryDialog's body asked for
// 620px. A panel with `overflow-y: auto` and no `overflow-x` of its own
// computes `overflow-x` to `auto` as well, so the width it could not fit
// came back as a horizontal scrollbar under the whole dialog rather than
// as content laid out to the width it was given.
//
// Two halves to the fix, and a browser is the only thing that can see
// either, so this pins the declarations themselves. Measured in a
// WKWebView probe at four window widths, before -> after:
//
//   900px  panel 660/520  -> 868/868
//   700px  panel 586/520, body 558/546 -> 684/684
//   520px  body 558/406   -> 518/518
//   420px  body 558/328   -> 418/418
//
//   1. The panel must be allowed to hold the body (`wide`), and the body
//      must cap against the PANEL (`max-width: 100%`) rather than against
//      the viewport (`78vw`) -- a viewport unit is measured on a box the
//      panel has already narrowed, so it still overruns on a small window.
//   2. Nothing inside the body may set a floor the body cannot go under.
//      A text control's automatic minimum is its `size`/`cols` intrinsic
//      width, and that alone held the body at 558px at EVERY window width
//      above (the 406 and 328 columns are the panel, shrinking past it);
//      the chip rows are the same shape of problem one line down.

const SVELTE = svelteSources();

function source(name: string): string {
  const text = SVELTE[name];
  if (!text) throw new Error(`no source for ${name}`);
  return text;
}

/// The declaration block of one CSS rule, by selector, from a component's
/// `<style>`. Whitespace-collapsed, so a reformat does not fail the suite.
function ruleFor(file: string, selector: string): string {
  const text = source(file);
  const at = text.indexOf(`\n  ${selector} {`);
  if (at === -1) throw new Error(`no \`${selector}\` rule in ${file}`);
  const open = text.indexOf("{", at);
  const close = text.indexOf("}", open);
  return text.slice(open + 1, close).replace(/\s+/g, " ").trim();
}

/// The first `<px>` in a declaration, e.g. `max-width: min(880px, 92vw)`
/// -> 880. Throws rather than returning a default: a rule that stopped
/// carrying a pixel width is a change this test must fail on, not skip.
function pxOf(rule: string, property: string): number {
  const found = new RegExp(`${property}:[^;]*?(\\d+)px`).exec(rule);
  if (!found) throw new Error(`no px \`${property}\` in \`${rule}\``);
  return Number(found[1]);
}

const DIALOG = "ToolLibraryDialog.svelte";
const MODAL = "Modal.svelte";

describe("the tool library modal", () => {
  it("asks the panel for the width its body is drawn at", () => {
    // `wide` is opt-in precisely because the cap lives on .panel, which is
    // scoped to Modal: a child wider than the cap does not widen the panel,
    // it overflows the one it is inside.
    expect(source(DIALOG)).toMatch(/<Modal\b[^>]*\bwide\b/s);
  });

  it("draws a body the wide panel can actually hold", () => {
    const body = ruleFor(DIALOG, ".body");
    const cap = pxOf(ruleFor(MODAL, ".panel.wide"), "max-width");
    // The comparison, not two hardcoded numbers: widening either one
    // without the other is the regression, and only one of the two
    // files is the one anybody would think to edit.
    expect(pxOf(body, "width")).toBeLessThanOrEqual(cap);
  });

  it("caps its body against the panel, never against the viewport", () => {
    const body = ruleFor(DIALOG, ".body");
    expect(body).toContain("max-width: 100%");
    // `78vw` is a viewport fraction applied to a box the panel has
    // already capped -- it reads as a safety net and is not one.
    expect(body).not.toMatch(/max-width:[^;]*vw/);
    expect(body).toContain("min-width: 0");
  });

  it("lets its text controls shrink with the form", () => {
    // Without this the parameter grid's three `1fr` tracks floor at the
    // inputs' intrinsic `size` width -- 558px measured -- and push the
    // overflow one level in, which looks identical to the bug it replaced.
    expect(ruleFor(DIALOG, "input,\n  textarea")).toContain("min-width: 0");
  });

  it("reflows its chip rows rather than letting them set the floor", () => {
    expect(ruleFor(DIALOG, ".chips")).toContain("flex-wrap: wrap");
    expect(ruleFor(DIALOG, ".row")).toContain("flex-wrap: wrap");
  });

  it("keeps the rows that hold a name shrinkable", () => {
    // A tool's name and description are the only unbounded strings in the
    // list, and they ellipsize -- a long one must not widen the dialog.
    for (const selector of [".name", ".desc"]) {
      const rule = ruleFor(DIALOG, selector);
      expect(rule).toContain("min-width: 0");
      expect(rule).toContain("text-overflow: ellipsis");
    }
  });
});
