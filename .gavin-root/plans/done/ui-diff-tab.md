---
order: 16384
kind: task
title: [ui] diff tab
status: Done
---
Diff tab of a session doesnt allow to resize the file list vs diff detail. Also when the file name is truncated allow to show its name on hover.

<!-- gavin:auto-commit -->
When the implementation is done, commit it. Commit only the files you touched — never `git add -A`. Do not push.
<!-- /gavin:auto-commit -->

- [ ] Human test: In a session's Changes/diff tab, drag the divider between the file list and the diff (it should resize and stay put after reopening; double-click resets), and hover a truncated file row to see its full path (a row that fits shows no tooltip)
