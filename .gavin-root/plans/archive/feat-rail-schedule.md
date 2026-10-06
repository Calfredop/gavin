---
order: 36864
kind: task
title: [feat] rail schedule
status: Done
---
Add the possibility for a rail to be scheduled to run a certain datetime (current machine datetime)

<!-- gavin:auto-commit -->
When the implementation is done, commit it. Commit only the files you touched — never `git add -A`. Do not push.
<!-- /gavin:auto-commit -->

- [ ] Human test: On Orchestration, open a rail’s Trigger tab, pick “At a date and time”, set a time a minute ahead, confirm the chip shows it and the rail arms when that time arrives (daemon restarted after the rebuild so it speaks v45).
