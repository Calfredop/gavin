---
order: 4096
title: [feat] linux port
status: In Progress
---
Gavin only builds and runs on macOS today. Linux is the short hop: the Unix-socket IPC, the `/bin/sh` PTY spawn, `pkill`, `curl` and every crate in use already work there, so the port is a handful of macOS-only assumptions plus verification on a real Linux desktop. Windows is its own card (`feat-windows-port.md`) and builds on the data-directory seam and the CI this card lands, so this card goes first.

Audit that produced this card (2026-09-07): the only macOS-specific code paths are `protocol::app_support_dir` (`~/Library/Application Support/gavin`, panics without HOME), `proc.rs` (libproc probes, stubs returning "gone" elsewhere), the watcher's `ONE_RECURSIVE_WATCH`, the `security` keychain probe in agent_usage.rs, and the AppKit chrome in mac_window.rs, which already has no-op stubs off macOS.

**Assumptions** (overrule in one word):
- Target is a mainstream x86_64 desktop distro with WebKitGTK 4.1 (Ubuntu 24.04 / Fedora 40 class), bundled as AppImage + deb, rpm if free.
- Data lives under XDG (`$XDG_DATA_HOME/gavin`, default `~/.local/share/gavin`). macOS keeps `~/Library/Application Support/gavin` unchanged so no existing user migrates anything.
- Shape: a checklist plus one nested child for the `/proc` process probe, the one piece another agent can pick up cold.

## Checklist

- [x] Data directory seam: `protocol::app_support_dir` resolves per OS (macOS unchanged, Linux XDG) and stops panicking on a missing HOME, returning an error the host surfaces as a bootstrap banner. Unit test that the socket path stays under the ~103-byte sun_path limit (the shutdown test documents it) with a long `XDG_DATA_HOME`.
- [x] Every other HOME read goes through one helper: fileviewer `~/` expansion, agent_usage, agent_tokens, superpowers, session `create_fresh_session`. Verify the agent CLIs' Linux dot-dirs (`~/.claude`, `~/.codex/sessions`, `~/.gemini`) match what the code assumes.
- [ ] [Process probe: nested child `feat-linux-port-proc.md` (identify / usage / children via `/proc`). Tick when merged.](./feat-linux-port-proc.md)
- [ ] Watcher: `ONE_RECURSIVE_WATCH` is macOS-only, so Linux arms one inotify watch per directory. Measure arm time and watch count on a 3000-folder repo; if it can exceed `fs.inotify.max_user_watches`, surface a daemon error naming the sysctl instead of silently missing card edits.
- [x] Credentials: the `security` keychain probe is skipped off macOS and the `~/.claude/.credentials.json` fallback has a test; the usage panel still fills in.
- [ ] Trash: `trash::delete` on Linux (freedesktop). Verify the delete wizard puts a workspace in the desktop's trash and it can be restored.
- [ ] Window chrome under WebKitGTK with `decorations: false`: drag via `startDragging`, edge resize, the non-mac `WindowControls` variant, and the title-bar double-click default off macOS. Keep the top-left corner placement TitleBar.svelte already decided.
- [ ] Bundling: `bundle.targets` produces AppImage + deb with `gavin-daemon` and `gavin-mcp` shipped beside the app binary (`externalBin`, spec 2026-08-24 §2). `resolve_daemon_binary_path` and `resolve_mcp_binary_path` find them, and the absolute gavin-mcp path written into agent configs is valid.
- [x] Dev tooling: `app/vite-cache-guard.sh` is zsh. Port it to POSIX sh or mark it macOS-only in a header comment; confirm `beforeDevCommand` runs under bash.
- [x] CI: the repo's first GitHub Actions workflow, an `ubuntu-latest` job running `cargo test --workspace`, `npm test`, `npm run check`, `npm run build`, re-running `gavin::tests` alone before a failure counts. This is what keeps Linux green afterwards.
- [ ] Verification on a Linux VM: launch, spawn a shell, run a card, restart the daemon from Settings, delete a workspace to trash, open a `~/` path under the cursor. Record results on this card.

**Out of scope:** Windows; Wayland polish beyond "it launches and resizes"; any installer beyond what Tauri bundles.

<!-- gavin:auto-commit -->
When the implementation is done, commit it. Commit only the files you touched — never `git add -A`. Do not push.
<!-- /gavin:auto-commit -->
