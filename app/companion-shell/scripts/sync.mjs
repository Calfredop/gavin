// Puts the web layers into the native projects: the hub into the shell's
// own webview (`cap sync`), and the Workstation UI bundles this binary
// carries into the folders the bundle webview serves from.
//
//   node companion-shell/scripts/sync.mjs [ios|android] [--probe]
//
// Run after `npm run companion:build` and `npm run companion-shell:build`
// (`npm run companion-shell:sync` does all three). The embedded copies are
// build outputs and are not committed.
//
// The Demo Workstation's bundle goes into every build: it is the one App
// Review explores (ADR 0005). The probe bundle is a debug build's only.
// On Android that is the `debug` source set, so a release build cannot
// carry it. On iOS resources have no per-configuration folder, so the
// probe is embedded only when asked for (`--probe`, which scripts/probe.sh
// passes) and removed by every sync without it -- and the native side
// refuses to open it outside a DEBUG build either way.
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const shell = join(dirname(fileURLToPath(import.meta.url)), "..");
const demo = join(shell, "..", "companion", "build");
const probe = join(shell, "probe");

const args = process.argv.slice(2);
const withProbe = args.includes("--probe");
const platforms = args.filter((a) => a === "ios" || a === "android");
const targets = platforms.length > 0 ? platforms : ["ios", "android"];

for (const [what, file, fix] of [
  ["the Companion web bundle", join(demo, "index.html"), "npm run companion:build"],
  ["the hub", join(shell, "build", "index.html"), "npm run companion-shell:build"],
]) {
  if (!existsSync(file)) {
    console.error(`${what} is not built (${file} is missing). Run \`${fix}\` in app/ first.`);
    process.exit(1);
  }
}

/// Replaces `to` with a copy of `from`.
function place(from, to) {
  rmSync(to, { recursive: true, force: true });
  mkdirSync(dirname(to), { recursive: true });
  cpSync(from, to, { recursive: true });
}

for (const platform of targets) {
  execFileSync("npx", ["cap", "sync", platform], { cwd: shell, stdio: "inherit" });
  if (platform === "ios") {
    const bundles = join(shell, "ios", "App", "App", "Bundles");
    place(demo, join(bundles, "demo"));
    if (withProbe) place(probe, join(bundles, "probe"));
    else rmSync(join(bundles, "probe"), { recursive: true, force: true });
  } else {
    place(demo, join(shell, "android", "app", "src", "main", "assets", "bundles", "demo"));
    place(probe, join(shell, "android", "app", "src", "debug", "assets", "bundles", "probe"));
  }
  console.log(`embedded the Demo Workstation's bundle${withProbe || platform === "android" ? " and the probe" : ""} for ${platform}`);
}
