---
title: Tab & sidebar context menus + tab pinning
status: To Do
priority: medium
labels: ui
---
# Tab & sidebar context menus

Right-click menus on pane tabs, sidebar workspace rows, page rows and
session rows, plus browser-style tab pinning persisted in the layout.

Spec: `docs/superpowers/specs/2026-08-20-tab-sidebar-context-menus-design.md`
Plan: `docs/superpowers/plans/2026-08-20-tab-sidebar-context-menus.md`

- [ ] Rust: `pinned` on layout leaves (serde default)
- [ ] layout.ts: pin/unpin prefix invariant, bulk-close targets, reorder clamp
- [ ] setTabPinned, closeTabs, ⌘W skips pinned
- [ ] tabMenu.ts builder + tests
- [ ] Pane wiring: menu, pin glyph, no × on pinned; single root ContextMenu
- [ ] sidebarMenu.ts builders + tests
- [ ] Sidebar wiring: workspace / page / session-row menus, Change Root Folder…
- [ ] Full suites + manual pass
