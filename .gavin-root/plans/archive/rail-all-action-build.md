---
title: Rail “all” action — build
status: Done
---
Implementation checklist for [Rail “all” action](rail-all-action.md).

A rail gets the column move a card already has, one rung up: **Move all cards
to …** in the rail header, listing the board's columns. It writes `status` to
every distinct card the rail carries. Tool steps have no card and sit it out;
a card already in the target column is not rewritten.

- [x] `orchestration.ts`: `railCardPaths` (distinct card steps, in run order)
      and `railCardsToMove` (minus the ones already there / gone) + tests
- [x] `orchestrationState.ts`: `moveRailCardsAction` — the sequential
      frontmatter writes, optimistic patch each, stop on first failure
      (planDrop.ts's contract) + tests
- [x] `OrchestrationRail.svelte`: a `SquareStack` header button, disabled with
      a reason when the rail carries no cards
- [x] `OrchestrationHubView.svelte`: the column menu (shared context menu),
      the action call, errors on the card-write strip
- [x] Sweep: `npm test`, `npm run check`, `npm run build`

Verified in a throwaway `__preview` route in Chrome (the app's dev server on
:1420), since the gavin app's own daemon is a version behind and its tools are
refusing writes: the header button opens the column menu, each entry counts
what that pick would rewrite ("Move 1 card to To Do" beside "Move 2 cards to
Done"), a column every card already sits in reads "All cards are in Done" and
is dead, and a rail with no cards has the button disabled saying so. Sweep:
1149 vitest pass, `npm run build` clean, and svelte-check reports 0 errors in
the orchestration files (the 13 it does report are another session's in-flight
`modifiedAt` work on CardView).
