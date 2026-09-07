import { describe, it, expect } from "vitest";
import { fitWorthTaking } from "./terminalFit";

describe("fitWorthTaking", () => {
  it("takes an ordinary pane's measurement", () => {
    expect(fitWorthTaking(800, 400)).toBe(true);
    expect(fitWorthTaking(120, 30)).toBe(true);
  });

  it("refuses a collapsed box, which is what FitAddon answers with a floor for", () => {
    // The measured case: 800x0 proposes 100 columns by ONE row, and
    // fitting to it reflows a live agent's screen into a single row.
    expect(fitWorthTaking(800, 0)).toBe(false);
    expect(fitWorthTaking(0, 400)).toBe(false);
    expect(fitWorthTaking(0, 0)).toBe(false);
  });

  it("refuses a measurement that is not a number at all", () => {
    // A `display: none` ancestor makes the computed height "auto", which
    // is where FitAddon's own NaN check comes from. Negative widths are
    // not reachable through clientWidth, but a guard that believed one
    // would pass the floor straight through.
    for (const bad of [NaN, Infinity, -Infinity, -1]) {
      expect(fitWorthTaking(bad, 400)).toBe(false);
      expect(fitWorthTaking(800, bad)).toBe(false);
    }
  });

  it("still takes a pane the human really has dragged down to one row", () => {
    // The guard is about zero, not about smallness: a 20px-tall pane IS
    // one row, and telling the daemon so is correct.
    expect(fitWorthTaking(800, 20)).toBe(true);
  });
});

// TerminalPane is the single seam every refit passes through -- its own
// effects, Pane's ResizeObserver, MainAgentPanel and HomeHubView all call
// the same exported fit(). The guard therefore has to sit INSIDE that
// function and BEFORE fitAddon.fit(), because the reflow happens inside
// fit() rather than in the resizeSession call after it. Neither the
// ordering nor "there is only one fit() call site" is expressible in the
// type system, and no suite renders this component, so both are pinned
// against the source the way terminalPaneSession.test.ts pins its own
// contract.
const SOURCES = import.meta.glob("./*.svelte", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

/// The source with its comments removed. Load-bearing, not tidiness: the
/// guard is explained in a comment that names both `fitWorthTaking` and
/// `fitAddon.fit()`, so a test that searched the raw text would find the
/// prose instead of the code and pass (or fail) on the wrong thing.
function code(source: string): string {
  return source.replace(/<!--[\s\S]*?-->/g, "").replace(/\/\/[^\n]*/g, "");
}

describe("TerminalPane's refit is guarded", () => {
  const source = code(SOURCES["./TerminalPane.svelte"] ?? "");

  it("has a source to read", () => {
    expect(source).toBeTruthy();
  });

  it("calls fitAddon.fit() exactly once, and only from the exported fit()", () => {
    const calls = [...source.matchAll(/fitAddon\.fit\(\)/g)];
    expect(calls).toHaveLength(1);
    const declaration = source.indexOf("export function fit(");
    expect(declaration).toBeGreaterThanOrEqual(0);
    expect(calls[0].index).toBeGreaterThan(declaration);
  });

  it("checks the measurement before fitting to it", () => {
    const guard = source.indexOf("fitWorthTaking(");
    const fitCall = source.indexOf("fitAddon.fit()");
    expect(guard).toBeGreaterThanOrEqual(0);
    expect(guard).toBeLessThan(fitCall);
  });

  it("measures the mount point, not the terminal it is about to resize", () => {
    // FitAddon measures the registry container's parent -- this mount
    // point -- so asking the terminal for its size instead would read
    // the geometry left over from the last good fit and never notice the
    // collapse.
    expect(source).toMatch(/fitWorthTaking\(\s*mountPoint\.clientWidth,\s*mountPoint\.clientHeight\s*\)/);
  });
});
