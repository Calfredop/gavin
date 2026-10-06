---
order: 37888
kind: task
title: [perf] Turn verdicts, auto-resume and reclaim still run in every window
status: Done
parent: perf-main-thread-command-audit.md
priority: medium
complexity: moderate
---
Follow-up to [perf-pollers-run-once-per-app.md](./perf-pollers-run-once-per-app.md),
which moved the timed pollers (usage, memory, watchman, the decoy sweep)
to one window and partitioned the rail scheduler by workspace window. It
left the event-driven actors alone. They still run once PER WINDOW, and
unlike the pollers each can ACT twice, not just ask twice.

Line numbers are as of branch perf/main-thread-commands, 2026-09-26.

## Evidence

- **Turn verdict** (`startTurnVerdict`, started from
  `initOrchestrationListeners`, orchestrationState.ts ~2413). Every window's
  status hook calls `noteQuietTransition` (turnVerdictDriver.ts:137), which
  makes `backend.sessionScreen` and then `backend.typesafeAsk`, an HTTPS
  request to a paid API, for every quiet turn of a bound session. Every
  window holds every board, so `ownerOf` finds the owner in all of them.
  With N windows that is N verdict requests per turn.
- **Auto-resume** (`startAutoResume`, orchestrationState.ts ~2404).
  `resumeClaims` (resumeClaim.ts:46) is an in-memory Map per window, so the
  claim that stops a double resume inside one window does not stop a
  second window. Both receive `session-failed` and both can arm a resume
  of the same session. Check what a resume does (a relaunch? keystrokes
  into the PTY?) to size the damage.
- **Done-session reclaim** (`startDoneSessionReclaim`,
  doneSessionReclaimState.ts:155). Every window runs the pass on the same
  shared memory readings, and each can `closeSession` (:132) inside one
  spacing interval. That is the burst the pacing exists to prevent. One
  catch: its trigger reads `launchQueue.length`, and the launch queue is
  per window by design (launchQueue.ts header). A single reclaimer needs
  every window's queued count.
- **Update check** (`startUpdateWatch`, updatesState.ts:94) makes one
  network check per window bootstrap. It is low cost and not a poller.
  Decide whether a follower window should take the holder's
  `availableUpdate` instead.

## Fix

`app/src/lib/shell/appDuty.ts` already provides the pieces:
- `whileHoldingAppDuties(start)` runs a starter only in the duty window and
  hands it over when that window closes.
- `runsRailsFor(workspaceId)` says which window owns a workspace's rails.
- `tellOtherWindows` / `listenToOtherWindows` share readings between
  windows, with the sender's own echo dropped.

For each actor, pick an owner (app-wide or per workspace) and share what
the other windows draw. `turnVerdictById` feeds the inbox and the
notification tray in every window, and `resumeTrail` and `reclaimLog` feed
UI too. Gating an actor without sharing its store would blank those
surfaces in the other windows.

## Verify

For each actor, a test that a window which does not own the session or
workspace makes no host call and takes no action, plus a test that the
owner's result reaches another window's store.

## Done

**Ownership.**
- Turn verdict and auto-resume: the window that `runsRailsFor` the
  session's workspace. A resume is a relaunch (`resumeStep` /
  `resumeCard`), not a keystroke into the PTY — two windows both arming
  would start the same work twice. `resumeClaims` stays per window; the
  gate is what stops the second.
- Done-session reclaim and the launch update check: the duty window
  (`whileHoldingAppDuties`).

**Sharing.**
- `turn-verdict` / `resume-trail` / `reclaim-log` / `update-reading`
  carry each actor's store writes; followers take them so the inbox,
  tray, trail and sidebar badge stay live. Reclaim also shares each
  window's `launch-queued-count` so one reclaimer still sees work waiting
  in another window's queue. A new window asks the holder for its current
  `availableUpdate` (`update-wanted`), the same pattern as usage.

**Tray.** A follower swallows the OS notification for a session another
  window judges (`turnVerdictRole` into `startVerdictNotices`), so one
  quiet turn does not send N tray lines.

**Checks.** Unit tests on each actor for non-owner silence and
  cross-window store apply; surface tests pin the bootstrap duty wiring.
  `npm run check` is clean on the change.

- [ ] Human test: With two windows open (main + a workspace window) and TypeSafe turn verdict on, finish one quiet turn of a card run in the workspace window: only one typesafeAsk / verdict should fire, both windows' attention inbox should show the same reading, and only one OS notification should land. Then fail a consented auto-resume run: only one relaunch. Under memory pressure with work queued only in the follower window, the duty window should still reclaim.
