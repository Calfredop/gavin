---
order: 16384
kind: task
title: [ui] orchestration layout
status: Done
---
Move the add rail in the empty orchestration layout from next to the “No rails…” message to under it

<!-- gavin:auto-commit -->
When the implementation is done, commit it. Commit only the files you touched — never `git add -A`. Do not push.
<!-- /gavin:auto-commit -->

- [ ] Human test: In a workspace with no rails, the Orchestration tab shows "+ Add rail" under the "No rails yet…" line, left-aligned with its text; once a rail exists the stub sits after the last rail as before
