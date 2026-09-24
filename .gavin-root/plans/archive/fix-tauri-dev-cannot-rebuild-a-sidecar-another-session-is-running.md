---
title: [fix] npm run tauri dev cannot start on Windows while a sibling session runs a sidecar
status: Done
priority: medium
complexity: simple
---
Found 2026-09-22 on
[feat-windows-port-on-a-windows-machine](./feat-windows-port-on-a-windows-machine.md)
§1, on the first attempt to run the dev loop.

`build.beforeDevCommand` in `app/src-tauri/tauri.conf.json` is

```
cargo build -p gavin-daemon -p gavin-mcp && npm run dev
```

Windows refuses to replace a running executable, so if anything is holding
`target\debug\gavin-mcp.exe` (or `gavin-daemon.exe`) open, the whole command
fails before vite is ever reached:

```
error: failed to remove file `C:\Users\calfr\coding\gavin\target\debug\gavin-mcp.exe`
Caused by:
  Access is denied. (os error 5)
       Error The "beforeDevCommand" terminated with a non-zero status code.
```

Four `gavin-mcp.exe` processes out of that path were open at the time, each
the MCP server of a different agent session in this checkout.

**This is a port defect, not a local mess.** On a unix host `cargo` unlinks
the old file and writes a new one; the running processes keep the old inode
and nothing notices. Only Windows turns it into a hard stop. And gavin's own
premise makes it the normal case rather than the unlucky one: the product
exists to run several agent sessions at once against one checkout, and each of
them holds a `gavin-mcp.exe` open for as long as it lives. **The more the tool
is used as designed, the less its own dev loop works.**

Same law as the installer card's second defect
([fix-windows-installer-collides-with-the-daemon](./fix-windows-installer-collides-with-the-daemon.md)
— an upgrade cannot overwrite a live `gavin-daemon.exe`), one layer down, and
worth fixing separately because the workaround differs: an installer can stop
what it is replacing, a dev build must not.

## Options, in the order they look promising

1. **Do not relink what is already current.** The failure is cargo deciding
   it needs a fresh link, then being unable to. If the sidecars were built
   into per-run staging names, or the dev loop tolerated a link failure when
   the existing binary is newer than every input, the common case stops
   biting. Look first at whether `--out-dir`/`CARGO_TARGET_DIR` for the
   sidecars alone buys this cheaply.
2. **Build the sidecars where the app looks, but under a name a running
   process never holds.** The dev app resolves its daemon as
   `current_exe().parent()/gavin-daemon.exe` and its MCP as the sibling
   `gavin-mcp.exe`, so the names are load-bearing — but only the daemon's
   is; nothing in a dev run execs `gavin-mcp.exe` except an agent CLI that
   was handed the path earlier.
3. **Fail usefully.** At minimum, `beforeDevCommand` should say which
   process holds the file and that stopping it is the developer's call,
   instead of an `os error 5` with no name in it.

Whatever the route, do not make the dev loop kill the processes it finds:
they are other people's live agent sessions, and taking their MCP server away
breaks a session that is mid-task.

## The workaround that got §1 ticked (superseded 2026-09-23)

Kept as the record of what the defect cost, not as advice: the route below
fixes the hook itself, so nothing needs overlaying any more.

Overlay the hook and build the one sidecar that matters:

```
cargo build -p gavin-daemon
npx tauri dev --config <a json file with {"build":{"beforeDevCommand":"npm run dev"}}>
```

The stale `gavin-mcp.exe` stays where it is. The dev app launches, spawns its
own daemon and binds the dev endpoint normally — nothing else in the dev run
depends on the MCP binary being current.

## A second site any fix must touch (board audit, 2026-09-22)

`scripts/start-dev-win.ps1:108-119` runs **the same**
`cargo build -p gavin-daemon -p gavin-mcp` ahead of its `npm run tauri dev`
(`:203-208`), so a fix applied only to `tauri.conf.json`'s
`beforeDevCommand` leaves the scripted path broken in exactly the same way.
On failure that script `Die`s with a message about missing Visual Studio
Build Tools — which is the wrong diagnosis for a file-in-use error and is
option 3 ("fail usefully") going unimplemented in the one place a human is
most likely to meet it.

Verified still open: `app/src-tauri/tauri.conf.json:7` is byte-for-byte the
line this card quotes, there is no dev-side override config in the repo
(`tauri.bundle.conf.json`, `tauri.updater.conf.json` and
`tauri.windows.conf.json` are bundle/update/window configs; only
`beforeBuildCommand` at `:9` uses `stage-sidecars.mjs`), and a repo-wide
search for `os error 5` / `Access is denied` finds hits only inside card
files.

## The route taken (2026-09-23)

Options 1 and 2 as written are both dead ends on stable Rust:

