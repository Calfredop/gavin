---
labels: bug
title: [bug] complexity table ignores model for Cursor fallback
status: Done
complexity: moderate
---
The complexity table is not working with Cursor as fallback agent; the `agent` command gets called with sonnet as model. Investigate for Cursor and other agents too.

## Cause

Fallback launches called `agentForProfile(workspaceId, profileId)` with no card. That resolve pinned the binary but dropped every complexity-table row for the launching agent — so Cursor never got the app table's `model: auto` and the CLI fell through to its own default (sonnet). Board Run, Develop, Resume/new-session and rail steps all shared that seam; same for Codex / Gemini / any other fallback.

## Fix

`complexityAttributionForProfile` reads the fallback profile's own table for the card's `complexity:` level (model / effort / advisor when the row targets that profile). `agentForProfile` takes the optional card and applies it; card + rail call sites pass the card through.

## Note (Gavin workspace)

Gavin's workspace Cursor table is effort-only (`model: ""` on every level). That owns the key and shadows the app-wide Cursor table's `auto`. After this fix, fallback still applies workspace effort; to get `--model auto` here, put `auto` on those rows or clear the workspace Cursor table so the app one inherits.

## Diagnosis

- [x] Map complexity → model → argv for Cursor and other agents
- [x] Reproduce: complexity table model not applied when Cursor is fallback
- [x] Fix routing / argv so the configured model is used
- [x] Cover other agents that share the same seam
- [x] Tests red then green
- [ ] Human test: With Claude over its fallback threshold and Cursor next in the chain: run a card rated moderate. Session command must be `agent … --model auto` (or whatever Cursor's complexity table says for that level), not a bare `agent` / `--model sonnet`. Repeat once with Codex as fallback and a Codex table model — argv must carry that model too.
