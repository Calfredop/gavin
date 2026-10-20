---
order: 14336
kind: task
title: [bug] starting claude in terminal
status: Done
---
Trying to manually start claude in a new tab, by calling “claude” is not working. The command stays idle.

<!-- gavin:auto-commit -->
When the implementation is done, commit it. Commit only the files you touched — never `git add -A`. Do not push.
<!-- /gavin:auto-commit -->

- [ ] Human test: Reinstall the release app from main (scripts/install-stable-mac.sh), open a new plain tab and type `claude`: Claude Code's screen appears at once, without closing and reopening the window
