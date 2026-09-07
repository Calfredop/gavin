---
order: 5120
title: [feat] windows port
status: Done
---
Gavin does not compile for Windows. Every process talks over Unix domain sockets imported from `std::os::unix` with no cfg gate (daemon server.rs / gavin.rs / main.rs, gavin-mcp main.rs, host daemon.rs / session.rs), the daemon chmods its socket through `PermissionsExt`, `proc.rs` calls `libc::kill`, and the PTY spawns `/bin/sh -c` for every command session. The 2026-07-30 terminal-core refinements spec made the project macOS-first on purpose; this card is the decision to add Windows. The Linux card (`feat-linux-port.md`) lands first: it delivers the per-OS data-directory seam and the CI workflow this card extends.

What already works: the frontend's platform seam (`platform.ts`, chords map ⌘ to Ctrl, the non-mac `WindowControls`), the target-gated AppKit code, `windows_subsystem` in main.rs, `icon.ico` and the Store logos, `settings.ts` accepting drive-letter paths, and every crate in use (portable-pty via ConPTY, notify, trash, rusqlite bundled, vt100, tauri).

## Shell: Git Bash, resolved from `git --exec-path` (decided)

Emitted command lines keep their POSIX shape and run through Git for
Windows' `sh.exe`. The alternative — emitting PowerShell — was rejected
because the emission sites (`buildToolCommand`, `buildUntilScript`,
`buildHeadlessCommand`, `shellQuote`, `[worktree] setup`'s `&&` chain)
are the same strings the agent launch lines are built from, so a second
dialect would fork every one of them and every test that asserts on
them, for a shell none of the agent CLIs need.

Resolution, in order: `<git>/usr/bin/sh.exe`, then `<git>/bin/sh.exe`,
then bare `sh` on `PATH`. `<git>` is `git --exec-path` with its three
trailing components (`mingw64/libexec/git-core`) removed — asked of git
rather than guessed from `%ProgramFiles%`, because a scoop/winget/portable
install lives elsewhere and a 32-bit one says `mingw32`. `usr/bin` first
because that is where the whole MSYS runtime sits; `bin/` carries only the
three-program PATH-convenience subset.

What is confirmed here, on a mac, and what the Windows pass owes:

- **Confirmed.** The `buildToolCommand` epilogue is POSIX, not bashism:
  `$?`, `[ … -ne 0 ]`, `printf '\n[gavin] %s exited with code %s\n'` and
  `exit "$code"` run identically under `dash` and under `sh -o posix`,
  exit code preserved. So the epilogue needs `sh.exe` only, not `bash`.
  A `script`-kind tool wraps its body in `bash -c`, and `bash.exe` sits
  beside `sh.exe` in both candidate directories.
- **Confirmed.** Git for Windows is already a hard prerequisite, not a new
  one: `git_status.rs`, `git/run.rs` and every worktree action shell out
  to `git`. This decision spends a dependency the app had already taken.
- **To confirm on Windows** (folded into the last checklist item): that
  ConPTY runs `sh.exe` as a tty — MSYS treats a Windows console as one,
  which is why Git Bash works in Windows Terminal, but portable-pty's
  ConPTY path has never been exercised here; that each CLI in the profile
  table (`claude`, `codex`, `gemini`, `cursor`, `opencode`) starts under
  it — npm's global bin holds both an extensionless `#!/bin/sh` shim and a
  `.cmd`, and inside `sh.exe` the shim is the one that wins, which is the
  whole reason this route was chosen; and that `git --exec-path` answers
  before any workspace is open, since the resolution happens at PTY spawn.

The Rust side does **not** inherit this. `Command::new("claude")` still
cannot start a `.cmd` or an extensionless script — `CreateProcess` runs
neither — so the CLI probes need their own answer under "Binaries".

## Corrections to the assumptions above

- **There is no per-user pipe namespace.** The "Permissions" item assumed
  `\\.\pipe\gavin-<user>` would be user-scoped by where it lives; it is not
  — `\Device\NamedPipe` is machine-global, and the default descriptor a pipe
  gets from a null `SECURITY_ATTRIBUTES` grants READ to Everyone, which
  would put every push on the daemon's connection (session output
  included) in reach of any local account. So the scoping IS a DACL:
  `transport` builds `D:P(A;;GA;;;SY)(A;;GA;;;<the running user's SID>)`
  from the process token and hands it to every `CreateNamedPipeW`.
  The name is derived from the endpoint PATH instead
  (`\\.\pipe\gavin-<last segment>-<hash of the lowercased path>`), which
  keeps two users apart because their `%LOCALAPPDATA%` differs, and gives
  every daemon test its own pipe from the tempdir it already has.
