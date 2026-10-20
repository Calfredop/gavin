---
order: 14336
kind: task
title: [ui][feat] middle click
status: Done
---
Make middle click open urls, files, and activate close tab (configurable in app’s settings, defaults to on)

<!-- gavin:auto-commit -->
When the implementation is done, commit it. Commit only the files you touched — never `git add -A`. Do not push.
<!-- /gavin:auto-commit -->

- [ ] Human test: In the running app: middle-click a URL and a file path in a terminal (each opens), middle-click an unpinned tab (it closes, with the usual confirm if it's running), then turn off Settings > Mouse > Middle click and check all three do nothing
