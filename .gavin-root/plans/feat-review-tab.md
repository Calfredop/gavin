---
order: 2048
title: [feat] Review tab
status: To Do
---
A new Review tab in the workspace hub. Here all "Done" (or other 'marked as review' cols) tasks and plan should be placed in a left side, collapsible, list of cards, grouped by 'touched files'. Selecting a card should bring a three cols ui. 
- first col: terminal session of the selected card, or if not preset a 'start agent session' cta that starts the session with current card context (opens a session in agent page too)
- second col: list of toched files
- third col: file editor with diff/edit mode switcher

Additional feats:

- search in top of cards list
- filter to show archived cards (default to off)

<!-- gavin:auto-commit -->
When the implementation is done, commit it. Commit only the files you touched — never `git add -A`. Do not push.
<!-- /gavin:auto-commit -->
