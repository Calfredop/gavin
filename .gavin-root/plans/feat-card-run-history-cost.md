---
order: 5120
title: Per-card run history and cost
status: To Do
priority: medium
---
Show a card's run history — every run, its duration, resumes, outcome and agent — and what each run cost in tokens, read from the agent CLI's own logs.

Run rows already exist in the daemon; nothing lists them per card. Token counts come from the same per-profile sources the usage probe already reads (`agent_usage.rs`: the codex rollout `token_count` events; Claude Code's session JSONL). This is Gavin's version of Cursor's analytics, scoped to one developer: per card, not per team.

Borrowed from Cursor's analytics dashboard + context usage report (2026-09-03 feature scan).
