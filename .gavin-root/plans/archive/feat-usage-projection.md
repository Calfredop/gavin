---
order: 5120
kind: task
title: [feat] usage projection
status: Done
---
Using reasonable intervals sampling (eg. 5 min per session, 3 hours per weekly + daily to take in account weekends), make the current usage feature include an end projection semaphore in the sidebar, with detail in the modal.
If projection is before limit end->red (user needs to stop)
If close->yellow (user needs to throttle)
If after by a reasonable % margin-> green
<!-- gavin:auto-commit -->
When the implementation is done, commit it. Commit only the files you touched — never `git add -A`. Do not push.
<!-- /gavin:auto-commit -->
