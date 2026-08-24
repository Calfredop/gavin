---
title: Clear done in orchestration — build
status: Done
---
Implementation checklist for [Clear done in orchestration](clear-done-in-orchestration.md).

A rail gets a **Clear done** header action (broom): it takes the finished steps
off the rail, dropping any stage they empty. A step counts as done when the
scheduler marked it `done`, or — for a card step on a rail that was never run —
when its card already sits in the board's done column. A `running` step is
never cleared: the daemon refuses a plan write that drops one, and one refusal
would lose the whole clear. The card FILES are untouched; only the steps that
pointed at them leave, so a cleared card returns to the unplaced drawer.

- [x] `orchestration.ts`: `removeSteps` (generalising `removeStep`) and
      `railDoneStepIds` (run state or card status, never a running step) + tests
- [x] `orchestrationState.ts`: `clearDoneStepsAction` — the plan write plus
      the rail-run repair when the cleared stage was the current one + tests
- [x] `OrchestrationRail.svelte`: a `BrushCleaning` (broom) header button,
      disabled with a reason when the rail has no done steps
- [x] `OrchestrationHubView.svelte`: wire the action, errors on the plan strip
- [x] Sweep: `npm test`, `npm run check`, `npm run build`

Verified in a throwaway `__preview` route in Chrome (the dev server on :1420),
since this session's `gavin-mcp` is a version behind the daemon and every
`gavin_*` tool refuses: a rail of three stages — a step the scheduler marked
`done`, a parallel stage holding one To Do card and one whose card is in Done,
and a stage of a pending card plus a tool step — shows the broom tipped "Remove
2 done steps from this rail"; clicking it drops the first stage whole, leaves
the second holding only the To Do card (no longer a parallel band), keeps the
pending card and the tool step, and leaves the broom dimmed. Route deleted
after the pass. Sweep: `npm run check` 0 errors, `npm run build` clean, 1236
vitest pass — the 4 failures in `orchestration.test.ts` are another session's
in-flight red tests for nested tasks under a done parent (`nextActions`,
untouched here).

Follow-up: when that nesting work lands, `railDoneStepIds` should read "is this
card done" from the same helper the scheduler uses, so a nested task under a
done parent clears too.
