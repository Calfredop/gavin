---
kind: task
title: Companion 13: the desktop app answers forwarded commands
status: Done
labels: ready-for-agent
parent: companion.md
complexity: intricate
---
Blocked by: companion-12-daemon-forwards-commands.md

Part of `companion.md`. Read the spec (section "Forwarding to the desktop app") and ADR 0003 first.

## What to build

The Tauri host's side of forwarding.

- **The connection.** Open the forwarding connection to the daemon.
- **The dispatcher.** Map a command name plus JSON arguments to the **same handler functions** the webview's `invoke` reaches.
- **Events.** Offer every event the host emits to its webview to the forwarding connection as well.

The key test: **the command table's keys equal the host's registered command set**, so adding a command without a Remote-role entry fails.

Traps:
- Any save under the Tauri host rebuilds and relaunches the owner's dev app, so batch your Rust edits.
- `tauri-build` validates `externalBin` in the build script.

## Acceptance criteria (seam 3)

- [x] Dispatch tests show a forwarded call reaching the same handler as the webview's `invoke`
- [x] The table-equals-registered-commands test fails when an entry is missing
- [x] An emitted event reaches the forwarding connection
- [ ] The test Device, through a local Relay and a running dev desktop, invokes a real read command and gets its result
- [ ] Human test: With remote access on against a local Relay, a paired test Device (or the Companion), and the running dev desktop: InvokeDesktop get_theme_pref (or get_board for a known workspace) and confirm the real handler result returns — not "desktop app not running".
