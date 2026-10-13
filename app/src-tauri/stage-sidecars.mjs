// Build gavin-daemon and gavin-mcp and put them where Tauri's
// `bundle.externalBin` expects to find them.
//
// The two binaries have to ship INSIDE the bundle:
// `resolve_daemon_binary_path` and `resolve_mcp_binary_path` both join
// against `current_exe().parent()`, and the absolute gavin-mcp path gavin
// writes into a workspace's agent config has to keep resolving after an
// update. `externalBin` is what puts them there -- and it looks for each
// source file with the host target triple appended (before the extension),
// stripping it again when it bundles. So the build cannot just leave them
// in `target/<profile>/`; something has to copy them under the suffixed
// names, and this is that something.
//
// Node rather than the `sh` script this replaces. `beforeBuildCommand` runs
// through the Tauri CLI's shell, which is `cmd /C` on Windows, and a stock
// Git for Windows install does NOT put `sh.exe` on PATH -- the installer's
// default adds only `<git>/cmd`. So the shell script was a Windows bundle
// that failed before it started, for a script whose whole job is two spawns
// and a copy. Node is already a hard requirement (the frontend is built with
// it in the same command).
//
// Bundling only. `externalBin` deliberately lives in
// `tauri.bundle.conf.json` rather than the base config, because
// `tauri-build` validates it from the app crate's BUILD SCRIPT: with it in
// `tauri.conf.json`, a plain `cargo test --workspace` on a clean checkout
// fails with "resource path binaries/gavin-daemon-<triple> doesn't exist".
// See BUNDLING.md. `tauri dev` needs none of this -- there the app finds its
// siblings in `target/debug/`, where cargo already put them.

import { execFileSync } from "node:child_process";
import { copyFileSync, chmodSync, mkdirSync, renameSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/// The sidecar build for one bundle: which program builds them, with which
/// arguments, where cargo leaves them and the triple they are staged under.
///
/// The triple is Tauri's TARGET, not this machine's: the CLI hands its
/// `beforeBuildCommand` the triple it is building for as
/// `TAURI_ENV_TARGET_TRIPLE`, and `externalBin` looks the sidecars up under
/// that same triple. A native bundle has target == host and builds exactly
/// as it always did -- no `--target`, out of `target/<profile>/`. A cross
/// bundle (`--target x86_64-pc-windows-msvc` on a Mac) builds them with
/// `--target`, so cargo leaves them in `target/<triple>/<profile>/`, and
/// through the same runner the app itself is built with: Tauri's
/// `--runner cargo-xwin` reaches this script as `GAVIN_CARGO_RUNNER`
/// (bundle.mjs sets it), because a plain `cargo` cannot link for msvc here.
export function sidecarBuild({ host, target, runner, release, root, targetDir }) {
  const triple = target || host;
  const cross = triple !== host;
  const profileDir = release ? "release" : "debug";
  return {
    triple,
    // The extension Windows needs on an executable, which `externalBin`
    // keeps AFTER the triple it appends. The target's, not the host's.
    exe: triple.includes("-windows-") ? ".exe" : "",
    command: runner || "cargo",
    // `--locked`: the two binaries that ship inside the bundle are built
    // from exactly the dependency versions Cargo.lock names, or the build
    // fails. Without it a manifest edit that no longer matches the lockfile
    // is silently re-resolved, and a release nobody can reproduce from the
    // tag is a release nobody can audit.
    args: [
      "build", "--locked", ...(release ? ["--release"] : []),
      "--manifest-path", join(root, "Cargo.toml"),
      ...(cross ? ["--target", triple] : []),
      "-p", "gavin-daemon", "-p", "gavin-mcp",
    ],
    outDir: cross ? join(targetDir, triple, profileDir) : join(targetDir, profileDir),
  };
}

function main() {
  const here = dirname(fileURLToPath(import.meta.url));
  const root = join(here, "..", "..");

  // `rustc -vV`'s host line, rather than a guess from the platform, is what
  // keeps this right on an Apple Silicon mac (aarch64-apple-darwin), across
  // a glibc/musl split on Linux, and between msvc and gnu on Windows.
  const version = execFileSync("rustc", ["-vV"], { encoding: "utf8" });
  const host = version.match(/^host: (.+)$/m)?.[1];
  if (!host) {
    console.error("stage-sidecars: could not read the host triple from `rustc -vV`");
    process.exit(1);
  }

  const build = sidecarBuild({
    host,
    target: process.env.TAURI_ENV_TARGET_TRIPLE,
    runner: process.env.GAVIN_CARGO_RUNNER,
    release: process.argv.includes("--release"),
    root,
    targetDir: process.env.CARGO_TARGET_DIR ?? join(root, "target"),
  });
  execFileSync(build.command, build.args, { stdio: "inherit" });

  const binaries = join(here, "binaries");
  mkdirSync(binaries, { recursive: true });

  for (const bin of ["gavin-daemon", "gavin-mcp"]) {
    const src = join(build.outDir, `${bin}${build.exe}`);
    if (!existsSync(src)) {
      console.error(`stage-sidecars: ${src} is missing after a successful cargo build`);
      process.exit(1);
    }
    // Copy to a temporary name and move it into place: overwriting a binary
    // that a previous `tauri dev` still has running is ETXTBSY on Linux and a
    // sharing violation on Windows, while a rename over it is neither.
    const staged = join(binaries, `${bin}-${build.triple}${build.exe}`);
    const tmp = `${staged}.tmp`;
    copyFileSync(src, tmp);
    if (process.platform !== "win32") chmodSync(tmp, 0o755);
    renameSync(tmp, staged);
  }
}

// Only when run as a program. The tests beside this file import
// `sidecarBuild`, and importing must not build anything.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
