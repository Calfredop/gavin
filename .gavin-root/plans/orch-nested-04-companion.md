---
kind: task
title: [orch-nested] Companion parity for orchestrated plans
parent: feat-plan-orchestrates-nested-tasks.md
complexity: moderate
---
Read the parent card `feat-plan-orchestrates-nested-tasks.md`, `docs/adr/0012-a-nested-task-finishes-by-its-tick.md` and `app/companion/README.md`. The daemon, scheduler and desk UI are in from the nested tasks before this one.

In `app/companion/`:
- `PhoneCard`: the children list shows each child's run state and tick instead of `child.status ?? "nested"`, and the plan gets the Children toggle (off / sequence / parallel) writing `children:`.
- Run on an orchestrated plan does exactly what the desk's does (the plan's own rail).
- `PhoneRails`: "n/m nested" on the plan's step.
- The Demo Workstation must answer every new read: add an orchestrated plan with mixed child states (running, ticked, stalled) to `sampleData.ts`.

Logic in the `phone*.ts` modules with tests; reuse the desk's pure modules rather than re-deriving. `npm run companion:test && npm run companion:check && npm run companion:build` green.

## Done (2026-10-29)

PhoneCard lists each child through `childRows` (phoneCard.ts, over the desk's `nestedChildState`) with a `nestedTaskIndicator` badge, and has the Children select (`setChildren` in state/cards.ts); an orchestrated plan's card reads the plan via `loadNestedRuns` (state/rails.ts). PhoneRails rows carry `nested` ("n/m nested"). Run is the desk's `runCard`, so it already takes the plan's own rail. Demo: `children:`/`checklistLinks` in `cardFiles.readCard`, `withChecklistLink`, `tick_checklist_link`, `set_nested_run`, `clear_nested_runs`, and the demo desk plays `childrenPhaseActions`; field-notes' "Notebook search" sample (ticked / running on `s-notes-search` / stalled, rail paused). Tests: `seam/orchestratedPlans.test.ts`, `demo/cardFiles.test.ts`.
