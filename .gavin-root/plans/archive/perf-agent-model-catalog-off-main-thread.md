---
order: 26624
kind: task
title: "[perf] agent_model_catalog runs `opencode models` at startup"
labels: bug
parent: perf-main-thread-command-audit.md
status: Done
---
`agent_model_catalog` (app/src-tauri/src/agent_models.rs:72) spawns
`opencode models` on the main thread during bootstrap.

## Evidence (2026-09-26)

- `resolve_all` runs `opencode models` (agent_models.rs:163) with a 15 s
  timeout (:51), a 2 s receive timeout (:270) and a 50 ms sleep-poll
  (:265). `opencode --version` alone takes 0.41–0.85 s here, so expect
  ≥0.5 s, up to ~17 s. Memoized per process (:64): once per launch.
- Trigger: bootstrap (app/src/lib/core/layoutState.ts:1474-1482). It lands
  in the same first seconds as the first `agent_usage` poll and
  `watchman_status` — together ~2–4 s of frozen UI at launch.

## Fix

`async` + `spawn_blocking`. No args, so it can keep returning the
`HashMap` (a `JoinError` maps to an empty map). The frontend already treats
the catalogue as a late second publish, so there is no ordering risk.

## Verify

Add it to `OFF_MAIN_THREAD` in
`app/src/lib/guards/mainThreadCommands.test.ts` (red first), then `sample`
the first 10 s after a launch.

## Done (2026-09-26, uncommitted on perf/main-thread-commands)

- `agent_model_catalog` is `async` + `spawn_blocking`. It is in
  `OFF_MAIN_THREAD`, which failed first (1 red) and now passes. It still
  returns the `HashMap`, and a `JoinError` maps to an empty map, the same
  "nothing" every other failure there answers. The memo body moved
  unchanged into `cached_catalog`, which runs on the pool.
- The memo's `Mutex` stays and now matters more. The main thread used to
  serialize two racing bootstraps; on the pool the lock is the only thing
  that does, so they still get one `opencode models` run and one answer.
  Its doc comment says so.
- Measured cost of what moved: `opencode models` from the temp dir with
  `NO_COLOR` and a null stdin, the way the host runs it, took 1.11-1.62 s
  over five runs here (485 lines). That is the window freeze each launch
  used to take, plus up to 50 ms from the sleep-poll.
- The 50 ms sleep-poll in `run` was left as it is. It is on a pool thread
  now, once per launch, so it freezes nothing. The fix the watchman card
  used (`stdout_by_deadline` in memory.rs) would work here too, but that
  is a cleanup, not part of this fix.
- No frontend change. layoutState.ts already publishes the catalogue as a
  second set after the static table, so an answer that arrives later
  changes nothing.
- Checks: `cargo test -p app` (575 passed), `npm test` (6545), `npm run
  check` (0 errors) all pass.

- [ ] Human test: In an app built from perf/main-thread-commands, with opencode installed, launch it and run `sample <Gavin pid> 10 1 -file /tmp/catalog.txt` straight away. The sample should show no `app_lib::agent_models::agent_model_catalog` frames on the main thread. Once it loads, the opencode profile's model picker should still list opencode's own models.
