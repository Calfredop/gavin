---
order: 18432
kind: task
title: "[perf] superpowers_status runs `claude plugin list` on every Settings visit"
labels: bug
parent: perf-main-thread-command-audit.md
status: Done
---
`superpowers_status` (app/src-tauri/src/superpowers.rs:514) and
`superpowers_install` (:539) are plain `fn`s that spawn the `claude` CLI on
the main thread.

## Evidence (2026-09-26)

- Both share `run()` (superpowers.rs:241-306, a 20 ms sleep-poll at :295).
  Detection runs `claude plugin list --json` with a 10 s timeout (:357,
  :43) — measured 0.48–0.90 s here. Install runs `claude plugin install`
  (network) with a 180 s timeout (:47, :555), then a detect (:566): the UI
  is frozen for the whole install.
- Triggers: every Settings tab visit and every workspace/profile change
  while there (the view is destroyed on tab switch, SettingsHubView.svelte:139-162);
  Home tab visits for a workspace with no recorded mark
  (HomeHubView.svelte:186-198); SetupWizard (:61-83), AgentArmWizard and
  AgentChangeWizard on their superpowers step; the Install button
  (SuperpowersControls.svelte:68).

## Fix

- Both `async` + `spawn_blocking`, reading the `marks` value before
  spawning; return `Result<Status, String>` (required: they borrow `State`).
- Consider caching the detector result per (root, binary, profile),
  cleared by install or a mark change.
- Frontend ordering: Settings (`spToken`) and Home (`readToken`) are
  guarded; `SetupWizard.reread`, `AgentArmWizard.refreshSuperpowers` and
  `AgentChangeWizard.refreshSuperpowers` are NOT — add tokens.

## Verify

Add both to `OFF_MAIN_THREAD` in
`app/src/lib/guards/mainThreadCommands.test.ts` (red first). Then open
Settings with `sample` running on the app: no `superpowers_status` on the
main thread.

## Done (2026-09-26, uncommitted on perf/main-thread-commands)

- `superpowers_status` and `superpowers_install` are now `async` +
  `spawn_blocking` and return `Result<Status, String>`. Both are in
  `OFF_MAIN_THREAD`; the test failed first (2 red) and now passes. The
  status command reads the mark before handing off to the pool. The
  install command takes the `AppHandle` instead, because it reads the mark
  after the run, as the old code did. Its body is now a plain `install()`,
  which the new test calls directly.
- New: one machine-wide `RwLock` (`CLAUDE_PLUGINS`) around every `claude
  plugin` run. A check takes a read lock and an install takes the write
  lock. Before this change, the frozen main thread was the only thing
  keeping two runs apart. Now someone can leave Settings mid-install, come
  back to an Install button and click it again, which would start a second
  install against the user-global `~/.claude/plugins` cache. A check asked
  for during an install waits for it to finish, so Settings shows
  "Checking…" instead of racing the install. The install drops the lock
  before its own follow-up check. The test
  `claude_plugin_runs_never_overlap_an_install` uses a stand-in `claude`
  that logs when each run starts and ends. It failed first (the two
  installs interleaved) and passes steadily now: 5 of 5 runs, about 1.3 s
  each.
- No cache for the check's result. Off the main thread, a visit costs a
  background process and a moment of "Checking…", not a frozen window. A
  cached result would keep saying "not installed" after an install made
  outside gavin, from a terminal or Claude Code's own `/plugin`.
- The 20 ms sleep-poll in `run()` stays. The watchman fix (waiting on the
  pipe instead of polling) is only safe when the CLI starts no child that
  inherits its pipes, and nothing guarantees that for `claude`. Off the
  main thread, a delay of up to 20 ms freezes nothing.
- The frontend now ignores older answers. `SetupWizard.reread` has
  `rereadToken`, which also covers the two file bodies, since they land in
  the same `Promise.all`. `AgentArmWizard` and `AgentChangeWizard` have
  `spToken` in `refreshSuperpowers`. Each bumps its token before the
  root check, as Settings does.
- Checks: `cargo test --workspace` (all crates; app 575), `npm test`
  (6544), `npm run check` (0 errors, no warnings in the touched files),
  `npm run build`, and clippy (nothing in `superpowers.rs`) all pass.

- [ ] Human test: In an app built from perf/main-thread-commands, run `sample <Gavin pid> 10 1 -file /tmp/superpowers.txt`, then open a workspace's Settings tab and switch its profile once while the sample runs. The sample should show no `app_lib::superpowers` frames on the main thread, and the Superpowers row should show "Checking…" and then its usual state. Then press Install on a workspace without Superpowers, leave Settings and come back mid-install: the row should stay on "Checking…" until the install ends, then show its result (Verified when the install succeeds).
