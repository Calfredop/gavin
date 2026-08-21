---
order: 4096
title: Git tab — Sync, branches, stashes (SP2 of 3)
status: Done
priority: high
---
# Git tab — Sync, branches, stashes (SP2 of 3)

Fetch/Pull/Push with streamed progress + cancel, branches and remotes in the
sidebar (checkout / create / delete / merge), stashes (push / pop / apply /
drop / contents), abort/continue for in-progress merges and rebases.

Spec: `docs/superpowers/specs/2026-08-20-git-tab-sync-worktrees-design.md` (§1–2)
Decisions: G10, G13, G14 in `docs/superpowers/brainstorms/2026-08-20-git-tab-brainstorm.md`
Plan: `docs/superpowers/plans/2026-08-20-git-tab-sync-branches.md`

## Steps

- [x] Streaming runner + op registry + cancel; fetch/pull/push commands (bare-remote tests)
- [x] Refs snapshot (`git_refs`): branches with tracking, remotes, stashes — parsers + tests
- [x] Branch / remote / stash / abort / continue commands + tests
- [x] Store: refs, activeRemote, navSelection, op lifecycle + tests
- [x] Toolbar trio + badges + remote dropdown + op bar + stash dialog
- [x] In-progress banner Abort / Continue
- [x] Sidebar sections: Branches, Remotes, Stashes + dialogs + stash view
- [x] Smoke checklist entries
