import { describe, it, expect } from "vitest";
import { source } from "$lib/sources";

// The Tools explorer shipped with invented tokens (`--bg`, `--panel`) and
// a dark-only textarea fallback (`#111`), which made prompt text vanish
// in light theme and left buttons relying on `color: inherit` against
// surfaces that never set --text. Pin the real theme.css roles.

const EXPLORER = "ToolsExplorerView.svelte";

describe("ToolsExplorerView theming", () => {
  it("uses theme.css surface/text roles, not invented tokens", () => {
    const css = source(EXPLORER);
    expect(css).toContain("var(--surface-base)");
    expect(css).toContain("var(--surface-sunken)");
    expect(css).toContain("var(--text)");
    expect(css).toContain("var(--text-muted)");
    expect(css).not.toMatch(/var\(--bg\b/);
    expect(css).not.toMatch(/var\(--panel\b/);
    expect(css).not.toMatch(/var\(--bg-elevated\b/);
    expect(css).not.toContain("#111");
  });

  it("sets button and textarea color explicitly", () => {
    const css = source(EXPLORER);
    // Buttons do not reliably inherit color; the list rows and the prompt
    // body both need --text named, or WKWebView paints system-black on a
    // dark surface.
    expect(css).toMatch(/\.row\s*\{[^}]*color:\s*var\(--text\)/s);
    expect(css).toMatch(/\.body\s*\{[^}]*color:\s*var\(--text\)/s);
    expect(css).toMatch(/\.body\s*\{[^}]*background:\s*var\(--surface-sunken\)/s);
  });
});
