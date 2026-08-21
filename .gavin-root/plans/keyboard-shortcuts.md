---
title: Keyboard shortcuts & hold-⌘ hints
status: Done
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
- [x] Manual pass confirmed in the app by the human (2026-08-21)
- [x] Fixed after the first manual pass: the hold-⌘ badges never appeared —
      createHintTracker's default clock was `{ setTimeout, clearTimeout }`,
      and WebKit throws "Can only call Window.setTimeout on instances of
      Window" when it is called as a method of that object, so the hold
      timer never started. Node's timers ignore `this`, which is why the
      suites stayed green; the regression test now stubs the global timer
      to behave like WebKit (`shortcutHints.test.ts` → "default clock").
