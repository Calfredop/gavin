---
title: Design tokens + light/dark (SP1 of 4)
status: In Progress
priority: high
labels: ui
---
Spec: `docs/superpowers/specs/2026-08-21-ui-design-tokens-design.md`
Plan: `docs/superpowers/plans/2026-08-21-ui-design-tokens.md`

- [x] Pure theme resolution (`theme.ts`) — 5 tests
- [x] Two-tier token stylesheet (`theme.css`) + `+layout.svelte`
- [x] Rust persistence — `AppConfig.theme`, `ThemePref` state, funnel
      threading, `get`/`set_theme_pref`, 3 tests
- [x] Boot wiring — pre-boot stamp, `themeState`, `onThemeChanged`
- [x] Light/Dark/System control in Settings
- [x] Beachhead migration — 5 app-shell components
- [x] Visual pass — both themes verified; found and fixed D52

594 frontend + 160 Rust tests pass, 0 svelte-check errors.

Known-incomplete by design (spec §7): 47 components, xterm and
CodeMirror stay dark under Light. See SP3 and SP4.

Awaiting the human's own pass in the real app window before Done.
