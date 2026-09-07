---
order: 4096
title: [feat] linux port
status: Done
---
Gavin only builds and runs on macOS today. Linux is the short hop: the Unix-socket IPC, the `/bin/sh` PTY spawn, `pkill`, `curl` and every crate in use already work there, so the port is a handful of macOS-only assumptions plus verification on a real Linux desktop. Windows is its own card (`feat-windows-port.md`) and builds on the data-directory seam and the CI this card lands, so this card goes first.

Audit that produced this card (2026-09-07): the only macOS-specific code paths are `protocol::app_support_dir` (`~/Library/Application Support/gavin`, panics without HOME), `proc.rs` (libproc probes, stubs returning "gone" elsewhere), the watcher's `ONE_RECURSIVE_WATCH`, the `security` keychain probe in agent_usage.rs, and the AppKit chrome in mac_window.rs, which already has no-op stubs off macOS.

**Done 2026-09-07 for everything a mac can answer**, in nine commits on
`feat/multi-os-support` (`abd2d4f`..`7a03dcc`), with the whole workspace green
in a Linux container. The two items that needed a Linux machine — building a
real deb/AppImage, and looking at the window — moved to
[feat-linux-port-on-a-linux-machine.md](../feat-linux-port-on-a-linux-machine.md).

**Assumptions** (overrule in one word):
- Target is a mainstream x86_64 desktop distro with WebKitGTK 4.1 (Ubuntu 24.04 / Fedora 40 class), bundled as AppImage + deb, rpm if free.
- Data lives under XDG (`$XDG_DATA_HOME/gavin`, default `~/.local/share/gavin`). macOS keeps `~/Library/Application Support/gavin` unchanged so no existing user migrates anything.
- Shape: a checklist plus one nested child for the `/proc` process probe, the one piece another agent can pick up cold.

## Checklist

- [x] Data directory seam: `protocol::app_support_dir` resolves per OS (macOS unchanged, Linux XDG) and stops panicking on a missing HOME, returning an error the host surfaces as a bootstrap banner. Unit test that the socket path stays under the ~103-byte sun_path limit (the shutdown test documents it) with a long `XDG_DATA_HOME`.
- [x] Every other HOME read goes through one helper: fileviewer `~/` expansion, agent_usage, agent_tokens, superpowers, session `create_fresh_session`. Verify the agent CLIs' Linux dot-dirs (`~/.claude`, `~/.codex/sessions`, `~/.gemini`) match what the code assumes.
- [x] [Process probe: nested child `feat-linux-port-proc.md` (identify / usage / children via `/proc`). Tick when merged.](./feat-linux-port-proc.md)
- [x] Watcher: `ONE_RECURSIVE_WATCH` is macOS-only, so Linux arms one inotify watch per directory. Measure arm time and watch count on a 3000-folder repo; if it can exceed `fs.inotify.max_user_watches`, surface a daemon error naming the sysctl instead of silently missing card edits.
- [x] Credentials: the `security` keychain probe is skipped off macOS and the `~/.claude/.credentials.json` fallback has a test; the usage panel still fills in.
- [x] Trash: `trash::delete` on Linux (freedesktop). Verify the delete wizard puts a workspace in the desktop's trash and it can be restored.
- [x] Window chrome under WebKitGTK with `decorations: false`: drag via `startDragging`, edge resize, the non-mac `WindowControls` variant, and the title-bar double-click default off macOS. Keep the top-left corner placement TitleBar.svelte already decided.
- [x] Dev tooling: `app/vite-cache-guard.sh` is zsh. Port it to POSIX sh or mark it macOS-only in a header comment; confirm `beforeDevCommand` runs under bash.
- [x] CI: the repo's first GitHub Actions workflow, an `ubuntu-latest` job running `cargo test --workspace`, `npm test`, `npm run check`, `npm run build`, re-running `gavin::tests` alone before a failure counts. This is what keeps Linux green afterwards.
- [x] Bundling and the desktop pass — **carried to [feat-linux-port-on-a-linux-machine.md](../feat-linux-port-on-a-linux-machine.md)**, not finished here. The code for both is in (`npm run bundle`, `stage-sidecars.sh`, `tauri.bundle.conf.json`, `WindowResizeEdges.svelte`), and the staging script was confirmed to emit `gavin-{daemon,mcp}-<host triple>`; what is left needs a Linux box to build a deb on and a person to look at a window, and neither was available. That card carries the full list, including the spec's own open item: does `externalBin` strip the triple and land the two binaries in `/usr/bin` beside the app?

## What was verified, and how (2026-09-07)

