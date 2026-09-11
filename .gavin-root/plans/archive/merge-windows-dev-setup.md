---
title: Merge windows-dev-setup onto main
labels: windows
status: Done
priority: high
---
Gracefully merge remote `win/windows-dev-setup` onto `main` so main is the baseline for all systems.

- [x] Fetch remote and inspect divergence vs main
- [x] Merge in an isolated worktree (do not disturb other checkouts)
- [x] Resolve conflicts preserving both sides' intent
- [x] Verify the merged tree
- [x] Fast-forward origin/main (shared checkout left in place; pull when quiet)

Landed as `f669e95` on `origin/main`.
