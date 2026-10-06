---
order: 16384
kind: task
title: "[perf] One non-reading terminal can stall every terminal's input"
labels: bug
parent: perf-main-thread-command-audit.md
status: Done
---
Typing into terminals goes app → `write_input` (app/src-tauri/src/session.rs:4662)
→ one write on the streaming socket (`send_request`, :2569) → the daemon's
SINGLE loop for that connection (crates/daemon/src/server.rs:5379) → a
synchronous `write_all` into the session's PTY (server.rs:3044). One program
that stops reading stdin blocks that loop for every session.

## Evidence (2026-09-26)

- Measured: a macOS PTY in raw mode (what agent TUIs use) accepts 1022
  bytes and then blocks while the program is not reading stdin (canonical
  mode took 1 MB).
- So a paste over ~1 KB into a wedged or busy raw-mode program parks the
  daemon's streaming loop: every other session's keystrokes, resizes,
  Attach and Snapshot queue behind it — typing stalls in ALL terminals.
- Once ~8 KB of socket send buffer (macOS AF_UNIX = 8192, measured) plus
  the daemon's ≤8 KB `BufReader` (server.rs:5169) fill, `write_input` and
  `resize_session` block the app's MAIN thread until that program reads.
- `send_queued_input` (session.rs:4756) writes the PTY on the
  command-connection thread (server.rs:3101-3120) and the app waits for
  the reply, so it freezes the main thread without any buffer filling —
  and it is the "send anyway" override, used exactly when an agent looks
  stuck.

## Fix

- **Daemon:** give each session its own PTY writer (a queue + thread, or
  non-blocking writes with a per-session buffer) so one non-reading program
  cannot head-of-line block the others. Deliver queued input the same way.
- **App:** keep `write_input` / `resize_session` / `snapshot_session`
  SYNC, but make `send_request` push onto an unbounded FIFO drained by a
  dedicated writer thread per connection (local + each ssh link). Do NOT
  use `async` + `spawn_blocking`: the blocking pool does not preserve
  order, keystrokes would reorder, and TerminalPane.svelte:62 relies on
  `fit().then(restoreScreen)` putting Resize before Snapshot.

## Verify

A daemon test: session A runs a raw-mode program that never reads; write
4 KB to A, then 1 byte to session B — B's byte arrives promptly. An app
test that `send_request` returns without waiting on a stalled peer and
preserves order.
