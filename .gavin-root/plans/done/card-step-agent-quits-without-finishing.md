---
kind: task
title: A card step whose agent stops without finishing the card waits forever, silently
status: Done
---
Noticed while fixing the Commit tool card. Not fixed there on purpose: it
changes how CARD steps behave, which that bug never asked for.

A card step is done when its card reaches the done column (rule 1), and
stalled when its session dies first (rule 3). But an interactive agent does
not die — it finishes its turn and sits at its prompt. So an agent that
answers, gets confused, or decides the work is not for it and never sets the
card's status leaves the step `running` with a live session, and the rail
waits on it forever with no stall, no reason, and nothing on screen to say
anything is wrong. It looks busy.

The signal now exists: `nextActions` already takes `sessionStatuses`, and
`agentTurnEnded` in `orchestration.ts` reads exactly this case for tool steps.

The question is what the right outcome is, and it is a judgement call rather
than a bug with one answer:

- **Stall it** — "the agent finished its turn but the card never reached Done"
  — which pauses the rail and puts a Retry within reach. Honest, but it fires
  on an agent that is merely mid-thought between turns and about to carry on.
- **Warn without stalling** — mark the chip somehow and leave the rail running,
  so a human looking at it can tell the difference.
- **Leave it** — waiting IS correct, and the missing piece is only that
  nothing says so.

Whichever way it goes, the "Mark done" button added alongside the Commit tool
fix is already the manual way past it.
