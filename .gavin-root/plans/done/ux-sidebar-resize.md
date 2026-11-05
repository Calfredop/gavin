---
order: 17408
kind: task
title: [ux] sidebar resize
status: Done
---
Allow resizing of sidebar

<!-- gavin:auto-commit -->
When the implementation is done, commit it. Commit only the files you touched — never `git add -A`. Do not push.
<!-- /gavin:auto-commit -->

- [ ] Human test: Drag the open sidebar's right edge: it widens/narrows live (200–480px, never narrower than the corner chrome), the corner buttons stay aligned, terminals refit, the width survives a relaunch, double-click resets it, the handle is absent while collapsed, and a hover-peek opens at the dragged width.
