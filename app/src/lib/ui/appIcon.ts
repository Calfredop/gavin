// The app icon: a wall of monospace code glyphs with ">G" carved out of
// it, so the letters are the dark tile showing through.
//
// One definition drawn three ways: as SVG for the icon files (the desktop
// set through `app/src-tauri/icons/render.mjs`, the phone's through
// `companion-shell/scripts/icons.mjs`), and live on a canvas in the app
// hub's masthead (LiveAppIcon.svelte), where the wall moves with what the
// fleet is doing. `appIcon.test.ts` holds the committed icon.svg to this
// module, so the file in the Dock and the one on screen cannot drift.
//
// Imports nothing and uses only erasable TypeScript, so both generator
// scripts load it straight from Node.

export const ICON_COLOURS = {
  /// The wall's glyphs: the light tone on the top half, the deep one below.
  light: "#a8e2ff",
  deep: "#7cc8f2",
  /// The tile, top to bottom of its gradient.
  tileTop: "#0f1c26",
  tileBottom: "#070e13",
  /// The rim: graphite, lit from above.
  rim: ["#6e7077", "#4a4c52", "#2e2f34"],
} as const;

/// Code glyphs the wall is built from.
export const WALL_GLYPHS = "{}();=<>/_.:+-*#$&|!?[]0123456789";

/// The faintest a wall glyph gets; each is between this and fully opaque.
export const WALL_OPACITY_MIN = 0.4;

const SEED = 23;

/// The tile's art, cell for cell: `x` is carved, a space is wall. 40 x 24,
/// because monospace glyphs are about 0.6 as wide as they are tall, so a
/// square tile holds 40 columns to 24 rows with no gaps. The strokes are
/// two to four cells thick so the letters survive the Dock at 32 px.
export const ICON_ART: readonly string[] = [
  "                                        ",
  "                                        ",
  "                                        ",
  "                                        ",
  "                                        ",
  "                                        ",
  "                     xxxxxxxxxxxx       ",
  "   xx              xxxxxxxxxxxxxxxx     ",
  "    xxx           xxxx         xxxx     ",
  "      xxx        xxxx                   ",
  "        xxx      xxx                    ",
  "          xxx    xxx                    ",
  "            xx   xxx       xxxxxxxxx    ",
  "          xxx    xxx       xxxxxxxxx    ",
  "        xxx      xxx            xxxx    ",
  "      xxx        xxxx           xxxx    ",
  "    xxx           xxxx         xxxx     ",
  "   xx              xxxxxxxxxxxxxxxx     ",
  "                     xxxxxxxxxxxx       ",
  "                                        ",
  "                                        ",
  "                                        ",
  "                                        ",
  "                                        ",
];

/// Where the live icon's "waiting on you" cursor sits: just right of the
/// G, on its lower half, in ICON_ART's cells.
export const CURSOR = { col: 37, row: 13, width: 2, height: 5 } as const;

export interface WallCell {
  ch: string;
  fill: string;
  opacity: number;
}

