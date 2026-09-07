---
order: 1024
kind: task
title: [feat] develop right away
status: Done
---
in new card modal, move the 'Run now with the agent' checkbox under an 'Agent actions' checkbox group.
Then add a new 'Develop with agent on add'. The second option should then start the develop skill for that plan/task/note. The actions should mutually exclude one from another (only one action selectable), but also should be unselectable (no action).
In this round of implementation, make the develop skill assign the correct 'Complexity' (new field) to the task/plan/note.

<!-- gavin:auto-commit -->
When the implementation is done, commit it. Commit only the files you touched — never `git add -A`. Do not push.
<!-- /gavin:auto-commit -->
