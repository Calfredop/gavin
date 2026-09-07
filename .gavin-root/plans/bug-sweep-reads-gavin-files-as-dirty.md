---
kind: task
title: [bug] the worktree sweep reads gavin's own files as uncommitted work
status: To Do
---
Sibling of `bug-rail-stall.md`, split off because its blast radius is
destructive and it needs a second moving part.

`sweepFacts` (gitState.ts) calls `backend.gitStatus` per worktree and calls
anything with a non-empty `staged`/`unstaged` dirty. `parse_status` files
untracked paths under `unstaged`, so every checkout of a gavin workspace is
dirty on the strength of its own `.gavin-root` — a symlink to the root
checkout's board in a shared fleet, a tracked folder that churns on every
card move where the workspace keeps its board in git. `classifyWorktrees`
then keeps the row with "uncommitted changes", which is the reason it
tests FIRST, so it outranks every other verdict.

Measured on the Grimoria workspace: six of six linked worktrees kept, five
of them with zero tracked changes between them. The Sweep button is a no-op
in exactly the workspaces it was built for, and the reason it gives names a
file gavin put there itself.

The rail-stall fix added `isGavinOwnPath` to gitTracking.ts, which is the
predicate this needs — but filtering `sweepFacts` alone would make things
worse, not better. `git worktree remove` refuses on untracked files too and
`sweepWorktrees` deliberately never passes `--force` ("the last line of
defence under the staleness rule"), so a row reclassified as stale would
fail at removal with git's raw error in the banner instead of a clear
"kept: uncommitted changes".

So the work is both halves at once:

- [ ] Filter `sweepFacts`'s dirty set through `isGavinOwnPath`, so `dirty`
      means the project's files.
- [ ] Decide what the removal does about gavin's own untracked files in a
      worktree git will refuse to remove without `--force`. Removing the
      symlink first is not obviously right — it is the human's link, and a
      removal that fails halfway has deleted it for nothing.
- [ ] Keep the guard honest for real untracked work: a new source file the
      human wrote must still keep the worktree.
