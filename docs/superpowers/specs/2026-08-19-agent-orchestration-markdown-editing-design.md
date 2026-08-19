# Markdown Editing (CodeMirror 6) — Design Spec

Sub-project **4 of 6** of the agent-orchestration phase. Phase decisions live in
`docs/superpowers/brainstorms/2026-08-06-agent-orchestration-brainstorm.md`; this
sub-project is governed by **D8** (CodeMirror 6, debounced autosave, preview via
the existing marked pipeline, silent reload when clean / conflict when dirty) and
its own **D23–D26**.

**Goal:** the read-only file viewer becomes an editor — every viewable text file
is editable, markdown gets a three-mode switch, and the workspace PRD and agent
instructions file get first-class hub tabs.

**Out of scope:** LSP, linting, formatting (D23 — see the cost analysis in the
decision log; cmux takes the same stance); creating or deleting files (sub-5's
explorer); the orchestration home layout (sub-6); additional agent profiles.

---

## 1. Component architecture and modes

`FileViewerPane.svelte` currently does everything and now has three callers
(pane file tabs, the PRD tab, the agent-file tab), so it splits:

| Component | Responsibility |
|---|---|
| `FileEditor.svelte` | The real unit: load, watch, modes, buffer, autosave, conflicts. Props: `path`, `initialMode`. |
| `FileViewerPane.svelte` | Thin pane wrapper — keeps the no-op `fit()` and `visible` handling `Pane.svelte` requires; renders `FileEditor`. |
| `PrdHubView.svelte` / `AgentFileHubView.svelte` | Hub-view wrappers (HUB_VIEWS components receive only `workspaceId`): resolve the path from the workspace root, render `FileEditor`. |
| `CodeMirrorView.svelte` | Thin CM6 mount/teardown wrapper. |
| `codeMirror.ts` | Extension assembly (theme, keymap, language-by-extension) — kept out of the component so the language mapping is unit-testable. |

**Modes**, via a segmented control at the pane's top right:

- Markdown (`.md`/`.markdown`): **Formatted · Plain · Edit**. Formatted is
  today's marked + DOMPurify render; Plain is the same CodeMirror view as Edit
  with `EditorState.readOnly` set.
- Every other text file: **Plain · Edit** (no rendered form exists).
- **Defaults:** file tabs open Formatted (markdown) or Plain (other) — they are
  read-first today; the PRD and agent-file hub tabs open in **Edit**. The mode
  is remembered per tab for the session.
- **Truncated files are never editable.** Over the 1 MB cap only a prefix was
  loaded, so a save would destroy the tail; those stay view-only with the
  existing "Open externally" escape.

**One highlighter, not two.** Plain mode is CodeMirror in read-only mode rather
than the current highlight.js `<pre>`, so Plain ↔ Edit is a flag flip with no
reflow, no font shift, and no second highlighting engine to keep in sync. That
leaves highlight.js with no importer once the old render path goes, so this
sub-project also drops the dependency and its theme CSS, and replaces
`fileTypes.fileLanguage` (hljs language names) with `codeMirror.ts`'s language
resolution. `fileExtension`/`isMarkdown` stay as they are.

**Hidden-pane measurement.** `Pane.svelte` keeps inactive tabs mounted, and CM6
measures on mount — mounting hidden yields a zero-height editor. `FileEditor`
calls `view.requestMeasure()` when its tab becomes visible. (Same class of bug
as the blank-terminal one from Milestone C.)

**Dependencies** (new): `@codemirror/state`, `@codemirror/view`,
`@codemirror/commands`, `@codemirror/language`, `@codemirror/theme-one-dark`,
and language packs `@codemirror/lang-markdown`, `-javascript`, `-rust`,
`-python`, `-json`, `-html`, `-css`, `-yaml`. Individual packages rather than the
`codemirror` meta-package, which pulls autocomplete and lint we do not use.
Language packs are **lazy-imported per file type** so opening a markdown file
never loads the Rust grammar. Extensions with no pack fall back to plain text —
editable, just uncolored.

## 2. Saving, echo suppression, conflicts

**Write command.** New `write_file_for_editor(path, content)` in
`fileviewer.rs`, plain `fs::write` (matching `gavin::write_plan_field`'s existing
convention rather than introducing temp-file-plus-rename in one place only). It
creates the file when absent — that is what lets the agent-file tab work before
setup has ever run.

