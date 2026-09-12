---
title: Context menu must not close sidebar peek
status: Done
complexity: trivial
---
Right-clicking a peeked sidebar row opens the portaled menu under the cursor, which fires mouseleave and ends the peek.

- [x] leave() can hold while a context menu is open
- [x] mousedown on the menu does not end the peek
- [x] after the menu closes, end the peek only if the pointer is not over the sidebar
