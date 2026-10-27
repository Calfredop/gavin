---
order: 15360
labels: memory
kind: note
title: The daemon's git_watch.rs watches only for an ssh desk
status: To Do
topics: daemon, git, watcher
---
crates/daemon/src/git_watch.rs runs only while an ssh desk sends WatchGitWorktree; a local workspace's .git is watched by the host (app/src-tauri/src/git/watch.rs), and the Workspace log's reflogs by the daemon's own crates/daemon/src/reflog.rs.
Why: a daemon feature that waits for git_watch.rs to wake never fires for a local workspace.
