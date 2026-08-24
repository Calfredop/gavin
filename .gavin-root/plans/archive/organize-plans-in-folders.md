---
title: Organize plans in folders
kind: plan
status: Done
---
# Organize plans in folders

Finished cards clog `.gavin*/plans/` — 30 of this repo's 44 plan files are
Done, and every agent that greps or lists the folder wades through them. A
plan card whose status reaches Done moves into `plans/done/`; everything else
stays flat. Status frontmatter stays the single source of truth, the folder is
derived from it, and nested children travel with their parent.

Spec: `docs/superpowers/specs/2026-08-23-plans-done-folder-design.md`
Plan: `docs/superpowers/plans/2026-08-23-plans-done-folder.md`

No SQLite schema migration is needed — the two tables holding plan paths
(`card_sessions.path`, `orch_steps.card_path`) are re-keyed with plain
UPDATEs when a file moves.

## Steps

- [x] Daemon rule: `archived_path_for` / `relocate_for_status`, `set_plan_field` returns the path, `create_plan_file` and `promote_checklist_item` handle `done/` (+ tests)
- [x] Path re-keying: `rename_card_path` on the kanban and orchestration stores, `Manager::set_plan_field`, `Response::PlanFieldSet`, protocol version 10 (+ tests)
- [x] Agent surface: gavin-mcp reports the moved-to path, Tauri command and `backend.ts` return it, both skill docs learn the rule
- [x] UI follows the move: `patchPlanPath`, `CardDetailModal` `onPathChange`, the three hosts, status-before-prompt in the run flows (+ tests)
- [x] Plan explorer groups `done/` files under one collapsed Done node (+ tests)
- [x] Smoke entries for the archive round trip
- [x] Migrate this repo's Done cards into `.gavin-root/plans/done/`
