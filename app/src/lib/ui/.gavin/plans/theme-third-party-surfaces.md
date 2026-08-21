---
title: Theme xterm + CodeMirror (SP4 of 4)
status: To Do
priority: medium
labels: ui
---
Depends on SP1.

Two surfaces that stay dark under a light theme no matter what the token
layer does:

- `terminalRegistry.ts:124` — `new Terminal({ convertEol: false })` passes
  no theme object, so xterm's own white-on-black default applies. Needs a
  full `ITheme` incl. 16 ANSI colours, swapped on theme change.
- `codeMirror.ts:114` — hard-wired `themeOneDark.oneDark`. Needs a light
  counterpart and a reconfigure on theme change.

Open question from the spec (§9): whether the 16 ANSI colours derive from
the tier-1 families or are authored separately.

Needs its own spec before work starts.
