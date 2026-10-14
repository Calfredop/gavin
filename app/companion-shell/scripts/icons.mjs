// Draws the shell's app icons and launch images from Gavin's own icon,
// `app/src/lib/ui/appIcon.ts` -- the definition the desktop's icon set
// (`app/src-tauri/icons/render.mjs`) and the hub's live icon also draw
// from -- so the store app carries the desktop's mark rather than
// Capacitor's placeholder (which App Review and Play both reject as
// template metadata).
//
//   node companion-shell/scripts/icons.mjs
//
// Needs `rsvg-convert` and `magick` (brew install librsvg imagemagick),
// and Menlo, the wall's font. The PNGs it writes are committed; run it
// again when appIcon.ts changes.
//
// The icon is a wall of code glyphs with ">G" carved out of it. The
// desktop's is a macOS one: a rounded tile inset on a clear canvas, with
// a drop shadow. A phone draws its own shape, so each platform gets the
// tile's contents instead:
// - iOS: the tile full-bleed and opaque, 1024 square (App Store Connect
//   refuses an icon with an alpha channel). The system rounds it.
// - Android: an adaptive icon. The background layer is the tile's colour;
//   the foreground is the wall, carved, over the whole 108dp layer, with
//   the >G moved to its middle and small enough to sit inside the 66dp
//   safe circle, since a launcher's mask may be a circle. The legacy PNGs
//   (unused from API 26, below this app's minSdk, but still packaged) are
//   the full-bleed tile.
// - Launch images: the rounded tile, small, on the tile's darkest colour.
// - store/play-icon-512.png: Play Console's hi-res icon, full-bleed.
//
// Loads appIcon.ts directly: it imports nothing and uses only erasable
// TypeScript, which Node strips on its own.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ICON_COLOURS, appIconSvg, centredArt, wallLayerSvg } from "../../src/lib/ui/appIcon.ts";

const shell = join(dirname(fileURLToPath(import.meta.url)), "..");
const res = join(shell, "android", "app", "src", "main", "res");
const ios = join(shell, "ios", "App", "App", "Assets.xcassets");

/// The tile's background, halfway down its gradient.
const tileColour = mix(ICON_COLOURS.tileTop, ICON_COLOURS.tileBottom);
/// The launch images' background: the bottom of that gradient.
const launchColour = ICON_COLOURS.tileBottom;

function mix(a, b) {
  const channel = (hex, i) => parseInt(hex.slice(1 + 2 * i, 3 + 2 * i), 16);
  const out = [0, 1, 2].map((i) => Math.round((channel(a, i) + channel(b, i)) / 2));
  return "#" + out.map((v) => v.toString(16).padStart(2, "0")).join("");
}

/// The adaptive foreground's wall. 42 rows puts the >G's diagonal at
/// about 56% of the layer, inside the 66dp circle's 61% with a margin;
/// 70 columns keeps the glyphs' 0.6 aspect on a square layer.
const ADAPTIVE_COLS = 70;
const ADAPTIVE_ROWS = 42;

const work = mkdtempSync(join(tmpdir(), "gavin-icons-"));
function svgFile(name, svg) {
  const path = join(work, name);
  writeFileSync(path, svg);
  return path;
}

function render(svgPath, size, out, { opaque = false, background = null, circle = false } = {}) {
  mkdirSync(dirname(out), { recursive: true });
  const png = join(work, "render.png");
  execFileSync("rsvg-convert", ["-w", String(size), "-h", String(size), "-o", png, svgPath]);
  const args = [png];
  if (background) args.push("-background", background, "-flatten");
  if (circle) {
    args.push(
      "(", "-size", `${size}x${size}`, "xc:none", "-fill", "white",
      "-draw", `circle ${size / 2 - 0.5},${size / 2 - 0.5} ${size / 2 - 0.5},0`, ")",
      "-compose", "DstIn", "-composite",
    );
  }
  if (opaque) args.push("-alpha", "off", `PNG24:${out}`);
  else args.push(`PNG32:${out}`);
  execFileSync("magick", args);
}

/// A launch image: the tile, `share` of the shorter side wide, centred on
/// the launch colour.
function launch(glyphSvg, width, height, share, out) {
  const mark = Math.round(Math.min(width, height) * share);
  const png = join(work, "mark.png");
  execFileSync("rsvg-convert", ["-w", String(mark), "-h", String(mark), "-o", png, glyphSvg]);
  execFileSync("magick", [
    "-size", `${width}x${height}`, `xc:${launchColour}`,
    png, "-gravity", "center", "-composite", "-alpha", "off", `PNG24:${out}`,
  ]);
}

try {
  const tile = svgFile("tile.svg", appIconSvg("square"));
  const foreground = svgFile("foreground.svg", wallLayerSvg(centredArt(ADAPTIVE_COLS, ADAPTIVE_ROWS), 1080));
  // The rounded tile with its rim, for the launch images.
  const mark = svgFile("mark.svg", appIconSvg("tile"));

  render(tile, 1024, join(ios, "AppIcon.appiconset", "AppIcon-512@2x.png"), {
    opaque: true, background: tileColour,
  });
  render(tile, 512, join(shell, "store", "play-icon-512.png"), { opaque: true, background: tileColour });

  const densities = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
  for (const [density, scale] of Object.entries(densities)) {
    const dir = join(res, `mipmap-${density}`);
    render(tile, 48 * scale, join(dir, "ic_launcher.png"), { background: tileColour });
    render(tile, 48 * scale, join(dir, "ic_launcher_round.png"), { background: tileColour, circle: true });
    render(foreground, 108 * scale, join(dir, "ic_launcher_foreground.png"));
  }
  writeFileSync(
    join(res, "values", "ic_launcher_background.xml"),
    `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">${tileColour.toUpperCase()}</color>\n</resources>\n`,
  );

  // Android: the Capacitor splash drawable, per density and orientation.
  const splashes = {
    drawable: [480, 320],
    "drawable-land-mdpi": [480, 320],
    "drawable-land-hdpi": [800, 480],
    "drawable-land-xhdpi": [1280, 720],
    "drawable-land-xxhdpi": [1600, 960],
    "drawable-land-xxxhdpi": [1920, 1280],
    "drawable-port-mdpi": [320, 480],
    "drawable-port-hdpi": [480, 800],
    "drawable-port-xhdpi": [720, 1280],
    "drawable-port-xxhdpi": [960, 1600],
    "drawable-port-xxxhdpi": [1280, 1920],
  };
  for (const [dir, [w, h]] of Object.entries(splashes)) launch(mark, w, h, 0.3, join(res, dir, "splash.png"));

  // iOS: one square image, drawn aspect-fill, so a phone shows only the
  // middle of it: the mark is kept small enough to sit inside that.
  for (const name of ["splash-2732x2732.png", "splash-2732x2732-1.png", "splash-2732x2732-2.png"]) {
    launch(mark, 2732, 2732, 0.14, join(ios, "Splash.imageset", name));
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
