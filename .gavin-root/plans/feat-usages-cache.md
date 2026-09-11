---
order: 11264
kind: task
title: [feat] usages cache
status: In Progress
complexity: moderate
---
Usages must be cached, so that at app restart last cached data is shown. Cache should have stale timer set to usage reset. Usages should still update upon app restart, but in an ansync way (show indicator)

<!-- gavin:auto-commit -->
When the implementation is done, commit it. Commit only the files you touched — never `git add -A`. Do not push.
<!-- /gavin:auto-commit -->
