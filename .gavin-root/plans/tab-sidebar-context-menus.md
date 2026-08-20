---
title: Tab & sidebar context menus + tab pinning
status: In Progress
priority: medium
labels: ui
---
# Tab & sidebar context menus

Right-click menus on pane tabs, sidebar workspace rows, page rows and
session rows, plus browser-style tab pinning persisted in the layout.

Spec: `docs/superpowers/specs/2026-08-20-tab-sidebar-context-menus-design.md`
Plan: `docs/superpowers/plans/2026-08-20-tab-sidebar-context-menus.md`

- [x] Rust: `pinned` on layout leaves (serde default)
- [x] layout.ts: pin/unpin prefix invariant, bulk-close targets, reorder clamp
- [x] setTabPinned, closeTabs, ⌘W skips pinned
- [x] tabMenu.ts builder + tests
- [x] Pane wiring: menu, pin glyph, no × on pinned; single root ContextMenu
- [x] sidebarMenu.ts builders + tests
- [x] Sidebar wiring: workspace / page / session-row menus, Change Root Folder…
- [x] Full suites (vitest 526, cargo 101+174+32+7, svelte-check 0 errors) + review fixes
- [x] Plan tree switched to the shared menu (openContextMenuFromEvent)
- [ ] Manual pass: pin/unpin + drag, ⌘W on pinned, Close Others with a pinned neighbour, daemon restart keeps pins, one menu with board + terminal side by side, sidebar menus, Change Root Folder on a plain folder, Plans-tab menus
