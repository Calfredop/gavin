---
title: Kanban/orchestration link — build
status: Done
---
Implementation checklist for [Kanban/orchestration link](kanban-orchestration-link.md).

One card lands on a rail as its own trailing stage — the sequential, safe
default the drawer's click already uses. A card already on ANOTHER rail
*moves* (its step id, and so its run state, rides along); a card already on
the target rail is a no-op.

- [x] `orchestration.ts`: `findCardPlacement` + `sendCardToRail` (pure, + tests)
- [x] `orchestrationState.ts`: `sendCardToRailAction`; `mutatePlan` returns the save error
- [x] Kanban surfaces fetch the orchestration plan (`KanbanBoard`, `BoardPane`)
- [x] Creation: rail picker in the `KanbanColumn` composer (task/plan only)
- [x] Contextual menu: `Send to rail “X”` per rail + `Remove from rail` (`cardMenu.ts`, + tests)
- [x] Detail modal: rail section — where it sits, send/move, remove, open the tab
- [x] Sweep: `npm test` (950 pass), `svelte-check` (0 errors), `npm run build`

Manual smoke in the running app is still outstanding — this was built and
verified in the `Orchestration/opts-01` worktree, not in the human's live
instance.
