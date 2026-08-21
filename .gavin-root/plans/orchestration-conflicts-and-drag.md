---
title: Orchestration tab — Conflicts and direct manipulation (SP2 of 3)
status: In Progress
priority: high
---
# Orchestration tab — Conflicts and direct manipulation (SP2 of 3)

The conflicts box, severity colouring with pairing badges, drag to build
sequential or parallel stages, the unplaced-cards drawer, and real
worktree/page binding.

Spec: `docs/superpowers/specs/2026-08-21-orchestration-tab-design.md`
Plan: `docs/superpowers/plans/2026-08-21-orchestration-conflicts-and-drag.md`

## Steps

- [x] `detectConflicts`, numbering and lookup helpers (+ tests)
- [x] Conflicts box with hover linking
- [x] Severity colouring and pairing badges on chips and rail headers
- [x] Move mutators for steps between stages and rails (+ tests)
- [x] `orchestrationDrag.ts` pure hit-testing (+ tests)
- [x] `orchestrationDragGlue.ts` controller and DOM glue
- [x] Drag wiring: data attributes, placeholders, floating preview
- [x] Unplaced-cards drawer
- [x] Rail binding dialog: worktree and page
