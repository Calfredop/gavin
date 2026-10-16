---
order: 2048
kind: task
title: [ui] companion session connect
status: Done
attachments: /Users/coalpila/Downloads/Screenshot 2026-10-15 (19.10.59).png
---
Connecting to a session via Companion app, on phone, make the session on the host device to resize the terminal. which looks odd. Also scrolling/tapping on the terminal in companion makes appears various chars in the terminal, therefore the agent prompt input. Check attached screenshot please.

<!-- gavin:auto-commit -->
When the implementation is done, commit it. Commit only the files you touched — never `git add -A`. Do not push.
<!-- /gavin:auto-commit -->

- [ ] Human test: After rebuilding + restarting the daemon (v74) and installing the app: open a Claude Code session on the phone. The desk's terminal shows the "Open on <phone>" bar with Fit here. Swiping and tapping on the phone's terminal type no `NaN;NaNM` into the prompt. Closing the terminal on the phone, or pressing Fit here, puts the desk's terminal back to full width.