/// A stable pseudo-random value in [0, 1) per (x, y, seed).
export function hash(x: number, y: number, seed: number): number {
  let h = (x * 374761393 + y * 668265263 + seed * 2246822519) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

export function wallFill(row: number, rows: number): string {
  return row < rows * 0.5 ? ICON_COLOURS.light : ICON_COLOURS.deep;
}

/// Every cell of `art`, row-major: a glyph for wall, null for carved.
export function wallCells(art: readonly string[]): (WallCell | null)[] {
  const rows = art.length;
  const out: (WallCell | null)[] = [];
  art.forEach((line, r) => {
    for (let c = 0; c < line.length; c++) {
      if (line[c] !== " ") {
        out.push(null);
        continue;
      }
      out.push({
        ch: WALL_GLYPHS[Math.floor(hash(c, r, SEED) * WALL_GLYPHS.length)],
        fill: wallFill(r, rows),
        opacity: WALL_OPACITY_MIN + (1 - WALL_OPACITY_MIN) * hash(r, c, SEED + 7),
      });
    }
  });
  return out;
}

/// ICON_ART's carving alone, centred in a bigger `cols` x `rows` wall. For
/// a canvas that crops to a shape of its own -- an Android adaptive icon's
/// mask can be a circle -- where the letters must sit well inside.
export function centredArt(cols: number, rows: number): string[] {
  const used = ICON_ART.map((line, r) => ({ line, r })).filter(({ line }) => line.includes("x"));
  const top = used[0].r;
  const bottom = used[used.length - 1].r;
  const left = Math.min(...used.map(({ line }) => line.indexOf("x")));
  const right = Math.max(...used.map(({ line }) => line.lastIndexOf("x")));
  const width = right - left + 1;
  const height = bottom - top + 1;
  if (width > cols || height > rows) throw new Error(`the carving does not fit ${cols} x ${rows}`);
  const x0 = Math.floor((cols - width) / 2);
  const y0 = Math.floor((rows - height) / 2);
  const out: string[] = [];
  for (let r = 0; r < rows; r++) {
    const src = r - y0 + top;
    const slice = src >= top && src <= bottom ? ICON_ART[src].slice(left, right + 1) : "";
    out.push((" ".repeat(x0) + slice.padEnd(width) + " ".repeat(cols)).slice(0, cols));
  }
  return out;
}

/// A glyph's em, as a share of its cell's height.
export const GLYPH_SIZE = 1.02;
export const GLYPH_FONT = "Menlo, 'SF Mono', monospace";
/// From a cell's centre down to the alphabetic baseline, in ems: centres
/// Menlo's symbols in the cell. Explicit rather than
/// `dominant-baseline="central"`, which rsvg -- the renderer that makes the
/// icon files -- ignores.
export const BASELINE_DROP = 0.36;

function escapeGlyph(ch: string): string {
  return ch === "&" ? "&amp;" : ch === "<" ? "&lt;" : ch === ">" ? "&gt;" : ch;
}

/// The wall's glyphs as SVG text, laid over a `side` x `side` square.
export function wallSvg(art: readonly string[], side: number): string {
  const rows = art.length;
  const cols = art[0].length;
  const cellW = side / cols;
  const cellH = side / rows;
  const size = cellH * GLYPH_SIZE;
  const glyphs: string[] = [];
  wallCells(art).forEach((cell, i) => {
    if (!cell) return;
    const x = ((i % cols) + 0.5) * cellW;
    const y = (Math.floor(i / cols) + 0.5) * cellH + size * BASELINE_DROP;
    glyphs.push(
      `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" fill="${cell.fill}" fill-opacity="${cell.opacity.toFixed(2)}">${escapeGlyph(cell.ch)}</text>`
    );
  });
  return (
    `<g font-family="${GLYPH_FONT}" font-weight="700" font-size="${size.toFixed(1)}" ` +
    `text-anchor="middle">\n${glyphs.join("\n")}\n</g>`
  );
}

export type IconFrame =
  /// The macOS icon: an 824 tile inset on a 1024 canvas, rounded, with a
  /// drop shadow and the graphite rim. The source of the desktop icon set.
  | "macos"
  /// The tile alone, square and full-bleed: a phone rounds it itself.
  | "square"
  /// The tile rounded, with its rim but no shadow: a mark to sit on a
  /// launch screen.
  | "tile";

export function appIconSvg(frame: IconFrame = "macos"): string {
  const { tileTop, tileBottom, rim } = ICON_COLOURS;
  const defs =
    `<linearGradient id="tile" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${tileTop}"/><stop offset="1" stop-color="${tileBottom}"/></linearGradient>\n` +
    `<linearGradient id="rim" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${rim[0]}"/><stop offset="0.5" stop-color="${rim[1]}"/><stop offset="1" stop-color="${rim[2]}"/></linearGradient>`;
  const wall = wallSvg(ICON_ART, 824);
  if (frame === "square") {
    return `<svg width="824" height="824" viewBox="0 0 824 824" xmlns="http://www.w3.org/2000/svg">
<defs>
${defs}
</defs>
<rect width="824" height="824" fill="url(#tile)"/>
${wall}
</svg>
`;
  }
  const shadow = frame === "macos";
  return `<svg width="1024" height="1024" viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg">
<!-- Generated by src/lib/ui/appIcon.ts (app/src-tauri/icons/render.mjs). Edit that, not this. -->
<defs>
${defs}
<clipPath id="squircle"><rect x="100" y="100" width="824" height="824" rx="184"/></clipPath>${
    shadow
      ? `\n<filter id="shadow" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="14" stdDeviation="22" flood-color="#000" flood-opacity="0.35"/></filter>`
      : ""
  }
</defs>
<rect x="100" y="100" width="824" height="824" rx="184" fill="url(#tile)"${shadow ? ` filter="url(#shadow)"` : ""}/>
<g clip-path="url(#squircle)"><g transform="translate(100 100)">
${wall}
</g></g>
<!-- The rim covers the glyphs the rounding clips mid-character, which
     otherwise read as a ragged, dithered edge at Dock sizes. -->
<rect x="106" y="106" width="812" height="812" rx="178" fill="none" stroke="url(#rim)" stroke-width="12"/>
</svg>
`;
}

/// The wall alone on a clear square, carved with `art`: an Android
/// adaptive icon's foreground, over a background of the tile's colour.
export function wallLayerSvg(art: readonly string[], side: number): string {
  return `<svg width="${side}" height="${side}" viewBox="0 0 ${side} ${side}" xmlns="http://www.w3.org/2000/svg">
${wallSvg(art, side)}
</svg>
`;
}
