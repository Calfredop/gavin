---
kind: task
title: Companion 06: keep-running mode
status: To Do
labels: ready-for-agent
parent: companion.md
complexity: complex
---
Blocked by: none (can start immediately)

Part of `companion.md`. Read the spec (section "The desktop app") and ADR 0003 first.

## What to build

- **Window close.** While remote access is on, closing the desktop window leaves the app running with a menu-bar icon (reopen the window, quit) instead of quitting. While it is off, closing quits, as today.
- **Idle sleep.** While remote access is on and at least one agent is running, the Mac must not idle-sleep.
- **Rail timers.** Measure whether the rail scheduler, which runs in the webview, keeps ticking on time with the window closed or hidden; WKWebView may throttle its timers. If it doesn't keep time, fix it: keep the webview alive and unthrottled, or drive ticks from the host.

Traps:
- A detached `Window.setTimeout` throws in WKWebView.
- The scheduler ticks only in a window showing the workspace, so a hidden window must still count.

## Acceptance criteria

- [ ] Unit tests for the close decision (remote access on or off)
- [ ] The idle-sleep hold is taken exactly while remote access is on and an agent is running
- [ ] A measurement of scheduler tick timing with the window closed, written on this card, showing ticks on time

When it works, file a human test: with remote access on, close the window; the menu-bar icon appears, a rail keeps advancing, and the Mac doesn't idle-sleep during an agent run.
