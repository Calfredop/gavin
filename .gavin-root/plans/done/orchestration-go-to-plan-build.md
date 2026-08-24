---
title: Orchestration go to plan — build
status: Done
---
Implementation checklist for [Orchestration go to plan](orchestration-go-to-plan.md).

A card step on a rail stops being a slim chip and becomes *the* kanban card —
same component, same features (open, context menu, run pills, session dot,
labels, priority, checklist, nesting, delete) — plus the two things only the
rail knows: its run state and its conflicts. A TOOL step keeps the chip: a
tool is not a card, and the dashed chip is what says so.

New on the card here, and only here: **which column it sits in**, because off
the board that is no longer visible.

- [x] `planBoard.ts`: `indexCardViews` — every card view by path, with its
      column name (nested children included, `null` column) + tests
- [x] `BoardCard.svelte`: optional `columnName` chip and `adornment` snippet,
      both no-ops for the surfaces that don't pass them
- [x] `OrchestrationStepCard.svelte`: the card in a `[data-orch-step]`
      wrapper — run-state ring, conflict fill, rail strip (state, badges,
      retry, remove)
- [x] `OrchestrationRail.svelte`: card steps render the card, tool steps keep
      the chip; parallel stages laid out for card-sized steps
- [x] `OrchestrationHubView.svelte`: the board plumbing — detail modal,
      context menu, delete prompt, run pills, labels, click-to-open
- [x] `OrchestrationDragPreview.svelte`: a card drag shows the card
- [x] Sweep: `npm test`, `npm run check`, `npm run build`

Manual smoke in the running app is still outstanding — this was built and
verified in the `Orchestration/opts-01` worktree (vitest 958 pass,
svelte-check 0 errors, `npm run build` clean, plus a throwaway `__preview`
route screenshotted in Chrome), not in the human's live instance.