**Autosave.** Debounced ~1 s after typing stops (D8), with an immediate flush on
⌘S, on switching away from Edit, and on destroy. Worst-case exposure is ~1 s.

**Echo suppression.** Our own save trips the watcher, which emits `file-changed`,
which today reloads — mid-typing that would yank the buffer and reset the cursor.
The rule is content-based, not timing-based, so a slow disk cannot defeat it:

```
resolveExternalChange(incoming, buffer, dirty) →
  incoming === buffer  → "ignore"    // our own echo, or an identical write
  !dirty               → "reload"    // silent (D8)
  dirty                → "conflict"
```

This lives in a new pure `fileEditing.ts` — the only way to get it under test in
a repo that cannot test components.

**Conflict UI.** A banner, not a modal (modals block, and panes already use
notice/error banners): *"This file changed on disk while you were editing."* with
**Keep mine** (dismiss; the next save wins) and **Take theirs** (discard buffer,
reload). Save failures use the same banner and leave the buffer intact.

**Dirty indicator.** A dot on the tab label, so an unsaved buffer is visible
without opening the tab.

**Consequence, stated deliberately:** editing a plan file's frontmatter here
moves its card on the kanban board within the watcher's ~3 s. That is
files-are-truth (D2) working as designed — and it means plan files now have two
write paths, this editor (whole-file, last-write-wins) and `set_plan_field`
(surgical single line). The conflict banner is what keeps that safe.

## 3. The PRD and agent-file hub tabs

Two new `HUB_VIEWS` entries (`prd`, `agent-file`) beside Kanban, with lucide
icons.

**Gating.** Both are meaningless without a bound root, so `visibleHubViews` gains
a `hasRoot` parameter — the same pure, tested predicate approach already used for
the dev-only Checklist tab. With no root the tabs are simply not offered; the
existing "Set root…" banner already explains why.

**Paths.** PRD: `<root>/.gavin-root/PRD.md`. Agent file: `<root>/CLAUDE.md`,
hardcoded with a comment pointing at `agent_setup.rs`'s `ClaudeCodeProfile` seam
(D4) — one profile exists, and a config lookup for a single value would be
speculative.

**Missing files.** The PRD exists whenever the root was initialized, but
CLAUDE.md may not. Rather than erroring on a file we are about to create,
`read_file_for_viewer`'s `FileContent` gains `exists: bool`: a missing but
otherwise permitted path returns empty content with `exists: false`. The tab
opens in Edit with a quiet notice — *"This file doesn't exist yet — saving will
create it."* One round trip, no error-string sniffing. (File tabs are unaffected:
`resolve_path_under_cursor` only ever yields existing files.)

**Deliberate exclusion:** these tabs edit their file and nothing else. No
"initialize root" or "run agent setup" buttons — those live on the hub's
root-control row, and duplicating actions across surfaces is how they drift.

## 4. Testing

Coverage goes where this repo can actually hold it (no component tests — vitest
cannot preprocess `.svelte` here):

- **`fileEditing.ts`** — `resolveExternalChange` across all three verdicts
  (including dirty-but-identical, which must ignore); `canEdit(truncated, error)`.
- **`codeMirror.ts`** — language selection per extension, including the
  unknown-extension fallback to plain text (replaces `fileTypes.fileLanguage`'s
  existing hljs-name test).
- **`workspace.ts`** — `hasRoot` gating for the new hub views.
- **Rust (`fileviewer.rs`)** — `write_file_for_editor`: creates a missing file,
  overwrites an existing one, round-trips UTF-8 (including multi-byte), errors on
  an unwritable path; `read_file_for_viewer` returns `exists: false` with empty
  content for a missing path and leaves existing behaviour unchanged.
- **Manual** (added to the dev Checklist tab): mode switching; typing then
  waiting ~1 s persists; ⌘S; external edit while clean reloads silently; external
  edit while dirty raises the banner and both buttons behave; a plan file's
  status edited here moves its card; a >1 MB file offers no Edit mode; the PRD
  and agent-file tabs appear only with a root and create CLAUDE.md on first save;
  an editor opened in a background tab renders at full height when revealed.

**Risks named:** bundle weight (mitigated by lazy language imports); the
hidden-pane measurement trap; two write paths into plan files.

## 5. What later sub-projects consume

- **Sub-5 (plan explorer):** `FileEditor` is the editing surface the tree opens
  into; file creation lands there, not here.
- **Sub-6 (orchestration home):** the PRD and agent-file tabs become panels in
  the Mission Control layout (D11) — same components, different placement.
