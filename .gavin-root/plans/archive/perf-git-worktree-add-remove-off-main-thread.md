---
order: 20480
kind: task
title: "[perf] Worktree add and remove run on the main thread"
labels: bug
parent: perf-main-thread-command-audit.md
status: Done
---
`git_worktree_add` (app/src-tauri/src/git/commands.rs:249) checks out a whole
tree and `git_worktree_remove` (:254) deletes one, both on the main thread,
and both are called in loops.

## Evidence (2026-09-26)

- Add: 0.32–0.43 s measured for 1,460 files, more with post-checkout hooks
  or LFS. Best-of-N creates N worktrees in sequence, each followed by a
  refresh (app/src/lib/cards/bestOfNActions.ts:199). The 10 s kill leaves a
  half-populated worktree still registered.
- Remove: deletes ignored build output too — this repo's worktrees hold
  ~28–30k files and 4–6.6 GB each (target/, node_modules/); unlinking 30k
  small files took 2.7 s here. Then watchman `watch-del` with a 5 s cap
  (memory.rs:449, :384). The sweep (gitState.ts:1355) and best-of-N
  discard (:1406) call it N times in sequence.

## Fix

Both `async` + `spawn_blocking` (owned args, `Result` already). Callers are
sequential `await` loops under `busy`, so ordering is safe. Consider
reporting progress for N-way sweeps, since they will now visibly take time
instead of freezing.

## Verify

Add both to `OFF_MAIN_THREAD` in
`app/src/lib/guards/mainThreadCommands.test.ts` (red first). Then sweep two
worktrees that hold a `target/` and confirm the window stays live.

## Outcome

- Both commands are `async` on the blocking pool; pinned in `OFF_MAIN_THREAD`. The guard's regex now also sees past an attribute between `#[tauri::command]` and the `fn`, since `git_worktree_add` carries `#[allow(clippy::too_many_arguments)]`.
- A correction to the evidence above: since 0f24eea1 the 10 s deadline sends SIGTERM to the process group, not SIGKILL, and git's `worktree add` answers a TERM during the checkout by deleting the half-made folder and its registration (checked by hand: SIGKILL leaves both behind, SIGTERM leaves neither). What 10 s still broke was a slow post-checkout hook, or a large remove, cut off part-way. Both now get the 600 s op ceiling.
- Add is a cancellable op, like a checkout. Remove has no Cancel: git has no cleanup for a remove stopped part-way.
- Single remove, sweep and best-of-N discard show in the op bar: "Remove worktree… <folder>" or "Sweep worktrees… 2 of 5: <folder>". Best-of-N's fork and discard run from the card or hub, so the bar only shows if the Git tab is open.

## Progress

- [x] Red: both commands in `OFF_MAIN_THREAD`
- [x] `git_worktree_add`: async + off the main thread, through `run_git_action` under the op bar's id (600 s ceiling; a stop is a TERM, which git answers by deleting the half-made checkout)
- [x] `git_worktree_remove`: async + off the main thread, 600 s ceiling, no cancel (git has no cleanup for a remove stopped mid-delete)
- [x] App: forks run as an op; removes (single, sweep, best-of-N discard) show in the op bar with "n of N: <folder>" and no Cancel
- [x] Suites: cargo tests for git::commands, app npm test + check
- [x] Sweep two worktrees holding a `target/`, timing the removes off the main thread: 30k files each, `git worktree remove` took 2.54 s and 2.21 s, about 4.8 s of window freeze per two-worktree sweep before this change
- [ ] Human test: In an app built from perf/main-thread-commands, fork two worktrees whose branches are merged and give each a target/ of ~30k files (a cargo build in each will do). Then run the worktree switcher's Sweep with `sample <Gavin pid> 20 1 -file /tmp/sweep.txt` running, and type into a terminal while it runs. The window should stay live. The op bar should show "Sweep worktrees… 1 of 2: <folder>" and then "2 of 2: <folder>", with no Cancel button. The sample should show no `app_lib::git::commands::git_worktree_remove` frames on the main thread.
