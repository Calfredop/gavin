---
name: gavin-orchestrate
description: Use when the human asks to plan, order, parallelize, or reorganize this workspace's work — or asks why a rail is blocked. Reads and writes the Orchestration tab's rails.
---

# Organizing a gavin workspace's work into rails

The Orchestration tab lays this workspace's cards out in time. A **rail**
is a vertical track bound to a git worktree and a workspace page. A rail
holds ordered **stages**; a stage holds one or more **steps**; a step is
a reference to a card file. Stages run one after another. **A stage's
steps run at the same time, in that rail's checkout.**

The human arms a rail with Start; gavin then launches each stage and
advances when every step's card reaches the board's done column.

## 1. Read before you write

Call `gavin_get_orchestration` first, every time. It returns the current
rails with their worktrees and their **uncommitted files**, every step
with its card and live run state, the board's columns, and every runnable
card not yet on a rail. Never author an arrangement from memory or from
the card titles alone.

If there are no rails yet, create one per natural workstream — a
subsystem, a layer, a piece of the PRD — and propose a worktree name for
each. The human binds them in the tab; you only name them.

## 2. The parallelism rule

Two steps collide only when they edit the **same working tree**:

- **Same rail, same stage** — always the same checkout. There is no
  step-level worktree, so co-staging two steps means two agents editing
  one tree at once. Only do this when the work genuinely does not touch
  the same files.
- **Different rails on different worktrees** — never a conflict, whatever
  they touch. Worktree isolation is the answer.
- **Different rails on the SAME worktree** — always a risk: rails advance
  independently, so gavin makes no ordering promise between them.
- **Different stages of one rail** — strictly sequential, never a
  conflict.

Weigh the card bodies and the rail's `dirtyPaths` before co-staging
anything. **When unsure, serialize.** A wrong serial order costs time; a
wrong parallel one costs a merge conflict in a live checkout, and the
human has to untangle two agents' half-finished edits.

If two pieces of work must run at once and might collide, the right move
is two rails on two worktrees — not one parallel stage.

## 3. Record your reasoning

Every judgement you made goes back as a `conflict_notes` entry naming the
step ids it concerns. The human reads these in the tab's Conflicts box,
beside gavin's own structural findings. An arrangement with no notes asks
to be trusted blindly; one with notes can be checked.

## 4. Write it

`gavin_set_orchestration` replaces the whole plan.

- **Preserve the ids** of steps you are keeping. Run state follows the
  step id, so a new id silently discards which agent is on which work.
- **Never remove a step whose `run` is `running`.** The daemon refuses
  the whole write and tells you which step — moving it between stages or
  rails is fine, only deleting it is not.
- Positions are yours to set; keep them dense and ascending.

Then say what you changed and why, in a sentence or two per rail.

## 5. When a rail is stuck

A step shows `stalled` when its agent exited before the card reached the
done column, or when its card or worktree went missing. Read the card,
fix the cause, and tell the human — Retry is theirs to press, not yours.
