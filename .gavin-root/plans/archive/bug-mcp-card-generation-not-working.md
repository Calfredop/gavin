---
order: 16384
kind: task
title: [bug] mcp card generation not working
status: Done
---
It happened both in tempo-game and Grimoria workspaces; claude code wasnt able to add cards to the kanban board. The md file are correctly generated but don’t show in the kanban. For tempo-game I had to close the workspace and reopen it.

<!-- gavin:auto-commit -->
When the implementation is done, commit it. Commit only the files you touched — never `git add -A`. Do not push.
<!-- /gavin:auto-commit -->

- [ ] Human test: After installing a build with 16326fb1 and restarting the daemon: run `sudo killall fseventsd`, wait about 45 s, then have an agent file a card with gavin_create_plan. It should appear on the board without reopening the workspace, and daemon.log should say "file watches stopped hearing events … re-arming them".
- [ ] Human test: After installing a build with 22cf3f46 and restarting both the app and the daemon: open a workspace's Git tab, run `sudo killall fseventsd`, wait about 45 s, then edit a tracked file in that repo. The Git tab should show the change without reopening it, and the session's git chip should go dirty within a few seconds.
