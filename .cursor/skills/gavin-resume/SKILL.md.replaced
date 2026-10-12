---
name: gavin-resume
description: Use when told to resume a gavin card — an In Progress card whose earlier agent stopped. Find the work already done before adding to it.
---

# Resuming a card someone already worked

The board's **In Progress** column holds cards that were started and
stopped: the agent finished its turn, its session exited, the human
walked away mid-run. Resuming one is not the same job as starting it.
The card's body still describes the whole task, and doing the whole task
again is the failure mode this skill exists to prevent.

## 1. Reconstruct before you write

Read, in this order, and do not touch a file until you have:

1. **The card file itself** — the prompt in a task's body, the checklist
   in a plan's. Ticked items (`- [x]`) are the previous agent's own
   record of what it finished. A promoted item links to its child card;
   read that card's status too.
2. **The working tree** — `git status` and `git diff` in the card's
   folder. Uncommitted edits are work in flight. Read them: they tell
   you what the last agent was in the middle of, which no checklist
   records.
3. **The recent commits** — `git log --oneline -20`, and the branch or
   worktree you are standing in. Work that has already landed is done
   whatever the card says.

Only then decide what is actually left.

## 2. What to do with what you find

- **Finished work stays finished.** Never redo, revert, or rewrite from
  scratch something that already works. Ticks are not to be cleared.
- **Half-finished work gets finished**, not deleted. A partial refactor,
  a function with no caller yet, a test that fails because its
  implementation is missing — carry it to completion.
- **Broken work gets fixed.** Conflict markers, a failing build, a test
  suite that no longer passes: that is the first thing to repair, before
  any new work.
- **Contradictory work gets flagged.** If what you find in the tree
  disagrees with what the card asks for, say so in your reply and, when
  it matters, write it into the card. Do not silently pick a side.

If the card turns out to be entirely done, say so and set it to the
board's done column rather than inventing more work for it.

## 3. Then carry on

Work the rest of the card the ordinary way: a plan's checklist top to
bottom, ticking items (`- [x]`) as you complete them and promoting the
ones that need their own agent with `gavin_promote_task`; a task's body
to its end.

Keep the card's status current with `gavin_set_plan_field`, and set it
to the board's done column when the work is genuinely finished — the app
never does that for you. If you end up blocked, leave the card In
Progress and write what blocked you into it, so the next agent to resume
this card starts from your findings instead of rediscovering them.
