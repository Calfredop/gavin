---
order: 5120
title: Agents parsing implementation
status: Done
---
During workspace init, sweep compatible agents for PATH presence, show them as found in the wizard, and let the user set main + fallback (reconciled with app settings).

- [x] Rust: detect installed agent binaries via program::on_path over AGENT_PROFILES
- [x] Wire Tauri command + backend.ts
- [x] Pure TS module + tests for found/missing and main/fallback suggestions vs app settings
- [x] AgentStep: show found agents, preselect main/fallback from sweep + app defaults
- [x] Surface/static checks; commit touched files only
