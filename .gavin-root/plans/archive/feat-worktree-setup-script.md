---
order: 2048
title: Worktree setup script
status: Done
priority: high
---
Run a repo-declared setup after every worktree Gavin creates, so a rail agent does not burn its first turn on `npm install`.

Today `worktree_add` in `app/src-tauri/src/git/commands.rs` runs a bare `git worktree add` and nothing else. Cursor's `.cursor/worktrees.json` declares a setup command list per platform; Gavin's equivalent is a setup list in `.gavin-root/config.toml`, run in a **visible session tab** in the new worktree (agents run where they can be seen), for both the Git tab's fork dialog and rail binding.

Borrowed from Cursor's worktree setup script (2026-09-03 feature scan).

## Shape

`.gavin-root/config.toml` grows one block:

```toml
[worktree]
setup = ["npm install", "cargo fetch"]
```

Read **host-side** in `app/src-tauri`, the way `root_agent_key` and
`prd_relative_path` already read that file — creating a worktree is a
one-shot user action, so it must not wait on a protocol bump, a daemon
restart and a compat gate to become real.

The list is joined with ` && ` and run as ONE visible session in the new
worktree. When "Start agent here" is on, the agent is chained onto the same
line, so the agent starts in a worktree that is already installed instead of
racing the install — and a failed setup stops before the agent, in view.

## Checklist

- [x] Read `[worktree] setup` from `.gavin-root/config.toml` host-side, with tests for absent / unparseable / wrong-typed shapes
- [x] Expose it as a Tauri command and a `backend.ts` binding
- [x] `worktreeSetup.ts`: the pure command-line builder (setup joined, agent chained after) with unit tests
- [x] The fork dialog runs setup in one visible session in the new worktree
- [x] Rail binding gets that session too — its fork dialog passes a no-op spawner today
- [x] The dialog says what will run before the human commits to it
- [x] Suites green and smoke items filed
