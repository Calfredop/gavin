---
kind: task
title: Network git sync and conflict resolution over ssh
parent: feat-ssh-support.md
complexity: complex
---
The Git tab and Files tree over ssh landed in `ed97220` (spec `docs/superpowers/specs/2026-09-22-ssh-git-files-design.md`): status, diff, stage/unstage, commit, log, branches, stash and the Files tree/read/write route to the host daemon through `RunGit` (v40) and `ListWorkspaceDir`. Four things stayed on the desktop and are gated off for ssh workspaces; this card finishes them.

1. **Network sync — fetch, pull, push.** They use `run_git_streaming` (progress lines, cancellable), which the synchronous `RunGit` is not shaped for. Add a streaming git request: the daemon runs the op and pushes progress lines (like `git-op-progress` today), and a cancel request `take()`s and kills the child on the host. Then route `run_git_streaming` and remove the `syncBlocked` gate in `GitToolbar.svelte`.
2. **The git watcher.** `git_watch`/`git_unwatch` no-op for ssh (no local `.git`). Either push a git-status change from the host daemon's existing `.gavin`/repo watcher, or poll on a timer, so the Git tab auto-refreshes over ssh instead of needing manual Refresh.
3. **Conflicts (the 3-pane).** `conflict.rs` reads rebase state from a local `git_dir` path (`std::fs` on `head-name`/`onto`) and the resolve actions mostly route via `run_git` but the file reads do not. Route the `git_dir` reads through `ReadWorkspaceFile`, and verify the 3-pane merge works after a conflicting merge on an ssh workspace.
4. **Tree mutations and `.gitignore`.** Creating, renaming, trashing in the Files tree and editing `.gitignore` (`ignore.rs`, which writes the file on the local disk) are gated off. Route create/rename via new confined requests (or reuse `WriteWorkspaceFile` for create); decide what "trash" means on a host (there is no OS Trash there — likely `rm` with a clear confirmation, or leave delete out); route `ignore.rs`'s file read/write. Cherry-pick and `run_git_env` (GIT_EDITOR) belong here too.

Tests: daemon tests for the streaming request and any new confined requests; app tests for the routing; then `cargo test -p protocol`, `cargo test -p gavin-daemon`, `cargo test -p app`, `cd app && npm test && npm run check`. Commit only the files you touched.
