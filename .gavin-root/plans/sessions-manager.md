---
kind: task
title: Sessions manager
status: To Do
---
Under the app “Settings” item in the sidebar, add a “Task manager” where the user can manage opened sessions: visible and invisible ones, with a stale indicator, cpu/mem usage and the possibility to:
- jump to that session (open a dedicated tab if it is an hidden session)
- kill that session (confirm)
- kill all session (confirm)

A surviving orphan agent — a process that outlived its daemon and is still
editing a checkout with no tab in front of it — is the purest "invisible
session with a stale indicator" this card asks for, and detecting it is
`.gavin-root/plans/bug-orphan-survives-daemon.md`. Whichever of the two lands
second should reuse the other's list rather than growing a parallel one.
