---
order: 11264
kind: plan
title: [bug] agent limit
status: Done
complexity: moderate
---
In Grimoria workspace I cant start an agent from a card: I get an usage limit for all agents (fallback included even if no fallback is configured neither in app or workspace) alert, even if Cursor (current default agent) is at 45% usage

## Cause

Grimoria's workspace agent is Cursor. The app-wide complexity table still attributes every level to `claude-code`. A card with `complexity:` therefore launches Claude, not Cursor. Claude is at its limit; the fallback chain is empty; the hold sentence claims the fallback chain is spent anyway.

Cursor's Other-Models / API pool is a separate quota from Auto. `usageBlock` treats any window as a hold, so a full API bar can also refuse an `agent` launch whose Auto window is at 45%.

## Plan

- [x] Fail: empty chain + spent attributed agent still uses the workspace agent when that agent has room
- [x] Fail: Cursor Auto under threshold is not spent just because the API pool is full
- [x] Fail: the hold sentence does not mention a fallback chain that is not configured
- [x] Walk the workspace agent after the card's agent and before the configured chain
- [x] Gate Cursor launches on Auto (else Total), not the API pool
- [x] Honest pause copy when the chain is empty
- [x] Targeted tests green

<!-- gavin:auto-commit -->
When the implementation is done, commit it. Commit only the files you touched — never `git add -A`. Do not push.
<!-- /gavin:auto-commit -->
