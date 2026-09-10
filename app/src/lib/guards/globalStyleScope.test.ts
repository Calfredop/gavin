import { describe, it, expect } from "vitest";
import { source, svelteSources } from "$lib/sources";

/// The route components, re-keyed by bare file name so they sit beside
/// the seam's entries in one map. `../routes` is outside lib and the
/// reorganization does not move it, so the glob stays here.
function routeSources(): Record<string, string> {
  const raw = import.meta.glob("../../routes/**/*.svelte", {
    query: "?raw",
    import: "default",
    eager: true,
  }) as Record<string, string>;
  return Object.fromEntries(
    Object.entries(raw).map(([path, text]) => [path.slice(path.lastIndexOf("/") + 1), text]),
  );
}

// A `:global(...)` at the START of a selector is not a component rule at
// all -- it is an app-wide rule that happens to live in a component's
// `<style>`. Svelte gives no warning for it, and nothing in the app links
// the two ends: the class it names may be the private class of some
// component the author never opened.
//
// That is not hypothetical. `PlanTree.svelte` styled the little "open
// beside a terminal" button it hands IconButton with
//
//     :global(.split) { margin-left: auto; opacity: 0 }
//
// -- correct-looking, because the class rides on IconButton's own element
// and only :global can reach it. But it also matched LayoutTree's split
// CONTAINER, the box every pane of a split page lives in, and drew it at
// opacity 0. A page with a split (or a board tab, which opens one) then
// rendered nothing: right geometry, right tab bars, all invisible, with
// only the sidebar and title bar left on screen. Every suite stayed green,
// because the rule and its victim never meet in any one file.
//
// So the rule this pins is: reach out of a component only on purpose.
// Anchor the selector to one of the component's own (scoped) classes --
// `.file-row :global(.split)` -- and the escape is confined to the subtree
// that meant it. The deliberate app-wide resets are listed below by hand,
// which is the point: adding one is an edit a reviewer sees.
const ALLOWED: Record<string, string[]> = {
  // xterm builds its own DOM inside the pane, so its selectors can only be
  // global; the app-wide `user-select: none` is what they opt back out of.
  "TerminalPane.svelte": [":global(.xterm)", ":global(.xterm *)"],
  // The two app-level resets: window chrome is not selectable, real text
  // input is.
  "+page.svelte": [
    ":global(html, body)",
    ':global(input, textarea, [contenteditable]:not([contenteditable="false"]))',
  ],
};

/// Splits a selector list on its TOP-LEVEL commas only -- `:global(html,
/// body)` and `:not(a, b)` are one selector each, not two.
function splitSelectorList(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of list) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      out.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  out.push(current);
  return out.map((s) => s.trim().replace(/\s+/g, " ")).filter((s) => s.length > 0);
}

/// Every selector in a component's `<style>` block that begins with
/// `:global(`. Deliberately crude: the text before each `{` in a style
/// block is either a selector list or an at-rule prelude, and at-rules
/// start with `@`.
function leadingGlobals(source: string): string[] {
  const style = /<style[^>]*>([\s\S]*)<\/style>/.exec(source);
  if (!style) return [];
  const css = style[1].replace(/\/\*[\s\S]*?\*\//g, "");
  const found: string[] = [];
  for (const [, prelude] of css.matchAll(/([^{}]+)\{/g)) {
    const text = prelude.trim();
    if (text.startsWith("@")) continue;
    for (const selector of splitSelectorList(text)) {
      if (selector.startsWith(":global(")) found.push(selector);
    }
  }
  return found;
}

describe("component styles do not leak app-wide", () => {
  it("starts no selector with :global() outside the listed resets", () => {
    const sources = { ...svelteSources(), ...routeSources() };

    expect(Object.keys(sources).length).toBeGreaterThan(20);

    const offenders: string[] = [];
    for (const [name, text] of Object.entries(sources)) {
      const allowed = ALLOWED[name] ?? [];
      for (const selector of leadingGlobals(text)) {
        if (allowed.includes(selector)) continue;
        offenders.push(`${name}: ${selector}`);
      }
    }

    // Named in the failure, not just counted: the whole trap is that the
    // rule and the element it breaks live in different files.
    expect(offenders).toEqual([]);
  });

  it("reads the selectors it is meant to be reading", () => {
    // A silent parse failure would make the check above pass for every
    // file, so pin one selector this suite must be able to see.
    const planTree = source("PlanTree.svelte");
    expect(planTree).toBeTruthy();
    expect(planTree).toContain(".file-row :global(.split)");
    expect(leadingGlobals(planTree)).toEqual([]);
  });
});
