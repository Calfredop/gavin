---
kind: task
title: Companion 06: keep-running mode
status: Done
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

- [x] Unit tests for the close decision (remote access on or off)
- [x] The idle-sleep hold is taken exactly while remote access is on and an agent is running
- [x] A measurement of scheduler tick timing with the window closed, written on this card, showing ticks on time
- [ ] Human test: After rebuilding the app from companion-desk-prep: with remote access on, close the main window — the ">G" menu-bar icon appears (Open Gavin / Quit Gavin both work, and a Dock click reopens), a running rail keeps advancing to its next step while the window is closed, and `pmset -g assertions` shows "Remote access is on and an agent is running" during an agent run (the Mac does not idle-sleep); with remote access off, closing still asks the old ladder.

When it works, file a human test: with remote access on, close the window; the menu-bar icon appears, a rail keeps advancing, and the Mac doesn't idle-sleep during an agent run.

## What was built (worktree `companion-desk-prep`, uncommitted)

- **Close.** `closeDecision` (`app/src/lib/shell/keepRunning.ts`): a workspace window closes, the main window with remote access on is **hidden** (`hide_to_menu_bar`, `keep_running.rs`) with a template ">G" status item: Open Gavin / Quit Gavin; with it off (or unknown: an old daemon) it asks the ladder as before. Hidden, not destroyed: the webview and its scheduler keep running, and a hidden window is still in the host's window list, so `runsRailsFor` still hands it its workspaces. A Dock click with nothing on screen reopens it. Tests: `keepRunning.test.ts`, `appWindowSurfaces.test.ts`.
- **Remote-access switch in every window.** Read once at bootstrap (`keepRunningState.ts`), kept current by a new `remote-access-changed` event `set_remote_access` emits. Settings says what "on" now does (`KEEP_RUNNING_NOTE`).
- **Idle sleep.** The duty window drives `set_sleep_hold`, an `NSProcessInfo` activity with `IdleSystemSleepDisabled` (shows in `pmset -g assertions` as "Remote access is on and an agent is running"). "Running" = an agent session (the memory poll's list, so never a plain shell) that is `working` or `waiting_for_input`: a question pending for the phone is exactly when the Mac must stay reachable. **One deliberate addition:** the hold outlives the last running agent by 2 minutes (`SLEEP_HOLD_LINGER_MS`), because an idle Mac sleeps moments after a hold drops, and an agent goes `idle` between rail steps (the launch queue alone spaces launches 20 s). Turning remote access off releases at once. Tests: `keepRunningState.test.ts` (fake timers), `layoutState.test.ts` (duty-gated).
- **Timers.** Every app window's WKWebView gets `inactiveSchedulingPolicy = none` **and** three WKPreferences SPI setters off (hidden-page DOM timer throttling, its auto-increase, visibility-based process suppression), each sent only if WebKit answers to it (`keep_timers_on_time`).

## Measurement: scheduler timing with the window closed

Method: an isolated app instance (own `$HOME`, own daemon, own vite origin) with a temporary probe (since removed) recording every `tick()` that passed the `runsRailsFor` gate, `setInterval(1000)` gaps, and the latency of daemon pushes from a stimulus agent session printing its own timestamp every 6 s. The probe closed the main window through the real `onCloseRequested` path; `pmset -g assertions` was sampled every 2 s.

**Throttling is real.** A bare WKWebView, window ordered out, 5 min: `setInterval(1000)` fires every 2000 ms (p50) with a 24–28 s stall ~37 s in; `evaluateJavaScript` (the path a Tauri event takes) max 27.5 s. In this app before the fix, closed and quiet: gaps up to 5.1 s, and 10.6 s once nothing was running.

**What fixes it, in this app** (four minutes closed and quiet, instances run side by side):

| switches | hidden `setInterval(1000)` p50 / p99 / max | late (>1.1 s) |
|---|---|---|
| private preferences only (4 runs) | 1100 / ~5300 / 6621 ms | 91–108 of ~188 |
| `inactiveSchedulingPolicy = none` only (2 runs) | 2000 / ~5000 / 7647 ms | every tick |
| both (3 runs) | 1004 / 1005 / 1006 ms | 0 of 239 |

Re-applying at page load or at hide, or holding an App Nap activity in the host, made no difference.

**Final build, full run** (phases driven by the probe):

| phase | `setInterval` p50 / max | push latency p50 / max | status push → scheduler tick | longest gap between ticks | idle-sleep hold |
|---|---|---|---|---|---|
| visible, remote off, agent running (60 s) | 1004 / 1005 ms | 500 / 5215 ms (see below) | 0 / 1 ms | 8.4 s | free 28/28 |
| visible, remote on (22 s) | 1004 / 1005 ms | 1579 / 1749 ms (same) | 0 ms | 4.4 s | taken |
| **closed to the menu bar, agent running (360 s)** | **1004 / 1005 ms** | **3 / 94 ms** | **0 / 1 ms** | **3.98 s** (the stimulus's own 4 s rhythm) | **held 174/174** |
| closed, agent stopped (149 s) | 1004 / 1005 ms | — | 0 ms | — | held ~120 s (the linger), then free |
| closed, remote off (20 s) | 1004 / 1005 ms | — | — | — | free 10/10 |

Ticks are on time with the window closed: every push reached the scheduler within a millisecond, and no timer slipped. The visible-phase delivery delay (pushes batched up to 5.2 s, 36–73 s after launch, while page timers stayed at 1004 ms) is the host's main thread busy with a fresh `$HOME`'s first launch; it cleared before the window closed and never recurred.

Not measured here: the display asleep or the screen locked; the human test below covers a real session.
