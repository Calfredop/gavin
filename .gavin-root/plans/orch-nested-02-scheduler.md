---
kind: task
title: [orch-nested] scheduler expands an orchestrated plan's step
parent: feat-plan-orchestrates-nested-tasks.md
complexity: intricate
---
Read `docs/adr/0012-a-nested-task-finishes-by-its-tick.md`, the Board terms in `CONTEXT.md`, the parent card `feat-plan-orchestrates-nested-tasks.md`, and `docs/superpowers/specs/2026-08-21-orchestration-tab-design.md` (O6, §5, §6.2). The daemon side (`children:`, `gavin_tick_item`, `orch_nested_runs`) is already in from `orch-nested-01-daemon.md`.

In `app/src/lib/orchestration/orchestration.ts` (pure, tested) and `orchestrationState.ts` (the executor), make a card step whose plan carries `children:` launch its nested tasks as card runs tracked in the nested-run rows:
- `sequence` runs them one at a time in tree order; `parallel` all at once, carrying the shared-checkout warning parallel stages already carry.
- Skip a child whose link is ticked, and a child placed as its own step on any rail.
- A child is finished on its TICK, never on a status. Launch the plan's own session only once every child is ticked; the step is done when the plan reaches the done column, as today.
- A stalled or failed child stalls the plan's step with "nested task `<file>` stalled: <reason>". Resume continues that child's conversation; auto-resume works per child on its own row's budget. Mark done skips what is left.

Prompts: a new `DEFAULT_RUN_ORCHESTRATED_PLAN` in `app/src/lib/agents/actionPromptDefaults.ts` ("your nested tasks are finished; work what is left of the checklist, integrate, verify, set Done"), and a child prompt that adds: "You are a nested task of <plan>. When finished, tick your own line with gavin_tick_item; never set this card's status." Launch children through the existing card-run path minus the In Progress write, so the binding, `base_sha`, both launch walls, run history and failure detection all still apply.

Also: `nested-with-parent` rises to `live` for an orchestrated plan; board Run on an orchestrated plan creates (or reuses) a rail named after the plan holding it as its one step and starts it, gated on `FEATURE_MIN_VERSION.orchestratedPlans`.

Pure-module tests for each rule, including: a plan without `children:` behaves exactly as before; a ticked child is never relaunched; a child on its own rail is skipped; a nested child never gains a `status:`. Go through `effectiveStatus`, never `plan.status`. No UI beyond what Run needs — the next nested task owns it.

## Done (2026-10-29)

An orchestrated plan's step has a CHILDREN PHASE: `running` with no session of its own (`inChildrenPhase`), driven by `childrenPhaseActions` in `orchestration.ts` — new actions `beginChildren` (appends missing link lines, files the plan In Progress; `fresh` from pending forgets the last pass's rows but keeps a still-live child), `launchChild` (card-run path via `launchCardOnRail`, prompt `action:run-nested-task`, no status write; `resume` reopens a stalled child's conversation), `stallChild` (row keeps its session, step stalls "nested task `x.md` stalled: …"), `childDone`. Once all are ticked the plan launches with `action:run-orchestrated-plan`. `stepAttentions` reads the running children's sessions. Auto-resume owner kind `nested` (rail consent, the child row's budget) resolves before the card binding. `runCard` routes an orchestrated plan to `runOrchestratedPlan` (own rail; `orchestratedRunTarget`). Parallel children raise `same-worktree` with scope `children`; `nested-with-parent` is live under an orchestrated plan. Tests: `orchestrationNested.test.ts`, the "Orchestrated plan's children" block in `orchestrationState.test.ts`, the nested block in `autoResumeState.test.ts`.
