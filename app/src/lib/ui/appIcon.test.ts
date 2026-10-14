import { describe, it, expect } from "vitest";
import {
  CURSOR,
  ICON_ART,
  APP_ICON_STYLE,
  appIconSvg,
  carvedRuns,
  centredArt,
  wallCells,
  wallSvg,
} from "./appIcon";

const COLS = 40;
const ROWS = 24;

function carvedCols(): number[] {
  return ICON_ART.flatMap((line) => [...line].flatMap((ch, c) => (ch === "x" ? [c] : [])));
}

describe("the icon's art", () => {
  it("is a 40 x 24 grid of wall and carving only", () => {
    expect(ICON_ART).toHaveLength(ROWS);
    for (const line of ICON_ART) {
      expect(line).toHaveLength(COLS);
      expect(line).toMatch(/^[ x]+$/);
    }
  });

  it("carves two separate shapes, the > on the left and the G on the right", () => {
    // A column with no carving in any row splits the two glyphs.
    const used = new Set(carvedCols());
    const gaps = [...Array(COLS).keys()].filter((c) => !used.has(c));
    const between = gaps.filter((c) => c > Math.min(...used) && c < Math.max(...used));
    expect(between.length, "the > and the G run into each other").toBeGreaterThan(0);
  });

  it("keeps the carving clear of the tile's rounded corners", () => {
    // 184 of 824 is the corner radius: about five rows and nine columns.
    for (const [r, line] of ICON_ART.entries()) {
      if (r < 5 || r >= ROWS - 5) expect(line.trim(), `row ${r} is in a corner band`).toBe("");
    }
  });
});

describe("the wall", () => {
  it("draws a glyph on every wall cell and nothing on a carved one", () => {
    const cells = wallCells(ICON_ART);
    expect(cells).toHaveLength(COLS * ROWS);
    cells.forEach((cell, i) => {
      const carved = ICON_ART[Math.floor(i / COLS)][i % COLS] === "x";
      expect(cell === null, `cell ${i}`).toBe(carved);
    });
  });

  it("is the same wall every time, so the icon files are reproducible", () => {
    expect(wallCells(ICON_ART)).toEqual(wallCells(ICON_ART));
    expect(appIconSvg()).toBe(appIconSvg());
  });

  it("escapes the glyphs that would break the SVG", () => {
    const svg = wallSvg(ICON_ART, 824);
    expect(svg).not.toMatch(/>[<>&]<\/text>/);
  });
});

describe("the waiting cursor", () => {
  it("sits on wall, right of the G, inside the tile", () => {
    const cells = wallCells(ICON_ART);
    for (let r = CURSOR.row; r < CURSOR.row + CURSOR.height; r++) {
      for (let c = CURSOR.col; c < CURSOR.col + CURSOR.width; c++) {
        expect(cells[r * COLS + c], `cursor cell ${c},${r} is carved`).not.toBeNull();
      }
    }
    expect(CURSOR.col).toBeGreaterThan(Math.max(...carvedCols()));
    expect(CURSOR.col + CURSOR.width).toBeLessThanOrEqual(COLS);
    expect(CURSOR.row + CURSOR.height).toBeLessThanOrEqual(ROWS - 5);
  });
});

describe("centredArt", () => {
  it("moves the whole carving into a bigger wall, centred", () => {
    const art = centredArt(70, 42);
    expect(art).toHaveLength(42);
    for (const line of art) expect(line).toHaveLength(70);
    const count = (lines: readonly string[]) => lines.join("").split("x").length - 1;
    expect(count(art)).toBe(count(ICON_ART));
    const cols = art.flatMap((line) => [...line].flatMap((ch, c) => (ch === "x" ? [c] : [])));
    const left = Math.min(...cols);
    const right = 69 - Math.max(...cols);
    expect(Math.abs(left - right)).toBeLessThanOrEqual(1);
  });

  it("refuses a wall too small to hold it", () => {
    expect(() => centredArt(20, 10)).toThrow();
  });
});

describe("the app icon's solid form", () => {
  it("cuts out exactly the carved cells, as runs that never overlap", () => {
    const cut = new Set<string>();
    for (const { row, col, length } of carvedRuns(ICON_ART)) {
      for (let c = col; c < col + length; c++) {
        expect(cut.has(`${c},${row}`), `cell ${c},${row} cut twice`).toBe(false);
        cut.add(`${c},${row}`);
      }
    }
    const carved = ICON_ART.flatMap((line, r) => [...line].flatMap((ch, c) => (ch === "x" ? [`${c},${r}`] : [])));
    expect([...cut].sort()).toEqual(carved.sort());
  });
});

describe("the committed app icon", () => {
  // icon.svg is what render.mjs turned into every PNG, ICNS and ICO the
  // app ships. If it differs from appIcon.ts, the Dock shows an icon this
  // module no longer draws; rerun `node src-tauri/icons/render.mjs`.
  it("is exactly the app-icon form appIcon.ts draws", () => {
    const sources = import.meta.glob("../../../src-tauri/icons/icon.svg", {
      query: "?raw",
      import: "default",
      eager: true,
    }) as Record<string, string>;
    const svg = Object.values(sources)[0];
    expect(svg, "icon.svg did not load -- the glob path is wrong").toBeTruthy();
    expect(svg).toBe(appIconSvg("macos", APP_ICON_STYLE));
  });
});
