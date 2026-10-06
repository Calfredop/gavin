---
order: 3072
kind: task
title: Memory init phase (wizard and open backfill)
parent: feat-vectorized-memory.md
complexity: moderate
---
Add the memory init phase for new and existing workspaces. Read
`app/src/lib/workspace/setupWizard.ts` (+ tests), `SetupWizard.svelte`,
`SuperpowersStep.svelte` / `superpowers.ts` (done/skip/mark pattern), and
`HomeHubView.svelte` resume.

Do:
- Derive a Memory setup step as done when the local BGE cache is present and
  the per-root index matches current `### Learned` (or Learned is empty and
  the index is empty/ready). Persist a skip/asserted mark only for “not now”,
  not as a fake “installed”.
- Wizard step + Home resume affordance: run ensure (download model if needed,
  rebuild index from Learned). Wire through the daemon APIs the index child
  exposes — do not reimplement embed logic in the app.
- On workspace/worktree open: if Learned has content and the index is missing
  or stale, kick the same ensure/backfill without opening the wizard; surface
  failure without blocking the whole workspace.
- Unit tests for setupProgress / done/skip; static pre-flight that the wizard
  and Home actually name the Memory step.
- Out of scope: changing Adopt, the search tool contract, or auto-inject.

Done when setupWizard tests cover the new step and open-backfill has a pure
or mocked unit path that proves stale → ensure is invoked.
