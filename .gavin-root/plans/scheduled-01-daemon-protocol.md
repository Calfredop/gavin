---
kind: task
title: Scheduled tasks: daemon + protocol
parent: feat-scheduled-tasks-plans.md
complexity: complex
---
Build the daemon and protocol half of Scheduled tasks. Read the parent card `feat-scheduled-tasks-plans.md` (Settled design), `docs/adr/0010-a-scheduled-task-is-a-copy.md` and the Scheduling terms in `CONTEXT.md` first; do not re-litigate them.

Do:
- Parse `.gavin-root/scheduled/*.md` (reuse `parse_frontmatter` in `crates/daemon/src/gavin.rs`): `title, agent, model, effort, complexity, from, schedule, paused` + body. Pick a `schedule:` one-line syntax (e.g. `at=2026-10-21T09:00 every=2h runs=5`, `runs=inf`; no `every` = single shot), with a parser and unit tests in `crates/protocol` (behind no OS feature; it is pure). Keep the files out of the board and the tree parse, and make sure the `.gavin*` watcher still pushes a change for them.
- Requests: list scheduled tasks (with their run state), create from a card path (copy per the parent; refuse kind plan; drop `parent:`), create blank, update schedule/paused/body fields, duplicate, delete (file + its runs + its reports). Keep the `set_plan_field` allow-list untouched; these are their own requests.
- Run state in `kanban.sqlite`: a table keyed by (workspace, scheduled file) holding fire count, last fire, and per-fire rows (fire index, at, outcome launched|skipped, skip reason, session id, exit code, report path). New table → `CREATE TABLE IF NOT EXISTS`, plus a `pre_v*` test against a database built by hand with the OLD schema (see kanban.rs's existing ones).
- An atomic claim: "claim fire k of <task>" succeeds once across two daemons sharing the file; a second claim of the same k fails. Test it with two store handles on one file.
- On a scheduled run's session exit, save the session's full screen text (screen.rs, scrollback included) next to the report as `<stamp>.raw.txt`, and prune `.gavin-root/scheduled/runs/<name>/` to the last 20 runs. Add `.gavin-root/scheduled/runs/` to `.gitignore`.
- Bump `PROTOCOL_VERSION` (currently 76; take the next free number when you land), add `min_version_for` entries for the new request types, and add `scheduledTasks` to `FEATURE_MIN_VERSION` in `app/src/lib/core/daemonCompat.ts`.
- Add every new Tauri command to the Companion's Remote role command table (its test fails when one is missing).

Done when `cargo test --workspace` is green (re-run `gavin::tests` alone if they flake) and the new requests round-trip through `backend.ts` typings. Don't restart the shared daemon; verify under a temp `$HOME`.

<!-- gavin:auto-commit -->
When the implementation is done, commit it. Commit only the files you touched — never `git add -A`. Do not push.
<!-- /gavin:auto-commit -->
