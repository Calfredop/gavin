---
kind: task
title: [perf] On Linux the main checkout's git watch registers every directory of .gavin-worktrees
status: To Do
priority: low
complexity: moderate
---
Since `feat-gavin-worktrees`, worktrees live INSIDE the workspace at
`<root>/.gavin-worktrees/<branch>`. Both git watchers already DROP those events
(`is_relevant` in app/src-tauri/src/git/watch.rs and crates/daemon/src/git_watch.rs).
But each still arms ONE `RecursiveMode::Recursive` watch on the checkout root
(`spawn_worktree_watcher` in both files). On Linux, `notify` emulates recursion with
one inotify watch per directory, so the main checkout now pays a watch for every
directory of every nested worktree, `node_modules/` and `target/` included. A few
rails can reach `fs.inotify.max_user_watches`, and then watch registration fails.
macOS FSEvents and Windows are unaffected: one stream or handle covers the whole
tree.

The daemon's RepoPoller (`setup_filesystem_watch`, crates/daemon/src/server.rs)
already avoids it. It watches each top-level entry separately and skips `.git` and
`.gavin-worktrees`. The tree watcher (`watch_targets`, crates/daemon/src/gavin.rs)
skips every dot directory.

## Fix

On Linux, register the git watchers the way the RepoPoller does: the root
non-recursively, then each top-level entry recursively except `.git` (already
covered by the gitdir watch) and `.gavin-worktrees`. Re-arm when a top-level
directory appears. Keep the single recursive watch where FSEvents or
`ReadDirectoryChangesW` makes it one registration (see `ONE_RECURSIVE_WATCH` in
gavin.rs for the same split).

## Verify

In the ubuntu:24.04 Docker harness (see the Linux port card), cut three worktrees
with `node_modules` into `.gavin-worktrees`, open the main checkout's Git tab, and
compare `/proc/<pid>/fdinfo` inotify watch counts before and after.
