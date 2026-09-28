---
order: 21504
kind: task
title: "[perf] Conflict resolution runs ~15 git processes per click"
labels: bug
parent: perf-main-thread-command-audit.md
status: Done
---
`git_conflict` (app/src-tauri/src/git/conflict.rs:234) runs ~14–16 git
processes on the main thread, and it re-runs on every refresh while a `U`
path is selected and after every resolve click.

## Evidence (2026-09-26)

- `git_conflict`: `ls-files -u`, 3× `show`, then `labels()` calls the whole
  `repo_info` again (conflict.rs:78, 7 processes) plus `symbolic-ref` and
  `rev-parse` that `repo_info` already ran, plus `name-rev`/`log`: ~0.6–1.3 s
  in the app, more with `name-rev` on big histories.
- Each resolve — `git_mark_resolved` :239, `git_resolve_whole` :244,
  `git_resolve_deleted` :249, `git_restore_conflict` :254 — is its own git
  + `run()`'s refresh (14) + a `git_conflict` reload (~14): ~1.5–2.5 s per
  click. `stageFiles` loops `git_mark_resolved` per `U` path.

## Fix

- All five `async` + `spawn_blocking` (owned args, `Result` already).
- Have `labels()` reuse one `repo_info` result instead of re-running it and
  the duplicate rev-parse calls.
- Ordering: `loadConflict` is guarded by `conflictToken`
  (app/src/lib/git/gitState.ts:1429-1440); resolves run under `run()`'s
  `busy`.

## Verify

Add the five to `OFF_MAIN_THREAD` in
`app/src/lib/guards/mainThreadCommands.test.ts` (red first). A conflict.rs
test that `labels()` spawns no second `repo_info`. Then resolve a merge
conflict with `sample` running.

- [ ] Human test: In an app built from perf/main-thread-commands, merge a branch that conflicts in two files. With `sample <Gavin pid> 30 1 -file /tmp/conflict.txt` running, select one U file, click "Use ours" on it and "Mark resolved" on the other after editing out its markers. The window should stay responsive during each click, and the sample should show no `app_lib::git::conflict` frames on the main thread. Then click quickly between a U file and a plain file: the merge editor should never show one file's conflict while another is selected.

## Done (2026-09-26)

- All five conflict commands in git/conflict.rs (`git_conflict`,
  `git_mark_resolved`, `git_resolve_whole`, `git_resolve_deleted`,
  `git_restore_conflict`) are `async` + `off_main_thread`.
- `labels()` no longer calls `repo_info`. It reads the git dir and HEAD's
  branch itself and gets `in_progress` from the git dir's state files via
  `in_progress_at`, which is split out of `repo_info` in git/commands.rs
  and shared by both. A merge's labels went from 8 processes to 3, so a
  conflict load is now 7 instead of 12. That is 5 fewer on every refresh
  while a `U` path is selected and on every resolve's reload. It is also
  two fewer ways to fail: an `author` config error or a failed `log -1`
  used to fail the whole conflict load.
- The card said the frontend's ordering was already guarded, but it
  wasn't completely. `loadDiff` cleared `conflict` (on a plain file or an
  empty selection) and `diff` (on a `U` file) without bumping their
  tokens, so a load started for the previous selection could still land
  after the clear. The frozen main thread used to hide this. Now clearing a
  pane bumps its token, and `loadConflict` drops another file's conflict
  while the new one loads. The merge editor's buttons act on the selected
  path, so without that, "Use ours" could name one file in its dialog and
  resolve another. The same file's conflict stays up during a refresh, so
  there is no "Loading" flash. The `diff` half of this was a gap left by
  the Git-view refresh card, fixed here because it is the same function.
- Test seam: `git_calls_of` in git/run.rs (cfg(test), thread-local) records
  the git command lines that `run_local` spawns during a closure. It is
  per thread, so parallel tests don't count each other's calls.
- Tests: guard list +5 commands (red first: 5 failures).
  `labels_run_no_second_repo_info` pins a merge's labels to exactly
  rev-parse, symbolic-ref and name-rev (red first: the old code ran 8, with
  `symbolic-ref` twice). gitState: 5 new cases under "answers that arrive
  after the selection moved on". 4 were red first. The fifth, same-file
  refresh keeps its conflict, pins the no-flash behaviour.
- Checks: `cargo test -p app` 564 passed; `npm test` 293 files / 6528
  passed; `npm run check` 0 errors; `npm run build` ok; clippy has nothing
  on the touched code.
- Not covered: `repo_info`'s and now `labels`' `in_progress` checks the
  git dir with a local `Path::exists`. On an ssh workspace that is the
  host's path checked on the desktop. This was already true of
  `repo_info` before this card, but `labels` inherited it; it used to get
  the same wrong answer from `repo_info`. The ssh-routes card is where it
  belongs.
- Filed by hand: `gavin_request_human` needs daemon protocol v42 and the
  running daemon is v41.
