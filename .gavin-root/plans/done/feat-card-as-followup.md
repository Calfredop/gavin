---
order: 16384
kind: task
title: [feat] card as followup
status: Done
---
In the followup feature ui, allow the user to pick a card as a followup, with the option to add it as “open in new session” (therefore in a new tab) or inline to the current session as injected prompt

<!-- gavin:auto-commit -->
When the implementation is done, commit it. Commit only the files you touched — never `git add -A`. Do not push.
<!-- /gavin:auto-commit -->

- [ ] Human test: Open Follow-ups on a working agent's tab, press Card: pick a card "Inline in this session" (it appears in the queue as the card's prompt and the card goes In Progress), then pick another with "Open in a new session" (it lists under "Cards to open in a new session"; when the agent's turn ends it opens in a new tab and the badge count drops)
