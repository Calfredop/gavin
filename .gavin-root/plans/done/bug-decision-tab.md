---
order: 38912
kind: task
title: [bug] decision tab
status: Done
---
When going in decision tab, open a card that needs decion, and then move the mouse over the agent’s terminal, the item disappears. It happens because on mouse hover it briefely goes into ‘working’ state

<!-- gavin:auto-commit -->
When the implementation is done, commit it. Commit only the files you touched — never `git add -A`. Do not push.
<!-- /gavin:auto-commit -->

- [ ] Human test: After rebuilding and restarting the daemon: in the Decisions tab, open a card whose Claude Code agent is waiting on you, move the mouse over its terminal and scroll it — the row stays in the list and the agent never shows as working
