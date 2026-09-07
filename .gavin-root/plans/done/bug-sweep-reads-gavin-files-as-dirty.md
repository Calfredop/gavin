---
order: 2048
kind: task
title: [bug] the worktree sweep reads gavin's own files as uncommitted work
status: Done
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

- [x] Filter `sweepFacts`'s dirty set through `isGavinOwnPath`, so `dirty`
      means the project's files.
- [x] Decide what the removal does about gavin's own untracked files in a
      worktree git will refuse to remove without `--force`. Removing the
      symlink first is not obviously right — it is the human's link, and a
      removal that fails halfway has deleted it for nothing.
- [x] Keep the guard honest for real untracked work: a new source file the
      human wrote must still keep the worktree.

## How it was settled

Deleting gavin's files first was rejected: a removal that fails halfway
would have deleted the human's link for nothing, and a real `.gavin-root`
folder of cards is not gavin's to delete either.

Instead the removal keeps a last line of defence of its own, narrower than
git's. `mayForceRemoval` (worktreeSweep.ts, pure) answers true only when
git still reports something AND every entry is gavin's own; `sweepWorktrees`
asks it per entry and passes that as the force flag. Clean checkouts stay
unforced — nothing is in the way — and a read that fails forces nothing, so
git refuses as before.

The freshness matters and is deliberate: the status is re-read at the
moment of removal, not taken from the facts the confirmation was drawn
from. Those were gathered before a dialog the human then spent seconds in,
and an agent writes to a checkout in far less — that window is exactly what
git's blanket refusal used to cover.

Probed against real git, all five shapes composing end to end: a symlinked
`.gavin-root`, a `.gavin-root` folder of cards and a nested `.gavin/` are
each swept and forced; a clean worktree is swept unforced; a worktree
holding `hours-of-work.ts` is never classified stale and is refused even if
it were. A forced removal deletes the symlink and not its target — the
human's board survived every case.

Before/after on the Grimoria repo, isolating the dirty rule: 6 of 6 kept on
a false "uncommitted changes" before, 5 of them offered afterwards with a
true reason. With the real rail bindings in place those 5 are still kept —
but now as "rail “UG · …” bound to it", which is the fact that actually
decides them.