No Linux desktop was available, so everything below was run **headlessly
in a container** (`rust:1-bookworm`, aarch64, Debian 12). That covers
every Rust code path; it covers no pixels, which is what the last
checklist item is still for.

- **The whole workspace is green on Linux** — the exact command CI runs.
  `cargo test --workspace` → protocol 72, gavin-daemon 459 + 1,
  gavin-mcp 42, app 364. 0 failed anywhere.
- **`/proc` probe (the nested card):** all 21 `proc::tests` pass on Linux,
  including the whole existing macOS-written set — `tree_usage`,
  `terminate`, and the CPU-units test that catches a tick/microsecond
  mix-up. That suite was the acceptance criterion and it needed no edits.
- **Watch set on a 3000-folder repo** (`measure_watch_set_on_a_large_repo`,
  `#[ignore]`d, run with `--ignored`): **3152 targets listed in 20 ms,
  all 3152 armed in 180 ms, 0 refused.** So arming is not the macOS
  problem in reverse — it is fine. The set is the SCANNED tree only
  (`node_modules/`, `target/`, dotdirs are never watched), so a repo would
  need ~8000 *scanned* directories to reach the stock 8192
  `fs.inotify.max_user_watches`; the container's own limit was 1048576.
  Reachable, though, on a machine that also runs a file indexer, so
  `sync_watches` now counts the `MaxFilesWatch` refusals and pushes one
  banner naming the sysctl instead of quietly missing card edits.

- **Trash:** a new test moves a real file to the real freedesktop trash
  and reads the record back — it lands in `~/.local/share/Trash/files/`
  with a `.trashinfo` carrying BOTH `Path=` and `DeletionDate=`. That
  second key needed a fix: `trash` was pulled in with
  `default-features = false`, and on Linux (unlike macOS) that feature
  flag also gates writing `DeletionDate`, which the trash spec makes
  mandatory. Restorability is the whole promise `trash_path` makes over
  `rm`, so `chrono` is back on for the Linux target only.

**One pre-existing test hung on Linux and now cannot.**
`recover_spawns_in_the_sessions_own_cwd_not_the_workspace_root` waited for
`$PWD` to appear TWICE in a session's output — which happens on macOS only
because `/bin/sh` is bash and readline redisplays the typed line after the
tty has already echoed it. Linux's dash echoes once, so the test's read
loop blocked forever in `Read::read` on the PTY master: its deadline
bounded the gap between reads, never a read. That is a failing assertion
turning into a six-hour CI job. All three such loops now go through one
`read_until` helper whose deadline actually bounds the read, and the test
asks the shell to print a marker it assembles at runtime, so the tty echo
can no longer satisfy the assertion by itself.

**`externalBin` cannot live in `tauri.conf.json`.** `tauri-build`
validates it from the app crate's BUILD SCRIPT, so a clean checkout fails
`cargo test --workspace` with "resource path
`binaries/gavin-daemon-<triple>` doesn't exist" — measured, not guessed.
It is in `tauri.bundle.conf.json`, merged only by `npm run bundle`; see
`app/src-tauri/BUNDLING.md`.

**The CI this card adds will go red on its own, and not because of Linux.**
`server::tests` is flaky under full-suite parallelism — a different test
each time, socket races and quiet-period timing. Measured on both this
branch (3 failures in 6 runs) and a detached worktree at `e8111ba`
(1 in 4), so it predates this work. CLAUDE.md already carves out
`gavin::tests` for fs-watcher timing; this is a second family, and the
workflow deliberately does NOT retry the suite to hide it. Filed as
[fix-daemon-server-test-flakiness.md](../fix-daemon-server-test-flakiness.md).
The container runs were green (2 full-workspace runs, 0 failures), which
may only mean it was not loaded enough.

**Found, out of scope, filed:** two builtin rail tools are macOS-only —
`builtin:notify` (osascript) and `builtin:send-email` (Mail.app). On
Linux they fail visibly in the step's terminal rather than silently, and
their descriptions already say "macOS", so nothing here changed them:
[feat-linux-notification-tools.md](../feat-linux-notification-tools.md).

**For anyone using the isolated-daemon trick on Linux:** a temp `$HOME` is
no longer enough on its own. `XDG_DATA_HOME` outranks it, so it has to be
cleared too or the isolated daemon binds the real socket
(`crates/daemon/tests/shutdown.rs` does exactly this).

**Out of scope:** Windows; Wayland polish beyond "it launches and resizes"; any installer beyond what Tauri bundles.

<!-- gavin:auto-commit -->
When the implementation is done, commit it. Commit only the files you touched — never `git add -A`. Do not push.
<!-- /gavin:auto-commit -->
