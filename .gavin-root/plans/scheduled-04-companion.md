---
kind: task
title: Scheduled tasks: Companion surface
parent: feat-scheduled-tasks-plans.md
complexity: moderate
---
Give the Companion a Scheduled surface. Requires `scheduled-03-hub-tab.md` landed. Read the parent card `feat-scheduled-tasks-plans.md` (Settled design), ADR 0003 and `app/companion/README.md` first.

Do:
- A Scheduled surface beside Board / Terminals / Rails / Decisions in `SurfaceTabs`, reusing the desk's Scheduled list components fitted to a finger, the way the Decisions surface reuses `DecisionsItemRow`.
- The same controls: Pause/Resume, Run now, Edit schedule, Duplicate, Delete, Unschedule, plus the last Run report view (rendered markdown, Raw output fallback). A running task opens its terminal the way Terminals do.
- The phone never ticks the scheduler (ADR 0003); assert it in a test.
- Every command reached is in the Remote role command table; Demo Workstation answers for each read.

Done when `cd app && npm run companion:test && npm run companion:check && npm run companion:build` are green.

<!-- gavin:auto-commit -->
When the implementation is done, commit it. Commit only the files you touched — never `git add -A`. Do not push.
<!-- /gavin:auto-commit -->
