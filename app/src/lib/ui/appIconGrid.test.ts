import { describe, it, expect } from "vitest";

// The app icon's ">" and "G" are 8-bit glyphs: axis-aligned rects on a
// 32px cell grid over a 1024px canvas. That style only survives export
// if every edge lands on a whole output pixel. Every size tauri emits
// divides 1024 by a power of two (1024 -> 512 -> 256 -> 128 -> 64 -> 32),
// so a coordinate that is a multiple of 32 is exact at all of them and
// one that is not is antialiased across two rows at all of them.
//
// That failure is invisible to every other check: the SVG is valid, the
// build succeeds, and the icon looks approximately right -- it is just
// soft. It shipped that way, with all of `x`, `w` and `h` on the grid
// and every `y` at 26 (mod 32), which is why the glyphs' vertical edges
// were razor sharp while every step of the staircase was a gradient.
//
// The traffic lights are deliberately NOT checked: they are drawn as
// crossed rects on a finer sub-grid (20/36px) to read as octagons, so
// they answer to a different rule than the glyphs do.
const CELL = 32;

// Anchored on the source comments, NOT on the fill: the green traffic
// light is also #8bc98b, so selecting the chevron by colour picks up the
// window chrome instead and quietly checks the wrong shape.
const GLYPHS = {
  "the > chevron": '<!-- pixel-art ">" chevron',
  "the G": '<!-- pixel-art "G"',
} as const;

/// Every `<rect>` in the `<g>` that follows each glyph's comment.
function glyphRects(): { glyph: string; rect: string; x: number; y: number; w: number; h: number }[] {
  const sources = import.meta.glob("../../../src-tauri/icons/icon.svg", {
    query: "?raw",
    import: "default",
    eager: true,
  }) as Record<string, string>;
  const svg = Object.values(sources)[0];
  expect(svg, "icon.svg did not load -- the glob path is wrong").toBeTruthy();

  const out: { glyph: string; rect: string; x: number; y: number; w: number; h: number }[] = [];
  for (const [glyph, marker] of Object.entries(GLYPHS)) {
    const at = svg.indexOf(marker);
    expect(at, `no "${marker}" comment -- ${glyph} was renamed or redrawn`).toBeGreaterThan(-1);
    const group = svg.slice(at).match(/<g fill="[^"]*">([\s\S]*?)<\/g>/);
    expect(group, `no <g> after the ${glyph} comment`).toBeTruthy();
    for (const m of group![1].matchAll(/<rect x="(\d+)" y="(\d+)" width="(\d+)" height="(\d+)"\s*\/>/g)) {
      const [x, y, w, h] = m.slice(1, 5).map(Number);
      out.push({ glyph, rect: m[0], x, y, w, h });
    }
  }
  return out;
}

describe("app icon pixel grid", () => {
  it("every glyph rect lands on the 32px cell grid", () => {
    const rects = glyphRects();
    expect(rects.length, "found no glyph rects -- the parse is looking in the wrong place").toBeGreaterThan(0);

    const offGrid = rects.flatMap(({ glyph, rect, x, y, w, h }) =>
      Object.entries({ x, y, width: w, height: h })
        .filter(([, v]) => v % CELL !== 0)
        .map(([edge, v]) => `${glyph}: ${edge}=${v} is ${v % CELL} past a cell boundary  (${rect})`),
    );

    expect(offGrid, `${offGrid.length} glyph edge(s) fall mid-pixel and will export blurred`).toEqual([]);
  });

  it("the two glyphs share one baseline and one cap height", () => {
    const rects = glyphRects();
    const box = (glyph: string) => {
      const own = rects.filter((r) => r.glyph === glyph);
      return { top: Math.min(...own.map((r) => r.y)), bottom: Math.max(...own.map((r) => r.y + r.h)) };
    };
    // A grid fix applied to one glyph and not the other would leave them
    // sitting on different baselines -- crisp, and visibly misaligned.
    expect(box("the > chevron")).toEqual(box("the G"));
  });
});
