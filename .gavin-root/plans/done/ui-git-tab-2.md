---
order: 16384
kind: task
title: [ui] git tab
status: Done
---
Replace hover “zoom” effect of elements in git tab, with a more in-line with the rest of the app effect (bg change). Watch out for light/dark theme.

<!-- gavin:auto-commit -->
When the implementation is done, commit it. Commit only the files you touched — never `git add -A`. Do not push.
<!-- /gavin:auto-commit -->

- [ ] Human test: Git tab, in BOTH light and dark theme: hover the toolbar buttons, file rows and their +/− and trash buttons, sidebar branch rows and their actions, graph rows, the worktree/ref pickers and their menu items, and the diff hunk Stage/Discard buttons. Each should show a soft background fill and no border flash or "zoom"; a selected row and the conflict view's active Base toggle should keep their accent tint while hovered.
