// Build the Companion UI bundle, sign it, and stage it for the desktop
// host to embed (ADR 0005, companion-23).
//
//   node src-tauri/stage-companion.mjs [--release] [--no-build]
//
// The desktop app ships the UI a Device runs to work on it, built from
// the same commit, and serves it over the encrypted channel; the shell
// runs only a bundle whose signature checks against a key it pins. So a
// desktop build is not complete until the bundle is built, packed,
// signed and staged where `build.rs` embeds it:
//
//   src-tauri/companion/bundle.tar    the archive (companion-bundle.mjs)
//   src-tauri/companion/bundle.json   its manifest: hash, size, signature
//
// Both are build outputs, never committed. `build.rs` embeds them when
// they are there and embeds nothing when they are not -- a plain `cargo
// test --workspace` on a clean checkout must keep building -- so a desktop
// that skipped this step carries no bundle and says so to a Device.
//
// Two keys, and which one signs is the whole difference between a store
// build and a dev build of the Companion:
//
// - **The publisher key**, whose seed is `GAVIN_BUNDLE_SIGNING_KEY` (64
//   hex characters). The release workflow holds it as a secret and its
//   preflight checks the public half against the one the shell pins
//   (`app/companion-shell/src/shell/bundle/publisherKey.ts`). Separate
//   from the updater's minisign key on purpose: the updater key signs
//   what an install will run as itself, this one signs what a phone will
//   run next to its keys, and a leak of either should not be a leak of
//   both.
// - **A dev key**, made on this machine the first time it is needed and
//   kept under gavin's data directory (`companion-dev-bundle-key.json`,
//   beside the daemon's databases, the same directory the daemon
//   resolves -- so every worktree on this machine signs with one key).
//   A debug build of the shell trusts it (`scripts/sync.mjs` embeds its
//   public half); a store build does not, and refuses a bundle it signed.
//
// `--release` asks for the publisher key and, absent it, signs with the
// dev key and says so -- the right default for `npm run bundle` on a
// laptop, and exactly the wrong one for a release, which is why the
// release workflow's preflight refuses to start without the secret.
//
// Node's `crypto` and nothing else, for the reason stage-sidecars.mjs
// gives beside it: this runs through `cmd /C` on Windows, and a
// dependency here is a dependency of every desktop build.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, posix, win32 } from "node:path";
import { fileURLToPath } from "node:url";

import { generateSeed, pack, publicKeyOf, readTree, sha256, sign } from "./companion-bundle.mjs";

/// Where gavin keeps its data on this OS: the rule `protocol::
/// resolve_app_support_dir` spells out, mirrored here because a Node
/// script cannot ask it. macOS deliberately ignores XDG.
export function dataDir(env = process.env, platform = process.platform) {
  const { join } = pathsOf(platform);
  if (platform === "darwin") return join(env.HOME ?? homedir(), "Library", "Application Support", "gavin");
  if (platform === "win32") {
    const base = env.LOCALAPPDATA ?? join(env.USERPROFILE ?? homedir(), "AppData", "Local");
    return join(base, "gavin");
  }
  return join(env.XDG_DATA_HOME ?? join(env.HOME ?? homedir(), ".local", "share"), "gavin");
}

/// `platform`'s own path rules, not the host's: asked about one OS from
/// another, the answer is still that OS's path.
function pathsOf(platform) {
  return platform === "win32" ? win32 : posix;
}

export const DEV_KEY_FILE = "companion-dev-bundle-key.json";

/// The dev key's file, or where it would be. `GAVIN_DEV_BUNDLE_KEY_FILE`
/// overrides it, for a test or a second machine's key.
export function devKeyPath(env = process.env, platform = process.platform) {
  return env.GAVIN_DEV_BUNDLE_KEY_FILE ?? pathsOf(platform).join(dataDir(env, platform), DEV_KEY_FILE);
}

/// The dev key, made if there is none: `{ seed, publicKey, madeAt }`.
/// The file is the seed, so it is written for the owner alone.
export function loadOrMakeDevKey(path) {
  if (existsSync(path)) {
    const key = JSON.parse(readFileSync(path, "utf8"));
    if (typeof key.seed !== "string" || publicKeyOf(key.seed) !== key.publicKey) {
      throw new Error(`${path} is not a dev bundle key this script wrote; move it aside to make a new one`);
    }
    return { ...key, made: false };
  }
  const seed = generateSeed();
  const key = { seed, publicKey: publicKeyOf(seed), madeAt: new Date().toISOString() };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(key, null, 2)}\n`, { mode: 0o600 });
  return { ...key, made: true };
}

/// Which seed signs, and what to say about it.
export function chooseKey({ release, env, devKey }) {
  const publisher = env.GAVIN_BUNDLE_SIGNING_KEY;
  if (publisher) return { seed: publisher, kind: "publisher" };
  if (release) {
    return {
      seed: devKey().seed,
      kind: "dev",
      warning: "GAVIN_BUNDLE_SIGNING_KEY is not set: the Companion bundle is signed with the DEV key, and a store build of the Companion will refuse it",
    };
  }
  return { seed: devKey().seed, kind: "dev" };
}

/// Packs and signs `buildDir` into `outDir`. Returns the manifest.
export function stage({ buildDir, outDir, seed, gavinVersion }) {
  const files = readTree(buildDir);
  if (!files.some((f) => f.path === "index.html")) {
    throw new Error(`${buildDir} holds no index.html: the Companion bundle is not built`);
  }
  const archive = pack(files);
  const manifest = sign(archive, seed, gavinVersion);
  mkdirSync(outDir, { recursive: true });
  // Written beside and moved into place, so a build that reads the two
  // files never sees a manifest for one archive next to another.
  const tar = join(outDir, "bundle.tar");
  const json = join(outDir, "bundle.json");
  writeFileSync(`${tar}.tmp`, archive);
  writeFileSync(`${json}.tmp`, `${JSON.stringify(manifest, null, 2)}\n`);
  renameSync(`${tar}.tmp`, tar);
  renameSync(`${json}.tmp`, json);
  return { manifest, files: files.length, sha256: sha256(archive).toString("hex") };
}

const here = dirname(fileURLToPath(import.meta.url));

function main() {
  const args = process.argv.slice(2);
  const release = args.includes("--release");
  const build = !args.includes("--no-build");
  const app = join(here, "..");
  const version = JSON.parse(readFileSync(join(here, "tauri.conf.json"), "utf8")).version;

  if (build) {
    const npm = process.platform === "win32" ? "npm.cmd" : "npm";
    execFileSync(npm, ["run", "companion:build"], { cwd: app, stdio: "inherit", shell: process.platform === "win32" });
  }

  const key = chooseKey({
    release,
    env: process.env,
    devKey: () => {
      const made = loadOrMakeDevKey(devKeyPath());
      if (made.made) console.log(`stage-companion: made a dev bundle key at ${devKeyPath()} (public ${made.publicKey})`);
      return made;
    },
  });
  if (key.warning) console.warn(`stage-companion: ${key.warning}`);

  const { manifest, files } = stage({
    buildDir: join(app, "companion", "build"),
    outDir: join(here, "companion"),
    seed: key.seed,
    gavinVersion: version,
  });
  console.log(
    `stage-companion: staged the Companion bundle (${files} files, ${manifest.size} bytes, sha256 ${manifest.hash.slice(0, 12)}…) signed by the ${key.kind} key ${manifest.signer.slice(0, 12)}…`
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main();
  } catch (e) {
    console.error(`stage-companion: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
