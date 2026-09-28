---
kind: plan
title: "[fix] The app freezes for seconds while it asks GitHub about PRs"
labels: bug
status: Done
---
The window beachballs for 3–10 s at a time, several times a minute: typing
into a terminal stalls and replays when the freeze lets go, while the tab
spinners keep turning (Core Animation composites them off the main thread).

## Measured, 2026-09-26

`sample <app pid> 60 1` on the running dev app, main-thread samples grouped
by Tauri command: `pr_status` 12.3 s of 60, `git_run_changes` 1.3 s,
`watchman_status` 0.4 s, everything else under 0.1 s.

A `ps` loop over the app's children for 75 s logged 19 `gh pr view` calls,
all `region/*` branches of the mushma workspace, in two unbroken runs:
10:27:05–08 (5 calls) and 10:27:21–30 (14 calls, a ~9.5 s freeze). Each
`gh` is a GitHub round trip, 0.45–1.3 s measured.

## Why

1. `pr_status` is a plain `fn` command, so Tauri runs it on the main thread
   and every `gh` round trip is frozen-window time.
2. prState.ts's 15 s sweep fires every expired key in one loop; serialized
   on the main thread, their latencies add into one freeze.
3. The scheduler renews PR interest for every rail that carries a `pr` step
   at all, in every loaded workspace, so mushma's 19 await-pr rails (5
   done, 14 never started) were polled once a minute indefinitely — about
   1,100 GitHub requests an hour.

## Steps

- [x] Run `pr_status`'s `gh` probe on the blocking pool (`async` +
      `spawn_blocking`); the cache read stays inline
- [x] Keep a rail's PR poll alive only while its `pr` step is running or
      mid-loop (re-armed after a failure, whose retry prompt reads the
      live report); a pure predicate with unit tests, used by the scheduler
      (`wantsPrPoll`, orchestrationLoop.ts)
- [x] Move `git_run_changes` off the main thread the same way
- [x] `cargo test` for app/src-tauri, app `npm test` + `npm run check`
      (+ `guards/mainThreadCommands.test.ts`, which pins the slow commands
      as `async` + `spawn_blocking`)

## After the fix, same measurement on the relaunched app

`gh` calls in 70 s: 19 → 0. `pr_status` on the main thread: 12.3 s → 0.

The next layer, a settled 60 s sample three minutes after launch, ~7.8 s
of main thread still blocked: `git_repo_info` 3.0 s, `git_refs` 1.9 s,
`agent_usage` 1.6 s (the usage probe's HTTP call), `git_status` 0.7 s,
`git_merge_tool_name` 0.4 s. One Git-view `refresh()` is ~12 `git`
processes at 45–90 ms each, ~0.6 s frozen, about twelve a minute; queued
refreshes chain. `refresh()` already drops a superseded answer
(`refreshToken`), so these can move off the main thread the same way.
Not done here — awaiting the owner's go-ahead.
