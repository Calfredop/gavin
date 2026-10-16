---
order: 15360
kind: task
title: [feat] direct prompt task
status: Done
---
A new kind of task that is a direct prompt. The body of the card goes straight to the agent, without gavin prompt or any other decorator.

<!-- gavin:auto-commit -->
When the implementation is done, commit it. Commit only the files you touched — never `git add -A`. Do not push.
<!-- /gavin:auto-commit -->

- [ ] Human test: After restarting the daemon on v75: file a task with ⌘N → "Direct prompt" ticked, check the board shows the send glyph and the card modal says "direct task" / "Prompt · sent as written", then Run it and confirm the agent's tab received only the body (no "name this tab", no card path, no status line)
