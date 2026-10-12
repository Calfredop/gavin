import { describe, it, expect } from "vitest";
import { source } from "$lib/sources";

// xterm measures a cell by appending a span of 32 "W"s to its helpers and
// reading the span's size. Up to 6.0 its own xterm.css put that span out of
// sight -- `visibility: hidden`, `left: -9999em` -- and pinned its
// `line-height` to `normal`. The 6.1 beta line dropped the rule from the
// stylesheet without styling the span any other way, so every terminal drew
// a row of black W's over its top-left corner, and the measured cell height
// followed whatever line-height the app happens to inherit.
//
// TerminalPane carries the rule itself now, so it no longer depends on which
// xterm happens to be installed. Pinned here because nothing else would
// notice it going: the suites never render a terminal.

/// The declarations of the TerminalPane rule that targets the measure span.
function measureRule(): string {
  const css = source("TerminalPane.svelte").split("<style>")[1] ?? "";
  const match = /[^{}]*:global\(\.xterm-char-measure-element\)[^{]*\{([^}]*)\}/.exec(css);
  return match?.[1] ?? "";
}

describe("xterm's font-measure span", () => {
  it("is styled by TerminalPane, not left to xterm.css", () => {
    expect(measureRule()).not.toBe("");
  });

  it("is out of sight", () => {
    const rule = measureRule();
    expect(rule).toMatch(/visibility:\s*hidden/);
    expect(rule).toMatch(/position:\s*absolute/);
    expect(rule).toMatch(/left:\s*-9999em/);
  });

  it("measures at a normal line-height, as xterm 6.0's own rule did", () => {
    expect(measureRule()).toMatch(/line-height:\s*normal/);
  });
});
