---
title: Migrate remaining components to tokens (SP3 of 4)
status: Done
priority: medium
labels: ui
---
Spec: `docs/superpowers/specs/2026-08-21-ui-design-tokens-design.md` (D53, D54)

Done 2026-08-21. 609 literals -> 9 app-wide; the nine survivors are four
`--ws-accent` fallbacks and the five fixed platform colours in
WindowControls.

- [x] Extend the vocabulary: `--surface-*` / `--border-*` tints (D53)
- [x] Git tab (18 files) incl. graph lanes as `--lane-1..8` (D54)
- [x] Kanban, plans, settings, home
- [x] Modals, dialogs, context menu, editor chrome, tooltip
- [x] Human visual pass in both themes
