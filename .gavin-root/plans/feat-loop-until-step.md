---
order: 6144
kind: task
title: Loop-until rail step
status: To Do
priority: medium
---
Add a `builtin:until` orchestration tool: a rail step that re-runs the step before it until a check command exits 0, or an iteration budget runs out.

Read first: `app/src/lib/orchestrationTools.ts` (the built-in tool table and the four tool kinds), `app/src/lib/orchestrationState.ts` (`startScheduler`, how a step completes and how the next one is armed), `app/src/lib/autoResume.ts` (the run-row budget and TTL claim — reuse that budget mechanism, do not invent a second one), and `docs/superpowers/specs/2026-09-02-auto-resume-design.md`.

Behaviour:
- Params: `check` (shell command, run in the rail's worktree), `max` (iterations, default 5). Both are template params like `{{base}}` on the existing tools.
- When the step runs: execute `check`. Exit 0 → the step completes and the rail advances. Non-zero → if the budget is spent, the step fails with the check's last output as its failure reason; otherwise re-arm the PREVIOUS step, prefixing its agent prompt with "The previous attempt failed this check:\n```\n<check output, last 40 lines>\n```\nFix it, then finish." (an agent step) — a shell or gavin step is simply re-run.
- The rail header's attention line shows "retry 2 of 5" while looping.
- The check runs as a visible shell session in the rail's page, like the other shell tools; it is not hidden.

Out of scope: any new daemon request or protocol bump — this is app-side scheduling over existing run rows. If you find it cannot be done without one, stop and say so on the card.

Done when: unit tests in a plain `.ts` module cover pass, fail-then-pass, budget exhaustion and the prompt prefix; the tool appears in the + Add step picker; `cd app && npm test && npm run check` are green; a smoke item is added to `smokeChecklist.ts`.

Borrowed from Cursor's /loop and /goal (2026-09-03 feature scan).
