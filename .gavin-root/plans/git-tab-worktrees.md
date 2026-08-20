---
title: Git tab — Worktrees / agent forks (SP3 of 3)
status: To Do
priority: high
---
# Git tab — Worktrees / agent forks (SP3 of 3)

Worktree switcher in the toolbar; fork a branch + worktree from the tab and
start an agent in it; merge back with optional cleanup; remove / prune;
watcher follows linked worktrees' gitdir.

Spec: `docs/superpowers/specs/2026-08-20-git-tab-sync-worktrees-design.md` (§3)
Decisions: G6, G11, G12 in `docs/superpowers/brainstorms/2026-08-20-git-tab-brainstorm.md`
Plan: `docs/superpowers/plans/2026-08-20-git-tab-worktrees.md`

## Steps

- [ ] Worktree list parser + add/remove/prune commands + tests; watcher gitdir fix
- [ ] Store: cwd switching + persisted selection + tests
- [ ] Switcher component with row actions
- [ ] Fork dialog (new / existing branch, default sibling path) + agent spawn
- [ ] Merge back + cleanup dialog; remove (+ force) ; prune
- [ ] Smoke checklist entries; whole-feature manual pass
