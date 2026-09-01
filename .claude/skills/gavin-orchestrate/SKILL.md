---
name: gavin-orchestrate
description: Use when the human asks to plan, generate, order, parallelize, or reorganize this workspace's work — or asks why a rail is blocked. Reads and writes the Orchestration tab's rails.
---

# Organizing a gavin workspace's work into rails

The Orchestration tab lays this workspace's cards out in time. A **rail**
is a vertical track bound to a git checkout and a workspace page. A rail
holds ordered **stages**; a stage holds one or more **steps**. Stages run
one after another. **A stage's steps run at the same time, in that rail's
checkout.**

A step is one of two things, never both:

- a **card step** (`cardPath`) — an agent runs that card, and the step is
  done when the card reaches the board's done column;
- a **tool step** (`toolId` + `toolParams`) — a reusable unit of work
  from the workspace's tool library: an agent prompt, a bash command, or
  a bash script. It is done when its session exits 0, and stalled on any
  other exit.

The human arms a rail with Start; gavin then launches each stage and
advances when every step in it is done.

## 1. Read before you write

Call `gavin_get_orchestration` first, every time. It returns the current
rails with their worktrees, branches and **uncommitted files**, every step
with its card or tool and live run state, the board's columns, every
runnable card not yet on a rail, and the **tool library** with each
tool's parameters. Never author an arrangement from memory or from the
card titles alone.

If there are no rails yet, create one per natural workstream — a
subsystem, a layer, a piece of the PRD — and propose an isolation for
each (see §2b). The human binds them in the tab; you only name them.

## 1a. What you were asked to change

The tab has two buttons that call you, and the request says which:

- **Generate with agent…** (the tab header) — the job is the cards
  **nobody has placed**: the `unplacedCards` list in the read payload. The
  request names them too, but cuts a long backlog and says so — the
  payload is the complete list. Put every one of them on a rail — extend a rail
  where the work belongs on one, add a rail where it does not (§2b for
  its isolation). Steps already on rails stay where they are unless a
  card you are placing forces a reorder, and then say which and why.
- **Reorganize with agent** (a wand in ONE rail's header) — the job is
  that rail's own arrangement: reorder its stages, split a stage whose
  steps would collide in one checkout, merge stages that are genuinely
  independent. Keep the steps it already holds — that button is not the
  place to add or drop work — and leave every OTHER rail exactly as you
  read it.

A request that names neither is the human asking in their own words:
then the whole orchestration is yours.

Either way you still send the **whole plan** back (§4) — the scope is
what you may CHANGE, not what you write. A rail you were not asked about
goes back with the same ids, the same stages and the same `toolId` /
`toolParams` it arrived with.

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

## 2b. Worktrees and branches are not the same tool

A rail carries two independent bindings: `worktreePath` says **which
checkout** its agents run in, and `branch` says **which branch gavin puts
that checkout on** before the rail's first step. A rail with a branch and
no worktree runs on that branch in the workspace's root checkout — a rail
per branch, with no folder per rail.

**A branch is not isolation.** A checkout can only be on one branch at a
time, so two rails sharing a checkout are exactly as dangerous as before
whether or not they name different branches — worse, in fact, because
they will fight over the head. Isolation comes from a separate worktree
and nothing else.

So propose:

- **a worktree** when rails must run **at the same time**, or when the
  work is long-lived enough to want its own files on disk;
- **a plain branch** when the rails are alternatives the human will run
  **one at a time**, and a folder per rail would just be clutter.

Gavin switches a bound branch only when no step of that rail is running,
refuses while the checkout has uncommitted changes, and never switches
back when the rail completes — the work stays checked out, in view.

A tool step counts here exactly like a card step: a `Run tests` or
`Commit changes` step writes to the rail's checkout, so co-staging it
with anything else in that rail is the same hazard.

## 2a. Placing tools

Tools are how a rail finishes its own work rather than leaving it for the
human: a `Commit changes` after the cards that produced the diff, a
`Run tests` before it, a `Push branch` or `Send a notification` at the
end. Pick them from the `tools` list in the read payload — never invent a
`toolId`.

- Give a tool step its own stage unless you have a reason not to. Tools
  are usually the *boundary* between pieces of work, and a boundary that
  runs concurrently with the work is not a boundary.
- Override a parameter with `toolParams: { "name": "value" }`, using the
  parameter names the payload lists. Omit a parameter to take the tool's
  own default — and prefer omitting, so a later edit to that default
  reaches the step.
- A tool step needs no `cardPath` at all. Sending both is refused.

## 3. Record your reasoning

Every judgement you made goes back as a `conflict_notes` entry naming the
step ids it concerns. The human reads these in the tab's Conflicts box,
beside gavin's own structural findings. An arrangement with no notes asks
to be trusted blindly; one with notes can be checked.

## 4. Write it

`gavin_set_orchestration` replaces the whole plan.

- **Preserve the ids** of steps you are keeping. Run state follows the
  step id, so a new id silently discards which agent is on which work.
- **Carry `toolId` and `toolParams` through** on every tool step you are
  keeping. A rewrite that drops them turns a tool step into a step that
  is neither a card nor a tool, and the daemon refuses the whole write.
- **Never remove a step whose `run` is `running`.** The daemon refuses
  the whole write and tells you which step — moving it between stages or
  rails is fine, only deleting it is not.
- Positions are yours to set; keep them dense and ascending.

Then say what you changed and why, in a sentence or two per rail.

## 5. When a rail is stuck

A card step shows `stalled` when its agent exited before the card reached
the done column, or when its card or worktree went missing. A tool step
shows `stalled` when it exited non-zero, when gavin was not running to
see it exit, or when its tool has been deleted from the library.

Read the cause, fix it, and tell the human — Retry is theirs to press,
not yours.
