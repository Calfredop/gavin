---
status: Done
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

5. **Two gaps the first pass did not name** (found by the 2026-09-22 board
   audit, both reachable today on an ssh workspace with a v41 host):
   - **`git_conflict` and `git_restore_conflict` are not ssh-gated at all.**
     `app/src-tauri/src/lib.rs:286,290` registers them unconditionally, and
     `GitHubView.svelte:45` gates on the host daemon's *version*, not on the
     workspace being remote. So the 3-pane is reachable over ssh and
     misreads. Gate it beside the others until item 3 lands, then ungate it
     with the fix.
   - **"Ignore this file" in the Git tab's Changes menu is not gated either.**
     `GitChanges.svelte:140` → `gitState.ts:515` → `git_add_ignore_pattern`
     reaches `ignore.rs`'s local-disk write. The Files tree's copy of the
     same action *is* gated (`FilesHubView.svelte:404`); this one was missed.
   - Item 3 is also **wider than written**: besides the `git_dir` reads,
     the 3-pane's own file content is local-only — `conflict.rs:145`
     (`std::fs::read` of the worktree side) and `conflict.rs:168`. Both need
     routing, not just the rebase-state reads.

**Verified still open on 2026-09-22**, against `main` with `feat/ssh-support`
merged in. Evidence per item: no streaming git variant exists in the protocol
(`min_version_for` tops out at 41 with `RunGit`/`ListWorkspaceDir`) and
`run_git_streaming` (`app/src-tauri/src/git/run.rs:156`) still does not route
while `run_git` (`run.rs:45`) does; `git_watch` returns early for a remote cwd
(`app/src-tauri/src/git/watch.rs:119-125`); `conflict.rs:91-95` still reads the
host's `git_dir` with `std::fs`; the four tree mutations
(`fileviewer.rs:855,870,883,908`) have no `route_for_root` check where their
read-side siblings do, and `ignore.rs:45,57-59` is unrouted. One nuance worth
keeping: `Response::GitStatusChanged` *is* session-scoped and does cross the
bridge, so a terminal tab's branch/dirty badge already updates over ssh — it is
the Git **tab** that needs manual Refresh.

Tests: daemon tests for the streaming request and any new confined requests; app tests for the routing; then `cargo test -p protocol`, `cargo test -p gavin-daemon`, `cargo test -p app`, `cd app && npm test && npm run check`. Commit only the files you touched.
