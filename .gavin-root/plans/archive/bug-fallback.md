---
order: 38912
kind: task
title: [bug] fallback
status: Done
---
When going in a workspace, if a certain fallback has not been setup, the fallback modal keeps poping even if I said ‘Cancel’; add a don’t ask again

<!-- gavin:auto-commit -->
When the implementation is done, commit it. Commit only the files you touched — never `git add -A`. Do not push.
<!-- /gavin:auto-commit -->

- [ ] Human test: In a workspace whose fallback agent is not set up, press "Don't ask again" in the setup wizard, restart the app and re-enter the workspace: the wizard stays closed; Settings → Fallback agent lists that agent with an "Ask again" button that reopens the wizard.
