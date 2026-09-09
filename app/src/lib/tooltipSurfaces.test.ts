import { describe, it, expect } from "vitest";
import { source, svelteSources } from "./sources";

// The app has one tooltip: the `use:tooltip` action in tooltip.ts, which
// mounts ONE bubble on <body>, positions it `fixed`, and flips it below
// the host when the viewport would clip it.
//
// Pane.svelte had a second one -- a `Tooltip.svelte` wrapper that drew
// the bubble as an absolutely positioned CHILD of the tab, anchored
// `bottom: 100%`. Inside a tab bar that is the top strip of a pane, and
// which carries `overflow-x: auto` (so its overflow-y computes to `auto`
// too, not `visible`), that bubble had nowhere to go: hovering a tab --
// including an agent tab named after the card it is running -- showed
// hover text sliced off at the tab bar's top edge, while the git and
// status badges sitting two pixels away, which go through the action,
// drew theirs correctly outside the strip.
//
// A bubble parented to its host can always be clipped by an ancestor's
// overflow, and nothing in the component that draws it can see that
// ancestor. So the rule is mechanical rather than stylistic: hover text
// goes through the action, never through a component-local element.
//
// This reads the committed source. Vite hands SSR an empty string for a
// CSS import and a scoped <style> block is never a module at all, so the
// rule can only be seen as text -- the same tactic as
// indicatorSurfaces.test.ts and globalStyleScope.test.ts.

/// The route components, re-keyed by bare file name so they sit beside
/// the seam's entries in one map. `../routes` is outside lib and the
/// reorganization does not move it, so the glob stays here.
function routeSources(): Record<string, string> {
  const raw = import.meta.glob("../routes/**/*.svelte", {
    query: "?raw",
    import: "default",
    eager: true,
  }) as Record<string, string>;
  return Object.fromEntries(
    Object.entries(raw).map(([path, text]) => [path.slice(path.lastIndexOf("/") + 1), text]),
  );
}

const SOURCES = { ...svelteSources(), ...routeSources() };

/// Selector + declaration block pairs from a component's `<style>`.
/// Deliberately crude: the text before each `{` is the selector list.
function rules(text: string): { selector: string; block: string }[] {
  const style = text.match(/<style[^>]*>([\s\S]*)<\/style>/);
  if (!style) return [];
  // Comments first: this file's own explanations mention tooltips, and a
  // comment sitting above a rule would otherwise ride along in its
  // selector and match.
  const css = style[1].replace(/\/\*[\s\S]*?\*\//g, " ");
  const out: { selector: string; block: string }[] = [];
  for (const m of css.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
    out.push({ selector: m[1].trim().replace(/\s+/g, " "), block: m[2] });
  }
  return out;
}

/// A hover bubble drawn inside its own host: a class that calls itself a
/// tooltip, taken out of flow. `position: fixed` is not this -- that is
/// what the shared action does, and it escapes every ancestor.
function localTooltipBubbles(text: string): string[] {
  return rules(text)
    .filter(({ selector, block }) => /tooltip|bubble/i.test(selector) && /position:\s*absolute/.test(block))
    .map(({ selector }) => selector);
}

describe("one tooltip mechanism", () => {
  it("leaves no component drawing its own hover bubble", () => {
    for (const [file, text] of Object.entries(SOURCES)) {
      const found = localTooltipBubbles(text);
      expect(
        found,
        `${file} draws its own tooltip bubble (${found.join(", ")}); an ancestor's overflow can clip it -- use \`use:tooltip\` from lib/tooltip.ts, which mounts on <body> and flips when the viewport would cut it`
      ).toEqual([]);
    }
  });

  it("gives the tab bar's hover text the shared action", () => {
    const pane = source("Pane.svelte");
    expect(pane).toMatch(/import \{ tooltip \} from "\.\/tooltip"/);
    expect(pane, "the tab label's hover text must go through use:tooltip").toMatch(
      /class="tab-label"[\s\S]{0,200}use:tooltip|use:tooltip[\s\S]{0,200}class="tab-label"/
    );
    expect(pane, "no component-local tooltip wrapper is left in the tab bar").not.toMatch(/<Tooltip\b/);
  });
});
