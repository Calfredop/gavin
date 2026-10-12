---
order: 15360
kind: task
title: "[perf] watchman_status and watchman_forget spawn the watchman CLI on the main thread"
labels: bug
parent: perf-main-thread-command-audit.md
status: Done
---
`watchman_status` (app/src-tauri/src/memory.rs:413) and `watchman_forget`
(:437) are plain `fn`s that spawn the watchman CLI. Measured 0.2–1.2 s of
main-thread time per minute.

## Evidence (2026-09-26)

- Both go through `watchman_command` (memory.rs:362-405) and `watchman_pid`
  (:251-265). `watchman --no-spawn --no-local watch-list` alone is 170–180 ms
  here; the `try_wait` loop sleeps 50 ms a turn (:399), so a call lands at
  ~200 ms. A wedged watchman costs the 5 s deadline (:46) plus a 2 s
  receive timeout (:404).
- Trigger: the memory poll reads watchman every 30 s per window
  (memoryState.ts:111, :158), with no host-side cache. Drop roots
  (SessionsManagerModal.svelte:94-99) calls `watchman_forget` once per root
  in sequence, then forces a status. `git::worktree_remove` also calls
  `forget_root`.

## Fix

- Both `async` + `spawn_blocking`. `watchman_status` borrows nothing and can
  keep returning `Option` (a `JoinError` maps to `None`); `watchman_forget`
  already returns `Result`.
- Replace the 50 ms sleep-poll with a blocking wait.
- Optional: speak watchman's JSON protocol over its unix socket instead of
  spawning the CLI each time.
- Frontend ordering is already safe: the `polling` flag
  (memoryState.ts:119, :150) prevents overlapping polls.

## Verify

Add both to `OFF_MAIN_THREAD` in
`app/src/lib/guards/mainThreadCommands.test.ts` (red first), then `sample`
the main thread across a 30 s poll.

## Done (2026-09-26, uncommitted on perf/main-thread-commands)

- `watchman_status` and `watchman_forget` are `async` + `spawn_blocking`.
  Both are in `OFF_MAIN_THREAD`, which failed first (2 red) and now
  passes. `watchman_status` still returns `Option`; a `JoinError` maps
  to `None`. `watchman_forget` now probes the pid once, not twice, by
  calling `forget_root` directly.
- The 50 ms sleep-poll is gone. The new `stdout_by_deadline` waits on
  the stdout pipe itself, which reaches end-of-file when the CLI exits,
  then only reaps the child. A child still running at the deadline is
  killed. The old worst case was the 5 s deadline plus a 2 s receive;
  it is now 5 s. Against this Mac's watchman, `watch-list` measured 217
  ms median with the old wait and 186 ms with the new one, with
  identical output. Three unit tests cover it: the whole stdout comes
  back past a pipe buffer, a non-zero exit returns `None`, and an
  overrun is killed at the deadline.
- The optional unix-socket protocol was skipped. Off the main thread, the
  CLI's ~180 ms runs on a pool thread every 30 s and freezes nothing.
  When the pidfile is missing, `pgrep` finds the server but not its
  socket, so the CLI would stay as a fallback: two paths for one read.
- A pre-existing gap, not fixed: `refreshMemory()` calls `poll(true)`,
  which returns early while another poll is in flight. So after Drop
  roots, if a regular poll happens to be running, the strip can list
  the dropped roots for up to 30 s. This change makes that slightly
  less likely, because forgets no longer hold up the poll's other calls
  on the main thread.
- Checks: `cargo test --workspace` (all crates), `npm test` (6542),
  `npm run check` (0 errors) and `npm run build` all pass.

- [ ] Human test: In an app built from perf/main-thread-commands, with watchman running, run `sample <Gavin pid> 40 1 -file /tmp/watchman.txt` across one 30 s memory poll and use Drop roots in the sessions manager once during it. The sample should show no `app_lib::memory::watchman_status` or `watchman_forget` frames on the main thread, and afterwards the watchman line should still show its memory and should no longer list the dropped roots.
