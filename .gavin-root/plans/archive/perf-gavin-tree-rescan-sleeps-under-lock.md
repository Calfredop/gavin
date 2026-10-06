---
order: 22528
kind: task
title: "[perf] get_gavin_tree waits on a rescan that sleeps under the lock"
labels: bug
parent: perf-main-thread-command-audit.md
status: Done
---
`get_gavin_tree` (app/src-tauri/src/session.rs:5571) asks the daemon for a
snapshot, and the daemon's snapshot waits on a lock the rescan holds across a
sleep of up to 2 s and a full scan.

## Evidence (2026-09-26)

- `GavinWatcher::rescan_and_push` (crates/daemon/src/gavin.rs:2706-2715)
  takes `inner`, computes `floor_wait`, `std::thread::sleep(wait)` (up to
  2 s) WHILE holding it, then `scan_root`, then pushes. The comment says why
  the whole sequence is under one lock: two flushes, or a flush racing the
  initial scan, must never interleave into an out-of-order emission.
- `snapshot()` (gavin.rs:2763) needs `inner` and does a full `scan_root`
  itself when the last scan is over 2 s old. Measured walks: gavin 45 ms,
  mandragora (152k entries) and arcadiaRN (142k) ~0.7–0.9 s, plus card
  reads (~250 ms cold).
- Worst case on a big repo: ~2 s sleep + scan + scan ≈ 3.5 s, and the app's
  command connection is held for all of it (see the command-connection
  card). Callers: PlanExplorerHubView.svelte:302/324/392/412/423/441 (user
  actions), HomeHubView.svelte:127 on mount with no tree.

## Fix

Keep the ordering guarantee, drop the sleep from under the lock: e.g. a
dedicated rescan thread per watcher that owns the debounce/floor timing and
takes `inner` only for scan + compare + emit; `snapshot()` returns
`last_tree` while a rescan is pending instead of scanning again. Or keep a
sequence number on emissions so order is enforced without holding the lock
through the wait.

## Verify

A gavin.rs test: with a rescan sleeping on its floor, `snapshot()` returns
within a few ms, and emissions stay in order under two racing flushes (the
existing HeuristicState-style tests are the model).
