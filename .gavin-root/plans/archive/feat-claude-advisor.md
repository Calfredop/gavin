---
order: 36864
kind: task
title: [feat] claude advisor
status: Done
---
Integrate claude advisor flag in complexity table/ui

<!-- gavin:auto-commit -->
When the implementation is done, commit it. Commit only the files you touched — never `git add -A`. Do not push.
<!-- /gavin:auto-commit -->

- [ ] Human test: Settings → Agents → Claude Code complexity table: each row shows an "advisor" box after effort (suggests opus/sonnet/…), all five rows still line up, and a level set to sonnet + advisor opus launches a card as `claude --model sonnet --advisor opus` (needs an app rebuild for the new Tauri profile field)
