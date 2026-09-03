---
order: 10240
title: Review with agent, findings as cards
status: Done
priority: medium
---
Put "Review with agent" on the Git tab and the card menu, and have the review file each finding as a note or task card on the board.

Today the read-only `builtin:code-review` tool exists only as a rail step (`orchestrationTools.ts`). The review runs in a visible session against a base; its findings become cards so they are durable and assignable. A workspace review-rules file, read by the review prompt, mirrors Cursor's `.cursor/BUGBOT.md`.

Borrowed from Cursor's /review, Review → Find Issues and Bugbot rules (2026-09-03 feature scan).

## Checklist

- [x] `codeReview.ts` (pure): the review-rules file's path and starter text, the default base, the prompt composers for a branch review and a card review, and the "why this can't run" reason — with unit tests
- [x] `codeReviewActions.ts`: launch one VISIBLE review session, revealed and named, shared by both surfaces — with unit tests
- [x] `ReviewDialog.svelte`: pick the base branch, and say whether this workspace has review rules (offering to create the file when it does not)
- [x] Git tab: "Review with agent" in the toolbar beside "Commit via agent", opening that dialog
- [x] Card menu: "Review with agent…" on task and plan cards, reviewing the work that card produced
- [x] `builtin:code-review`: the rail step gets the same prompt, so a review files findings wherever it runs
- [x] Smoke checklist items for the three surfaces
- [x] `npm test`, `npm run check`, `npm run build` green
