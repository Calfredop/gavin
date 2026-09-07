---
order: 6144
kind: task
title: [bug] review tab file grouping
status: Done
---
The group by touched files logic in “Review” tab is not working. All cards fall inside all touched files group. So ther’s only one group with all touched files

## Root cause

Two defects, compounding. Measured on this board: 24 cards, **2 groups**,
one of them holding 22.

**1. A card's files were the checkout's, not the card's.** `run_changes`
answers `git diff <baseline>..worktree`, which in a checkout several
agents share is every LATER run's work as well. The oldest finished card
here claimed 196 files — nearly the whole tree — and every card's list
was a superset of the next one's (16 strict-subset pairs among 11 cards).
Sets that nest cannot be told apart by any clustering rule. The
repo-wide `ls-files --others` scan made it worse: all 23 untracked files
were appended to every card in the checkout, identical for each.

**2. A file's identity was its repo-relative path, with no checkout in
it.** `app/src/lib/git.ts` in this tree and in a sibling worktree keyed
the same, so cards from four checkouts — and two unrelated repositories —
unioned into one component. `README.md` would have been enough.

## What landed

**The window stops where the next run started** (`next_baseline` in
`runchanges.rs`). `git_run_changes` takes `peers`, every baseline
recorded against the same launch cwd, and bounds the diff at the nearest
one that is a strict DESCENDANT of this baseline — ancestry, never a
commit date, because a rebase rewrites dates and a non-descendant bound
would report the difference between two branches as one card's work. A
peer equal to this baseline is no bound either: two runs launched from
one commit are measured identically, and a zero-length window would say
they wrote nothing. Untracked files belong to the unbounded question
only — `ls-files --others` has no baseline in it, so it cannot be cut to
a window. `git_diff_since` takes the same bound back, so a file opens
with exactly the hunks its row counted.

On this board that turned 196/137/132/128/128/122/102/76-file cards into
81/12/6/19/19/26/40/5.

**A collision is the same file in the same CHECKOUT.** `ReviewCandidate`
carries the repository root it was measured in (so two cards launched at
different depths of one tree still meet) and the clustering keys on it.

**A group whose cards all share one baseline says so** rather than naming
files: their list is one measurement handed to each of them, not an
agreement between them. `SAME_BASELINE_LABEL` + `sameBaselineHint`, and
the hint moved onto `ReviewGroup.hint` so the list no longer special-cases
one group id.

Board after: **6 groups**, and they are the real per-worktree families
(custom-agents 4, modal-rework 4, review-tab 3, two single cards, and the
shared main checkout 11).

## Left standing, deliberately

The shared main checkout still groups as 11. That is now the *documented*
transitive join — settled with the owner on `feat-review-tab` ("clusters
of cards that share at least one touched file") — working on genuine
1-to-19-file collisions (`Pane.svelte`, `theme.css`, `+page.svelte`)
rather than on the measurement artefact this card removed. Changing that
rule is a separate decision, not this bug's.

Two of those links are worth knowing about: the last cards launched in a
checkout have no successor, so their window stays open and absorbs
whatever the fleet is doing right now; and `.gavin-root/plans/*.md`
churn counts as a collision like any other file.

## Checks

`cargo test --lib` in `app/src-tauri` 374 passed · `npm test` 4544 passed ·
`npm run check` 0 errors · `npm run build` green. Verified end-to-end
against the real board by replaying the shipped rule over every Done
card's actual baseline.

Left for the owner: the rendered pass — the new group header and its
hint, and whether the six groups read usefully in the running app.

<!-- gavin:auto-commit -->
When the implementation is done, commit it. Commit only the files you touched — never `git add -A`. Do not push.
<!-- /gavin:auto-commit -->
