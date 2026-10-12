---
order: 27648
kind: task
title: "[perf] Every window runs its own pollers"
labels: bug
parent: perf-main-thread-command-audit.md
status: Done
---
Each workspace window runs the full `bootstrap()`, so app-wide pollers run
once PER WINDOW, and every main-thread cost they carry multiplies with the
number of open windows.

## Evidence (2026-09-26)

- app/src/routes/+page.svelte:320 calls `bootstrap()` in every window; the
  `isMainWindow()` check at :300 only gates the close prompt.
- `bootstrap()` (app/src/lib/core/layoutState.ts:1185) starts, with no
  main-window gate: the usage pause clock (:1386-1387 → `agent_usage` for
  every profile every 180 s), the memory poll (:1396-1397 →
  `list_managed_sessions` every 5 s, `watchman_status` every 30 s,
  `system_memory` every 5 s), and `initOrchestrationListeners` (:1371 →
  the rail scheduler and the PR poll).
- The host caches that would absorb a second window's calls are thin or
  missing (watchman has none; `agent_usage`'s floor races — see its card).

## Fix

Decide per poller whether it is app-wide or per-window:
- App-wide (usage, memory, watchman): run in the main window only and
  broadcast the readings to other windows via an event, or move the poll
  host-side (one Rust thread emitting to all windows).
- The rail scheduler: check whether windows partition workspaces (a
  workspace window claims its workspaces) so two schedulers never tick the
  same workspace; if they can overlap, gate it too — two schedulers could
  double-launch a step.

## Verify

A test that a non-main window's bootstrap starts none of the app-wide
pollers. Open a second window and confirm (e.g. with `sample`) that the
usage and watchman calls do not double.

## Plan (2026-09-26)

Every window holds the FULL workspace list (`forThisWindow` only picks the
active id), so each window's pollers do identical work, and the Sidebar
loads every rooted workspace's plan and board in every window, so two
schedulers tick the same workspaces. `mutateRunState` has no cross-window
claim: two schedulers can launch one step twice. The "close this window"
rung destroys only `main` and leaves workspace windows running, so a hard
`isMainWindow()` gate would stop rails in the survivors. The duty has to
hand over.

- [x] Host: one "duty window" (main, else a survivor when it is destroyed), a command to read it and an `app-duty-changed` event carrying it and the live window labels
- [x] `appDuty.ts`: `holdsAppDuties`, `whileHoldingAppDuties(start)` (starts/stops across a handover), and a tell/listen pair for other windows
- [x] Usage poll: split from the pause clock, run by the duty window only; every landed reading shared; a new window asks for the current set
- [x] Memory poll (system memory, watchman, managed sessions): duty window only; every reading shared
- [x] Rail scheduler: ~~duty window only~~ each workspace's rails run in the window showing it, and the duty window runs only those of a workspace no open window shows (`tick` gated by `runsRailsFor`); decoy sweep split the same way, results shared
- [x] Orchestration writes announced to other windows (they re-read), since the daemon pushes none for the app's own writes: the duty window has to hear a rail started elsewhere, and the others have to see the duty window's run state
- [x] Tests: a bootstrap whose duty is elsewhere makes no usage/memory/watchman calls; a workspace shown in another window is not ticked here; handover starts and stops; sharing applies other windows' readings and ignores its own echo
- [x] Follow-up card for the event-driven actors that also run per window (turn verdict, auto-resume, reclaim): [perf-window-actors-run-once.md](./perf-window-actors-run-once.md)

## Done (2026-09-26, uncommitted on perf/main-thread-commands)

**Which window does what.**
- The host tracks one duty window (`DutyWindow`, workspace_window.rs). It
  starts as `main`. When the holder is destroyed, the duty passes to
  `main` if that is still open, otherwise to the lowest surviving label.
  It never moves to a window that opens later, since every handover stops
  the pollers in one window and starts them in another. The host exposes
  it through the `app_duty` command and the `app-duty-changed` event,
  which carries `{ holder, windows }`. `lib.rs` hooks `on_window_event`
  for every window's Destroyed, including `main`'s.
- `appDuty.ts` holds the frontend side:
  - `holdsAppDuties` and `whileHoldingAppDuties(start)` start a poller in
    the holder and hand it over when the holder closes.
  - `railWindowFor` and `runsRailsFor` decide which window runs a
    workspace's rails.
  - `tellOtherWindows` and `listenToOtherWindows` carry messages tagged
    with the sending window's label, so a window drops its own echo. A
    lone window sends nothing.

**What moved to the duty window.**
- Usage: the probe is split out of `startPauseClock` into
  `startUsagePoll`. The clock and cache hydration still run in every
  window. Any window that lands a reading shares it, including a Check
  again pressed in a follower. A new window asks the holder for its
  current set, because the cache only keeps ready readings.
- Memory: `startMemoryPoll` runs in the holder only. Each pass shares
  `systemMemory`, `watchmanStore` and `agentSessions` whole. Followers
  load the stored means themselves. Only the window that measured writes
  to localStorage, which all windows share.

**Rails.** I gated rails per workspace, not on the duty window. The first
version gated them on the duty window. Tracing the inputs showed a
regression: `gitStore` refs load only in a window that shows the
workspace's Orchestration, Home or Git view. `branchSwitchFor` reads
unknown refs as "no switch", so the duty window would launch a
branch-bound rail started from a workspace window on whatever branch the
checkout was on. Today that workspace window's own scheduler, which has
the refs, runs the rail.
- `tick` now returns early unless `runsRailsFor(workspaceId)`. The window
  showing a workspace runs its rails, and the duty window takes those of
  a workspace no open window shows (the main window's, after the close
  prompt's first rung).
- `workspaceWindows` and `appDuty` are tick inputs, so a workspace handed
  to a window is ticked at once.
- The decoy sweep is split the same way, and each sweep shares its
  findings.
- The PR poll stays in every window: it is demand-driven, and the host's
  freshness floor absorbs repeat asks.

**Orchestration writes are announced.** The daemon never pushes the app's
own orchestration writes. So today two windows' copies of a plan already
drift apart, and a rail started from the app hub in one window would
never reach the window that runs it. Every successful `mutatePlan` and
`mutateRunState` now sends `orchestration-written`. Other windows re-read
that workspace from the daemon, which also ticks it. Re-reads are
debounced at 250 ms and wait for the reader's own in-flight saves.

**Left per window, on purpose.**
- The launch queue, which is per window by design (launchQueue.ts
  header).
- Arm-on-focus, which follows each window's own active workspace.
- The developing-cards and tool-run watchers, which are layoutState
  subscriptions with idempotent writes.
- The one-shot update check.
- Turn verdict, auto-resume and reclaim do act twice. They are filed as
  [perf-window-actors-run-once.md](./perf-window-actors-run-once.md).

**Checks.**
- New tests:
  - `appDuty.test.ts`: 15 tests covering the gate, handover, echo, the
    lone-window skip and `railWindowFor`.
  - Usage sharing: 9 tests in `agentPauseState.test.ts`.
  - `memoryState.test.ts`: 3 tests.
  - Orchestration: 9 tests, covering a workspace shown elsewhere, handover
    both ways, the orphan case, write announcements, re-read and schedule,
    burst folding, and decoy sharing.
  - Bootstrap in `layoutState.test.ts`: in a window without the duty,
    `agentUsage`, `systemMemory`, `watchmanStatus` and
    `listManagedSessions` are never called. A holder control calls all
    four.
  - Rust: 3 `duty_successor` tests.
- The orchestration and bootstrap tests fail against the pre-change
  sources (8 and 1 red).
- `cargo test --workspace`, `npm test` (6583), `npm run check` (0 errors)
  and `npm run build` all pass.

- [ ] Human test: In an app rebuilt from perf/main-thread-commands (src-tauri too, for the new app_duty command), with watchman running, open a workspace in its own window, then count watchman polls for 60 s with `(for i in $(seq 240); do pgrep -P <app pid> -f 'watchman.*watch-list'; sleep 0.25; done) | sort -u | wc -l`: expect about 2, not about 4. Also check that the second window's sidebar usage badge and memory strip keep updating.
- [ ] Human test: In the same build, start a branch-bound rail from the Orchestration tab of a workspace that has its own window: its checkout should switch to the rail's branch and each step should launch exactly once, and the main window's Home hub should show the same run state. Then close the main window with the "Close this window" rung while a rail in one of its workspaces is running: that rail should keep advancing, and the surviving window's memory strip should keep updating.
