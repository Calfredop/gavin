---
order: 10240
title: Review with agent, findings as cards
status: To Do
priority: medium
---
Put "Review with agent" on the Git tab and the card menu, and have the review file each finding as a note or task card on the board.

Today the read-only `builtin:code-review` tool exists only as a rail step (`orchestrationTools.ts`). The review runs in a visible session against a base; its findings become cards so they are durable and assignable. A workspace review-rules file, read by the review prompt, mirrors Cursor's `.cursor/BUGBOT.md`.

Borrowed from Cursor's /review, Review → Find Issues and Bugbot rules (2026-09-03 feature scan).
