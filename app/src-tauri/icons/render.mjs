// Draws the desktop APP ICON -- the Dock, the taskbar, Finder -- from
// `src/lib/ui/appIcon.ts`, in its app-icon form (APP_ICON_STYLE, a solid
// face with the >G cut through) at every size. The in-app mark, the code wall, has its own
// generator: `scripts/in-app-mark.mjs`.
//
//   node src-tauri/icons/render.mjs        (from app/)
//
// Writes icon.svg, renders it to a 1024 PNG with rsvg-convert, and hands
// that to `tauri icon` for every size and format the bundles take (PNG,
// ICNS, ICO, the Windows Store tiles, the mobile sets). One form at every
// size on purpose: the dev build gives macOS a single image at launch,
// which the Dock scales down from its largest layer, so a per-size icon
// does not reach it.
//
// Needs `rsvg-convert` (brew install librsvg). The outputs are committed;
// run it again when appIcon.ts changes -- appIcon.test.ts fails until
// icon.svg matches. A running dev app shows the new icon only once it is
// rebuilt and relaunched: the icon is compiled into the binary. The
// phone's app icon is drawn by companion-shell/scripts/icons.mjs.
//
// Loads appIcon.ts directly: it imports nothing and uses only erasable
// TypeScript, which Node strips on its own.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { APP_ICON_STYLE, appIconSvg } from "../../src/lib/ui/appIcon.ts";

const icons = dirname(fileURLToPath(import.meta.url));
const app = join(icons, "..", "..");

const svgPath = join(icons, "icon.svg");
writeFileSync(svgPath, appIconSvg("macos", APP_ICON_STYLE));

const work = mkdtempSync(join(tmpdir(), "gavin-icon-"));
try {
  const png = join(work, "icon.png");
  execFileSync("rsvg-convert", ["-w", "1024", "-h", "1024", "-o", png, svgPath]);
  execFileSync("npx", ["tauri", "icon", png, "--output", icons], { cwd: app, stdio: "inherit" });
} finally {
  rmSync(work, { recursive: true, force: true });
}
