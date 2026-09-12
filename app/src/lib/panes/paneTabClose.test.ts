import { describe, it, expect } from "vitest";
import { svelteSources } from "$lib/sources";

// The close box on a pane tab is chrome the label has to share. It
// used to sit in the flex row -- an X slot beside the title, painted
// or not -- so the handle never gave the content its full width. The
// suites cannot see a component <style> (compiled away; vite hands SSR
// an empty string for a CSS import), so this pins the declarations
// themselves: the title fills the handle, the X overlays the handle's
// far right as a solid glyph, and it stays hidden until hover/focus.

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
    expect(hovered.opacity).toBe("1");
    expect(hovered["pointer-events"]).toBe("auto");
  });

  it("overlays the close on the far right of the handle, opaque", () => {
    expect(PANE).toContain('class="tab-title"');
    // A sibling of the title and badges, not nested in the title --
    // otherwise `right: 0` is the label's trailing edge, not the handle's.
    expect(PANE.indexOf('class="close"')).toBeGreaterThan(PANE.indexOf('class="restored-badge"'));

    const title = rule(PANE, ".tab-title");
    expect(title.flex).toBe("1 1 auto");
    expect(title["min-width"]).toBe("0");

    const label = rule(PANE, ".tab-label");
    expect(label.width).toBe("100%");
    expect(label["max-width"]).toBeUndefined();

    expect(rule(PANE, ".tab").position).toBe("relative");
    const close = rule(PANE, ".close");
    expect(close.position).toBe("absolute");
    expect(close.right).toBe("0");
    expect(close.background).toBe("var(--surface-base)");
    expect(close.background).not.toContain("gradient");
    expect(close.background).not.toContain("transparent");
  });
});
