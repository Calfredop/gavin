---
order: 2048
title: Worktree setup script
status: To Do
priority: high
---
Run a repo-declared setup after every worktree Gavin creates, so a rail agent does not burn its first turn on `npm install`.

Today `worktree_add` in `app/src-tauri/src/git/commands.rs` runs a bare `git worktree add` and nothing else. Cursor's `.cursor/worktrees.json` declares a setup command list per platform; Gavin's equivalent is a setup list in `.gavin-root/config.toml`, run in a **visible session tab** in the new worktree (agents run where they can be seen), for both the Git tab's fork dialog and rail binding.

Borrowed from Cursor's worktree setup script (2026-09-03 feature scan).
