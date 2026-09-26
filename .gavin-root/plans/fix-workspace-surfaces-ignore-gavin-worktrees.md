---
kind: task
title: [fix] The removal wizard and the Files tab don't know about .gavin-worktrees
status: To Do
priority: low
complexity: simple
---
Since `feat-gavin-worktrees`, the worktrees gavin cuts are live checkouts inside the
workspace at `<root>/.gavin-worktrees/<branch>`. Two workspace-wide surfaces treat
that folder as ordinary content:

1. **Workspace removal wizard.** `walk_contexts` in
   app/src-tauri/src/workspace_delete.rs skips dot folders, so "remove gavin from
   this folder" never mentions `.gavin-worktrees/`. It leaves live checkouts,
   possibly holding uncommitted work, and their `git worktree` registrations behind
   without a word. Nothing in that flow calls `git worktree remove`, which is right,
   because trashing them is not the wizard's call. But the summary should list them
   and say how to remove them: the Git tab's sweep, or `git worktree remove`.
2. **Files tab.** `fileTree.ts` hides nothing, so `.gavin-worktrees/` is listed and
   its folders can be moved to the Trash (`fileviewer.rs` trash, confirm-gated).
   Trashing a live worktree that way skips `git worktree remove`: the branch stays
   checked out in a prunable entry until someone runs `git worktree prune`. At
   minimum the confirmation for a path under `.gavin-worktrees/<x>` should say it is
   a worktree and point at the Git tab's remove. Hiding or dimming the folder is
   the alternative.

## Verify

A workspace_delete.rs test: a root with `.gavin-worktrees/feat-x` reports it in the
scan summary, and `remove()` never touches it. For the Files tab, a pure-module
test of whatever decides the confirmation text.
