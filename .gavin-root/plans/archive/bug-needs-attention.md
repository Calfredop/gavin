---
order: 39936
kind: task
title: [bug] needs attention
status: Done
---
Many coding sessions ends with a “need attention” when is actually not needed. Check the “Commit changes” of third page of ‘Gavin’ workspace

<!-- gavin:auto-commit -->
When the implementation is done, commit it. Commit only the files you touched — never `git add -A`. Do not push.
<!-- /gavin:auto-commit -->

## Root cause

The "Commit changes" tab (page "companion phone", session `97f7acd4`) finished
its turn normally at 15:20:19 — three commits, clean tree, rail step
`cp-20-commit` done — yet the registry holds it `waiting_for_input`.

Claude Code sends an idle reminder, `Claude is waiting for your input`
(notification type `idle_prompt`), 60 s (`messageIdleNotifThresholdMs`) after
EVERY turn nobody has answered. Under the `TERM_PROGRAM=ghostty` pty.rs pins,
that arrives as `ESC ] 777 ; notify ; Claude Code ; Claude is waiting for your
input BEL`, and `status.rs` maps every OSC 777/9/99 notification to
`WaitingForInput`. So every finished agent reads as "waiting for you" a minute
later, and the reminder's own bytes also flash a `working` through the output
heuristic first. It never marks a dialog either: Claude Code withholds it
while one is on screen, and permission prompts send their own notification.

## Plan

- [x] `status.rs`: recognise the reminder on all three channels (777, 9, 99) as its own event, never `WaitingForInput`
- [x] `server.rs`: a chunk carrying the reminder is not the agent working (skip the output heuristic, like a provoked repaint)
- [x] Tests: scanner unit tests per channel + an end-to-end pump test that the reminder changes no status
- [x] `cargo test -p gavin-daemon` green
- [ ] Human test: After rebuilding and restarting the daemon, let an agent finish a turn and leave its tab alone for two minutes: it stays idle, with no "waiting for you" badge and no entry in the attention inbox

Lands with the next daemon rebuild + restart (the human's call). Sessions
already stuck at `waiting_for_input` stay there until answered or marked read.
