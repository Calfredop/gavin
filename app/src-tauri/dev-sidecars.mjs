// Build the two sidecars a dev run needs beside the app, surviving the case
// Windows makes ordinary here: another agent session is running one of them.
//
// `tauri dev` gives the app no bundle, so it finds its siblings in
// `target/<profile>/` where cargo's uplift step leaves them, and it resolves
// both by NAME beside `current_exe()` at runtime
// (`daemon::resolve_daemon_binary_path`, `agent_setup::resolve_mcp_binary_path`
// -- the latter bails outright when the file is not there). So the two names
// are load-bearing and cannot be swapped for per-run staging names.
//
// That uplift is also the whole problem. To refresh
// `target/debug/gavin-mcp.exe` cargo UNLINKS it and links the fresh artifact
// in its place, and Windows refuses to unlink a running image:
//
//   error: failed to remove file `...\target\debug\gavin-mcp.exe`
//   Caused by:
//     Access is denied. (os error 5)
//
// On a unix host that is not an error at all -- the old inode lives on inside
// whoever holds it and cargo writes a new one over the name. And gavin
// guarantees somebody holds it: every agent session in a checkout runs a
// `gavin-mcp` out of that path for as long as the session lives, so the more
// the product is used as designed, the less its own dev loop works.
//
// Windows does allow a running image to be RENAMED, though. The process keeps
// its mapping of the renamed file and a fresh binary can then be written at
// the original name -- the missing unix semantic, one syscall away. So before
// building, this moves aside exactly those sidecars that are actually held
// open, and lets cargo link into the name it just vacated.
//
// Never the reverse. This does not stop what it finds and must not learn how:
// the processes holding those files are other people's agent sessions, and
// taking a session's MCP server away mid-task is a worse failure than the one
// being fixed.
//
// Shared by all three dev entry points -- `beforeDevCommand` in
// tauri.conf.json, scripts/start-dev-win.ps1 and scripts/start-dev-mac.sh --
// because the bug was one `cargo build` line copied into three places, and a
// fix applied to fewer than three leaves the other paths broken identically.
// Node for the reason stage-sidecars.mjs gives beside it: `beforeDevCommand`
// runs through `cmd /C` on Windows, where a stock Git for Windows puts no
// `sh.exe` on PATH.

import { spawnSync } from "node:child_process";
import { closeSync, existsSync, openSync, readdirSync, renameSync, unlinkSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/// The two packages, and the file names their binaries uplift to.
export const SIDECARS = ["gavin-daemon", "gavin-mcp"];

/// The suffix parked files carry, and the pattern the sweep matches.
const PARKED = ".locked-";
const PARKED_RE = /\.locked-\d+$/;

/// Windows opens a running image without FILE_SHARE_WRITE, so a write-open
/// of one fails while a read and a rename both still succeed -- which makes
/// `r+` the precise probe for "cargo is about to be denied here", with no
/// process enumeration and no guessing from a message.
///
/// `EBUSY` is what Windows answers; `EPERM`/`EACCES` mean cargo cannot write
/// the file either, so parking it is right for those too. A file that is
/// simply absent (`ENOENT`) is not held by anyone.
export function isHeldOpen(path) {
  let fd;
  try {
    fd = openSync(path, "r+");
  } catch (err) {
    return err.code === "EBUSY" || err.code === "EPERM" || err.code === "EACCES";
  }
  closeSync(fd);
  return false;
}

/// The next free `<binary>.locked-<n>`. Numbered rather than timestamped so
/// the sweep has one stable pattern to match, and counted rather than fixed
/// because a parked file cannot be removed while its holder lives: several
/// dev restarts against several live sessions leave several waiting.
export function freeParkPath(path, exists = existsSync) {
  for (let n = 1; n <= 200; n += 1) {
    const candidate = `${path}${PARKED}${n}`;
    if (!exists(candidate)) return candidate;
  }
  throw new Error(`dev-sidecars: 200 parked copies of ${basename(path)} already waiting`);
}

/// Remove the parked files whose holders have since exited. Unlinking one
/// that is still running fails with EPERM, which is not an error here -- the
/// next dev start tries again, and the file costs a few megabytes of a
/// directory that is already disposable.
export function sweepParked(dir, log = () => {}) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return 0; // No target dir yet: the first build in a fresh checkout.
  }
  let removed = 0;
  for (const entry of entries) {
    if (!PARKED_RE.test(entry)) continue;
    if (!SIDECARS.some((bin) => entry.startsWith(bin))) continue;
    try {
      unlinkSync(join(dir, entry));
      removed += 1;
    } catch {
      log(`still in use, leaving it: ${entry}`);
    }
  }
  return removed;
}

