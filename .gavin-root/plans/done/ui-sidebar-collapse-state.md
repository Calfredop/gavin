---
order: 1024
kind: task
title: [ui] sidebar collapse state
status: Done
---
make the sidebar collapse state be full compact mode (icons/workspace first letter). To do so, put the sidebar action button/system actions bar in same logical level (use same height too for beauty) of the tab switcher header (hub or page), so that when bar is collapsed the content of the current tab can occupy as much width as possible. When pressing a bar item expand the bar until mouse exits.

<!-- gavin:auto-commit -->
When the implementation is done, commit it. Commit only the files you touched — never `git add -A`. Do not push.
<!-- /gavin:auto-commit -->
