---
order: 19456
kind: task
title: "[perf] Git actions run git, hooks and signing on the main thread"
labels: bug
parent: perf-main-thread-command-audit.md
status: Done
---
Every Git-tab action is a plain `fn` command, so git — and whatever git runs:
hooks, commit signing, LFS — runs on the main thread. Three of them have no
timeout at all.

## Evidence (2026-09-26)

- Commands (app/src-tauri/src/git/commands.rs): `git_stage_files` :599,
  `git_unstage_files` :604, `git_stage_all` :609, `git_unstage_all` :614,
  `git_apply_patch` :619, `git_discard_files` :624, `git_commit` :629,
  `git_checkout` :529, `git_create_branch` :534, `git_merge` :549,
  `git_abort_in_progress` :554, `git_continue_rebase` :559,
  `git_stash_push/pop/apply` :574-584, `git_checkout_commit` :174,
  `git_cherry_pick` :179, `git_revert` :184, `git_reset` :189,
  `git_continue_in_progress` :194; plus `git_discard_run`
  (git/runchanges.rs:435: `reset --hard` + a trash per untracked path).
- Each press = its own git + `run()`'s refresh tail (14 processes, see the
  refresh card) + a second watcher refresh ~300 ms later (`.git/index` is
  relevant): 0.7–1.3 s per click with no hooks at all.
- `git_commit`, `git_merge`, `git_revert` and the checkout family run
  pre-commit / commit-msg / post-* hooks, gpg/ssh signing (a pinentry or
  1Password Touch ID prompt appears while the app is frozen) and git-lfs
  smudge (network). All sit under `run_git`'s 10 s SIGKILL (git/run.rs:37),
  which fails the action, orphans hook grandchildren, and can leave
  `index.lock` or a half-written tree.
- `git_cherry_pick`, `git_continue_in_progress`, `git_continue_rebase` go
  through `run_git_env` (git/run.rs:178-196): `.output()` with NO timeout
  and no cancel — unbounded on the main thread.
- The rail branch switch runs `git_status` + `git_checkout` unattended on a
  scheduler tick (orchestrationState.ts:1687-1704), then a full refresh.

## Fix

- All of them `async` + `spawn_blocking` (owned args, `Result` already;
  no `State` to thread through).
- Give `run_git_env` a deadline and a kill path like `run_git`. For
  commit-type operations consider a longer deadline plus the existing
  cancel mechanism (`git_cancel_op`) rather than a 10 s kill that leaves
  `index.lock` behind.
- Ordering is safe: `runWithReason` (app/src/lib/git/gitState.ts:408) holds
  `busy` for the whole operation, the toolbar disables on `locked`
  (GitToolbar.svelte:52), and `runBlocker` refuses a second press. The rail
  switch runs inside the per-workspace `ticking` guard.

## Verify

Add them to `OFF_MAIN_THREAD` in
`app/src/lib/guards/mainThreadCommands.test.ts` (red first). A Rust test
that `run_git_env` kills a command that outlives its deadline (a hook that
sleeps). Then commit in a repo with a slow pre-commit hook (`sleep 5`) and
confirm the window stays live.

- [ ] Human test: In an app built from perf/main-thread-commands, in a repo whose pre-commit hook is `echo checking >&2; sleep 15`: press Commit and type into a terminal meanwhile — the window stays live and after ~0.3 s the op bar shows "Commit… checking" with Cancel; press Cancel — the banner says "Commit cancelled" and no .git/index.lock remains. A plain commit or branch checkout shows no op-bar flash.

## Done (2026-09-26)

- Every Git-tab action in git/commands.rs is `async` + `off_main_thread`:
  the card's list, plus `git_delete_branch`, `git_stash_drop`,
  `git_add_remote`, `git_remove_remote` and `git_init` (all behind
  `run()`, same ordering argument), and `git_discard_run`. Worktree and
  conflict commands are left to their own cards.
- git/run.rs has one local runner, `run_local`, used by both `run_git` and
  the new `run_git_action`. `run_git_env` is gone: its two callers
  (cherry-pick, `--continue`) now go through `run_git_action` with
  `GIT_EDITOR`, so the env path has a deadline and a kill path.
- Git spawns as its own process-group leader (unix). A stop, on the
  deadline or on cancel, sends SIGTERM to the group, waits up to 2 s, then
  SIGKILLs the group. On TERM git removes its lock files. SIGKILL cannot be
  handled, so it left `index.lock` behind. Signalling the group also stops
  the hook git was waiting on, which a kill of git alone left orphaned.
  Windows still kills git alone.
- Hook-running actions (commit, merge, revert, cherry-pick, both
  continues, checkout, checkout-commit, create-branch) run under
  GIT_OP_TIMEOUT (600 s), not 10 s. They register in `GitOps` under the op
  bar's id (`ops::RunningOp`), so `git_cancel_op` reaches them, and their
  stderr (where git puts hook output) streams as `git-op-progress`. The
  registry now holds cancel flags, not children. `git_cancel_op` only sets
  the flag and the runner does the stopping, so the main thread never
  waits on a dying git. Fetch/pull/push get the same group stop.
- Frontend: `runAction` in gitState.ts, used by commit, merge, merge-back,
  revert, cherry-pick, the continues, checkout, checkout-commit and
  create-branch, sets both `busy` and `op`. The op bar shows the action
  with the hook's line and Cancel. A cancel reads "<label> cancelled".
  GitOpBar only appears once an op has run 300 ms, so fast actions don't
  flash it.
- The rail's branch switch passes no op id: it runs silent and cannot be
  cancelled. It is now bounded by 600 s, not 10 s, so a slow LFS checkout
  no longer dies halfway.
- Found on the way: git releases `index.lock` BEFORE pre-commit on a commit
  of the index as it stands, when the refresh changed nothing. The lock is
  held through the hooks for `commit -a`, merge, cherry-pick and checkouts,
  and the tests use `commit -a` for that reason.
- Not covered: on an ssh workspace an action runs on the host through
  `RunGit`/`RunGitEnv`, with no cancel or progress. The host daemon's
  `run_git` still kills at 10 s, and its `run_git_env`
  (crates/daemon/src/gavin.rs) has no deadline at all. That is daemon
  side, so it needs a protocol-aware card (see the ssh-routes card).
- Tests: guard list +27 commands (red first). run.rs: an action past its
  deadline stops its hook's child and leaves no `index.lock` (asserting
  the lock WAS held); a cancelled action does the same, says "cancelled"
  and streamed the hook's lines; `read_lines`; streaming cancel by flag.
  ops.rs: registry lifetime and id reuse. Mutation-checked: with git
  killed alone the hook survives, and with a group SIGKILL and no TERM
  `index.lock` is left behind; both tests go red. gitState: 4 new cases.
- Checks: `cargo test` (app) 563 passed; `npm test` 293 files / 6518
  passed; `npm run check` 0 errors; `npm run build` ok; clippy has nothing
  on the touched code. The Windows cross-check of the app crate cannot
  run from this Mac (`ring` needs MSVC). Every signal path is
  `cfg(unix)`.
