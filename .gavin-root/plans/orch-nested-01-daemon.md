---
kind: task
title: [orch-nested] daemon: children: field, gavin_tick_item, nested-run rows
parent: feat-plan-orchestrates-nested-tasks.md
complexity: complex
---
Read `docs/adr/0012-a-nested-task-finishes-by-its-tick.md` and the parent card `feat-plan-orchestrates-nested-tasks.md` first. Then, in `crates/protocol`, `crates/daemon` and `crates/gavin-mcp`:

(a) Parse `children: sequence | parallel` from a plan's frontmatter into `PlanFileInfo`. An unknown value reads as absent and raises a card warning. `SetPlanFrontmatterField` accepts the `children` key; so does `gavin_set_plan_field`'s key enum; `gavin_create_plan` takes it too.

(b) A new request `TickChecklistLink { plan, child_file, checked }` that ticks or unticks the plan's `[…](./child_file)` checklist line, appending `- [ ] [title](./child_file)` when the line is missing. It refuses a `child_file` that is not a nested task of that plan. Expose it as the MCP tool `gavin_tick_item(plan, child, checked = true)`.

(c) A new `orch_nested_runs` table keyed by (step_id, child_path) with state, session_id, reason, conversation_id, launch_cwd and resume_attempts, read and written through new requests and returned with the orchestration, pruned with its step exactly as `orch_step_runs` is. `orch_step_runs` cannot hold these: it is pruned to step ids in `orch_steps`. Prove the migration against a database built by hand with the old schema (the `pre_v*` tests).

Bump `PROTOCOL_VERSION` with a doc paragraph in the house style; give the new request TYPES `min_version_for` entries; add `FEATURE_MIN_VERSION.orchestratedPlans` in `app/src/lib/daemonCompat.ts` and the matching TS wire types. Rust tests for each piece. Do not touch app UI or the scheduler — the next nested tasks own those.

## Done (2026-10-29)

v80. `PlanFileInfo.children` and `PlanFileInfo.checklist_links` (each `[…](./child.md)` line of a plan with its tick — added beyond the brief, because the app has to read ticks from the tree, not the file). `CreatePlan` was NOT widened: `gavin_create_plan`'s `children` is a second `SetPlanFrontmatterField` write, like its labels. New TYPES `TickChecklistLink`, `SetNestedRun`, `ClearNestedRuns`; `Orchestration.nested_runs`. Tauri commands `tick_checklist_link`, `set_nested_run`, `clear_nested_runs` (Remote: Allowed); TS `backend.tickChecklistLink / setNestedRun / clearNestedRuns`, `NestedRun` in `orchestration.ts`, `FEATURE_MIN_VERSION.orchestratedPlans = 80`.
