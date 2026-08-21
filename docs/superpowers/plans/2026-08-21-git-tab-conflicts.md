# Git Tab — Conflict Resolution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Fork-style 3-pane merge editor for conflicted files in the Git tab, with per-block and whole-file resolutions, navigation, undo, safety rails, odd-shaped conflict choosers, and an external-mergetool escape hatch.

**Architecture:** The Result document *is* the on-disk file with git's markers; a pure `conflictMarkers.ts` parses/rewrites it. The backend exposes one read (`git_conflict`) that gathers stages, kind, labels and EOL, plus small writes that never bypass the marker check. Panes are CodeMirror instances from the app's `createEditor`, extended with a decoration extension and scroll-to-line.

**Tech Stack:** as SP1–SP4 + `@codemirror/state`/`view` decorations (already dependencies).

**Spec:** `docs/superpowers/specs/2026-08-21-git-tab-conflicts-design.md`.

## Global Constraints

- Mark resolved refuses while markers remain — enforced server-side, mirrored client-side.
- EOL and final newline of the original are preserved on every save.
- No `git add` of a `U` path except through `git_mark_resolved`/`git_resolve_*`.
- Whole-file and delete choices always confirm; per-block choices don't (they're undoable by Restore markers or editing).

## File structure

**Rust** `git/`: `types.rs` (+ `ConflictInfo`, `ConflictLabels`), `conflict.rs` (new: `conflict_info`, `mark_resolved`, `resolve_whole`, `resolve_deleted`, `restore_conflict`, `merge_tool_name`, `has_markers`, `detect_eol`), `mod.rs`, `lib.rs`.
**TS**: `conflictMarkers.ts` (+ test), `git.ts` (types), `backend.ts`, `gitState.ts` (+ test), `codeMirror.ts` (`extensions`, `scrollToLine`, `getDoc`), `mergeDecorations.ts` (new), `GitConflictView.svelte`, `GitConflictChooser.svelte`, `GitHubView.svelte` (column swap + banner count), `GitFileRow.svelte`/`GitChanges.svelte` (U routing), `smokeChecklist.ts`.

---

### Task 1: Backend `conflict.rs`
- [ ] Tests (temp repos): text merge conflict (kind, stages, labels, `has_markers`), rebase conflict labels, cherry-pick label, delete/modify both directions, added-by-both, binary, `mark_resolved` refusal → success, `restore_conflict`, `resolve_whole` ours/theirs, `resolve_deleted` keep/delete, CRLF EOL detection.
- [ ] Implement per spec §2; register commands (`git_conflict`, `git_mark_resolved`, `git_resolve_whole`, `git_resolve_deleted`, `git_restore_conflict`, `git_merge_tool_name`).
- [ ] `cargo test -p app` green; commit.

### Task 2: `conflictMarkers.ts` + store
- [ ] Tests: parser on merge/diff3/zdiff3 styles, CRLF, no final newline, adjacent blocks, stray `=======` inside content (not a marker unless a block is open); `applyChoice` ×4 (+ empty side); `locateRegion`; `splitEol`/`joinEol` round trip; store: selecting a `U` row loads the conflict instead of a diff, `markResolved` advances to the next `U`, `stageFiles` routes `U` paths to `markResolved`.
- [ ] Implement `conflictMarkers.ts`, types, wrappers, store actions (`loadConflict`, `saveConflict`, `markResolved`, `resolveWhole`, `resolveDeleted`, `restoreConflict`, `openMergeTool`, `mergeToolName` cached on `repo` refresh).
- [ ] `npm test && npm run check` green; commit.

### Task 3: Editor plumbing + components
- [ ] `codeMirror.ts`: `CreateEditorOptions.extensions?: unknown[]`, `EditorHandle.scrollToLine(line)`, `getDoc()`. `mergeDecorations.ts`: `createRegionDecorations()` → `{ extension, setRegions(view-less: returns a StateEffect) }` using a StateField of line decorations + gutter numbers; an `applyRegions(handle, regions)` helper dispatching the effect (handle exposes `dispatch(effects)`).
- [ ] `GitConflictView.svelte`, `GitConflictChooser.svelte`; wire into `GitHubView` (U rows → conflict view), `GitFileRow` tooltip/route, banner count; keyboard shortcuts.
- [ ] `npm run check` clean, `npm run build` clean; commit.

### Task 4: Smoke + docs + merge
- [ ] Smoke section "Git tab — conflicts"; card `git-tab-conflicts.md`; execution notes; decisions G17–G18 in the brainstorm log; merge `main`; full verification; commit.
