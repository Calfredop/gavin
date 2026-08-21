---
title: IconButton primitive (SP2 of 4)
status: In Progress
priority: medium
labels: ui
---
Done 2026-08-21. `app/src/lib/ui/IconButton.svelte`.

36 of 51 icon buttons migrated across 9 files. Four variants (bare,
outlined, filled, segmented) x five tones, tone applied through two CSS
variables the variant rules read rather than a variant x tone matrix.

- [x] The primitive, with `label` required (drives aria-label + tooltip)
- [x] TitleBar, Pane, GitToolbar
- [x] GitNav, Sidebar (incl. the theme toggle, which was a 7th style)
- [x] PlanTree, GitWorktreeSwitcher, BoardCard, KanbanColumn
- [x] Radii unified: was 3 / 6 / 10 / none, now one
- [x] Disabled unified: was 0.4 / 0.45 / 0.5, now one
- [ ] Human visual pass

**15 left as raw `<button>` on purpose**, not missed:
- WindowControls (4) — fixed-colour platform circles, not icon buttons
- GitNav (5) — `.item` nav rows and section `.toggle` headers; the
  headers render TWO icons, which one `icon` prop can't express
- GitWorktreeSwitcher (3) — dropdown trigger and menu rows
- Pane / PlanTree / Sidebar (3) — tab rows, file rows, the footer
  Settings row: full-width rows, not buttons

Hosts styling a forwarded `class` must use `:global()` — Svelte scopes
selectors to the host's own markup, so a class on a child component is
never matched. This silently deleted PlanTree's hover-reveal until
svelte-check's unused-selector warning caught it.
