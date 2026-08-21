---
title: Keyboard shortcuts & hold-⌘ hints
status: To Do
priority: medium
labels: ui
---
# Keyboard shortcuts & hold-⌘ hints

⌘-number quick navigation (tabs, hub tabs, pages, workspaces), badges while
the command key is held, and shortcut hints in button tooltips.

Spec: `docs/superpowers/specs/2026-08-21-keyboard-shortcuts-design.md`
Plan: `docs/superpowers/plans/2026-08-21-keyboard-shortcuts.md`

- [ ] Synchronous platform flag (⌘ on macOS, Ctrl elsewhere)
- [ ] shortcuts.ts: chords, formatting, digit → index mapping
- [ ] Component-free hub view metadata + sidebar workspace order
- [ ] keyboard.ts: ⌘/⌘⇧/⌘⌥ number routing
- [ ] Hold-⌘ hint state machine
- [ ] Badge component + pane tab & hub tab hints
- [ ] Sidebar page & workspace hints
- [ ] Shortcut hints in icon button tooltips
- [ ] Full suites + manual pass
