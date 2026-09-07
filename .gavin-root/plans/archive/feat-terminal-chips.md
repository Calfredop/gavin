---
order: 1024
kind: task
title: [feat] terminal actions
status: Done
---
Let's improve the terminal session tabs actions. First of all: the "jump to card" should be replaced (icon too) by a "Show plan" action. 
Then both actions should open a split view (to the right) with the requested data: plan detail (reuse the card detail modal component and put the jump to card action here so the user can go to orchestration/kanban) or file diff.

<!-- gavin:auto-commit -->
When the implementation is done, commit it. Commit only the files you touched — never `git add -A`. Do not push.
<!-- /gavin:auto-commit -->
