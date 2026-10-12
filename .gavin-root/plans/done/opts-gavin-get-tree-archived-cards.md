---
order: 15360
kind: task
title: [opts] gavin_get_tree archived cards
status: Done
complexity: complex
---
Check if this mcp returns archive cards too; if so create a dedicated mcp tool for whole tree with search criteria. Else optimize it because big workspaces fails the hook because of big trees.
From a Grimoria's session:
 gavin_get_tree returns the whole board as one JSON dump: every card in the workspace with its path, title, status, kind, parent, checklist counts, complexity and so on. This workspace has a lot of cards, so the output ran to about 457,000 characters over 12,000 lines. That's far over what I can read in a single tool result.

      The tool therefore saved the output to a file instead of showing it to me. I couldn't read it in one go, so I searched that file for the two cards I cared about, the parent and the new child, and read only their entries.

      I used the tree for the read-back, to confirm the parent came back as kind: plan with complexity: moderate and 4 checklist items, and that the child came back as kind: task with the right parent, no status and complexity: complex. Your card isn't huge. The same applied to the PRD, whose output was also saved to a file, and I only searched it for "checklist".

<!-- gavin:auto-commit -->
When the implementation is done, commit it. Commit only the files you touched — never `git add -A`. Do not push.
<!-- /gavin:auto-commit -->
