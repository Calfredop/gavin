---
title: Git tab — History graph (SP4 of 4)
status: In Progress
priority: high
---
# Git tab — History graph (SP4 of 4)

Fork's "All Commits": colored-lane graph over all branches with paging,
commit detail with read-only per-file diffs, and commit actions (checkout
detached, branch here, copy SHA/message, cherry-pick, revert, reset).

Spec: `docs/superpowers/specs/2026-08-21-git-tab-history-design.md`
Decisions: G15, G16 in `docs/superpowers/brainstorms/2026-08-20-git-tab-brainstorm.md`
Plan: `docs/superpowers/plans/2026-08-21-git-tab-history.md`

## Steps

- [x] Backend: log + decorations parsing, commit detail, revision diffs, cherry-pick/revert/reset, in-progress kinds (+ tests)
- [x] Lane model `graphLanes.ts` + history store (+ tests)
- [x] Graph, detail pane, reset dialog, context menu, banner kinds
- [x] Smoke entries
- [ ] Whole-feature manual pass (Smoke Test workspace → the four “Git tab” sections)
