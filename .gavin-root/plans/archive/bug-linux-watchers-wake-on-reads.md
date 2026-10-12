---
kind: task
title: [bug] Linux watchers wake on reads (RepoPoller, .gavin watcher, file viewer)
status: Done
priority: medium
attachments: crates/daemon/src/server.rs,crates/daemon/src/gavin.rs,app/src-tauri/src/fileviewer.rs,crates/daemon/src/git_watch.rs
complexity: moderate
---
Found while fixing `bug-ci-fails`. On Linux, notify's inotify backend watches `IN_OPEN` and `IN_CLOSE_NOWRITE` and reports them as `EventKind::Access`. `notify_debouncer_mini` keeps only each event's path, so a READ reaches the callback looking exactly like a change. FSEvents (macOS) and ReadDirectoryChangesW (Windows) report no reads, so this only shows up on Linux.

The Git-tab worktree watchers (`crates/daemon/src/git_watch.rs`, `app/src-tauri/src/git/watch.rs`) now build their debouncer over `ChangesOnly`, a `Watcher` wrapper that drops reads before the debouncer sees them. The other `notify_debouncer_mini::new_debouncer` users still use the bare `RecommendedWatcher`:

- `crates/daemon/src/server.rs` RepoPoller (`setup_filesystem_watch`) watches `.git` NonRecursive, then runs `git status` on every batch. That `git status` opens `.git/index` and `HEAD`, which is a read event in `.git`. Check whether this keeps re-triggering on Linux, or whether `trigger_recheck`'s coalescing absorbs it.
- `crates/daemon/src/gavin.rs` (the `.gavin*` watcher): every card read by the daemon or by an agent is an open.
- `app/src-tauri/src/fileviewer.rs`: the viewer re-reading the file it watches is an open.

For each one, measure it in a Linux container (see the `ubuntu:24.04` recipe in memory `project_linux_port`), and apply the same `ChangesOnly` wrapper where reads cause a wake-up. The daemon can share one copy across `git_watch.rs` and `server.rs`/`gavin.rs`. Add a test that fails on Linux without the wrapper.

## Result (2026-10-10)

Measured in the `gavin-ci-linux` container (ubuntu:24.04), idle, before the fix:

- RepoPoller: its own `git status` re-armed it -- one run every 5 s (MIN_RECHECK_INTERVAL), forever. `trigger_recheck`'s coalescing paces the loop, it does not stop it.
- `.gavin*` watcher: 6 rescans in 10 s on a 20-card root -- each rescan's card reads armed the next, paced by MIN_RESCAN_INTERVAL.
- File viewer: 20 reloads in 10 s after one write.

After: 1 status run in 20 s, 1 scan in 10 s, 1 reload -- the initial one each time.

`ChangesOnly` now lives once per crate -- `crates/daemon/src/changes_only.rs` (git_watch, RepoPoller, `.gavin*` watcher) and `app/src-tauri/src/changes_only.rs` (Git tab, file viewer; the app does not link the daemon) -- with `new_debouncer(timeout, cb)` as the one way to build a debouncer. New tests, each red on Linux without the wrapper: `server::tests::the_pollers_own_git_status_does_not_recheck_the_repo`, `gavin::tests::reading_a_card_does_not_rescan`, `fileviewer::tests::reading_the_watched_file_does_not_fire_the_callback`.
