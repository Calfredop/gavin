# A Nested task finishes when its line in the plan is ticked, never by a status of its own

An Orchestrated plan runs each of its Nested tasks as its own agent session before the plan's own session runs, and so the scheduler has to know when each one is finished. Everything else on the board answers that with the done column: a rail's card step is done when its card reaches it. But a Nested task has no status. Its status is its plan's, which is what keeps it drawn inside the plan's card, carried by the plan onto a rail and filed with the plan into `plans/done/`. Running a Nested task by hand today writes In Progress, and that un-nests it: the child gets its own card, its own column and its own row on the Orchestration tab, and the plan the human was looking at turns into several things.

We decided that a Nested task is finished when its link in its plan's checklist, `- [x] [title](./child.md)`, is ticked. The link is the record, and the checklist that was already the plan's progress bar now counts its children too. A child that had no such line gets one appended when its plan starts. The child's agent ticks its own line with `gavin_tick_item` and is told never to set its card's status. The child keeps no status from start to finish and stays nested the whole time. While it runs, the session bound to it says so, not a column.

## Consequences

- The scheduler reads "finished" for a child from its plan's checklist, and for the plan itself from the done column, as before.
- A child whose line is ticked is never run again, so a stalled plan can be resumed without repeating finished children.
- A human can mark a child finished, or un-finish it, by ticking or unticking its line, with no status write and nothing moving on the board.
- Removing a child's line from the plan takes it out of the plan's checklist count but not out of the plan. The next start appends the line again.

## Considered options

- **Give the child a real status while it runs** (today's run path). Rejected. It un-nests the child, so a plan that orchestrates its children would scatter them across the board, and every rule that treats the plan as one unit (placement, filing, archiving) would have to re-collect them.
- **A new frontmatter field on the child, such as `done: true`.** Rejected. It is a second notion of status beside the rule that a Nested task's status is its plan's, it needs its own parse, compat gate and UI, and it would not show on the plan's checklist where the human already reads progress.
