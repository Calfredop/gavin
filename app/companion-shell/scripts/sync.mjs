// Puts the web layers into the native projects: the hub into the shell's
// own webview (`cap sync`), and the Workstation UI bundles this binary
// carries into the folders the bundle webview serves from.
//
//   node companion-shell/scripts/sync.mjs [ios|android] [--probe] [--release]
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
//
// The dev bundle-signing key's PUBLIC half goes the same way (ADR 0005,
// story 80): a debug build of the shell trusts bundles the dev desktop
// signed, and this is how it learns the key. `stage-companion.mjs` makes
// the key under gavin's data directory the first time a desktop build
// needs it; this embeds its public half -- on Android in the `debug`
// source set, which a release build cannot carry, and on iOS under
// `Bundles/`, where a sync with `--release` leaves it out and the native
// side reads it only in a DEBUG build. Never the seed.
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { devKeyPath } from "../../src-tauri/stage-companion.mjs";

const shell = join(dirname(fileURLToPath(import.meta.url)), "..");
const demo = join(shell, "..", "companion", "build");
const probe = join(shell, "probe");

const args = process.argv.slice(2);
const withProbe = args.includes("--probe");
const release = args.includes("--release");
const platforms = args.filter((a) => a === "ios" || a === "android");
const targets = platforms.length > 0 ? platforms : ["ios", "android"];

/// `{ publicKey }` of the dev key, or null when this machine has made none
/// (no desktop build has run here yet) or the sync is for a release.
function devKeyFile() {
  if (release) return null;
  const path = devKeyPath();
  if (!existsSync(path)) {
    console.warn(`no dev bundle key at ${path}: a debug build will trust only the publisher key until a desktop build makes one`);
    return null;
  }
  const { publicKey } = JSON.parse(readFileSync(path, "utf8"));
  return typeof publicKey === "string" ? JSON.stringify({ publicKey }) : null;
}

/// Writes the dev key's public half to `to`, or removes what an earlier
/// sync put there.
function placeDevKey(to) {
  const contents = devKeyFile();
  rmSync(to, { force: true });
  if (contents) {
    mkdirSync(dirname(to), { recursive: true });
    writeFileSync(to, `${contents}\n`);
  }
  return Boolean(contents);
}

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
  let devKey;
  if (platform === "ios") {
    const bundles = join(shell, "ios", "App", "App", "Bundles");
    place(demo, join(bundles, "demo"));
    if (withProbe) place(probe, join(bundles, "probe"));
    else rmSync(join(bundles, "probe"), { recursive: true, force: true });
    devKey = placeDevKey(join(bundles, "dev-bundle-key.json"));
  } else {
    place(demo, join(shell, "android", "app", "src", "main", "assets", "bundles", "demo"));
    place(probe, join(shell, "android", "app", "src", "debug", "assets", "bundles", "probe"));
    devKey = placeDevKey(join(shell, "android", "app", "src", "debug", "assets", "dev-bundle-key.json"));
  }
  console.log(
    `embedded the Demo Workstation's bundle${withProbe || platform === "android" ? " and the probe" : ""}${devKey ? " and the dev key's public half" : ""} for ${platform}`
  );
}
