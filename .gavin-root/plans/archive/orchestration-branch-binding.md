---
title: Branch binding for rails
status: Done
---
A rail binds to a CHECKOUT plus a BRANCH. `worktreePath` says which
checkout, `branch` says which branch there — so `worktreePath: null` +
`branch: feature/x` means the root checkout on that branch, no folder.
Executing card [Orchestration branch](orchestration-branch.md).

Rules settled in brainstorming:
- Switch before launching, never under a running step.
- A dirty checkout REFUSES the switch (stricter than git; no stashing).
- A finished rail stays on its branch — the work stays in view.

- [x] Protocol: `Rail.branch: Option<String>`, serde-defaulted (wire-compatible)
- [x] Daemon: `branch TEXT` column via `add_column_if_missing`, select/insert, round-trip test
- [x] MCP: emit `branch` in the rail JSON and document it in the rails schema
- [x] Spec: fold the branch rules into `2026-08-21-orchestration-tab-design.md`
- [x] Scheduler tests: switch emitted / suppressed while running / suppressed on unloaded refs / no-op when already there
- [x] Scheduler: `Rail.branch`, `switchBranch` action, the per-rail decision in `nextActions`
- [x] Conflict tests: `branch-missing` present and suppressed
- [x] Conflicts: `branch-missing` kind, ordering, copy; sharpen `same-worktree` when branches differ
- [x] Executor tests: happy path, dirty refusal, git error stalls the stage
- [x] Executor: dirty pre-check, `gitCheckout`, refresh, stall on failure
- [x] UI: Branch section in `RailBindDialog` (pick, and New branch…)
- [x] UI: rail header bindings row shows the branch
- [x] Full suite green (`cargo test`, `npm test`, `svelte-check`)
