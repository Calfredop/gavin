---
order: 2048
kind: task
title: [bug] page tab drag
status: Done
---
In workspaces' pages, let's say I have a page with one tab. If I try to drag a Gavin window in this context, using the blank space on the right of the tab, it activates the dnd of the tab instead of the window. The dnd of a tab should be activated only when dnd is on the tab palette; else on blank space the dnd should be of the whole window (like it happens in workspace's hub)

<!-- gavin:auto-commit -->
When the implementation is done, commit it. Commit only the files you touched — never `git add -A`. Do not push.
<!-- /gavin:auto-commit -->
