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

- [ ] Protocol types and the four orchestration requests
- [ ] `orchestration.rs` SQLite store with its guards (+ tests)
- [ ] Daemon server wiring and request routing (+ tests)
- [ ] Tauri commands and `backend.ts`
- [ ] `orchestration.ts` primitives (+ tests)
- [ ] `nextActions` scheduler (+ tests)
- [ ] `orchestrationState.ts` store and persistence (+ tests)
- [ ] Launch executor and the tick loop (+ tests)
- [ ] Plan mutators: rails, stages, steps (+ tests)
- [ ] `OrchestrationHubView` and the tab registration
