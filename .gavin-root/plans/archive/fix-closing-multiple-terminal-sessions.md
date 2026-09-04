---
order: 13312
kind: task
title: [fix] closing multiple terminal sessions
status: Done
---
Closing multiple terminal sessions (from task manager, kanban archive, closing workspace’s page) makes the ui hang. Make the process async from ui.

<!-- gavin:auto-commit -->
When the implementation is done, commit it. Commit only the files you touched — never `git add -A`. Do not push.
<!-- /gavin:auto-commit -->
