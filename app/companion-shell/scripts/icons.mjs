// Draws the shell's app icons and launch images from Gavin's own icon,
// `app/src-tauri/icons/icon.svg`, so the store app carries the desktop's
// mark rather than Capacitor's placeholder (which App Review and Play
// both reject as template metadata).
//
//   node companion-shell/scripts/icons.mjs
//
// Needs `rsvg-convert` and `magick` (brew install librsvg imagemagick).
// The PNGs it writes are committed; run it again when icon.svg changes.
//
// The desktop's icon is a macOS one: a rounded tile inset on a clear
// canvas, with a drop shadow. A phone draws its own shape, so each
// platform gets the tile's contents instead:
// - iOS: the tile full-bleed and opaque, 1024 square (App Store Connect
//   refuses an icon with an alpha channel). The system rounds it.
// - Android: an adaptive icon. The background layer is the tile's colour;
//   the foreground is the ">G" glyphs alone, sized to the 66dp safe circle
//   of the 108dp layer, since a launcher's mask may be a circle and would
//   cut the title bar's lights off. The legacy PNGs (unused from API 26,
//   below this app's minSdk, but still packaged) are the full-bleed tile.
// - Launch images: the glyphs on the tile's darkest colour.
// - store/play-icon-512.png: Play Console's hi-res icon, full-bleed.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const shell = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(join(shell, "..", "src-tauri", "icons", "icon.svg"), "utf8");
const res = join(shell, "android", "app", "src", "main", "res");
const ios = join(shell, "ios", "App", "App", "Assets.xcassets");

/// The tile's background, halfway down its gradient (#32323a to #161619).
const tileColour = "#24242a";
/// The launch images' background: the bottom of that gradient.
const launchColour = "#161619";

/// One replacement that must match, so a redrawn icon.svg that no longer
/// has the shape this expects fails here rather than drawing a wrong icon.
function replace(svg, from, to) {
  if (!svg.includes(from)) throw new Error(`icon.svg no longer contains ${JSON.stringify(from)}`);
  return svg.replace(from, to);
}

/// The tile, square and full-bleed: the viewBox cropped to it, the shadow
/// and the rounding gone, and the rounded edge highlight dropped.
function fullBleed(svg) {
  svg = replace(svg, 'viewBox="0 0 1024 1024"', 'viewBox="100 100 824 824"');
  svg = replace(svg, ' filter="url(#dropShadow)"', "");
  svg = svg.replaceAll('rx="184"', 'rx="0"');
  return svg.replace(/\s*<rect x="102" y="102"[^>]*\/>/, "");
}

/// The ">G" glyphs alone on a clear canvas, `box` design units square,
/// centred. The glyphs span x 224..832, y 384..768.
function glyphs(svg, box) {
  const start = svg.indexOf("<!-- pixel-art \">\" chevron");
  const end = svg.lastIndexOf("<rect x=\"102\"");
  if (start < 0 || end < start) throw new Error("icon.svg no longer has the glyphs where expected");
  const [cx, cy] = [528, 576];
  const view = `${cx - box / 2} ${cy - box / 2} ${box} ${box}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${view}">${svg.slice(start, end)}</svg>`;
}

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

/// A launch image: the glyphs, `share` of the shorter side wide, centred
/// on the launch colour.
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
  const tile = svgFile("tile.svg", fullBleed(source));
  // 608 design units of glyph across a 1296-unit layer puts the glyphs'
  // diagonal (about 719 units) inside the 66dp circle of the 108dp layer,
  // with a margin (1176 units would touch it).
  const foreground = svgFile("foreground.svg", glyphs(source, 1296));
  // Tight around the glyphs, for the launch images.
  const mark = svgFile("mark.svg", glyphs(source, 640));

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
