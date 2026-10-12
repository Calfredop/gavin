---
order: 16384
kind: task
title: [bug] kimi as bash
status: Done
---
I’ve set up a new workspace, with Kimi as default agent, but when I try to start the workspace’s agent I get this error:\
/bin/sh: kimi: command not found

<!-- gavin:auto-commit -->
When the implementation is done, commit it. Commit only the files you touched — never `git add -A`. Do not push.
<!-- /gavin:auto-commit -->

- [ ] Human test: After rebuilding and restarting the daemon, start the agent in the Kimi workspace: it should launch kimi instead of failing with "/bin/sh: kimi: command not found"