- **The Windows gate cannot run on a mac unaided.** `cargo check
  --target x86_64-pc-windows-msvc` needs no linker, but `rusqlite`'s
  `bundled` feature compiles `sqlite3.c`, and that needs an MSVC C
  compiler no mac has. Locally the check runs as
  `LIBSQLITE3_SYS_USE_PKG_CONFIG=1 SQLITE3_LIB_DIR=/usr/lib
  SQLITE3_INCLUDE_DIR=/usr/include cargo check -p protocol -p gavin-daemon
  -p gavin-mcp --target x86_64-pc-windows-msvc`, which swaps the bundled
  build for a linked one that `check` never has to link. The honest gate
  is the CI job.

## Window chrome: the controls stay top-left (decided)

`decorations: false` now sits beside an explicit `"shadow": true` in
tauri.conf.json. It is Tauri's default, but it is the line that gives an
undecorated Windows 11 window its 1px border and rounded corners, and
leaving it implicit next to the flag that removes the frame is how it
gets turned off by accident.

The resize grips `WindowResizeEdges.svelte` draws off macOS are drawn on
Windows too. tao does keep `WS_THICKFRAME` on an undecorated resizable
window and answers `WM_NCHITTEST` for a border inside the client area --
but the WebView2 child window covers those pixels and takes the mouse
before the frame is asked, so the OS border cannot be relied on. Six
pixels of overlay per edge is the cheaper mistake than a window that
cannot be resized at all.

**The window controls stay in the top-LEFT corner on Windows**, not
top-right. The reasoning is already in TitleBar.svelte and this card only
confirms it: the corner is a fixed geometry the sidebar column is built
around (`CornerOverhang.svelte` cuts the header row to fit it), and off
macOS the controls were never in the platform's own place anyway -- they
sat at the right-hand end of a 200px strip over the sidebar, which is the
middle of the window. Moving them right on Windows would mean a second
corner geometry, a second overhang and a sidebar whose top row differs
per OS, to reach a convention the app was already not following.

**Assumptions** (overrule in one word):
- Shell: require Git for Windows and run emitted commands through its `sh.exe` (found via `git --exec-path`), leaving the POSIX script emission in cardRun.ts and worktreeSetup.ts untouched. The alternative is emitting PowerShell, which touches every tool body and every agent launch line; Git Bash wins because all four agent CLIs are npm-installed and already run under it.
- IPC: one transport abstraction that keeps `std::os::unix::net` on Unix and uses named pipes on Windows. The wire format stays newline-delimited JSON, so gavin-mcp and the protocol above the transport do not change.
- Paths: the daemon normalizes to forward slashes at the protocol boundary (Windows APIs accept them), so the ~25 frontend modules that split on `/` keep working; `paths.ts` helpers learn to accept both separators anyway.
- Terminate: Windows has no SIGTERM. Ending an orphan becomes `TerminateProcess` and the button copy says so.
- Shape: checklist plus two nested children (transport abstraction, Windows process probe), each a piece another agent picks up cold.

## Checklist

