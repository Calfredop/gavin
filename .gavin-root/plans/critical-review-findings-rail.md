---
kind: task
title: Build review rail from findings
status: To Do
parent: feat-critical-review.md
complexity: moderate
---
Add an explicit "Build review rail from findings" action: take finding cards from a critical-review run and create a new orchestration rail whose steps are those cards (one step each).

Also honour the per-run auto-build toggle when it is on. On the explicit path, the human can cull finding cards before building. Refuse cleanly when there are no findings.

Pure builder + UI entry from the Review tab / run summary; unit tests for step order and empty refusal.
