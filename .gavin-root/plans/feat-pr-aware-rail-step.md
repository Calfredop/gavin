---
order: 8192
title: PR-aware rail step
status: To Do
priority: high
---
Give a rail a step that waits on the pull request it opened — CI checks and review state — and either advances the rail or re-runs the card with the failing check as its prompt.

Today `builtin:open-pr` is one `gh pr create` line and the rail is blind afterwards (`orchestrationTools.ts`). A gavin-kind step polls `gh pr checks` / `gh pr view` for the rail's branch; the same poll feeds read-only PR chips on a branch-bound rail header. Merging stays the human's action.

Borrowed from Cursor's PR subscriptions, /babysit and the Await tool (2026-09-03 feature scan).
