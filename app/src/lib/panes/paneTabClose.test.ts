import { describe, it, expect } from "vitest";
import { svelteSources } from "$lib/sources";

// The close box on a pane tab is chrome the label has to share. It
// used to stay painted at rest, so every idle tab carried an X. The
// suites cannot see a component <style> (compiled away; vite hands SSR
// an empty string for a CSS import), so this pins the declarations
// themselves: hidden until the tab is hovered or focused, space still
// reserved so hover never reflows the strip.

const SOURCES = svelteSources();

function source(name: string): string {
  const text = SOURCES[name];
  if (!text) throw new Error(`no source for ${name}`);
  return text;
}

/// The declarations of one rule, by exact selector, as a trimmed map.
/// Crude by design -- none of these rules sits inside a nested at-rule.
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

const PANE = source("Pane.svelte");

describe("the pane tab close box", () => {
  it("stays in the tab handle and is hidden until the tab is hovered", () => {
    expect(PANE).toContain('class="close"');
    expect(PANE).toContain('aria-label="Close Tab"');

    const rest = rule(PANE, ".close");
    expect(rest.opacity).toBe("0");
    expect(rest["pointer-events"]).toBe("none");

    const hovered = rule(PANE, ".tab:hover .close, .tab:focus-within .close");
    expect(Number(hovered.opacity)).toBeGreaterThan(0);
    expect(hovered["pointer-events"]).toBe("auto");
  });
});
