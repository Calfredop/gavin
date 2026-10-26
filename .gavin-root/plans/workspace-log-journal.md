---
kind: task
title: Workspace log: journal, card/rail/human/scheduled entries, protocol v79
parent: feat-backlog.md
complexity: complex
---
Build the daemon side of the Workspace log described on the parent card `feat-backlog.md` (read its settled list first, and `docs/adr/0011-the-workspace-log-is-recorded-as-it-happens.md`).

1. **Store.** A new `workspace_log` table in `kanban.sqlite`. Each row holds the workspace id, a UTC unix-seconds timestamp, the kind, a structured payload (card file name and title, from/to column, rail id and name, human item text, scheduled task id, plus a `noticed_on_start` flag), indexed `(workspace_id, at)`. Prove the migration against a database built by hand with the pre-v79 schema, as the `pre_v*` tests in `kanban.rs` do. When the table is first created, copy `card_runs` into it once, as run started/finished entries, and never again.
2. **Card and human-item entries.** In the `.gavin*` watcher (`crates/daemon/src/gavin.rs`), keep a last-known snapshot per workspace (path, title, effective status, `human_items`) and diff it on every wake and once at startup.
   - A file name that leaves `plans/` and appears in `plans/archive/` is **archived**.
   - One that disappears with no matching appearance is **deleted**.
   - A status change, or a move into `plans/done/`, is **moved column**. Go through the effective status: a nested task has none of its own.
   - A changed `title:` is **title changed**.
   - A human item that appears is **filed**; one that gains `Answer`/`Result` is **answered/passed/failed**.
   - Entries found at startup carry `noticed_on_start`.
   - Debounce so a file saved twice is one entry. A rename by file move must not read as delete + create.
3. **Run, rail and scheduled entries.**
   - Card runs: journal started/finished where `card_runs` rows are written.
   - Rails: created and deleted where orchestration is saved; started · paused · resumed · finished · failed from the state transition in `set_rail_run` / `set_rail_run_by_root` (`server.rs`), comparing the old state with the new.
   - Scheduled task fired: where the fire is claimed in `kanban.sqlite`, so two apps never log it twice.
4. **Protocol v79** (`crates/protocol`). New request types:
   - read a page of entries (workspace, before-cursor, limit, kinds, text query over card/rail names and git branch/worktree fields)
   - clear entries older than a timestamp (or all); this never touches `card_runs`
   - a push of new entries to subscribed clients

   Add them to `min_version_for`. Add the `FEATURE_MIN_VERSION` entry in `app/src/lib/daemonCompat.ts`; the tab card will consume it.
5. Leave a `pub` function the git card can call to append entries, with its kinds reserved in the payload enum (git commit/checkout/merge/pull/rebase/reset/push, branch deleted).

Tests: unit tests for the diff (create, delete, archive, rename-by-move, column move, done, title, each human-item transition, offline diff) and for clear-preserves-card_runs. Run `cargo test --workspace`. Re-run `gavin::tests` alone before calling a failure a regression. Verify behaviour against an isolated daemon under a temp `$HOME`, never the shared one.
