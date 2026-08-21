---
title: Keyboard shortcuts & hold-⌘ hints
status: In Progress
priority: medium
labels: ui
---
# Keyboard shortcuts & hold-⌘ hints

⌘-number quick navigation (tabs, hub tabs, pages, workspaces), badges while
the command key is held, and shortcut hints in button tooltips.

Spec: `docs/superpowers/specs/2026-08-21-keyboard-shortcuts-design.md`
Plan: `docs/superpowers/plans/2026-08-21-keyboard-shortcuts.md`

- [x] Synchronous platform flag (⌘ on macOS, Ctrl elsewhere)
- [x] shortcuts.ts: chords, formatting, digit → index mapping
- [x] Component-free hub view metadata + sidebar workspace order
- [x] keyboard.ts: ⌘/⌘⇧/⌘⌥ number routing
- [x] Hold-⌘ hint state machine
- [x] Badge component + pane tab & hub tab hints
- [x] Sidebar page & workspace hints
- [x] Shortcut hints in icon button tooltips
- [x] Full suites: vitest 654, cargo 170+174+32+7, svelte-check 0 errors, build clean
- [ ] Manual pass: ⌘1-8/9/0 on pane tabs (focused pane only) and hub tabs;
      ⌘⇧-number pages; ⌘⌥-number workspaces (Unfiled = 1); hold ⌘ / ⌘⇧ / ⌘⌥
      for badges; ⌘T does not flash hints; ⌘Tab away leaves no stuck badges;
      "New Tab (⌘T)" tooltip; ⌘W still tab-close and still refuses on pinned;
      ⌘Q still quits
