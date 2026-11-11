# A plan with Nested tasks runs each of them as its own session, with or without a `children:` line

Starting a plan from the board is meant to take it to the end. Until now a plan orchestrated its Nested tasks only when it carried `children: sequence | parallel`. Without the line, Run started ONE agent and handed it the plan file, with a prompt that never mentioned the Nested tasks and never asked for the plan to be finished. A Nested task made with `parent:` alone is not even referenced by the plan's file, so that agent did not know it was there; one that was linked was usually done inline or promoted and left. Plans with Nested tasks stopped partway, and humans had to ask by hand for the rail behaviour the app already had.

We decided that a plan with at least one Nested task is an Orchestrated plan whether or not it carries the line. Run puts it on a rail of its own, each Nested task runs as its own session and finishes by ticking its line (ADR 0012), and then the plan's own session integrates and sets it Done. The `children:` line now says only how the tasks run: no line or `sequence` is one at a time in tree order, and `parallel` is all at once in one checkout. The rule lives in one place, `childrenModeOf`, and the scheduler, Run, conflict detection and every surface read it.

## Consequences

- Resume and Launch as new session on a plan with a Nested task still to run go to its rail too, so a second agent never works the plan beside its children. An automatic resume still reopens the session it was asked about.
- The rail cannot raise the first-Run review, so a press that goes to the rail asks it for each Nested task still to run and for the plan, before the rail starts. Otherwise the rail would stall at each child nobody had reviewed yet.
- A plan with nothing nested runs as one session, as before, and its prompt now tells the agent to do every item itself and set the plan to the done column. It no longer suggests promoting items, because a promoted item became a Nested task that nothing in that run would ever start.
- There is no "one session" setting for a plan with Nested tasks. Work meant for one agent is written as checklist items on the plan instead of as Nested tasks.
- A daemon older than v80 cannot orchestrate. There a plan with no line still runs as one session, which is what it did there before, and one with the line is refused by the existing gate.

## Considered options

- **Keep the opt-in and change only the one-session prompt to mention the children.** Rejected. One agent working several Nested tasks inline is the behaviour that left plans unfinished, and the rail that does it properly already existed.
- **A `children: none` value to opt back into one session.** Rejected for now. It needs a protocol value, a compat gate and a third control state, for a case that checklist items already cover.
