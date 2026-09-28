---
order: 30720
kind: task
title: "[perf] Git view refresh runs 14 git processes on the main thread"
labels: bug
parent: perf-main-thread-command-audit.md
status: Done
---
Move the Git view's read commands off the main thread, and make `refresh()`
single-flight so the move does not turn bursts into parallel storms.

## Evidence (2026-09-26)

- `refresh()` (app/src/lib/git/gitState.ts:320) awaits, in sequence,
  `git_repo_info` (git/commands.rs:639, 7 git processes, 8 detached),
  `git_status` (:644, 1), `git_refs` (:264, 5 — it calls `worktrees()`),
  `git_merge_tool_name` (git/conflict.rs:259, 1): 14 processes. Then it
  chains `git_diff` (:666, 1–2) when a file is selected, `git_log` (:164, 2)
  while History shows, `git_conflict` when a `U` path is selected.
- All are plain `fn` commands. Measured main-thread time with a Git view
  open: `git_repo_info` 2.9–3.0 s/min, `git_refs` 1.9–2.2 s/min,
  `git_status` 0.7–1.5 s/min, `git_merge_tool_name` 0.4 s/min.
- One refresh ≈ 300 ms of git measured from a shell, 0.6–1.3 s in the
  app: `run_git` waits with `try_wait` + `sleep(20ms)` (git/run.rs:94-106),
  rounding every process up to the next 20 ms tick.
- Triggers: GitHubView mount (GitHubView.svelte:74), every `git-changed`
  (gitState.ts:1505), after every `run()` (:447) and `startOp` (:1028),
  rail branch switch (orchestrationState.ts:1704), OrchestrationHubView
  mount, GitForkDialog. `refreshToken` only DISCARDS stale answers — every
  overlapping refresh still runs all 14 processes.

## Fix

1. Make `git_repo_info`, `git_status`, `git_refs`, `git_merge_tool_name`,
   `git_diff`, `git_log`, `git_commit_detail` (:169) and `git_diff_since`
   (git/runchanges.rs:423) `async fn … -> Result<T, String>` with
   `tauri::async_runtime::spawn_blocking(move || f(&cwd)).await.map_err(|e| e.to_string())?`.
   All take owned args and already return `Result`; a small helper keeps
   each to one line. Not `#[tauri::command(async)]`: that blocks a tokio
   worker for up to 10 s per process.
2. Single-flight `refresh()` per workspace: one in flight plus a "dirty,
   run again once" flag. Without it, an npm install's burst of
   `git-changed` launches ~180 git processes in parallel on the blocking
   pool.
3. Optional: replace run.rs's 20 ms sleep-poll with a blocking wait
   (`wait` on a thread + `recv_timeout`), and merge `repo_info`'s 7
   processes into ~2 (one multi-arg `rev-parse`, one `config --get-regexp`
   that also answers merge.tool).
4. `git_diff` / `git_diff_since` read all of stdout before the 2 MB check —
   cap the read.

Ordering is already guarded: `refreshToken`, `diffToken` (gitState.ts:308),
`logToken`, `detailToken`, `conflictToken`; runChangesState/reviewState use
`diffToken`.

## Verify

Add each command to `OFF_MAIN_THREAD` in
`app/src/lib/guards/mainThreadCommands.test.ts` first and watch it fail.
Unit-test the single-flight rule in gitState's tests. Then, with a Git view
open, `sample <Gavin pid> 60 1` and tally main-thread samples by command
(method on the parent card): the four should be gone from the main thread.

## Done, 2026-09-26 (branch `perf/main-thread-commands`, uncommitted)

- All eight commands are `async` and run on the blocking pool through one
  helper, `git::run::off_main_thread` (`spawn_blocking(work).await`). The
  guard lists all eight, and pins the helper itself as `spawn_blocking`.
  Seen red first: 8 failed.
- `refresh()` is single-flight per view, keyed by workspace AND cwd. A
  call during a pass queues one more pass, and every caller waits for that
  one, so a refresh after a mutation still reads the tree the mutation
  left. A burst of 12 during a pass costs 1 more pass (was 12). A worktree
  switch starts at once instead of queueing behind the old checkout's pass.
- Found on the way: the stale check compared tokens only, and a worktree
  switch restarts the new view's count at 0, so the old checkout's answer
  could land on the new view. `refreshPass` now also checks `cwd`. Pinned by
  a test that was red before the change.
- `git_diff` / `git_diff_since` read through `run_git_ro_capped`: at most
  MAX_DIFF_BYTES + 1 bytes kept, the rest drained unread so git still
  exits.
- Optional item 3, partly: `repo_info` runs 5 processes instead of 8
  (`rev-parse --show-toplevel --absolute-git-dir`,
  `rev-parse --verify --short HEAD`, one `config -z --get-regexp` for the
  author). A refresh is 12 processes now. `run_git`'s 20 ms tick is a
  1→20 ms doubling poll, not a blocking wait on a helper thread: that
  thread would own the child, so the deadline kill would have to go by pid
  to a process it may already have reaped. merge.tool was NOT folded into
  `repo_info`. It would change `RepoInfo`'s shape for one process a refresh.
- Checks: `cargo test -p app --lib` 548 passed. `npm test` 6481 passed.
  `npm run check` 0 errors. `npm run build` ok.
- Not run here: the live `sample`. The running app is the main checkout's
  binary, and a second instance shares WKWebView's localStorage with it.

- [ ] Human test: With this branch built and running and a Git view open, `sample <Gavin pid> 60 1 -file /tmp/git-view.txt`, then tally main-thread samples by the first `app_lib::git::` frame: `git_repo_info`, `git_refs`, `git_status` and `git_merge_tool_name` should not appear (they were 2.9-3.0, 1.9-2.2, 0.7-1.5 and 0.4 s/min)
