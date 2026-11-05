---
order: 16384
kind: task
title: [ux][agents] waiting background activity + done
status: Done
---
Add a new status to each agent’s session (and their card). It should notify the user that the agent is waiting for a background task to finish. As of today it gets the generic idle status and it sounds confusing.
Add also a “done” status (unlinked from the card kanban status) that should be the concept of “you can close this session if you dont have followups”

<!-- gavin:auto-commit -->
When the implementation is done, commit it. Commit only the files you touched — never `git add -A`. Do not push.
<!-- /gavin:auto-commit -->

- [ ] Human test: After rebuilding and restarting the daemon (protocol v81): in a Claude Code tab, ask it to run `sleep 60` with run_in_background and end its turn — the tab, the sidebar row and its board card show the "waiting for background work to finish" badge (accent, not spinning) instead of nothing/idle, and turn plain idle after the sleep ends. Then have an agent call gavin_session_done at the end of a turn — the green "done — close it unless you have a follow-up" badge appears, and sending it a message clears it.
