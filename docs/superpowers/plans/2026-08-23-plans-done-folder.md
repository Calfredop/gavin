# Plans — Archive Done cards into `plans/done/` — Implementation Plan

> **For agentic workers:** Steps use checkbox (`- [ ]`) syntax for tracking. Work them in order; each task ends green and committed.

**Goal:** a plan card whose status reaches Done lives in `plans/done/`; anything else stays flat. Nested children travel with their parent. Status frontmatter remains the only source of truth.

**Architecture:** the rule lives in one daemon function (`relocate_for_status`) called after every frontmatter write. `Manager` wraps it so a move can re-key the two SQLite tables that store plan paths. The protocol answer carries the post-write path so the UI can follow a card that moved under it.

**Spec:** `docs/superpowers/specs/2026-08-23-plans-done-folder-design.md`.

## Global Constraints

- The folder is derived from status, never the reverse — no scanner infers status from a path.
- "Done" is a slug match (`Done`/`done`/`DONE`), nothing else archives.
- A collision leaves the file in place; the status write still lands.
- No SQLite schema migration: path re-keying is plain `UPDATE`s.

## File structure

**Rust**: `crates/daemon/src/gavin.rs` (`archived_path_for`, `relocate_for_status`, `set_plan_field` return type, `create_plan_file`, `promote_checklist_item`), `crates/daemon/src/kanban.rs` (`rename_card_path`), `crates/daemon/src/orchestration.rs` (`rename_card_path`), `crates/daemon/src/server.rs` (`Manager::set_plan_field`), `crates/protocol/src/lib.rs` (`Response::PlanFieldSet`, `PROTOCOL_VERSION` 10), `crates/gavin-mcp/src/main.rs` (report the new path), `app/src-tauri/src/lib.rs` (command returns the path).

**TS**: `backend.ts` (return type), `gavinState.ts` (`patchPlanPath`), `CardDetailModal.svelte` (`onPathChange`), `KanbanBoard.svelte` / `BoardPane.svelte` / `OrchestrationHubView.svelte` (follow the path), `cardRunActions.ts` (status before prompt), `planExplorer.ts` (Done group), `PlanTree.svelte` / `PlanExplorerHubView.svelte` (render it), `smokeChecklist.ts`.

**Docs**: `.claude/skills/gavin/SKILL.md`, `app/src-tauri/src/gavin_skill.md`.

---

### Task 1: The daemon rule
- [ ] Tests in `gavin.rs`: to-Done moves and creates `done/`; out-of-Done moves back; `Shipped` never moves; nested children travel both ways; a child with its own status stays; collision leaves the file and still writes status; `create_plan_file(status = "Done")` lands in `done/`; `promote_checklist_item` from inside `done/` creates the task in `plans/` root; `delete_card_file` accepts a `done/` path.
- [ ] Implement `archived_path_for` + `relocate_for_status`; `set_plan_field` returns `PathBuf`; `create_plan_file` and `promote_checklist_item` per spec §2.
- [ ] `cargo test -p gavin-daemon` green; commit.

### Task 2: Path re-keying and the protocol
- [ ] Tests: `KanbanStore::rename_card_path` moves a binding and leaves others alone; `OrchestrationStore::rename_card_path` likewise; `Manager::set_plan_field` re-keys both after a move.
- [ ] Implement both store methods and `Manager::set_plan_field`; route `Request::SetPlanFrontmatterField` through it; add `Response::PlanFieldSet`; bump `PROTOCOL_VERSION` to 10 (and its assertion).
- [ ] `cargo test` green across the workspace; commit.

### Task 3: Agent surface
- [ ] `gavin-mcp`'s `gavin_set_plan_field` reports the moved-to path.
- [ ] `app/src-tauri` command returns the path; `backend.setPlanFrontmatterField` types it.
- [ ] Both skill docs learn the rule.
- [ ] `cargo test` + `npm run check` green; commit.

### Task 4: UI follows the move
- [ ] Vitest: `patchPlanPath` re-identifies a plan in the projection and no-ops on an unknown path.
- [ ] `CardDetailModal` `onPathChange`; the three hosts update `openPlanPath`; `cardRunActions` writes status before composing the prompt.
- [ ] `npm test && npm run check` green; commit.

### Task 5: Explorer grouping
- [ ] Vitest: `buildExplorerTree` collects `done/` files under one Done node, leaves flat plans in place, and omits the node when nothing is archived.
- [ ] Implement in `planExplorer.ts`; render the collapsed node in the tree components.
- [ ] `npm test && npm run check && npm run build` green; commit.

### Task 6: Smoke, migration, card
- [ ] Smoke entries for the archive round trip (including with the modal open).
- [ ] `git mv` this repo's Done plan cards into `.gavin-root/plans/done/` — separate commit, no content edits.
- [ ] Tick the card's checklist, set it Done, full verification.
