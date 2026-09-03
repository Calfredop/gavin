---
order: 2048
kind: task
title: [bugs] Round of fixes
status: Done
---
- Init wizard modal have horizontal scrolling. Content shoudl adapt to its width isntead
- PRD step in init wizard doesnt pick the user picked file (take a look at grimoria workspace, I’ve tried to pick docs/llm_prd.md)
- PRD is not pickable in workspace’s settings. File is picked but when I navigate away from settings, it gets reset to .gaving-root prd path
- After init wizard is done and I pick the start session option, the hub home terminal shows blank

<!-- gavin:auto-commit -->
When the implementation is done, commit it. Commit only the files you touched — never `git add -A`. Do not push.
<!-- /gavin:auto-commit -->
