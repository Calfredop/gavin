---
order: 15360
kind: task
title: [chore] scripts rename
status: Done
---
Rename ‘stable’ build scripts into ‘release’; add versioning with both version number and build number

<!-- gavin:auto-commit -->
When the implementation is done, commit it. Commit only the files you touched — never `git add -A`. Do not push.
<!-- /gavin:auto-commit -->

- [ ] Human test: On the Windows box, run `scripts\start-release-win.ps1`: the old ..\gavin-stable worktree is moved to ..\gavin-release, `npm run bundle` prints "bundle: gavin 0.1.0 (build N)", and after installing, Settings > Updates reads "gavin 0.1.0 (N)"
