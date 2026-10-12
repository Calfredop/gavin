---
order: 10240
kind: task
title: [feat] check against branch
status: Done
---

In git (?) tab add a way to compare branch/worktrees/current checkout to another branch/workree. Both local and remote.

<!-- gavin:auto-commit -->
When the implementation is done, commit it. Commit only the files you touched — never `git add -A`. Do not push.
<!-- /gavin:auto-commit -->

- [ ] Human test: In the Git tab, open the new Compare nav item: pick a base and a target (a local branch, an origin/ remote branch, and a worktree), check the file list and ahead/behind counts look right, flip the three-dot/two-dot toggle, and open a file's diff in both unified and split.
