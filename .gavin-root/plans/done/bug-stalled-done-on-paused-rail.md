---
labels: bug, ready-for-agent
title: [bug] Stalled step whose card is already Done stays stuck on a paused rail
status: Done
priority: medium
complexity: simple
---
A card-step agent that finishes the card and exits can lose a race: the scheduler sees the dead session before the board shows Done, stalls with "agent exited before the card reached Done", and Rule 5 pauses the rail. On the next tick the card is Done, but paused-rail reconciliation only repairs leftover `running` rows — not `stalled` ones — so Rule 1 never clears the obsolete stall until a human presses Play.

## Done when

- [x] On idle/paused rails, a stalled card step whose card is already in the done column is marked done (truth write; no relaunch).
- [x] When that markDone clears the stall that paused the rail, the rail returns to running so the sequence can advance (same "and proceed" idea as Skip).
- [x] A stalled step whose card is NOT done is still left alone on a paused rail.
- [x] A skipped step whose card later reaches Done is not rewritten as done.
- [x] Tests in `orchestration.test.ts` / executor coverage as needed; `npm test` for the touched suite passes.
