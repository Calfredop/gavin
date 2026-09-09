import { describe, it, expect } from "vitest";
import { svelteSources } from "$lib/sources";

// Two CSS contracts the Review tab depends on, neither of which any
// other suite can see: a component <style> is compiled away, vite hands
// SSR an empty string for a CSS import, and nothing in this project
// renders. Both were owner reports before they were tests.
//
// 1. TEXT COLOUR. Nothing in the app sets a root one -- theme.css
//    defines the tier-2 tokens, two base rules and the scrollbars, and
//    stops -- and no stylesheet declares `color-scheme`, so an element
//    with no `color` of its own inherits the user agent's black. On this
//    ground that is a card title at about 1.1:1. Every other component
//    pays for it by naming its own (BoardCard sets `color: var(--text)`
//    on `.card` for exactly this reason); four rules in this tab did
//    not, and the card list rendered invisible. So each of the four
//    components names it on its own root, rather than one of them
//    naming it for all four: they are separate components, and a pane
//    that only looks right inside one particular parent is the same bug
//    one level up.
//
// 2. HEADER HEIGHT. The tab draws each of its two header rows TWICE --
//    the card list's search row beside the panes' strip, its column
//    picker beside the three column heads -- and nothing links the
//    halves. Measured in WKWebView at the app's real 13px root size, the
//    four column heads came to 20px, 20px, 26px (the one holding the
//    diff/edit group) and 23px, so the rules under them landed at three
//    different y across one window. Worse, every head was `padding: 0
//    8px 6px` -- no top padding at all -- which left the 19px switch
//    with zero pixels above it, sitting on the column's top border.
//    28px is what that switch needs to sit in with 4px above and below.

const SOURCES = svelteSources();

function source(name: string): string {
  const text = SOURCES[name];
  if (!text) throw new Error(`no source for ${name}`);
  return text;
}

/// The declarations of one rule, by exact selector, as a trimmed map.
/// Crude by design, exactly as appHeader.test.ts's is: none of these
/// rules sits inside a nested at-rule, so "the text between this
/// selector's braces" is the rule.
function rule(componentSource: string, selector: string): Record<string, string> {
  const style = /<style[^>]*>([\s\S]*)<\/style>/.exec(componentSource);
  const css = (style ? style[1] : componentSource).replace(/\/\*[\s\S]*?\*\//g, "");
  const found = new Map<string, string>();
  for (const [, prelude, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    found.set(prelude.trim().replace(/\s+/g, " "), body);
  }
  const body = found.get(selector);
  if (body === undefined) {
    throw new Error(`no rule for "${selector}" (saw: ${[...found.keys()].join(", ")})`);
  }
  const out: Record<string, string> = {};
  for (const decl of body.split(";")) {
    const at = decl.indexOf(":");
    if (at < 0) continue;
    out[decl.slice(0, at).trim()] = decl.slice(at + 1).trim();
  }
  return out;
}

const HUB = source("ReviewHubView.svelte");
const LIST = source("ReviewCardList.svelte");
const AGENT = source("ReviewAgentPane.svelte");
const FILE = source("ReviewFilePane.svelte");

/// Every root that has to carry its own text colour: each component's
/// outermost element, plus the collapsed rail, which replaces the card
/// list entirely rather than sitting inside it.
const ROOTS: [string, string, string][] = [
  ["ReviewHubView", HUB, ".review"],
  ["ReviewCardList", LIST, ".list"],
  ["ReviewCardList (collapsed)", LIST, ".rail"],
  ["ReviewAgentPane", AGENT, ".agent"],
  ["ReviewFilePane", FILE, ".file-pane"],
];

/// The four heads of the column row, and which property each pins its
/// height with. The card list's picker uses `min-height` because the
/// picker expands inside it -- a fixed height would clip the checkboxes
/// -- and that is the one difference the row is allowed.
const COLUMN_HEADS: [string, string, string, string][] = [
  ["ReviewAgentPane", AGENT, ".head", "height"],
  ["ReviewHubView (touched files)", HUB, ".head", "height"],
  ["ReviewFilePane", FILE, ".head", "height"],
  ["ReviewCardList (column picker)", LIST, ".columns", "min-height"],
];

/// The two heads of the row above it: the strip over the three columns,
/// and the card list's search row, which has no strip over it and so IS
/// the tab's first row on that side.
const STRIP_HEADS: [string, string, string][] = [
  ["ReviewHubView", HUB, ".strip"],
  ["ReviewCardList", LIST, ".head"],
];

describe("the Review tab's text colour", () => {
  it("is named on every component root, never inherited", () => {
    for (const [name, text, selector] of ROOTS) {
      expect(`${name}: ${rule(text, selector).color}`).toBe(`${name}: var(--text)`);
    }
  });
});

describe("the Review tab's header rows", () => {
  it("defines both metrics once, on the tab's own root", () => {
    const review = rule(HUB, ".review");
    expect(review["--review-strip-height"]).toBe("28px");
    expect(review["--review-head-height"]).toBe("28px");
  });

  it("sizes all four column heads from the metric, never a literal", () => {
    for (const [name, text, selector, property] of COLUMN_HEADS) {
      const head = rule(text, selector);
      expect(`${name}: ${head[property]}`).toBe(`${name}: var(--review-head-height)`);
      // Without this the border and the padding are added to the height
      // rather than contained by it, and the four heads part company
      // again by however much their borders differ.
      expect(`${name}: ${head["box-sizing"]}`).toBe(`${name}: border-box`);
    }
  });

  it("sizes both first-row heads from the other metric", () => {
    for (const [name, text, selector] of STRIP_HEADS) {
      const head = rule(text, selector);
      expect(`${name}: ${head.height}`).toBe(`${name}: var(--review-strip-height)`);
      expect(`${name}: ${head["box-sizing"]}`).toBe(`${name}: border-box`);
    }
  });

  it("keeps no bottom padding in a head, which is what glued the switch to the border", () => {
    // A head's content is centred in a fixed height now. A three- or
    // four-value `padding` shorthand is the shape the bug had: it pushed
    // the content up against the top edge and left the switch touching
    // the border above it.
    for (const [name, text, selector] of [
      ...COLUMN_HEADS.map(([n, t, s]) => [n, t, s] as [string, string, string]),
      ...STRIP_HEADS,
    ]) {
      const padding = rule(text, selector).padding ?? "";
      expect(`${name}: ${padding.split(/\s+/).filter(Boolean).length}`).toBe(`${name}: 2`);
    }
  });

  it("centres every head's content on the cross axis", () => {
    for (const [name, text, selector] of COLUMN_HEADS.map(
      ([n, t, s]) => [n, t, s] as [string, string, string]
    )) {
      const head = rule(text, selector);
      // The picker column is a flex COLUMN (the toggle, then the
      // expanded checkboxes), so it centres on the main axis instead.
      const centred = head["align-items"] === "center" || head["justify-content"] === "center";
      expect(`${name}: ${centred}`).toBe(`${name}: true`);
    }
    for (const [name, text, selector] of STRIP_HEADS) {
      expect(`${name}: ${rule(text, selector)["align-items"]}`).toBe(`${name}: center`);
    }
  });
});
