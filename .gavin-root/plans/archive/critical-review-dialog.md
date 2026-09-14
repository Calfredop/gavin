---
kind: task
title: Critical-review dialog + launch
status: Done
parent: feat-critical-review.md
complexity: complex
---
Build the Critical review dialog and launch path.

Reuse Best-of-N's N x (profile, model) picker pattern, but run parallel visible sessions on the **same checkout** (no worktrees, no pick-winner). Subject is a card or a whole rail. Prompt reviewers to file findings as note/task cards (reuse/extend the existing `codeReview` filing path). Per-run toggle "also build findings rail" default **off**.

Entry points: card menu "Critical review…", rail menu, and the Review tab once rails-as-subjects exists. Do **not** remove or fold in single-agent "Review with agent".

Pure module + unit tests; thin Svelte. Prefer app-side — no protocol bump unless unavoidable.
