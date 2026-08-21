---
title: Theme xterm + CodeMirror (SP4 of 4)
status: In Progress
priority: medium
labels: ui
---
Spec: `docs/superpowers/specs/2026-08-21-ui-design-tokens-design.md` (D55)

Done 2026-08-21.

- [x] xterm `ITheme` incl. 16 ANSI slots; `applyTerminalTheme` walks the
      registry, since terminals outlive their components
- [x] CodeMirror light arm + `defaultHighlightStyle` (oneDark was the only
      source of syntax colour), both via a `Compartment` so scroll and
      undo survive a flip
- [ ] Human visual pass: terminal colours, diff readability, syntax
      highlighting in light