- [x] Shell strategy spike: confirm `sh.exe` resolution from a stock Git for Windows install, that ConPTY runs it with the `$?` / `[ ]` / `printf` epilogue from `buildToolCommand` intact, and that `claude`, `codex`, `gemini` and `opencode` launch under it. Write the decision at the top of this card before anything else.
- [x] Transport: nested child `feat-windows-port-transport.md`. Tick when merged. Gate: `cargo check -p protocol -p gavin-daemon -p gavin-mcp --target x86_64-pc-windows-msvc` passes.
- [x] Permissions: the `PermissionsExt` chmod calls in daemon main.rs and server.rs sit under `#[cfg(unix)]`; the Windows pipe lives in the per-user namespace (`\\.\pipe\gavin-<user>`) so it is user-scoped without a DACL.
- [x] Data directory: `app_support_dir` resolves to `%LOCALAPPDATA%\gavin` through the seam the Linux card added; home lookups read `USERPROFILE` on Windows; verify each agent CLI's Windows dot-dir location.
- [x] Process probe: nested child `feat-windows-port-proc.md`. Tick when merged.
- [x] Process management: daemon restart stops shelling out to `pkill -x gavin-daemon`. Use `Request::Shutdown` over the transport everywhere, with `taskkill /IM gavin-daemon.exe` only as the Windows fallback for a wedged daemon.
- [x] Binaries: `resolve_daemon_binary_path` and `resolve_mcp_binary_path` append `std::env::consts::EXE_SUFFIX`; `Command::new("claude")` and the other CLI probes resolve npm's `.cmd` shims (spawn through `cmd /C` or resolve with `where`); `curl -K -` works with the Windows 10+ built-in curl.
- [x] PTY: spawn `sh.exe -c <line>` for command sessions and `%COMSPEC%` or PowerShell for a plain shell; TERM / TERM_PROGRAM env is harmless; OSC 7 cwd tracking degrades gracefully (Git Bash emits `file://host/C:/...` or nothing), and idle detection must not depend on it.
- [x] Paths: normalize at the daemon boundary; audit git.ts, fileTree.ts, archiveActions.ts, cardDelete.ts and `paths.ts`; worktree paths and `.gavin*` relPaths round-trip through the board, the Plans tab and the file viewer.
- [x] Window chrome: `decorations: false` on Windows needs `shadow: true` (Tauri 2) so resize borders exist; decide whether the non-mac `WindowControls` sit top-right per Windows convention or keep TitleBar.svelte's top-left decision, and note it on this card.
- [x] Bundling: `externalBin` entries with the target-triple suffix for daemon and mcp (spec 2026-08-24 §2 names this as an assumption to verify); NSIS installer via `bundle.targets`.
- [x] CI: add a `windows-latest` job to the workflow the Linux card created, `cargo check --target x86_64-pc-windows-msvc` as the gate first, then the full cargo + npm suites once it links.
- [x] Verification on a Windows machine — **carried to [feat-windows-port-on-a-windows-machine.md](./feat-windows-port-on-a-windows-machine.md)**, not finished here. Nothing in this card has been executed on Windows; it compiles for the target and is green on macOS, which is a different claim. That card carries the full list, in the order that matters: the shell assumption first, because ConPTY running `sh.exe` as a tty is what every emitted command line rests on, and if it is wrong the answer is a re-plan rather than a patch.

## What the Windows pass has to answer

Moved to [feat-windows-port-on-a-windows-machine.md](./feat-windows-port-on-a-windows-machine.md), which carries this list in full and in the right order. Kept here in summary only, so this card still says what it did not prove.

Everything above compiles for `x86_64-pc-windows-msvc` and is green on
macOS; none of it has been RUN on Windows, and several decisions can only
be settled there. The list below is the last checklist item, spelled out,
and it is written for someone sitting at a Windows machine with Git for
Windows, the MSVC build tools and Node 22.

1. **It launches.** `npm run tauri dev`, then `npm run bundle` and the
   NSIS installer it produces. WebView2 is present on Windows 11 and on
   an updated Windows 10.
2. **A shell tab opens** — `%COMSPEC%`, per the PTY decision — and a
   **card runs**: that resolves `sh.exe` from `git --exec-path`, that
   ConPTY gives it a tty, and that the agent CLI starts under it. This is
   the one assumption the whole shell decision rests on.
3. **The daemon restarts** from Settings. It now asks over the wire
   (`Request::Shutdown`) and falls back to `taskkill /F /IM
   gavin-daemon.exe`; both halves want exercising, the second by killing
   the daemon's own request loop first if that can be arranged.
4. **A workspace deletes to the Recycle Bin**, and Restore puts it back.
5. **A file path under the cursor opens** — that is
   `resolve_path_under_cursor`, and the first place a `\\?\` verbatim
   path would have shown up before `protocol::canonical_path`.
6. **A workspace at a `C:\` path renders on the board**, and its cards
   open from the Plans tab and the file viewer. Card ids are paths, and
   they are compared and split as strings.
7. **A `until` rail step retries**, quoting its check. The log now lives
   under the host's own temp directory rather than `/tmp`, which is the
   one file the shell writes and the app reads back.
8. **Two accounts on one machine do not share a daemon**, and neither can
   read the other's pipe — the `D:P(A;;GA;;;SY)(A;;GA;;;<sid>)` descriptor
   `transport` builds. `Get-Acl` on the pipe, or simply a second account
   getting its own daemon.
9. **The window resizes at every edge and corner**, and the controls in
   the top-left corner do what they say.

Then promote the reporting steps in the `windows` CI job to gates, one
per thing that goes green.

**Out of scope:** WSL-based operation (a WSL workspace is the Linux app talking to a Linux daemon); code signing; the ARM64 Windows target.

<!-- gavin:auto-commit -->
When the implementation is done, commit it. Commit only the files you touched — never `git add -A`. Do not push.
<!-- /gavin:auto-commit -->
