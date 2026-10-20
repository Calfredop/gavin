// Draws Gavin's IN-APP MARK -- the wall of code glyphs with ">G" carved
// out -- from `src/lib/ui/appIcon.ts`, in its in-app form (IN_APP_STYLE),
// for the files the app's own pages load. The APP ICON, what the OS shows
// for the application, has its own generators and its own form: see
// `src-tauri/icons/render.mjs`.
//
//   node scripts/in-app-mark.mjs        (from app/)
//
// Writes static/favicon.png. The hub's masthead needs no file: it draws the
// same wall live (LiveAppIcon.svelte). Needs `rsvg-convert` (brew install
// librsvg) and Menlo, the glyphs' font. The output is committed; run it
// again when appIcon.ts changes.
//
// Loads appIcon.ts directly: it imports nothing and uses only erasable
// TypeScript, which Node strips on its own.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { IN_APP_STYLE, appIconSvg } from "../src/lib/ui/appIcon.ts";

const app = join(dirname(fileURLToPath(import.meta.url)), "..");

const work = mkdtempSync(join(tmpdir(), "gavin-mark-"));
try {
  const svg = join(work, "mark.svg");
  writeFileSync(svg, appIconSvg("macos", IN_APP_STYLE));
  execFileSync("rsvg-convert", ["-w", "128", "-h", "128", "-o", join(app, "static", "favicon.png"), svg]);
} finally {
  rmSync(work, { recursive: true, force: true });
}
