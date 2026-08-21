---
title: Orchestration tab — Rails that run (SP1 of 3)
status: In Progress
priority: high
---
# Orchestration tab — Rails that run (SP1 of 3)

Rails of stages of steps over the board's cards: build a rail, press Start,
and gavin launches each stage's agents and advances when their cards reach
the Done column.

Spec: `docs/superpowers/specs/2026-08-21-orchestration-tab-design.md`
Plan: `docs/superpowers/plans/2026-08-21-orchestration-rails-that-run.md`

## Steps

- [x] Protocol types and the four orchestration requests
- [x] `orchestration.rs` SQLite store with its guards (+ tests)
- [x] Daemon server wiring and request routing (+ tests)
- [x] Tauri commands and `backend.ts`
- [x] `orchestration.ts` primitives (+ tests)
- [x] `nextActions` scheduler (+ tests)
- [x] `orchestrationState.ts` store and persistence (+ tests)
- [x] Launch executor and the tick loop (+ tests)
- [x] Plan mutators: rails, stages, steps (+ tests)
- [x] `OrchestrationHubView` and the tab registration
