---
order: 16384
kind: task
title: [bug] file tab
status: Done
---
files’ tab remember opened file but not the editor mode (view, plain, edit)

<!-- gavin:auto-commit -->
When the implementation is done, commit it. Commit only the files you touched — never `git add -A`. Do not push.
<!-- /gavin:auto-commit -->

- [ ] Human test: Files tab: open a .md file, switch it to Edit (then Plain), leave for another tab and come back — the file reopens in the mode you left it in; picking a different file opens that one in its default mode
