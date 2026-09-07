---
order: 5120
title: [feat] windows port
status: To Do
---
Gavin does not compile for Windows. Every process talks over Unix domain sockets imported from `std::os::unix` with no cfg gate (daemon server.rs / gavin.rs / main.rs, gavin-mcp main.rs, host daemon.rs / session.rs), the daemon chmods its socket through `PermissionsExt`, `proc.rs` calls `libc::kill`, and the PTY spawns `/bin/sh -c` for every command session. The 2026-07-30 terminal-core refinements spec made the project macOS-first on purpose; this card is the decision to add Windows. The Linux card (`feat-linux-port.md`) lands first: it delivers the per-OS data-directory seam and the CI workflow this card extends.

What already works: the frontend's platform seam (`platform.ts`, chords map ⌘ to Ctrl, the non-mac `WindowControls`), the target-gated AppKit code, `windows_subsystem` in main.rs, `icon.ico` and the Store logos, `settings.ts` accepting drive-letter paths, and every crate in use (portable-pty via ConPTY, notify, trash, rusqlite bundled, vt100, tauri).

**Assumptions** (overrule in one word):
- Shell: require Git for Windows and run emitted commands through its `sh.exe` (found via `git --exec-path`), leaving the POSIX script emission in cardRun.ts and worktreeSetup.ts untouched. The alternative is emitting PowerShell, which touches every tool body and every agent launch line; Git Bash wins because all four agent CLIs are npm-installed and already run under it.
- IPC: one transport abstraction that keeps `std::os::unix::net` on Unix and uses named pipes on Windows. The wire format stays newline-delimited JSON, so gavin-mcp and the protocol above the transport do not change.
- Paths: the daemon normalizes to forward slashes at the protocol boundary (Windows APIs accept them), so the ~25 frontend modules that split on `/` keep working; `paths.ts` helpers learn to accept both separators anyway.
- Terminate: Windows has no SIGTERM. Ending an orphan becomes `TerminateProcess` and the button copy says so.
- Shape: checklist plus two nested children (transport abstraction, Windows process probe), each a piece another agent picks up cold.

## Checklist

- [ ] Shell strategy spike: confirm `sh.exe` resolution from a stock Git for Windows install, that ConPTY runs it with the `$?` / `[ ]` / `printf` epilogue from `buildToolCommand` intact, and that `claude`, `codex`, `gemini` and `opencode` launch under it. Write the decision at the top of this card before anything else.
- [ ] Transport: nested child `feat-windows-port-transport.md`. Tick when merged. Gate: `cargo check -p protocol -p gavin-daemon -p gavin-mcp --target x86_64-pc-windows-msvc` passes.
- [ ] Permissions: the `PermissionsExt` chmod calls in daemon main.rs and server.rs sit under `#[cfg(unix)]`; the Windows pipe lives in the per-user namespace (`\\.\pipe\gavin-<user>`) so it is user-scoped without a DACL.
- [ ] Data directory: `app_support_dir` resolves to `%LOCALAPPDATA%\gavin` through the seam the Linux card added; home lookups read `USERPROFILE` on Windows; verify each agent CLI's Windows dot-dir location.
- [ ] Process probe: nested child `feat-windows-port-proc.md`. Tick when merged.
- [ ] Process management: daemon restart stops shelling out to `pkill -x gavin-daemon`. Use `Request::Shutdown` over the transport everywhere, with `taskkill /IM gavin-daemon.exe` only as the Windows fallback for a wedged daemon.
- [ ] Binaries: `resolve_daemon_binary_path` and `resolve_mcp_binary_path` append `std::env::consts::EXE_SUFFIX`; `Command::new("claude")` and the other CLI probes resolve npm's `.cmd` shims (spawn through `cmd /C` or resolve with `where`); `curl -K -` works with the Windows 10+ built-in curl.
- [ ] PTY: spawn `sh.exe -c <line>` for command sessions and `%COMSPEC%` or PowerShell for a plain shell; TERM / TERM_PROGRAM env is harmless; OSC 7 cwd tracking degrades gracefully (Git Bash emits `file://host/C:/...` or nothing), and idle detection must not depend on it.
- [ ] Paths: normalize at the daemon boundary; audit git.ts, fileTree.ts, archiveActions.ts, cardDelete.ts and `paths.ts`; worktree paths and `.gavin*` relPaths round-trip through the board, the Plans tab and the file viewer.
- [ ] Window chrome: `decorations: false` on Windows needs `shadow: true` (Tauri 2) so resize borders exist; decide whether the non-mac `WindowControls` sit top-right per Windows convention or keep TitleBar.svelte's top-left decision, and note it on this card.
- [ ] Bundling: `externalBin` entries with the target-triple suffix for daemon and mcp (spec 2026-08-24 §2 names this as an assumption to verify); NSIS installer via `bundle.targets`.
- [ ] CI: add a `windows-latest` job to the workflow the Linux card created, `cargo check --target x86_64-pc-windows-msvc` as the gate first, then the full cargo + npm suites once it links.
- [ ] Verification on a Windows machine: launch, spawn a shell, run a card, restart the daemon, delete a workspace to the Recycle Bin, open a file path under the cursor, and confirm a workspace at a `C:\` path renders on the board. Record results on this card.

**Out of scope:** WSL-based operation (a WSL workspace is the Linux app talking to a Linux daemon); code signing; the ARM64 Windows target.

<!-- gavin:auto-commit -->
When the implementation is done, commit it. Commit only the files you touched — never `git add -A`. Do not push.
<!-- /gavin:auto-commit -->
