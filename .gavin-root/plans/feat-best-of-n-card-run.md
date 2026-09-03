---
order: 4096
title: Best-of-N card run
status: To Do
priority: high
---
Run one card on N agent profiles or models at once, each in its own worktree, watch them side by side in the tiled layout, pick one, merge it, and close the rest.

Cursor's `/best-of-n` hides the candidates in chat; Gavin's version shows them live in terminals, which is the product thesis. Prerequisite: a per-run profile and model override — today the profile is per workspace only (`agent_setup.rs`, `.gavin-root/config.toml [agent]`). Picking one must close the losing sessions and remove their worktrees; merging stays the human's action.

Borrowed from Cursor's /best-of-n + /apply-worktree (2026-09-03 feature scan).
