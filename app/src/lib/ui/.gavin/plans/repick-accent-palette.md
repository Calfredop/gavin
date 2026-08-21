---
title: Re-pick accent PALETTE for two-theme legibility
status: Done
priority: low
labels: ui
---
Done 2026-08-21 — solved without re-picking anything.

All eight swatches scored 6.0–10.0 on `#1e1e1e` and **1.7–2.8 on white**
— every one below WCAG's 3:1 non-text floor, while the accent renders as
thin indicators (3px sidebar stripe, 2px tab underline).

`accentVar(color, theme)` now darkens toward black until the colour
clears 3:1 on white, scaling all three channels by the same factor so
hue survives (`#fbbf24` → a darker gold, not grey).

- [x] Confirm the failure with measured contrast
- [x] `accentVar` resolves per theme; 7 tests in `settings.test.ts`
- [x] Wire the two call sites (`+page.svelte`, `Sidebar.svelte`)
- [x] Human visual pass on a coloured workspace in light mode

Two properties that made this better than a new palette: dark mode is
untouched, so nobody's existing choice changes appearance; and it applies
to any colour, so a hand-edited `config.json` is covered too. `PALETTE`
is unchanged, so there is no migration.
