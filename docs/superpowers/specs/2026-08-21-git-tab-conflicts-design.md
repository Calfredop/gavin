# Git Tab — Conflict Resolution — Design Spec

Follow-on to the Git tab (SP1–SP4). Decisions G17–G18 in
`docs/superpowers/brainstorms/2026-08-20-git-tab-brainstorm.md`.

**Goal:** a production-grade merge editor inside the Git tab: every
conflicted file (from merge, pull, rebase, cherry-pick, revert or stash
pop) opens in a Fork-style 3-pane editor with per-conflict and whole-file
resolutions, navigation, undo, safety rails, odd-shaped conflict handling,
and an escape hatch to the user's external merge tool.

**Out of scope:** semantic/AST merges, resolving conflicts in untracked
files, multi-file "resolve all with ours/theirs" (one click per file keeps
the decision explicit), editing the Ours/Theirs panes.

---

## 1. Model

**The Result document is the file on disk, markers and all.** Git writes
the worktree file with conflict markers in the user's `merge.conflictStyle`
(`merge`, `diff3` or `zdiff3`); the editor parses those, rewrites marker
regions when a resolution is chosen, and writes the text back on Save.
There is no separate resolution model to drift from the text. "Resolved"
means the document contains no markers.

```ts
interface ConflictBlock {
  index: number;                 // 0-based, in document order
  from: number; to: number;      // line range of the whole marker region (inclusive start, exclusive end)
  ours: string[]; base: string[] | null; theirs: string[];
  oursLabel: string; theirsLabel: string;   // text after the markers
}
parseConflicts(doc: string): ConflictBlock[]        // all three styles; tolerant of markers inside content only when they start a line with the exact 7-char run
applyChoice(doc, block, "ours" | "theirs" | "both" | "both-reverse"): string
hasMarkers(doc): boolean
locateRegion(sideText: string, lines: string[], fromLine: number): { from: number; to: number } | null
splitEol(text): { lines: string[]; eol: "lf" | "crlf"; finalNewline: boolean }
joinEol(lines, eol, finalNewline): string
```

## 2. Backend

### 2.1 `git_conflict(cwd, path) → ConflictInfo`

```ts
interface ConflictInfo {
  path: string;
  kind: "text" | "deleteModify" | "addedBoth" | "binary" | "submodule";
  base: string | null; ours: string | null; theirs: string | null;   // stage contents (null when the stage is missing or binary)
  worktree: string | null;                                           // current file (null if absent)
  hasMarkers: boolean;
  eol: "lf" | "crlf";
  finalNewline: boolean;
  labels: { ours: string; theirs: string; operation: InProgressKind | "stash" | "unknown" };
  deletedBy: "ours" | "theirs" | null;                               // deleteModify only
}
```

- `ls-files -u -z -- <path>` → `(mode, sha, stage)` per stage. Missing stage 2 → `deletedBy: "ours"`; missing stage 3 → `"theirs"`; both present but stage 1 missing → `addedBoth`; mode `160000` → `submodule`; a NUL byte in any present stage (first 8 000 bytes) → `binary`; else `text`.
- Contents via `show :<n>:<path>`; the worktree file read directly (lossy UTF-8).
- `eol`: CRLF if most line breaks in ours (else theirs) are `\r\n`; `finalNewline` from ours (else theirs).
- Labels: ours = `symbolic-ref --short HEAD` or `HEAD`; theirs by operation —
  merge: `name-rev --name-only --refs=refs/heads/* --refs=refs/remotes/* MERGE_HEAD` (fallback short SHA);
  rebase: ours = upstream label `"<HEAD branch> (upstream)"`, theirs = `<rebase-merge/head-name minus refs/heads/> (rebasing)` — git's ours/theirs are swapped during a rebase and the labels say so;
  cherry-pick / revert: `"<short sha> <subject>"` of `CHERRY_PICK_HEAD` / `REVERT_HEAD`;
  none of the above but stages exist: `"stash"` when `refs/stash` exists, else `"theirs"`.

### 2.2 Writes

| Command | git | Notes |
|---|---|---|
| `git_mark_resolved(cwd, path)` | reads the file; `Err("conflict markers remain")` if `hasMarkers`; then `add -- path` | the row's **+** on a `U` file routes here |
| `git_resolve_whole(cwd, path, side)` | `checkout --ours|--theirs -- path` then `add -- path` | text and binary kinds |
| `git_resolve_deleted(cwd, path, keep)` | `keep` → `add -- path` (file must exist: for `deletedBy: "ours"` first `checkout --theirs -- path`); else `rm -- path` | deleteModify |
| `git_restore_conflict(cwd, path)` | `checkout -m -- path` | undo: re-creates the markers from the index stages |
| save | existing `write_file_for_editor(<abs path>, content)` | content re-joined with `eol`/`finalNewline` |

