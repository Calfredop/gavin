---
kind: task
title: Parallel card drop
status: Done
---
In orchestration tab, if dropping a task/plan into a running pararellel step - either already pararellel or creating one via dropping - make the dropped item start right away since its on a running step.

## What landed

A drop onto the stage a rail is **currently running** now starts immediately;
every other drop target still queues.

- `orchestration.ts` — `runningStageId(orch, railId)` and
  `isStageRunning(orch, stageId)`: the stage a running rail is actually on,
  as opposed to `firstUnfinishedStageId`'s "where it would start".
- `orchestrationState.ts` — `startIfStageRunning` ticks after a successful
  save, wired into `addStepToStageAction` (card), `addToolToStageAction`
  (tool) and `moveStepIntoStageAction` (a step dragged up from a later
  stage). The launch stays the scheduler's, so blockers, stall reasons and
  rule 1 (a card already in the done column) are unchanged.
- `tick` no longer DROPS a request that arrives while a pass is in flight —
  that pass read the plan before the drop existed, so the request is
  remembered and replayed once it drains.
- Spec §6.5 records the rule; one smoke item (`run-drop-on-running-stage`)
  covers what only the running app can show.

Both sub-cases from the card are the same gesture: a stage that is already
parallel, and a single-step stage that the drop makes parallel.

Green: `cargo test --workspace` (the two `gavin::tests` fs-watcher failures
are the known parallelism flake — that module passes alone), `npm test`
(1395), `npm run check` (0 errors), `npm run build`.

**Adjacent, not fixed:** a step dragged out of a running rail's *current*
stage can empty it, leaving `railRuns.currentStageId` naming nothing; the
scheduler then reads that as "complete" and idles the rail instead of
advancing it. Pre-existing — `resumeRail` and `clearDoneStepsAction` each
repair it at their own site — and unreachable through this change's own
path, since a stage that is the drop target cannot also be the one the move
emptied.