- `--out-dir` is `-Z unstable-options` only, so it needs nightly.
- A separate `CARGO_TARGET_DIR` for the sidecars alone does not share the
  dependency graph with `-p app`, so it re-compiles every shared dependency
  into a second tree — minutes and gigabytes on every dev start, for a
  failure that costs one rename.
- A per-run staging name cannot move: `resolve_mcp_binary_path` requires
  `gavin-mcp<EXE_SUFFIX>` beside `current_exe` and BAILS when it is absent,
  so the dev app writes no agent config at all if that exact name is gone.

What Windows actually forbids is *unlinking* a running image, and cargo's
uplift step only ever unlinks. Windows does allow **renaming** one: the
running process keeps its mapping of the renamed file, exactly the way a unix
process keeps its inode, and a fresh binary can then be written at the
original name. That is the missing unix semantic, recovered with one syscall.

So: a shared `app/src-tauri/dev-sidecars.mjs` builds the two sidecars, and
when the build fails because a sidecar is held open, renames the held file
aside and retries once. Nothing is ever killed, and on a non-lock failure
cargo's own output is passed through untouched.

- [x] Prove the three Windows primitives the route rests on: a write-open of
      a running image is `EBUSY`, an unlink is `EPERM`, and a rename aside
      succeeds while the process keeps running.
- [x] Add `app/src-tauri/dev-sidecars.mjs` — build both sidecars; on a
      file-in-use failure rename each held binary to `<name>.locked-<n>`,
      retry once, and restore the name if the retry did not write a fresh
      one; sweep stale `.locked-*` files on the way in.
- [x] Option 3, fail usefully: when the rename route cannot save the build,
      name the PIDs running that exact image and say that stopping them is
      the developer's call.
- [x] Point all three dev entry points at the one script —
      `tauri.conf.json`'s `beforeDevCommand`, `scripts/start-dev-win.ps1`
      (whose `Die` currently blames missing Visual Studio Build Tools) and
      `scripts/start-dev-mac.sh`.
- [x] Unit-test the script: the file-in-use predicate against the exact
      cargo message this card quotes, and the rename-around against a real
      running process.
- [x] Record the trap in `docs/dev-setup.md`, and mark the manual
      `--config` overlay workaround above superseded rather than deleting it —
      it is the record of what the defect cost, and an old checkout still needs it.
- [x] Verify: the app vitest suite, `npm run check`, and a real `cargo build`
      driven through the script with a sidecar deliberately held open. Not
      `cargo test -p app`: no Rust changed, so its result is the known
      baseline — `tauri.conf.json` is the only file the app crate reads here
      and `npx tauri info` parses it clean.

## What landed (branch `win/dev-loop`, uncommitted)

- `app/src-tauri/dev-sidecars.mjs` (new) — the shared sidecar build.
- `app/src-tauri/dev-sidecars.test.mjs` (new) — 22 tests; the state machine
  with injected fakes on every platform, the platform fact once against a real
  running image on Windows.
- `app/vite.config.js` — `test.include` widened to `src-tauri/*.test.mjs`,
  non-recursively (`src-tauri/target` is a cargo tree). The two build scripts
  are shipping code and had no test home.
- `app/src-tauri/tauri.conf.json:7` — `beforeDevCommand` is now
  `node src-tauri/dev-sidecars.mjs && npm run dev`.
- `scripts/start-dev-win.ps1` — runs the script; its `Die` no longer asserts
  missing Build Tools over the file-in-use explanation just printed.
- `scripts/start-dev-mac.sh` — runs the same script, so the line cannot
  diverge in three files again.
- `docs/dev-setup.md` — the trap, and that `gavin-*.exe.locked-*` files in
  `target/debug/` are expected while sessions are open.

Proved end to end against real cargo, in a throwaway workspace shaped like this
one (so the script's own `../..` root derivation was exercised, not bypassed),
with a real process holding `target/debug/gavin-mcp.exe`:

| | |
|---|---|
| bare `cargo build` | exit 101, `failed to remove file ... Access is denied. (os error 5)` — the card's defect, reproduced |
| through the script | exit 0, fresh binary in place, holder still running |
| held + already fresh | exit 0, binary present (cargo re-links a missing destination; the restore is the belt to that brace) |
| held + compile error | exit 101, binary restored under its own name, one pid named — the holder's, not the three same-named processes in another checkout |
| holder exits, next run | the parked copy is swept |

Suites: app vitest 282 files / 6206 tests green (6184 baseline + 22 new),
`npm run check` 0 errors.

### Two things a later change must not undo

- **Never stop what it finds.** `diagnoseFailure` has a test asserting the
  word "kill" appears nowhere in its output, because the tempting fix — stop
  the holders — takes a live session's MCP server away mid-task.
- **The restore is not redundant.** Parking a binary cargo then does not
  re-link would DELETE it from the dev tree, and
  `agent_setup::resolve_mcp_binary_path` bails rather than degrades when
  `gavin-mcp` is missing, so the dev app would write no agent config at all.
