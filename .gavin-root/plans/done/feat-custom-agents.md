---
order: 4096
kind: task
title: [feat] custom agents
status: Done
---
Both in app and workspaces’ settings, allow the user to set a custom agent (as cli command) with custom model flag (cli param to concatenate to custom agent command). Also add a new param for tasks, plans, and notes: 'Complexity'. It should be a 5 step scale (pick best labels).
This param will be present in both app and workspaces settings. For each level the user can change app level complexity agent/mode attribution, with wokspace ovveride.

<!-- gavin:auto-commit -->
When the implementation is done, commit it. Commit only the files you touched — never `git add -A`. Do not push.
<!-- /gavin:auto-commit -->
