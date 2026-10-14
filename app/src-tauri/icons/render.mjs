// Draws the desktop app's icon set from `src/lib/ui/appIcon.ts`, the one
// definition the live icon on the app hub also draws from.
//
//   node src-tauri/icons/render.mjs        (from app/)
//
// Writes icon.svg, renders it to a 1024 PNG with rsvg-convert, hands that
// to `tauri icon` for every size and format the bundles take (PNG, ICNS,
// ICO, the Windows Store tiles), and redraws the web favicon. Needs
// `rsvg-convert` (brew install librsvg) and Menlo, the glyphs' font.
// The outputs are committed; run it again when appIcon.ts changes --
// appIcon.test.ts fails until icon.svg matches. The phone's icons are
// drawn separately, by companion-shell/scripts/icons.mjs.
//
// Loads appIcon.ts directly: it imports nothing and uses only erasable
// TypeScript, which Node strips on its own.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { appIconSvg } from "../../src/lib/ui/appIcon.ts";

const icons = dirname(fileURLToPath(import.meta.url));
const app = join(icons, "..", "..");

const svgPath = join(icons, "icon.svg");
writeFileSync(svgPath, appIconSvg("macos"));

const work = mkdtempSync(join(tmpdir(), "gavin-icon-"));
try {
  const png = join(work, "icon.png");
  execFileSync("rsvg-convert", ["-w", "1024", "-h", "1024", "-o", png, svgPath]);
  execFileSync("npx", ["tauri", "icon", png, "--output", icons], { cwd: app, stdio: "inherit" });
  execFileSync("rsvg-convert", ["-w", "128", "-h", "128", "-o", join(app, "static", "favicon.png"), svgPath]);
} finally {
  rmSync(work, { recursive: true, force: true });
}