/// Move every held sidecar out of the name cargo is about to link into.
/// Returns what was moved, so the caller can put a name back that cargo
/// turned out not to write.
///
/// A rename that fails is reported and not fatal: cargo only needs the name
/// when it has something new to link there, so a held sidecar whose package
/// did not change builds fine anyway. Bailing here would turn a build that
/// would have succeeded into one that never ran.
export function parkHeldBinaries(paths, { log = () => {}, held = isHeldOpen, move = renameSync } = {}) {
  const parked = [];
  for (const path of paths) {
    if (!held(path)) continue;
    let to;
    try {
      // Inside the try along with the move: every way this can fail ends the
      // same way, with a named binary left where it was and a build that may
      // well succeed without the rename.
      to = freeParkPath(path);
      move(path, to);
      parked.push({ path, to });
      log(`${basename(path)} is running -- parked as ${basename(to)} so the fresh one can take its name`);
    } catch (err) {
      log(`could not park ${basename(path)} (${err.code ?? err.message}); building anyway`);
    }
  }
  return parked;
}

/// Put back the name of every parked binary cargo did not write.
///
/// Two ways to get here. Cargo skips the uplift entirely when the package is
/// already fresh, so parking a binary nothing was going to relink would
/// otherwise DELETE it from the dev tree -- and `resolve_mcp_binary_path`
/// bails when `gavin-mcp` is missing, so the dev app would then write no
/// agent config at all. And a build that failed for an unrelated reason -- a
/// compile error in the daemon -- must leave the tree exactly as it found it.
export function restoreUnwritten(parked, { log = () => {}, exists = existsSync, move = renameSync } = {}) {
  const restored = [];
  for (const { path, to } of parked) {
    if (exists(path)) continue; // cargo linked a fresh one; `to` is now litter.
    try {
      move(to, path);
      restored.push(path);
      log(`cargo wrote no new ${basename(path)}; put the running one back under its own name`);
    } catch (err) {
      log(`could not restore ${basename(path)} from ${basename(to)} (${err.code ?? err.message})`);
    }
  }
  return restored;
}

/// Every process running an image of this base name, as `{ pid, path }`.
///
/// Queried by process NAME and not by path because `Get-Process` has no path
/// filter worth trusting; the caller does the path comparison, and needs the
/// non-matching ones too in order to say what they are.
export function holdersOf(path, run = spawnSync, platform = process.platform) {
  if (platform !== "win32") return [];
  const name = basename(path).replace(/\.exe$/i, "");
  const script = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    `Get-Process -Name '${name.replace(/'/g, "''")}' |`,
    '  ForEach-Object { "$($_.Id) $($_.Path)" }',
  ].join("\n");
  const res = run("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
  });
  if (res.error || res.status !== 0 || !res.stdout) return [];
  return res.stdout
    .split(/\r?\n/)
    .map((line) => line.trim().match(/^(\d+) (.+)$/))
    .filter(Boolean)
    .map(([, pid, image]) => ({ pid: Number(pid), path: image }));
}

/// Windows path equality: case-insensitive, and blind to which slash was used.
function samePath(a, b) {
  const norm = (p) => resolve(p).replace(/\\/g, "/").toLowerCase();
  try {
    return norm(a) === norm(b);
  } catch {
    return false;
  }
}

