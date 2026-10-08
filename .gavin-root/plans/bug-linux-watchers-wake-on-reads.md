---
kind: task
title: [bug] Linux watchers wake on reads (RepoPoller, .gavin watcher, file viewer)
status: To Do
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
