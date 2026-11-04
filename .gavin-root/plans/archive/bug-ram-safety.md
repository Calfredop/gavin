---
order: 16384
kind: task
title: [bug] RAM safety
status: Done
---
How is RAM safety treshold calculated? One user reported being unable to run agents with 20 GB used on 48 GB total. Wasn’t the threshold %? Allow the user to set the treshold manually in app settings

<!-- gavin:auto-commit -->
When the implementation is done, commit it. Commit only the files you touched — never `git add -A`. Do not push.
<!-- /gavin:auto-commit -->

- [ ] Human test: App Settings → Memory wall: the new "Pressure threshold" row lays out like the ceiling row above it, the "Now X of Y GB in use (N%) · macOS reports …" line shows live figures, and typing e.g. 85 then reopening Settings keeps 85 (blank goes back to following macOS)