`git_stage_files` is unchanged but the frontend never sends `U` paths to it.

### 2.3 External merge tool

`git_merge_tool_name(cwd)` → `config merge.tool` (null when unset). The UI
runs `git mergetool --no-prompt -- <path>` through `createSessionForCard`
(a terminal pane in the current page, cwd = the worktree); the file watcher
picks up the tool's write and the editor reloads the document.

## 3. Frontend

### 3.1 Store

`conflict: ConflictInfo | null` and `conflictToken` on `GitViewState`;
`loadConflict(ws)` runs when the selection is a `U` row (instead of
`loadDiff`); `saveConflict(ws, text)`, `markResolved(ws)` (then auto-select
the next `U` row, else clear), `resolveWhole(ws, side)`,
`resolveDeleted(ws, keep)`, `restoreConflict(ws)`, `openMergeTool(ws)`.
`stageFiles` guards: paths whose entry is `U` are routed to `markResolved`.

### 3.2 `GitConflictView.svelte`

Shown in the diff column when the selected entry's status is `U`.

- **Header**: path · kind badge · `⟨ n of m ⟩` navigation (disabled at
  0 conflicts) · **Base** toggle (text kind) · **Use ours** / **Use theirs**
  (confirm: "Replace the whole file with <label>'s version?") · **Restore
  markers** (confirm; enabled when the worktree differs from git's
  marker output or the file has been saved marker-free) · **Open in
  <tool>** (hidden when `merge.tool` is unset) · **Save** (dirty only) ·
  **Mark resolved** (enabled when not dirty and `!hasMarkers`).
- **Panes** (text kind): top row Ours | [Base] | Theirs — read-only
  CodeMirror, each decorated with its conflict regions (numbered gutter
  marker + background) located via `locateRegion`; bottom: **Result** —
  editable CodeMirror with marker regions decorated and an inline widget
  per block: `Ours · Theirs · Both · Both ⇅`. Choosing rewrites the region
  through `applyChoice`; the document is re-parsed on every change so the
  counter, decorations and pane highlights track the text. Navigation
  scrolls all four panes to block n.
- **Odd kinds** → `GitConflictChooser.svelte`: a sentence built from the
  labels (e.g. "`main` deleted `src/x.ts`; `feature` modified it.") and
  buttons: deleteModify → **Keep file** / **Delete file**; addedBoth-binary,
  binary, submodule → **Keep ours** / **Keep theirs**. Each confirms.
- **Keyboard**: `⌘S` save, `⌘Enter` mark resolved, `⌥↓/⌥↑` next/prev
  conflict.

### 3.3 Elsewhere

- Banner: "Merge in progress — 3 files conflicted" with the count live;
  **Continue** disabled until zero.
- `GitFileRow` for `U`: the **+** tooltip reads "Mark resolved" and calls
  `markResolved`; the diff column is the conflict view.
- `GitDiff` is untouched for non-`U` rows.

## 4. Edge cases

| Case | Behaviour |
|---|---|
| Markers typed by hand that don't parse | counted as unresolved (the file still has marker lines); Mark resolved refuses |
| CRLF file | parsed as lines, saved back with CRLF; markers themselves are written with the file's EOL |
| No final newline | preserved on save |
| Both sides deleted (rename/rename with delete) | git reports no stage 2 and 3: chooser offers **Delete file** only |
| Rename/rename (different new names) | two `U` rows; each is a text conflict against stage 1 |
| File resolved externally (no markers, not staged) | editor opens in "ready to mark resolved" state |
| Worktree file missing (deletedBy ours, text kind) | Result starts from theirs; Keep file restores it |
| > 2 MB stage | editor refuses with "too large — use the external tool / whole-file buttons" |
| Operation aborted while editing | the `U` row disappears on refresh; the view falls back to "Select a file" |

## 5. Testing

- **Rust**: real merge conflict → kind text, labels (ours=main, theirs=feature), stages; rebase conflict → labels swapped and suffixed; cherry-pick → short sha label; delete/modify both directions; added-by-both; binary detection; submodule detection via a fake 160000 entry (skip if unsupported); `mark_resolved` refuses markers then succeeds after a clean write; `restore_conflict` brings markers back; `resolve_whole` both sides; `resolve_deleted` keep/delete; EOL detection CRLF.
- **Vitest**: `parseConflicts` on merge/diff3/zdiff3/CRLF/no-final-newline/adjacent blocks; `applyChoice` four choices incl. empty side; `locateRegion` ordered search with repeats; `joinEol`; store: U selection loads the conflict, markResolved advances, stageFiles routes U paths.
- **Smoke**: "Git tab — conflicts": merge conflict resolved per-block and marked; rebase labels read correctly; delete/modify chooser; binary chooser; restore markers; external tool round-trip; Continue unlocks at zero.
