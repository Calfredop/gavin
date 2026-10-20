---
order: 15360
kind: task
title: [bug] touched files
status: Done
---
The touched files of a session don’t look right. The impression is that every card’s touched files are the uncommited changes, instead of files actually touched by that agent’s session.

<!-- gavin:auto-commit -->
When the implementation is done, commit it. Commit only the files you touched — never `git add -A`. Do not push.
<!-- /gavin:auto-commit -->

- [ ] Human test: After the app is rebuilt (new host command card_run_touched_files), open the Review tab and press Refresh: cards that ran in this shared checkout should each list only their own files, no longer the same whole uncommitted tree under "Same starting point".
