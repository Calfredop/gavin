---
order: 16384
kind: task
title: [bug] on new workspace open
status: Done
---
When opening a new workspace, the fallback(s) setup mini-wizards pops out before the first wizard setup is shown.

<!-- gavin:auto-commit -->
When the implementation is done, commit it. Commit only the files you touched — never `git add -A`. Do not push.
<!-- /gavin:auto-commit -->

- [ ] Human test: With a fallback chain set (e.g. claude-code → codex), create a workspace via "+ New workspace…" and via "Open workspace…" → Initialize: the setup wizard appears first, and the "Set up codex as a fallback" wizard only after the setup wizard closes
