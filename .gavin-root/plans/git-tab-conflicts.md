---
order: 1024
title: Git tab — Conflict resolution (merge editor)
status: Done
priority: high
---
# Git tab — Conflict resolution (merge editor)

Fork-style 3-pane merge editor for conflicted files: per-block ours/theirs/
both, whole-file choices, base pane, next/prev navigation, restore markers
(undo), marker-aware Mark resolved, CRLF/final-newline preservation,
choosers for delete/modify, added-by-both, binary and submodule conflicts,
and "Open in <merge.tool>".

Spec: `docs/superpowers/specs/2026-08-21-git-tab-conflicts-design.md`
Plan: `docs/superpowers/plans/2026-08-21-git-tab-conflicts.md`

## Steps

- [x] Backend `conflict.rs`: conflict info (kind, stages, labels, EOL), mark resolved (marker check), resolve whole/deleted, restore markers, merge tool name (+ tests)
- [x] `conflictMarkers.ts` parser/rewriter + store actions (+ tests)
- [x] CodeMirror decorations + scroll; `GitConflictView`, `GitConflictChooser`; wiring, banner count, U-row routing
- [x] Smoke entries
- [x] Manual pass (Smoke Test workspace → “Git tab — conflicts”)
