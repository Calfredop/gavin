import { describe, it, expect } from "vitest";
import { DEFAULT_AGENT_SHARE, DIVIDER_PX, homeGridColumns } from "$lib/hub/homeSplit";
import { svelteSources } from "$lib/sources";

// Three facts about the home tab that live entirely in its markup and
// its <style> block, and that no other suite can see: a component's CSS
// is compiled away, and vite hands SSR an empty string for a CSS import.
//
// Each of them was a complaint. The Board panel took a third of the side
// column to draw one wrapped row of counts. The PRD excerpt was clipped
// with `overflow: hidden`, so whatever did not fit was simply gone. And
// the agent/summaries split was a fixed `3fr 2fr` nobody could move.
// Pinning them here is what keeps a later tidy-up from quietly undoing
// any of the three.

const SOURCES = svelteSources();

function source(name: string): string {
  const text = SOURCES[name];
  if (!text) throw new Error(`no source for ${name}`);
  return text;
}

/// The declarations of one rule, by exact selector. Crude by design --
/// this component has no at-rules around the panels, so "the text
/// between this selector's braces" is the rule.
function rule(componentSource: string, selector: string): Record<string, string> {
  const style = /<style[^>]*>([\s\S]*)<\/style>/.exec(componentSource);
  if (!style) throw new Error("component has no <style> block");
  const css = style[1].replace(/\/\*[\s\S]*?\*\//g, "");
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

const home = source("HomeHubView.svelte");

describe("the home tab's board recap", () => {
  it("is sized to its chips, not to a share of the column", () => {
    // `1 1 0` is what the other panels take, and what this one used to:
    // a third of the side column for one wrapped row of counts.
    expect(rule(home, ".board-panel").flex).toBe("0 1 auto");
  });

  it("caps itself so a wide board scrolls instead of squeezing the rest", () => {
    expect(rule(home, ".board-panel")["max-height"]).toBe("30%");
    const columns = rule(home, ".columns");
    expect(columns["overflow-y"]).toBe("auto");
    // A flex child only scrolls once it is allowed to be shorter than
    // its own content.
    expect(columns["min-height"]).toBe("0");
  });
});

describe("the home tab's PRD excerpt", () => {
  it("scrolls rather than clipping what does not fit", () => {
    const excerpt = rule(home, ".excerpt");
    expect(excerpt["overflow-y"]).toBe("auto");
    expect(excerpt.overflow).toBeUndefined();
    expect(excerpt["min-height"]).toBe("0");
    expect(excerpt["align-self"]).toBe("stretch");
  });

  it("holds enough of the PRD to be worth scrolling", () => {
    const lines = /const EXCERPT_LINES = (\d+);/.exec(home);
    expect(lines).not.toBeNull();
    expect(Number(lines?.[1])).toBeGreaterThan(50);
  });
});

describe("the home tab's agent divider", () => {
  it("takes its columns from the stored share, not a fixed ratio", () => {
    expect(home).toContain("style:grid-template-columns={homeGridColumns(share)}");
    expect(rule(home, ".grid")["grid-template-columns"]).toBeUndefined();
    // The gutter the grid used to hold IS the divider now; a column gap
    // as well would double the space between the two cells.
    expect(rule(home, ".grid").gap).toBeUndefined();
  });

  it("still opens on the split the tab shipped with", () => {
    expect(homeGridColumns(DEFAULT_AGENT_SHARE)).toBe(`0.6fr ${DIVIDER_PX}px 0.4fr`);
  });

  it("is draggable and resets on a double-click", () => {
    expect(home).toContain("onpointerdown={startDrag}");
    expect(home).toContain("ondblclick={resetSplit}");
    expect(rule(home, ".divider").cursor).toBe("col-resize");
  });

  it("refits the terminal from the agent's own cell", () => {
    // Observing the row instead would miss every drag: the row is
    // exactly as wide before and after, only its two cells change.
    expect(home).toContain("observer.observe(agentEl)");
  });

  it("lets the summaries column shrink with the divider", () => {
    // A grid item is min-width:auto by default, so without this the
    // column's own content becomes a floor the divider cannot cross.
    expect(rule(home, ".side")["min-width"]).toBe("0");
  });
});
