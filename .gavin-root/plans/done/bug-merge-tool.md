---
kind: task
title: [bug] merge tool
status: Done
---
The orchestration merge tool item, does not merge the rail worktree to “main"

## What it was

The direction — and structurally so: no parameter value could have fixed it.

`builtin:merge` was authored as "merge `{{branch}}` INTO the branch checked out
in this worktree", and a tool step always runs in the rail's own checkout
(`executeToolLaunch`, `orchestrationState.ts:409`). So on a rail bound to a
worktree the tool pulled `main` in; on a rail with none — the root, already on
`main` — it merged `main` into `main`: "Already up to date", exit 0, step done.
Either way the rail's work stayed where it was and the step reported success.

Measured rather than reasoned, in a throwaway repo (root on `main`, a linked
worktree on `feat/x` carrying a commit), run from the rail's worktree:

| what was run | result |
|---|---|
| `git merge --no-edit main` — the tool as shipped | `Already up to date.` — `main` never moved |
| `git merge --no-edit feat/x` — `branch` overridden to the rail's own | `Already up to date.` — a branch cannot merge itself |
| `git switch main` first | `fatal: 'main' is already used by worktree at …` |

The landing direction is unreachable from the rail's checkout at all. It has to
run in the checkout that HAS the base branch — `git -C <that checkout> merge
<rail branch>` — which is exactly the move the Git tab's own merge-back already
makes (`gitState.mergeBack`: **root** cwd, not the fork's). The tool library had
no equivalent.

The other git-touching built-ins were checked for the same defect and are sound:
Commit and Push act on the rail's own checkout, which is where they belong, and
Open a pull request lands from the checked-out branch via `--base`.

## The fix

Merge ships in both directions now, told apart by name:

- `builtin:merge` keeps its id and its behaviour, renamed **Update from a
  branch** — every existing step goes on working and now says what it does.
- **`builtin:merge-into` — Merge this rail into a branch** (`base` [main]) is
  new: an agent that finds the checkout holding `base` and merges there.

Renaming rather than flipping was deliberate. Pulling `main` into a long-running
rail is a real operation the board already used; flipping `builtin:merge` would
have reversed every existing step silently, under an unchanged name.

The new prompt refuses rather than improvises. It stops if the rail is already
on `base` (no branch of its own to land), stops if the rail's checkout is dirty
(uncommitted work does not travel with a merge), and if git refuses because the
base checkout has local changes it reports that verbatim and stops — it never
commits, stashes or discards work it did not write. That checkout is the human's
and the stash stack is shared with every worktree, which is the single most
damaging thing an agent could do here.

Verified by running the **shipped prompt** (headless claude scoped to
`Bash(git *)`) in real fixtures, each outcome then re-checked with git directly:

| fixture | outcome |
|---|---|
| rail on `feat/x`, `main` moved on separately | merge commit on `main`, `main..feat/x` empty, root clean and not mid-merge, fork still on `feat/x` |
| root dirty on the same file the merge touches | stopped with git's own refusal; the WIP still uncommitted, stash stack still empty, `main` unmoved |
| rail with no worktree (root, on `main`) | stopped: "this rail has no branch of its own"; nothing committed, merged or stashed |
| the renamed inbound tool, same fixture shape | still merges `main` into the fork and leaves `main` where it was — the added direction paragraph did not confuse it |

Covered in code by `orchestrationTools.test.ts` (eleven built-ins, distinct
names, the inbound one named for its direction, the new one an agent taking
`base` and told to run the merge in another checkout). Spec §7.1 records why.
One smoke item added (`run-merge-into`) — the two directions on a real rail are
the part no suite can see.

Adjacent gap, left alone: built-ins are frontend constants and never reach the
daemon, so `gavin_get_orchestration` reports `tools: []` and an orchestrating
agent cannot place either merge tool — only a human dropping it can. Pre-existing
and its own card's worth of work.

Green at `7523f83` with only this change dirty: app 1568 tests, 0 type errors,
build clean. No Rust touched.
