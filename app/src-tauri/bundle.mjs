// `npm run bundle`: `tauri build` with the bundle overlay, `--locked`, and
// the build number stamped in.
//
// A bundle carries two numbers. The VERSION is `version` in
// tauri.conf.json -- the semver a human bumps on purpose, the one a release
// tag has to agree with and the one the updater compares. The BUILD NUMBER
// is which build of the tree this is: the count of commits reachable from
// the one being built (`git rev-list --count HEAD`). That makes it a pure
// function of the commit -- the same commit always builds the same number,
// on any machine -- and it only ever grows along `main`, so two installs of
// the same version still say which one is newer. A counter kept in a file
// would do neither: every session in the shared tree would bump it, and a
// release cut from a tag would not know what it was.
//
// Where the build number goes:
//
// - macOS: CFBundleVersion, through `bundle.macOS.bundleVersion`, beside
//   CFBundleShortVersionString (the version). Finder and the About box read
//   it as "0.1.0 (1234)".
// - Every platform: `GAVIN_BUILD_NUMBER` in the environment of the cargo
//   build Tauri runs, which the app crate compiles in (`option_env!` in
//   updater.rs; build.rs re-runs when it changes) and Settings prints after
//   the version.
// - NOT the Windows file version. Tauri derives that from `version` alone,
//   and the only way in is to make `version` itself `X.Y.Z+N` -- which is
//   then what the updater compares and what the release tag gate reads. A
//   build number that changes which update an install accepts is not worth
//   a field in a file-properties dialog.
//
// It also fixes an ordering trap the old one-line npm script had: npm
// appends whatever follows `npm run bundle --` to the END of the script,
// i.e. after its own `-- --locked`, so a Tauri flag landed on cargo. Here
// arguments before a `--` go to Tauri and arguments after it to cargo, and
// `--locked` is added to cargo's either way.

import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/// The build number for the checkout at `root`: `GAVIN_BUILD_NUMBER` when
/// it is set (a build from a tarball, or one that has to reproduce another
/// machine's number), otherwise the commit count. A shallow clone is
/// refused rather than counted -- its count is the depth it was fetched
/// at, a small number that would look like a very old build.
export function buildNumber(root, env = process.env, git = runGit) {
  const given = env.GAVIN_BUILD_NUMBER?.trim();
  if (given) {
    if (!/^[1-9][0-9]*$/.test(given)) {
      throw new Error(`GAVIN_BUILD_NUMBER must be a positive whole number, not "${given}"`);
    }
    return given;
  }
  if (git(root, ["rev-parse", "--is-shallow-repository"]) === "true") {
    throw new Error(
      "this is a shallow clone, so its commit count is not a build number. " +
        "Fetch the full history (fetch-depth: 0 on actions/checkout) or set GAVIN_BUILD_NUMBER.",
    );
  }
  return git(root, ["rev-list", "--count", "HEAD"]);
}

/// The config overlay that stamps the build number into the bundle.
export function versionOverlay(build) {
  return { bundle: { macOS: { bundleVersion: build } } };
}

/// Tauri's arguments for this bundle: the bundle overlay, the version
/// overlay, then the caller's own Tauri flags (so a `--config` of theirs
/// merges last), then cargo's after `--` with `--locked` among them.
export function tauriArgs(args, build) {
  const split = args.indexOf("--");
  const forTauri = split === -1 ? args : args.slice(0, split);
  const forCargo = split === -1 ? [] : args.slice(split + 1);
  return [
    "build",
    "--config",
    "src-tauri/tauri.bundle.conf.json",
    "--config",
    JSON.stringify(versionOverlay(build)),
    ...forTauri,
    "--",
    ...(forCargo.includes("--locked") ? [] : ["--locked"]),
    ...forCargo,
  ];
}

/// The program Tauri builds the app with when the caller named one
/// (`--runner cargo-xwin`, `-r cargo-xwin`, `--runner=cargo-xwin`), from the
/// Tauri half of the arguments. stage-sidecars.mjs builds the sidecars with
/// the same one, and the CLI does not pass it on to `beforeBuildCommand`
/// itself -- only the target triple -- so main() hands it over as
/// `GAVIN_CARGO_RUNNER`.
export function runnerOf(args) {
  const split = args.indexOf("--");
  const forTauri = split === -1 ? args : args.slice(0, split);
  for (let i = 0; i < forTauri.length; i++) {
    const a = forTauri[i];
    if (a === "--runner" || a === "-r") return forTauri[i + 1];
    if (a.startsWith("--runner=")) return a.slice("--runner=".length);
  }
  return undefined;
}

function runGit(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function main() {
  const here = dirname(fileURLToPath(import.meta.url));
  const app = join(here, "..");
  const version = JSON.parse(readFileSync(join(here, "tauri.conf.json"), "utf8")).version;

  let build;
  try {
    build = buildNumber(app);
  } catch (e) {
    console.error(`bundle: ${e.message}`);
    process.exit(1);
  }
  console.log(`bundle: gavin ${version} (build ${build})`);

  // The CLI's own entry point under this Node, rather than
  // node_modules/.bin/tauri: on Windows that is a .cmd, which only a shell
  // can start, and a shell would re-parse the JSON overlay's quotes.
  const cli = join(app, "node_modules", "@tauri-apps", "cli", "tauri.js");
  const args = process.argv.slice(2);
  const env = { ...process.env, GAVIN_BUILD_NUMBER: build };
  // Always this build's runner or none, never one left in the caller's
  // environment by an earlier build.
  delete env.GAVIN_CARGO_RUNNER;
  const runner = runnerOf(args);
  if (runner) env.GAVIN_CARGO_RUNNER = runner;
  const res = spawnSync(process.execPath, [cli, ...tauriArgs(args, build)], {
    cwd: app,
    stdio: "inherit",
    env,
  });
  if (res.error) {
    console.error(`bundle: could not run the Tauri CLI (${res.error.message})`);
    process.exit(1);
  }
  process.exit(res.status ?? 1);
}

// Only when run as a program. The tests beside this file import the pieces
// above, and importing must not build anything.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
