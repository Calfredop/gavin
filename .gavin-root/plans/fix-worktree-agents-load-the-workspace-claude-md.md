---
kind: task
title: [fix] A Claude Code agent in .gavin-worktrees also loads the workspace's CLAUDE.md
status: To Do
priority: medium
complexity: moderate
---
Since `feat-gavin-worktrees`, worktrees live at `<workspace>/.gavin-worktrees/<branch>`.
Claude Code loads `CLAUDE.md` / `CLAUDE.local.md` from the cwd and EVERY directory
above it, up to `/` (docs: code.claude.com/docs/en/memory.md, "How CLAUDE.md files
load"). So an agent in a worktree reads its branch's `CLAUDE.md` AND the main
checkout's. That doubles the instructions, and they can disagree when the branch edits
the file. It also picks up the human's `CLAUDE.local.md`, which a sibling worktree
never saw. Codex, Gemini and opencode stop at the git root, which for a linked
worktree is the worktree itself. Claude Code's own `--worktree` (`.claude/worktrees/`)
has the same double load.

Documented escape: `claudeMdExcludes`, an array of globs over ABSOLUTE paths, settable
in local scope (`<worktree>/.claude/settings.local.json`, where arrays merge across
scopes). Goal: a worktree agent loads exactly what it loaded when worktrees were
siblings.

## Proposed fix (decide before building)

When `worktree_add` (app/src-tauri/src/git/commands.rs, `prepare_worktrees_dir`) cuts
into `.gavin-worktrees`, write `claudeMdExcludes` into the new worktree's
`.claude/settings.local.json`. The list covers `CLAUDE.md`, `CLAUDE.local.md` and
`.claude/CLAUDE.md` in every directory strictly above the worktree, up to and
including the workspace root.

Guards:
- Only when the worktree has its own tracked `CLAUDE.md`. If the project's is
  untracked, the parent copy is the ONLY one the agent gets, and excluding it is a
  regression.
- Never overwrite an existing `settings.local.json`; merge the key, or skip.
- Only when `git check-ignore -q .claude/settings.local.json` holds in the new
  worktree. On this Mac the global excludes file covers it; elsewhere it would show
  as untracked.

Worktrees cut by hand through the orchestrate skill would need the same step, or a
note. The alternative is `--settings '{"claudeMdExcludes":[…]}'` on the claude-code
launch line for a cwd under `.gavin-worktrees`. It writes no file, but it touches
every launch path and needs shell quoting on three OSes.

## Verify

A commands.rs test: after `worktree_add` into `.gavin-worktrees`, the worktree's
`.claude/settings.local.json` lists the parent's `CLAUDE.md` path, and the worktree's
`git status` stays clean. Then, in the running app, start a Claude Code agent in a
fresh worktree and check `/memory`: only the worktree's `CLAUDE.md` is listed.
