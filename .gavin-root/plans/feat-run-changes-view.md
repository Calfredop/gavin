---
order: 11264
title: Per-run Changes view
status: To Do
priority: high
---
Show what a specific card run changed, live, as a diff from the commit the run started on — and let the human discard that run's changes from the same baseline.

Today the Git tab is one checkout per workspace (`gitState.ts`) and nothing links a session or a card run to a diff. Record the HEAD sha when a card run starts (the run row), then surface "Changes" on the card detail modal and the tab bar, scoped to the run's worktree. A "Discard this run" action resets that worktree to the baseline, which is Cursor's checkpoint restore done with git.

Borrowed from Cursor's live agent diff + checkpoints (2026-09-03 feature scan).
