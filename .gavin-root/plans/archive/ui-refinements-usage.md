---
order: 60416
kind: task
title: [ui][refinements] usage
status: Done
---
Improve usage row of sidebar. Each linked agent it’s badge, with semaphore status. Badge shows the ‘avatar’ of the coding agent.
If there’s collision add a letter. Eg. Claude Code and Codex linked, not C and C but Cl and Co.
If agent is running in any session, make the badge slowly fade out and fast fade in

<!-- gavin:auto-commit -->
When the implementation is done, commit it. Commit only the files you touched — never `git add -A`. Do not push.
<!-- /gavin:auto-commit -->

- [ ] Human test: Sidebar Usage row: each linked agent shows a letter badge (Cl/Co when Claude Code and Codex collide), coloured by that agent's usage semaphore; a working session makes that agent's badge slowly fade out and quickly fade in
