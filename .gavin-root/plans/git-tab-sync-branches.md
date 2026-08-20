---
title: Git tab — Sync, branches, stashes (SP2 of 3)
status: In Progress
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

- [ ] Streaming runner + op registry + cancel; fetch/pull/push commands (bare-remote tests)
- [ ] Refs snapshot (`git_refs`): branches with tracking, remotes, stashes — parsers + tests
- [ ] Branch / remote / stash / abort / continue commands + tests
- [ ] Store: refs, activeRemote, navSelection, op lifecycle + tests
- [ ] Toolbar trio + badges + remote dropdown + op bar + stash dialog
- [ ] In-progress banner Abort / Continue
- [ ] Sidebar sections: Branches, Remotes, Stashes + dialogs + stash view
- [ ] Smoke checklist entries
