---
title: Git tab — Local Changes (SP1 of 3)
status: In Progress
priority: high
---
# Git tab — Local Changes (SP1 of 3)

A Fork-style Git tab in the workspace hub. Sub-project 1 of 3: the tab,
the three-pane Local Changes screen, file/hunk/line staging in unified or
split diffs, discard, commit + amend, live watcher-driven refresh.

Spec: `docs/superpowers/specs/2026-08-20-git-tab-local-changes-design.md`
Decisions: `docs/superpowers/brainstorms/2026-08-20-git-tab-brainstorm.md` (G1–G9)
Implementation plan: `docs/superpowers/plans/2026-08-20-git-tab-local-changes.md` (18 tasks)

Follow-ups: SP2 sync/branches/stashes · SP3 worktrees (agent forks) · SP4 history graph.

## Steps

- [ ] Backend `git.rs`: porcelain-v2 + unified-diff parsers, read commands, unit tests
- [ ] Backend write commands (stage/unstage/apply/discard/commit/init) + temp-repo integration tests
- [ ] Watcher `git_watch`/`git_unwatch` with `.git/` path filter → `git-changed` event
- [ ] `Workspace.gitView` persisted prefs (Rust + TS + shape test)
- [ ] TS pure modules: `diffRows.ts`, `patch.ts`, `gitState.ts` + vitest (shared patch fixtures)
- [ ] Tab registration, empty states (not a repo / git missing), three-pane shell + splitters
- [ ] Unstaged/Staged lists, row actions, keyboard, commit box + amend
- [ ] Diff viewer unified, then split layout, then line selection + partial staging
- [ ] Discard flows with confirm dialogs + "don't ask again"
- [ ] Home tile, smoke checklist entries, manual pass
