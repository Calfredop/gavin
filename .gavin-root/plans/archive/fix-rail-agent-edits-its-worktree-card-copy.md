---
order: 17408
kind: plan
title: "[fix] a rail agent can edit its worktree's copy of a card and stall the rail forever"
status: Done
priority: high
---
`.gavin-root/plans/` is tracked in git (179 files on `main`), so every rail
worktree carries a full copy of the board at its branch point. A rail step
hands its agent a worktree cwd and an absolute card path in the MAIN
checkout — two different files with the same name, one of them inside the
agent's own cwd. An agent that writes to the wrong one gets no error and
no signal of any kind, and three things go wrong at once.

Observed on 2026-09-04, rail "Follow-up queue", step
`4c747b20-d7ac-4f16-9662-2f39e1ba62c1`:

- The agent read `/…/gavin/.gavin-root/plans/feat-queued-follow-ups.md`
  (the path the prompt gave it) and wrote
  `/…/gavin-follow-up-queue/.gavin-root/plans/feat-queued-follow-ups.md`
  (a relative path from its cwd). Different inodes.
- **The board never moved.** Main's copy still read `status: In Progress`
  with every checklist item unticked, so the card showed no progress at
  all for a completed piece of work.
- **The rail stalled.** The step stayed `running` and stage 1's step
  (`fix-closing-multiple-terminal-sessions.md`) stayed `pending` — with
  nothing on any surface saying why, because from the board's side the
  agent simply had not finished.
- **The divergence rides the branch.** The worktree's copy was moved to
  `plans/done/`, so the branch carries a rename of a card that main still
  has in `plans/`, waiting to land as a merge conflict.

`recover_moved_card_paths` cannot help here and is not at fault: from the
watched workspace's tree the card never moved, because the file that
moved was in a checkout nobody is watching.

## Why it is worth fixing rather than filing under agent error

The agent did make the mistake. But the arrangement makes it a cheap
mistake to make and an expensive one to notice: the prompt names the
absolute path exactly once, every subsequent relative path resolves
inside the worktree to a file that exists and looks right, and the
failure is silent on all four surfaces that could have caught it (the
card, the rail, the step, the merge). A rail that can stall forever with
no explanation is the part that has to change.

## Decisions to make

- **Is a warning enough, or does the write have to be caught?** A rail's
  worktree path and its steps' card paths are both in the daemon, so it
  can already tell that a card file under a rail worktree mirrors a
  tracked step's card path. Detecting a modified mirror and surfacing it
  on the rail is the cheap half.
- **Should the launch prompt say it?** One sentence naming the main
  checkout as the card's only home, and the worktree copy as a decoy, is
  the cheapest fix of all — and it is the one that also covers agents
  reaching the card through a skill rather than through the prompt.
- **Does a stalled rail deserve a timeout or an attention state?** The
  step sat `running` against a session that had gone idle. Whatever the
  cause, "running for a long time with an idle session and an untouched
  card" is a state the rail could name instead of holding.
- **Should `.gavin-root/plans/` be in the worktree at all?** The obvious
  structural answer — don't check the board into git — is almost
  certainly wrong (the design versions it deliberately, and the archive
  is 175 cards of history). But it should be rejected explicitly here
  rather than left as an open question the next reader re-derives.

## Decisions taken

**A warning, not a caught write.** Nothing gavin owns sits between an
agent and the filesystem of a checkout it does not watch, so the write
cannot be intercepted. What can be done is to make it hard to make and
impossible to miss: say it in the prompt, and detect it afterwards.

**The prompt says it** (`cardHomeNote` in `cardRun.ts`). One paragraph,
appended to a card step's prompt only when the launch directory does not
contain the card — so a board Run, which starts in the card's own
context folder, reads exactly as it did before. It names three things
because all three are load-bearing: which file is real, what the other
one is, and what happens if it is written. "There is a copy" reads as
trivia; "the board never sees it" reads as an instruction.

**Detection is app-side and reads RUN CHANGES, not `git status`**
(`worktreeCards.ts` + `refreshDecoyEdits` in `orchestrationState.ts`).
Three alternatives were weighed and rejected:

- *In the daemon*, as the card first suggested. It would cost a protocol
  bump, and a bump takes every `gavin_*` tool in every running agent down
  until the human rebuilds and restarts. The app already has the rail,
  the worktree path and a git host command; nothing was gained.
- *Comparing the two files' contents.* A worktree branched off main days
  ago legitimately holds older copies of half the board, so this fires
  constantly and means nothing.
- *`git status` in the worktree.* Right until the agent commits the decoy
  — which is what actually happened here, since the divergence rode the
  branch — and then it goes quiet while the rail stays just as wedged.

`git_run_changes` against the baseline the run started on
(`CardSession.baseSha`, v26) reports the write whether or not it was
committed. One call per RUNNING card step on a bound rail, every 30s, so
a workspace with nothing running makes no calls at all. Every unknown —
no baseline, no worktree, a failed call, a workspace root that is not the
repo root — produces silence rather than a mark: "we did not look" must
never render as "we looked and it was fine".

**An attention state, not a timeout.** The rails already have a warn-only
vocabulary that five surfaces render (chip, step card, rail header,
sidebar recap, hub inbox), so both new facts joined it rather than
inventing a sixth surface: `decoy-edit` (the cause) and `stale`
(`turn-ended` aged past ten minutes — the symptom that will not clear).
Neither stalls the rail or touches `nextActions`: a mark costs nothing if
it is wrong, and a persisted verdict on a heuristic does not.
`ATTENTION_RANK` now has one statable rule — a mark meaning "this will
not finish by itself" outranks one meaning "it still might" — and
`stepAttentions` gathers candidates and lets the rank decide, instead of
letting the order of its `if`s decide.

**`.gavin-root/` stays in git — rejected explicitly.** Taking the board
out of version control would end the whole class of bug, and is still the
wrong trade: the design versions the cards deliberately, cards are read
and written by agents working in branches, `plans/archive/` is 175 cards
of history that belong with the code they describe, and the PRD's first
principle is that the work is a markdown file committed alongside the
repo. The decoy is the price of that, and it is paid with a warning and a
detector rather than by giving the property up.

Two things deliberately left alone. **Best-of-N** launches in worktrees
too, but its candidates are told to leave the card's status alone
entirely, so there is no status write to misdirect; a decoy warning there
would contradict the instruction beside it. And **`recover_moved_card_paths`
is not at fault** and is not touched: from the watched workspace's tree
the card never moved.

## Checklist

- [x] Reproduce: a rail step whose agent edits the worktree copy leaves the step `running` and the next stage `pending` with nothing said on any surface
- [x] Decide the shape from the four questions above, and record the rejected structural option
- [x] Warn at launch: the run prompt names the card's real home and the worktree copy as a decoy
- [x] Detect the divergence: the daemon can compare a rail worktree's mirror of a step's card against the tracked file, and the rail says so when they differ
- [x] Give a rail a way to say "this step has been running a long time and its card has not moved" rather than holding silently
- [x] Tests, and a smoke item for the stall being visible
