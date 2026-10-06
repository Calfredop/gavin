---
order: 39936
kind: task
title: [bug] tools and steps
status: Done
---
Tools and steps that are commands and scripts keep showing as “Working” even if their work is done. Check current ‘Gavin’ headroom page’s ‘Run test’ tab for example

## Plan

Root cause: a command/script tool's tab is retained after its PTY exits
(`retainTabOnExit`), but the daemon sends no status on exit -- it forgets
the session and drops the writer -- so the tab keeps the last status it was
pushed. A test run prints until the moment it exits, the 2-second quiet
timer never fires, and that last status is `working`. Every layout-keyed
surface (tab badge, sidebar row and tallies, hub, attention inbox, Close
Idle Tabs) believes it.

- [x] Failing tests: a retained tab's `working` / `waiting_for_input` settles on exit; `failed` stays
- [x] Settle the status in `handleSessionExited`'s retained branch (app side only: a daemon push would mark crashed agent steps done)
- [x] Run app tests + check
- [x] Commit only the touched files (78f24916)

<!-- gavin:auto-commit -->
When the implementation is done, commit it. Commit only the files you touched — never `git add -A`. Do not push.
<!-- /gavin:auto-commit -->
