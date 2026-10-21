---
kind: task
title: Activity calendar: commits, pushes and files
parent: tbd-feat-activity-calendar.md
complexity: moderate
---
Part of the activity calendar (parent card `tbd-feat-activity-calendar.md` — read its "Settled" list first). This piece is the Tauri host's git side only; do not touch the app UI.

Add a Tauri host command `git_activity(cwd, since)` in `app/src-tauri/src/git/`, read-only through `run_git_ro` so an ssh workspace routes over the link. It returns `{ commits: [{ sha, at, author, subject, files: [path] }], pushes: [{ at, remote_ref, old_sha, new_sha }] }`, every time UTC unix seconds.

- Commits: one `git log --all --name-only` since `since`, deduped by sha, `at` = author date (convert the dated offset to UTC).
- Pushes: from the reflogs of `refs/remotes/*`, only the `update by push` entries; `old_sha` is the previous reflog entry's sha (absent on the first).
- A folder that is not a repo returns empty lists, not an error.
- Register it in `REGISTERED_COMMANDS` and as `Allowed` in `crates/protocol/src/remote_commands.rs`.
- Tests against a temp repo with a bare remote: two branches, a merge, two pushes, and a `since` that cuts one commit off.

Run `cargo test --workspace`.
