---
kind: task
title: [fix] Shell tool steps never finish on a rail
labels: bug
status: Done
---
Every command and script tool step (run tests, sync from main, a deploy)
held its rail at `running` forever, its tab still open after the run.

Cause: cd708524 kept a shell tool's tab open after the PTY exits
(`retainTabOnExit`) so its output stays readable. The scheduler's live set is
read off the layout, so the retained tab counted as a live session. Rule 3
only reads the exit code of a session that is not live, so the step never
completed or stalled.

Fix: `nextActions` treats a session with a witnessed exit (`sessionExits`) as
dead whatever the layout says. Session ids are never reused, so an exit is
final. Tests cover running and paused rails and every shell built-in with its
tab kept open.
