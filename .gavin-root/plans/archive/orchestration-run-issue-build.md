---
title: Orchestration run issue — build
status: Done
---
Implementation checklist for [Orchestration run issue](../orchestration-run-issue.md).

**Root cause (reproduced against the live workspace data).** The scheduler
decided a card step was finished by comparing the card's own `status:` to the
board's done column. A **nested task** — `parent:` set, no `status:` of its own
— has no status: on the board it renders inside its parent's card, in the
parent's column, and on disk it travels into `plans/done/` with its parent. The
scheduler read `""`, missed rule 1, and **launched it**. Running `nextActions`
over this workspace's real rails with the run rows swept produced
`launch done/md-file-viewer-bug.md` — a card sitting in `done/`.

Two aggravations, both observed live:
- the launch writes `status: In Progress` onto the card, which un-nests it and
  moves it back out of `done/` — so a re-run erases its own evidence;
- rail “Generic fixes” was paused on a `currentStageId` naming a stage that no
  longer exists (a swept re-arrangement). Resume handed that id straight back
  to `nextActions`, which found no stage and called the rail **complete**.

- [x] `orchestration.ts`: `effectiveStatus` — a card's status, or for a nested
      task its parent's — resolved on `planBoard.planKey`, the same link the
      board nests on, plus `planIndex` for the lookup + tests
- [x] `orchestration.ts`: rule 1, `deadSessionAction` and `railDoneStepIds`
      judge "done" through `effectiveStatus`, so a nested task under a Done
      parent is skipped and cleared, never re-run + tests
- [x] `orchestrationState.ts`: `resumeRail` drops a `currentStageId` that no
      longer names one of the rail's stages and re-arms at the first unfinished
      stage + tests (both fail against the old code — checked)
- [x] `orchestration.ts`: rule 2 retries a **stalled** step when the run
      reaches its stage, and rule 1 now covers a stalled step whose card was
      finished by hand + tests
- [x] Sweep: `npm test` 1289 pass / 69 files, `npm run check` 0 errors
      (28 pre-existing a11y warnings, none in these files), `npm run build` ✓

**Second half — a failed step blocked the rail.** A `stalled` step was
invisible to every rule: rule 1 wanted pending or running, rule 2 wanted
pending, rule 3 wanted running. A rail armed on its stage produced **no actions
at all** and sat there looking busy, with the per-step Retry button the only way
past it — replaying the workspace's real “Orchestration fixes” rail confirmed
it, empty action list and all. Rule 2 now retries a stalled step when the run
REACHES it, re-deriving the blocker rather than replaying the old command, so it
either goes this time or stalls again on its own merits; a fresh stall
re-pauses the rail (rule 5), which keeps it to one attempt per press of Play.
Rule 1 runs first, so a card finished by hand while its step sat failed is
counted done instead. Spec §4.1/§4.2/§6.2 updated — the old text said Resume
“will not advance past a `stalled` one”.

`firstUnfinishedStageId` was deliberately left alone: it arms on run state and
`nextActions` cascades past the already-done stages in the same tick, which
keeps one place deciding what "done" means (its own doc says so).

Re-verified by replaying the workspace's three real rails through `nextActions`.
With the run rows swept, every done stage collapses to `markDone` + `advance`
and each rail stops at its first genuinely unfinished step. With their REAL run
state, the two rails that previously produced nothing now move: “Orchestration
fixes” retries its stalled `each-rail-it-s-page.md`, and “Multiple agents
support” marks its stalled step done — its card reached Done while the step sat
failed — and completes.
