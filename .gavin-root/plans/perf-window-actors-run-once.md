---
kind: task
title: [perf] Turn verdicts, auto-resume and reclaim still run in every window
status: To Do
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
