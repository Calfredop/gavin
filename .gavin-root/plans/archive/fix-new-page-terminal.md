---
order: 5120
kind: task
title: [fix] new page terminal
status: Done
---
Creating a new page adds an empty terminal tab as first page’s tab, even if the intent of opening already was originating from a “creating a new tab” flow (eg. orchestration rail start or agent session start)

<!-- gavin:auto-commit -->
When the implementation is done, commit it. Commit only the files you touched — never `git add -A`. Do not push.
<!-- /gavin:auto-commit -->
