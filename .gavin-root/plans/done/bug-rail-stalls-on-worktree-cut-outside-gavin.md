---
kind: task
labels: bug
title: "[bug] A rail bound to a worktree cut outside gavin stalls as \"worktree is gone\""
status: Done
priority: high
complexity: moderate
---
A rail bound to a worktree that exists on disk and in `git worktree list` stalls at its first step with `worktree <path> is gone`, then pauses. Start, Retry and `gavin_start_rail` can't get past it. The gavin-orchestrate skill tells agents to cut worktrees by hand into `.gavin-worktrees/`, so every Organize run that follows the skill can hit this.

## Observed (2026-10-30, workspace arena-roguelike, desktop app on the Mac, driven from the Companion)

- An agent following the gavin-orchestrate skill ran `git worktree add -b build/art .gavin-worktrees/build-art build/vertical-slice` in the root checkout, then sent the rail with `worktreePath: <root>/.gavin-worktrees/build-art` and `branch: build/art` via `gavin_set_orchestration`.
- `git worktree list --porcelain` from the root lists `worktree /Users/coalpila/CloudStation/Coding/arena-roguelike/.gavin-worktrees/build-art`, byte-for-byte the rail's `worktreePath`. The folder, its `.git` file and `.git/worktrees/build-art/` are all intact, and it is clean.
- Every Start immediately records in `orchestration.sqlite`: `orch_step_runs` `<first step>|stalled||worktree … is gone`, and `orch_rail_runs` `paused`. No session is launched.
- These did **not** clear it:
  - a Git-tab refresh from the Companion app;
  - creating and deleting a branch in the root checkout;
  - the dev refreshing again, followed by the rail re-sent under fresh rail and step ids and started.
- Not yet tried: quitting and reopening the desktop app.
- Second problem: `gavin_start_rail` refuses a paused rail ("resume it yourself"), and a Resume or Retry from the Companion did not launch either. So the only way an agent could unpause was to re-send the rail under fresh ids, and that just stalled again.

## Where it comes from (read, not yet verified by a repro)

- `launchBlocker` (`app/src/lib/orchestration/orchestration.ts:1175`) returns "is gone" when `knownWorktrees` (built at `:1879` from `refs.worktrees`) lacks `rail.worktreePath`.
- `runTick` (`app/src/lib/orchestration/orchestrationState.ts:2691`) takes `worktrees` from the desktop app's `gitStore[workspaceId].refs.worktrees`.
- That snapshot is filled only by `refreshPass` in `app/src/lib/git/gitState.ts` (via `git_refs`, which runs `git worktree list --porcelain`). Refresh is "watcher/activation/mutation-driven — never a timer".
- The git watcher deliberately ignores `.gavin-worktrees/` and, inside `.git/`, everything but HEAD, refs, index and similar, so `.git/worktrees/<name>/` too (`app/src-tauri/src/git/watch.rs:48`, `is_relevant`). A `git worktree add` run from a shell therefore never triggers a refresh, and the scheduler judges against a stale snapshot.
- Open question: why a Companion-side Git refresh didn't update the desktop's snapshot. Maybe the Companion refreshes its own view only, or the desktop's gitStore for the workspace is keyed to another cwd or has no live view.

## What to fix

- [x] Reproduce: open a workspace, cut `.gavin-worktrees/x` with `git worktree add` from a shell, bind a rail to it, and Start. It should stall with "is gone".
  Reproduced in the scheduler suite rather than the running app: a refs snapshot without the checkout stalls the step with the exact reason. The live rows agree: `rail-art3`'s stored `worktree_path` is byte-identical (hex-compared) to the path `git worktree list` prints, so this is no path mismatch.
- [x] Before `launchBlocker` declares a worktree gone, the scheduler re-reads `git worktree list` itself (or forces a refs refresh and waits a tick). A missing path in a cached snapshot must never stall a rail on its own.
  `runTick` now asks `worktreesStalledAsGone` which checkouts the pass would stall as gone, re-reads them with `git_refs` on the view's cwd, and when git lists one, decides the whole pass again on the fresh list (`branchSwitchFor` reads it too) and kicks a Git refresh so the tab and the rail's warning catch up. A stall pauses the rail, so a worktree that really is gone costs one `git worktree list` per press of Play. If git cannot answer, the snapshot's verdict stands.
- [x] Make a Git refresh from the Companion reach the desktop app's `gitStore`, or make the scheduler independent of it.
  Independent. The open question's answer: the Companion runs its own `gitState` in the phone's webview, so its refresh only refreshes the phone's copy. And the desktop's own watcher (`startWatching`) is armed only while that workspace's Git tab is mounted (`GitHubView.svelte`), which is also why creating and deleting a branch changed nothing.
- [x] Decide whether `gavin_start_rail` (or a new tool) may resume a rail paused by a launch blocker that no longer holds, as opposed to a human pause or a failed session. Today an agent's only workaround is re-sending the rail under fresh ids.
  Decided: no, the refusal stays. A stall writes `session_id` null whether the step never launched or its session died, so the plan cannot tell a launch-blocker pause from a failed run without matching reason strings across the TS and Rust twins of `startRailVerdict`. And the pause is the human's gate by design. What made the workaround necessary was the stale snapshot: with it gone, the human's Resume or Retry (desk or Companion) re-derives the blocker against git and launches.
- [x] A test: a rail bound to a worktree created outside the app launches its first step.
  `orchestrationState.test.ts`, "a rail bound to a worktree the refs snapshot has not seen": launches when git lists it, still stalls when git agrees it is gone, keeps the verdict when git fails, and asks git nothing when the snapshot already has it. The launch case fails with the re-read disabled. Plus `worktreesStalledAsGone` in `orchestration.test.ts`.
- [ ] Human test: In arena-roguelike, with the desktop app on this build and its Git tab NOT open, press Resume on the paused "art" rail: its first step launches a session in .gavin-worktrees/build-art instead of stalling "worktree … is gone"
