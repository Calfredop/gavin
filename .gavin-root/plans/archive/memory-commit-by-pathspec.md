---
kind: note
labels: memory
title: Commit by pathspec, not by index
status: Done
---
Commit with `git commit -- <paths>`, never `git add` then a bare `git commit`.

Why: the index is shared with every other session in this checkout. A
`git add` followed by a commit leaves a window in which another agent's
`git commit -a` sweeps your staged files into its own commit under its
own message — which happened on 2026-09-07, when the app-home work
landed inside a terminal fix. The pathspec form commits the working-tree
content of exactly those paths and ignores whatever else is staged, so
there is no window at all.
