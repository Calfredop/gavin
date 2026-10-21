---
order: 14336
kind: task
title: [feat][ui] new agent tab
status: Done
---
Right before the “+” button in the page view, add robot&+ icon dropdown button. On click it should open a tab with the default workspace agent; the dropdown should allow the user to pick which agent to spawn from the setup ones

<!-- gavin:auto-commit -->
When the implementation is done, commit it. Commit only the files you touched — never `git add -A`. Do not push.
<!-- /gavin:auto-commit -->

- [ ] Human test: On a terminal page, the robot+ button left of the tab row's "+" reads as one glyph; clicking it opens a tab running the workspace's agent, and its chevron lists the installed agents (default ticked) and launches the one picked
