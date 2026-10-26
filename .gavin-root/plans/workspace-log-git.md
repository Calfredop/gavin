---
kind: task
title: Workspace log: git entries from the reflog
parent: feat-backlog.md
complexity: complex
---
Add the git entries of the Workspace log described on the parent card `feat-backlog.md`. Needs `workspace-log-journal.md` done: use its append function and reserved git kinds.

1. When the daemon's `.git` watcher (`crates/daemon/src/git_watch.rs`) wakes for a workspace, read the new lines of:
   - each worktree's `HEAD` reflog: the main checkout and every `git worktree list` entry, rail worktrees included
   - the remote-tracking reflogs (`refs/remotes/*`) for pushes

   Journal each line as commit / checkout / merge / pull / rebase / reset / push, tagged with its branch and worktree path. Take the timestamp from the reflog line. Reuse the reflog parsing in `app/src-tauri/src/git/activity.rs` where it fits (push detection: `update by push`).
2. Keep a cursor per reflog (path + last line's timestamp and hash) in `kanban.sqlite`, so nothing is logged twice: not across wakes, not across restarts, and not for the remote-tracking refs every worktree shares. A worktree that appears starts its cursor at its current end and is not backfilled. A reflog that shrinks (expiry or `git reflog expire`) resets its cursor without re-logging. Lines added while the daemon was down are logged at startup with their own reflog times.
3. **Branch deleted.** Branch deletion leaves no reflog line, so the host reports it: wherever `app/src-tauri/src/git` deletes a branch, send the daemon a request (add it to protocol v79 alongside the journal card's, with a `min_version_for` entry) that appends a branch-deleted entry.

Tests: reflog parsing for each kind, the cursor across wakes and restarts, no double push across two worktrees, the shrink reset. Build them against real temp repos with `git worktree add`. Run `cargo test --workspace`, and verify against an isolated daemon under a temp `$HOME`.

Done (2026-10-26). One deviation from item 1: `git_watch.rs` runs only for an ssh desk's `WatchGitWorktree`, so a local workspace's `.git` is never watched by the daemon at all. The reflogs are read by the daemon's own watch instead (`crates/daemon/src/reflog.rs`), attached to each workspace's `.gavin*` watch: it watches `logs/` and `worktrees/` in the common git dir and reads the reflog files directly (no git process, no lock), with a byte-offset cursor per reflog in `kanban.sqlite`. The host reports branch deletion through `RecordBranchDeleted` from `git_delete_branch`.
