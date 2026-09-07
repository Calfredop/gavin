---
order: 6144
kind: task
title: [bug] rail stall
status: Done
---
When I try to start rail "UG · card model (tags, per-copy attrs)” in grimoria workspace, it stall right away. Could it be because of rail name and page creation?

## What it was

Not the rail's name, and not page creation — `startRail` spawns no page at
all (O16: the page is made by the first *launch*, around that session).

The rail binds branch `feat/ug-card-model`, and its worktree
`mandragora-wt-collection-detail` sat on `feat/collection-detail-batch`, so
O15's branch switch ran first. `executeSwitchBranch` refuses a dirty
checkout — and read the checkout's *only* entry, `?? .gavin-root`, as the
human's uncommitted work. `parse_status` files untracked paths under
`unstaged`, and `.gavin-root` there is the symlink to the root checkout's
board that lets a fleet of worktrees share one. So the first stage stalled
and rule 5 paused the rail, before anything launched, over a file gavin put
there itself — advising "commit or stash them", which is advice the human
must not take.

Measured across the whole workspace, not just the rail that was reported:
all five UG rails' worktrees were blocked by exactly this, with zero
tracked changes between them, and the root checkout was blocked too — its
only dirt is `.gavin-root/plans/…` moving a card to Done. On a workspace
that keeps its board in git the board is dirty most of the time, so a rail
bound to the root checkout on a branch (O15's "a branch with no worktree")
could essentially never switch.

## The fix

`isGavinOwnPath` in `gitTracking.ts` — segment-exact on `.gavin-root` and
`.gavin`, mirroring `IGNORE_PATTERNS`/`GAVIN_PATHSPECS` in
`git/tracking.rs` — and the switch gate filters both `staged` and
`unstaged` through it. Staged too, because turning tracking off *stages*
the removal of gavin's files and never commits it, which would wedge the
gate the same way.

Nothing is lost by letting it through: `git switch` does not touch an
untracked file, and refuses on its own the one case where it would — the
target branch tracking that very path. Verified both halves against a
throwaway repo with the identical symlink shape.

## Left open

`sweepFacts` (gitState.ts) computes the same dirty set for the worktree
sweep, so every gavin worktree reports "uncommitted changes" and is never
swept. Same root cause, but not fixed here: `git worktree remove` refuses
on untracked files too and `sweepWorktrees` never passes `--force`, so
filtering the classification alone would turn a clear verdict into a raw
git failure. Its own card.

<!-- gavin:auto-commit -->
When the implementation is done, commit it. Commit only the files you touched — never `git add -A`. Do not push.
<!-- /gavin:auto-commit -->
