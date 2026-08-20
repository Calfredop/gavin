---
order: 2048
title: Kanban Trello-quality rework
status: Done
priority: high
---
# Kanban Trello-quality rework

Pointer-event drag engine (zero deps), manual plan-card ordering via `order:`
frontmatter, nine confirmed defects fixed, one rendering path for both board
surfaces.

- Spec: docs/superpowers/specs/2026-08-19-kanban-trello-rework-design.md
- Plan: docs/superpowers/plans/2026-08-19-kanban-trello-rework.md (20 tasks)
- Decisions: docs/superpowers/brainstorms/2026-08-19-kanban-trello-brainstorm.md (K1–K8)

All 20 tasks implemented and committed. Automated verification green:
cargo 256, vitest 366, svelte-check 0 errors (kanban warnings 0), build clean.
Remaining before Done: the owner's interactive smoke pass — in-app Checklist
“Board interaction” section / fixture README B7–B11.
