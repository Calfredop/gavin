---
order: 29696
kind: task
title: "[perf] end_orphan waits 2 s per orphan on the main thread"
labels: bug
parent: perf-main-thread-command-audit.md
status: Done
---
`end_orphan` (app/src-tauri/src/session.rs:3283) blocks the main thread while
the daemon waits up to 2 s for an orphan to exit — and app close calls it once
per orphan, in sequence.

## Evidence (2026-09-26)

- Daemon `EndOrphan` (crates/daemon/src/server.rs:2326-2366) sends SIGTERM,
  then polls `still_running` every 25 ms up to `ORPHAN_EXIT_GRACE` = 2 s
  (:1108), on the connection's thread. An orphan already survived SIGHUP,
  so one that ignores SIGTERM is the expected case, not an edge case.
- `endEverySession` (app/src/lib/shell/appClose.ts:162-176) calls it per
  orphan in sequence, then `killSession`: N stubborn orphans = N × 2 s of
  beachball at close. Also orphanActions.ts:41 (badge) and
  sessionsManagerActions.ts:210.
- The 2 s wait is deliberate (memory: its answer IS whether the process
  refused) — keep the semantics, move the waiting.

## Fix

Depends on the command-connection card: moved off the main thread alone it
would hold the shared `CommandConnection` mutex for 2 s and freeze every
still-sync daemon command instead. Either move it with that family, or give
it its own short-lived connection (with the token Hello — `EndOrphan` is
privileged, server.rs:4872-4879). For the close sweep, end orphans in
parallel. Ordering is safe: callers await in sequence and a double call is
harmless (server.rs:2330-2337).

## Verify

A daemon test with an orphan that ignores SIGTERM: N of them end in ~2 s
total, not N × 2 s, and the app stays responsive meanwhile.
