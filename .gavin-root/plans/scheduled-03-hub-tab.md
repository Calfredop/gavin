---
kind: task
title: Scheduled tasks: hub tab + Schedule dialog
parent: feat-scheduled-tasks-plans.md
complexity: moderate
---
Build the desktop surfaces for Scheduled tasks. Requires children 01 and 02 landed. Read the parent card `feat-scheduled-tasks-plans.md` (Settled design) first; logic goes in plain `.ts` modules with tests, the `.svelte` files stay thin.

Do:
- A "Scheduled" workspace hub tab: `HUB_VIEW_META` in `hub/hubViewMeta.ts` (beside Decisions/Review) and `COMPONENTS` in `hub/workspaceViews.ts`. A dot on it when the latest run of any task failed or wrote no report.
- Rows: title, schedule in words, next run, last run, Last run result (the report's `#` headline, or "no report"/the skip reason), total runs, state (scheduled / running / paused / completed). The selected task shows its live terminal in `review/ReviewAgentPane.svelte` while a run is going, otherwise its latest Run report rendered as markdown, with a "Raw output" fallback and earlier reports listed.
- Controls: Edit schedule, Pause/Resume, Run now, Open report, Open card (`from:` as a file link resolved across `plans/`, `done/`, `archive/`; "gone" only when no file exists), Duplicate, Delete (`askConfirm`, danger), Unschedule, and "New scheduled task".
- "Schedule…" on task cards in the card menu (`cards/cardMenu.ts`) and the detail modal, archived cards included; refused with its reason on plan cards. The dialog: start date-time, optional every N unit, runs (1 / n / indefinite), and the resolved agent, with a picker of headless-capable agents when it has none (disabled with the reason when no agent qualifies).
- Gate every surface that sends the new requests through `featureBlockedReason("scheduledTasks")`.
- Add demo answers for every new read in the Demo Workstation so the Companion bundle's desk-load does not break.

Done when `cd app && npm test && npm run check && npm run build` are green, plus a static pre-flight: grep that the tab id, the menu entry and the dialog strings are in the committed source.

<!-- gavin:auto-commit -->
When the implementation is done, commit it. Commit only the files you touched — never `git add -A`. Do not push.
<!-- /gavin:auto-commit -->
