---
order: 10240
kind: task
title: [chore] recouncile repo
status: Done
complexity: complex
---
Recouncile all opened worktrees gracefully onto main. Then remove them. In git graph I can see a lot of opened branches/worktrees. Merge them if needed or remove them. I want a clean graph

<!-- gavin:auto-commit -->
When the implementation is done, commit it. Commit only the files you touched — never `git add -A`. Do not push.
<!-- /gavin:auto-commit -->
