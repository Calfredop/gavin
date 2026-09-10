import { describe, it, expect } from "vitest";

// The window's own three buttons off macOS.
//
// They are drawn in the window's top-LEFT corner, over the sidebar
// (TitleBar.svelte) -- not on the right-hand end of a title bar, which
// is where Windows draws them and which this app has no bar for. The
// header row beside that corner has to leave room for them before
// either has been laid out, so their width is STATED, as
// --window-corner-width in +page.svelte, and measured nowhere. Nothing
// links the statement to the buttons; this is what does.
//
// The rest of what it pins is the handful of choices in this cluster
// that are deliberate and would otherwise read as accidents: the
// reversed order, the glyph that follows the window, and the bar that
// sits low in its box.
//
// Source text rather than rendered DOM, for the reason appHeader.test.ts
// gives: a component <style> is compiled away, and vite hands SSR an
// empty string for a CSS import, so the declarations are only legible
// here.

const CONTROLS = (
  import.meta.glob("./WindowControls.svelte", { query: "?raw", import: "default", eager: true }) as
    Record<string, string>
)["./WindowControls.svelte"];

const PAGE = (
  import.meta.glob("../routes/+page.svelte", { query: "?raw", import: "default", eager: true }) as
    Record<string, string>
)["../routes/+page.svelte"];

/// The declarations of one rule, by exact selector -- the same crude
/// "text between this selector's braces" parse appHeader.test.ts uses,
/// which holds because none of these rules sits inside an at-rule.
function rule(source: string, selector: string): Record<string, string> {
  const style = /<style[^>]*>([\s\S]*)<\/style>/.exec(source);
  const css = (style ? style[1] : source).replace(/\/\*[\s\S]*?\*\//g, "");
  const at = css.indexOf(`${selector} {`);
  if (at === -1) throw new Error(`no rule for ${selector}`);
  const body = css.slice(at + selector.length + 2, css.indexOf("}", at));
  const out: Record<string, string> = {};
  for (const decl of body.split(";")) {
    const colon = decl.indexOf(":");
    if (colon === -1) continue;
    out[decl.slice(0, colon).trim()] = decl.slice(colon + 1).trim();
  }
  return out;
}

/// A px length, or a bare 0 -- which is what a shorthand writes for
/// the sides that have no padding.
function px(value: string): number {
  const n = /^(-?\d+(?:\.\d+)?)(px)?$/.exec(value.trim());
  if (!n || (!n[2] && Number(n[1]) !== 0)) throw new Error(`not a px length: ${value}`);
  return Number(n[1]);
}

/// The non-macOS branch of the template: everything after `{:else}`.
const DEFAULT_BRANCH = CONTROLS.slice(CONTROLS.indexOf("{:else}"));

describe("the window's controls off macOS", () => {
  it("adds up to the corner width the header row leaves room for", () => {
    const strip = rule(CONTROLS, ".default-controls");
    const tile = rule(CONTROLS, ".win-btn");
    const pad = strip.padding.split(/\s+/).map(px); // top right bottom left
    expect(pad).toHaveLength(4);
    const tiles = DEFAULT_BRANCH.match(/class="win-btn/g)?.length ?? 0;
    expect(tiles).toBe(3);
    const total = pad[3] + pad[1] + tiles * px(tile.width) + (tiles - 1) * px(strip.gap);
    expect(`${total}px`).toBe(
      rule(PAGE, ".app.wide-window-controls")["--window-corner-width"]
    );
  });

  it("keeps the tiles smaller than the full-height slabs they replaced", () => {
    const tile = rule(CONTROLS, ".win-btn");
    // The slabs were 40px wide and the full height of the corner, with
    // 14px glyphs. A corner over the sidebar is not a title bar, and
    // these sit beside that sidebar's own icon buttons.
    expect(px(tile.width)).toBeLessThan(40);
    expect(px(tile.height)).toBeLessThan(36);
    for (const size of DEFAULT_BRANCH.match(/size=\{(\d+)\}/g) ?? []) {
      expect(Number(/\d+/.exec(size)![0])).toBeLessThan(14);
    }
  });

  it("puts close first and minimize last -- the reverse of a Windows title bar", () => {
    const close = DEFAULT_BRANCH.indexOf('aria-label="Close"');
    const zoom = DEFAULT_BRANCH.indexOf('aria-label={maximized ? "Restore" : "Maximize"}');
    const minimize = DEFAULT_BRANCH.indexOf('aria-label="Minimize"');
    expect(close).toBeGreaterThan(-1);
    expect(zoom).toBeGreaterThan(close);
    expect(minimize).toBeGreaterThan(zoom);
  });

  it("draws which way the middle button will go, from the window itself", () => {
    // Arrows in once maximized, arrows out while it can still grow.
    expect(DEFAULT_BRANCH).toMatch(/\{#if maximized\}\s*<Minimize2 size=\{12\} \/>/);
    expect(DEFAULT_BRANCH).toMatch(/\{:else\}\s*<Maximize2 size=\{12\} \/>/);
    // Read back off the window rather than flipped on click: a
    // double-click on the drag strip and the OS's own snap gestures
    // maximize it too, and a locally toggled boolean would drift.
    expect(CONTROLS).toContain("isMaximized()");
    expect(CONTROLS).toContain("onResized(() => void readMaximized())");
    expect(DEFAULT_BRANCH).not.toContain("maximized = !maximized");
  });

  it("hangs the minimize bar low in its box, where the window is going", () => {
    const line = /<line x1="(\d+)" y1="(\d+)" x2="(\d+)" y2="(\d+)" \/>/.exec(DEFAULT_BRANCH);
    expect(line).not.toBeNull();
    const [, , y1, , y2] = line!.map(Number);
    // Flat, and below the middle of the 24-unit box lucide's own icons
    // are drawn in -- which is exactly what lucide's Minus is not, and
    // why this glyph is hand-drawn.
    expect(y1).toBe(y2);
    expect(y1).toBeGreaterThan(12);
    expect(DEFAULT_BRANCH).not.toContain("<Minus");
  });
});
