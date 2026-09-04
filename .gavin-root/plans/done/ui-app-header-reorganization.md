---
order: 7168
title: [ui] app header reorganization
status: Done
---
[x] make hub/page area full app height
[x] increase workspace's page tab height to the same of the workspace's hub tabs; unify tab indicator of page's to the one of the workspace's hub
[x] move split and close page actions from app wide context to page's session context alway in top right, same bar as tab selector; add diff and linked task/plan/note actions buttons (which needs to be removed from tab itself)
[x] remove the "New page" string from the "+" button and move it to the dropdown (title-ish)
[x] keep actions and new page button fixed on the right, but make the tab lists (both page and hub) h-scrollable via mouse wheel
[x] make sure the change doesnt break the app window drag feature

<!-- gavin:auto-commit -->
When the implementation is done, commit it. Commit only the files you touched — never `git add -A`. Do not push.
<!-- /gavin:auto-commit -->
