---
order: 5120
kind: task
title: [feat] archive delete
status: Done
---
Add a drop-down ‘Delete’ button in kanban archive, with:
- selected (then make the list go in select mode)
- older than 24h
- older than 3 days
- older than 7 days
- older than 15 days
- older than 30 days
- older than 90 days

If you think there’s better than dropdown, go for a better way. In any case make user confirm before delete.
The delete action should then remove the cards and the related files/gavin dbs references permanently.

<!-- gavin:auto-commit -->
When the implementation is done, commit it. Commit only the files you touched — never `git add -A`. Do not push.
<!-- /gavin:auto-commit -->
