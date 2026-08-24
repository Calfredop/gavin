---
kind: plan
title: Archive closes session — implementation
status: Done
parent: archive-closes-session.md
---
Implementation checklist for the [Archive closes session](./archive-closes-session.md)
task card: archiving a card ends the agent sessions bound to it and closes the
tabs that were showing it.

Decisions taken with the human (2026-08-24):
- Confirm ONLY when a live agent session would end — one dialog for the whole
  batch, naming the count, in `confirmClose.ts`'s voice. A card's file tab ends
  no process, so it closes silently.
- The `card_sessions` binding SURVIVES the archive. The session is killed, the
  row stays, so a restored card still offers "Re-launch agent" with the
  remembered cwd/command.
- Closing happens per card, right after that card's own move succeeds — a
  failure half-way through a batch must not kill sessions for cards that never
  moved.

## Projection

- [x] `archiveClose.ts`: `closablesForArchive(state, board, cards)` — for each
      card (and its nested children, which travel with it), the LIVE bound
      session ids plus every file tab open on those paths
- [x] `archiveClosePrompt(cardCount, sessionCount)` — the dialog's wording
- [x] Unit tests: nested children counted, dead bindings ignored, duplicate
      file tabs on one path all listed, no cross-talk between cards

## Wiring

- [x] `executeArchive` computes the closables BEFORE the first move, confirms
      once when sessions are live, then moves-then-closes card by card
- [x] Cancel returns cleanly: nothing archived, nothing closed, no error strip
- [x] Unarchive untouched — restoring a card is not a launch

## Verify

- [x] `npm test` green
- [x] `npm run check` green + `npm run build` clean
- [x] Four manual smoke items filed under a new "Archiving closes what the card was
      using" section in `smokeChecklist.ts` — the rendered dialog and the closed
      tab are the one thing the suites cannot see
