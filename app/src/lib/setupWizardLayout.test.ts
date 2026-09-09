import { describe, it, expect } from "vitest";
import { source } from "./sources";

// The setup wizard's width lives entirely in two <style> blocks and one
// prop, none of which any other suite can see. It used to force a 520px
// minimum inside a modal panel capped at 480px, so the panel scrolled
// sideways on every step -- the complaint this pins closed. The rule now
// is the other way round: the wizard states a preferred width, and the
// panel's cap (wide, but a cap) wins on a narrow window.

/// The declarations of one rule, by exact selector -- the same crude
/// reader homeHubLayout.test.ts uses, for the same reason.
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

const wizard = source("SetupWizard.svelte");
const modal = source("Modal.svelte");

describe("the setup wizard's width", () => {
  it("asks the modal for its wide panel", () => {
    expect(wizard).toMatch(/<Modal\s+wide\b/);
  });

  it("states a preferred width and defers to the panel's cap", () => {
    const r = rule(wizard, ".wizard");
    expect(r["min-width"]).toBe("0");
    expect(r["max-width"]).toBe("100%");
    // The preferred width has to sit inside the wide panel's cap, or the
    // sideways scroll is back the moment the window is wide enough.
    const wideCap = /\.panel\.wide\s*\{[^}]*max-width:\s*min\((\d+)px/.exec(modal);
    expect(wideCap).not.toBeNull();
    expect(parseInt(r.width, 10)).toBeLessThan(parseInt(wideCap![1], 10));
  });

  it("lets the step strip wrap rather than widen the panel", () => {
    expect(rule(wizard, ".steps")["flex-wrap"]).toBe("wrap");
  });
});

describe("the agent step's form row", () => {
  it("gives its controls a preferred width, not a floor", () => {
    const r = rule(source("AgentStep.svelte"), ".row input, .row select");
    expect(r["min-width"]).toBe("0");
    expect(r.flex).toMatch(/^0 1 \d+px$/);
  });
});
