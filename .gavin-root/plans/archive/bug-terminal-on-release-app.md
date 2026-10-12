---
order: 14336
kind: task
title: [bug] terminal on release app
status: Done
---
On macOS release app, when starting a new card or opening a new terminal I get this error in the terminal itself:\
/Users/coalpila/.zshrc:115: command not found: ng

<!-- gavin:auto-commit -->
When the implementation is done, commit it. Commit only the files you touched — never `git add -A`. Do not push.
<!-- /gavin:auto-commit -->

- [ ] Human test: Rebuild and reinstall the release app, then quit and relaunch it from Finder or the Dock so its daemon restarts. Open a new terminal and start a card: neither shows "~/.zshrc:115: command not found: ng", and `which ng` in the plain terminal prints /opt/homebrew/bin/ng.