/// What to print when the build failed and a sidecar is still held. Empty
/// when no sidecar is held, because then the failure was an ordinary one and
/// cargo has already said everything there is to say.
///
/// Option 3 of the card this fixes: an `os error 5` with no name in it tells a
/// developer nothing, and the answer -- stop that session, or don't -- is
/// theirs to choose and needs a pid to choose with.
///
/// Only the pids running THIS file, separated from the same-named processes
/// running some other checkout's copy. One machine routinely has both, and a
/// developer told to consider stopping a pid that has nothing to do with their
/// build is worse served than one told nothing.
export function diagnoseFailure(paths, { held = isHeldOpen, holders = holdersOf } = {}) {
  const lines = [];
  for (const path of paths) {
    if (!held(path)) continue;
    const found = holders(path);
    const here = found.filter((h) => h.path && samePath(h.path, path));
    lines.push(`${path} is open in another process and could not be replaced.`);
    if (here.length > 0) {
      lines.push(...here.map((h) => `  pid ${h.pid}`));
      lines.push(
        "  Each of those is a live agent session's own server. Stopping one is",
        "  your call and nothing here will do it for you -- a session loses its",
        "  gavin tools mid-task when you do.",
      );
    } else {
      lines.push(
        "  No process on this machine is running that image, so something else",
        "  holds the file -- an antivirus scan, or another cargo. Retrying is",
        "  usually enough.",
      );
      if (found.length > 0) {
        lines.push(
          `  (${found.length} process(es) of the same name are running another`,
          "  checkout's copy; they do not hold this one.)",
        );
      }
    }
  }
  return lines;
}

/// `target/<profile>/`, the same way stage-sidecars.mjs finds it: the app's
/// own binary lands there too, which is what makes the sidecars its siblings.
/// Resolved against `root` and not the cwd, because that is where cargo is
/// run from below and a relative `CARGO_TARGET_DIR` is relative to it.
export function debugBinaryPaths(root, env = process.env, platform = process.platform) {
  const targetDir = resolve(root, env.CARGO_TARGET_DIR ?? "target");
  const exe = platform === "win32" ? ".exe" : "";
  return SIDECARS.map((bin) => join(targetDir, "debug", `${bin}${exe}`));
}

function main() {
  const here = dirname(fileURLToPath(import.meta.url));
  const root = join(here, "..", "..");
  const paths = debugBinaryPaths(root);
  const log = (msg) => console.log(`dev-sidecars: ${msg}`);

  // Silent about what it could not remove: a parked copy whose session is
  // still open is the expected state, and one line per copy per dev start is
  // noise in front of the build the developer is waiting for.
  const swept = sweepParked(dirname(paths[0]));
  if (swept > 0) {
    const what = swept === 1 ? "binary whose holder has" : "binaries whose holders have";
    log(`swept ${swept} parked ${what} exited`);
  }

  const parked = parkHeldBinaries(paths, { log });

  // stdio inherited, not captured: cargo writes its progress to a stderr it
  // checks for a tty, and a dev build that takes minutes without a progress
  // bar reads as a hang. Nothing here needs to parse cargo's output -- the
  // write-open probe above already knows which files are held, which is the
  // same answer a message match would give and does not go stale when cargo
  // rewords the error.
  const res = spawnSync("cargo", ["build", "-p", SIDECARS[0], "-p", SIDECARS[1]], {
    cwd: root,
    stdio: "inherit",
  });

  restoreUnwritten(parked, { log });

  if (res.error) {
    console.error(`dev-sidecars: could not run cargo (${res.error.message})`);
    process.exit(1);
  }
  if (res.status !== 0) {
    for (const line of diagnoseFailure(paths)) console.error(`dev-sidecars: ${line}`);
    process.exit(res.status ?? 1);
  }
}

// Only when run as a program. The tests beside this file import the pieces
// above, and importing must not build anything.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
