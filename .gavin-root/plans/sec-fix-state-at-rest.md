---
order: 11264
kind: task
title: [sec] 0600 database files and reap queued input
status: To Do
priority: low
complexity: simple
---
**Severity:** Low. Finding **R7** in `docs/security/README.md` (source DP-04 in `01-daemon-protocol.md`). The report lives on branch `sec/review-2026090801` until merged.

**The problem.** `registry.sqlite`, `kanban.sqlite` and `orchestration.sqlite` are created `0644` inside the `0700` app-support directory, while the socket beside them is `0600`; and queued-input text (`queued_inputs`) sits in plaintext and is not removed when its session is ended as an orphan, so pasted text outlives the session it was typed for. Same-user reading is the accepted boundary (AD-1/AD-5); the mode and the retention are the fix. Screen content is not persisted — do not add a store for it.

**The fix.** In `crates/daemon/src/main.rs` / `registry.rs`: open each database and then `set_permissions(0o600)` (and on first open of an existing `0644` file, tighten it — a migration that touches only the mode). In `server.rs`'s `EndOrphan` and `KillSession` handlers, delete the session's `queued_inputs` rows in the same transaction that ends the session; add a registry test that a killed session leaves no queued rows, and note in `CLAUDE.md`'s trap list that a column added only to `CREATE TABLE IF NOT EXISTS` never reaches an existing DB, since this touches the same code.

<!-- gavin:auto-commit -->
When the implementation is done, commit it. Commit only the files you touched — never `git add -A`. Do not push.
<!-- /gavin:auto-commit -->
