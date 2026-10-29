---
kind: task
title: [orch-nested] desk: Children toggle, nested run state on the plan's card
parent: feat-plan-orchestrates-nested-tasks.md
complexity: moderate
---
Read the parent card `feat-plan-orchestrates-nested-tasks.md` and `docs/adr/0012-a-nested-task-finishes-by-its-tick.md`. The daemon fields and the scheduler are in from the two nested tasks before this one.

In the desktop app:
- Card detail modal: a "Children" control (off / sequence / parallel) that writes `children:`, shown only on a plan that has nested tasks, behind `featureBlockedReason` for `orchestratedPlans`.
- BoardCard: a small mark when `children:` is set. Each nested child row inside the plan's card shows its run state (from the nested-run rows and its session's status) and its ticked state — through `ui/indicators.ts` + `StatusBadge` only.
- A rail's card step for such a plan: an "n/m nested" chip.

Logic in a plain `.ts` module with unit tests; the `.svelte` files stay thin templates. Do not change scheduler rules. `npm test && npm run check && npm run build` green. Static pre-flight (grep the strings the change relies on); the rendered check is the parent card's Human test.

## Done (2026-10-29)

Logic in `orchestration/orchestratedPlanView.ts` (+ test): `CHILDREN_CHOICES`, `childrenControlShown`, `childrenFieldValue`, `childrenHint`, `childrenMarkTip`, `nestedRunsOfPlan`, `nestedChildState` (ticked → done, else the run row), `nestedProgress` / `nestedProgressText` ("n/m nested"). `ui/indicators.ts` gained `nestedTaskIndicator` (the step axis's squares and tones, nested-task words). Surfaces: the Children select in the card detail modal's settings fold (gated on `orchestratedPlans`); BoardCard's ListTree mark on a plan with `children:` and a `nestedState` badge on each child row; the "n/m nested" chip in `OrchestrationStepCard`. `CardView` carries `children` and `checklistLinks`. Source-pinned by `orchestratedPlanSurfaces.test.ts`.
