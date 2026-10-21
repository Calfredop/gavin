---
kind: task
title: Activity calendar: runs by time range
parent: tbd-feat-activity-calendar.md
complexity: moderate
---
Part of the activity calendar (parent card `tbd-feat-activity-calendar.md` — read its "Settled" list first). This piece is the daemon side only; do not touch the app UI.

Add a daemon request `ActivityRuns { workspace_id, since, until }` (UTC unix seconds) that returns, in one list oldest first, the card runs (`kanban.sqlite` `card_runs`) and standalone tool runs (`orchestration.sqlite` `tool_runs`) whose `started_at` falls in the window. Each item: `{ kind: "card" | "tool", workspace_id, path | tool_id, session_id, command, started_at, ended_at, outcome }`.

- Bump `PROTOCOL_VERSION` to the next free version at the time you land it, with its `min_version_for` entry and the protocol's usual round-trip test.
- A workspace-routed Tauri command `activity_runs`, so an ssh workspace is answered by its host daemon (follow how `card_runs` routes); register it in `REGISTERED_COMMANDS`.
- `Allowed` entry in `crates/protocol/src/remote_commands.rs` (it is a read).
- `FEATURE_MIN_VERSION.activityCalendar` in `app/src/lib/daemonCompat.ts`, plus the ssh-host twin the way `sshCardRuns` does.
- The query must be indexed by time; if it needs an index on `started_at`, add it with DDL that reaches an existing database (CLAUDE.md: `CREATE TABLE IF NOT EXISTS` hides a migration).
- Tests: two workspaces, card and tool runs both sides of a window boundary, and a still-running run (no `ended_at`).

Run `cargo test --workspace` (re-run `gavin::tests` alone before calling a failure yours).
