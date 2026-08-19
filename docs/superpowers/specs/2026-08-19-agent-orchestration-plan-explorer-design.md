# Plan Explorer — Design Spec

Sub-project **5 of 6** of the agent-orchestration phase. Phase decisions live in
`docs/superpowers/brainstorms/2026-08-06-agent-orchestration-brainstorm.md`; this
sub-project is governed by **D10** (creation lives in the explorer, no general
file manager) and its own **D27–D30**.

**Goal:** a `.gavin*`-scoped markdown explorer — tree on the left, editor on the
right — that also creates plans, docs, specs and contexts, and lets a plan's
kanban-relevant metadata be edited directly rather than only by hand-writing YAML
or dragging cards.

**Out of scope:** renaming or deleting files (D10 stands — destructive ops stay in
the terminal where git sees them); non-markdown files; the Mission Control home
layout (sub-6); a general file browser outside `.gavin*`.

---

## 1. Layout and the tree

A new hub tab **Plans** (`requiresRoot: true`, gated exactly like PRD/CLAUDE.md),
master-detail: tree left at a fixed ~260 px, `FileEditor` right, keyed by the
selected path so switching files rebuilds cleanly.

The tree is a **pure projection of `$gavinTrees[workspaceId]`** — `GavinContext`
already carries `plans`, `docs` and `specs`, so there is no new scanning and no
new backend for the tree itself.

- **Context nodes** — root context first, then by folder path — labelled with the
  context name (`config.toml` name, folder-name fallback), carrying ⚠ when
  `configWarning` is set.
  - **Group nodes** (Plans / Docs / Specs) render **only when non-empty**, so a
    fresh context is not three empty folders.
    - **File rows.** Plans show title, status, priority dot and the ⚠
      parse-warning badge (all already in `PlanFileInfo`). Docs and specs show
      their `relPath`, so a nested `guides/setup.md` reads correctly.

Contexts and groups start expanded (`.gavin` folders are few by design); collapse
state is per node, in the component.

**Selection is held by path**, because the tree rebuilds on every watcher push. A
selected file that disappears from the tree (deleted in a terminal) yields an
explicit "this file no longer exists" state rather than a stale buffer.

Empty states mirror the PRD tab: no root → "No root folder set"; root but no
`.gavin*` → a prompt to create the first context.

`buildExplorerTree` lives in a pure `planExplorer.ts` — the only way this is
testable in a repo that cannot test components.

## 2. Creation (D10)

Each context node carries a **+ menu** (New plan / New doc / New spec); the tab
header carries **New context**. All are inline composers in the tree, not modals.

- **New plan** → the daemon's existing `CreatePlan`, which already validates the
  filename, refuses overwrites and writes canonical frontmatter with
  `status: To Do`. You type a title; the filename is auto-slugified from it
  (`"Auth flow rework"` → `auth-flow-rework.md`) and shown as a hint.
- **New doc / new spec** → no daemon command exists; `write_file_for_editor`
  (which creates missing files) is used with the path computed from the context's
  `kind` — `.gavin-root` for the root context, `.gavin` otherwise. **This
  asymmetry is deliberate:** plans are validated daemon-side because MCP agents
  create them too; docs and specs are UI-only. The same pure `slugFileName`
  guarantees a daemon-legal name either way.
- **New context** → native folder picker (`plugin-dialog`, already wired), then
  the existing `CreateGavinContext`. The picked folder must be under the
  workspace root — a pure `isUnderRoot` check, since a `.gavin` outside the root
  is a context the scanner can never see.

After any creation the new file is **selected immediately** (its path is known:
`CreatePlan` returns it, docs/specs are constructed), so the editor opens without
waiting ~3 s for the watcher push, which then merely reconciles the tree.
Failures surface inline beside the composer, never as a modal.

## 3. Plan metadata panel (D28)

`PlanMetadataPanel.svelte` sits above the editor in the detail pane, **for plan
files only** — docs and specs have no frontmatter contract.

- **Title** (text), **Status** (dropdown of the board's column names, plus the
  current value when it matches none — the D6 slug rule), **Priority** (select).
- Each commit writes surgically through `setPlanFrontmatterField`, so everything
  else in the file is preserved byte for byte.
- The board reacts immediately via the existing optimistic `patchPlanField`
  (which gains a `title` branch), with the watcher push confirming ~3 s later.
- Board columns come from `$kanbanState[workspaceId]`; the explorer calls the
  existing idempotent `fetchBoard` on mount.

**Allow-list extension.** `gavin::set_plan_field` currently permits
`status`/`priority`/`order`. It gains `title` (validated non-empty, single-line).
It remains a **fixed allow-list** — it must never become an arbitrary-line
writer.

**A pre-existing test encodes the old contract.**
`set_plan_field_rejects_disallowed_keys_and_invalid_priorities` asserts
`set_plan_field(path, "title", "x").is_err()`. That assertion is exactly what
this section changes, so it must be **rewritten to use a still-disallowed key**
(e.g. `owner`), not deleted — the disallowed-key coverage it protects has to
survive the change.

**Panel/editor double-write.** The panel writes to disk while the editor may hold
an unsaved buffer of the same file, which would trip sub-4's conflict banner —
technically correct but obnoxious, since both edits are the user's. So **a panel
commit flushes the editor first**, then writes the field. `FileEditor` exposes a
`flush()` for this.

The title field changes **frontmatter only, never the filename** — renaming is
out of scope (§Out of scope), and a title/filename divergence is normal and
harmless.

## 4. Open in split

A secondary action on file rows: switch the workspace to the terminal view and
call the existing `openFileInSplit` against the active page's focused session.
Hidden when that page has no terminal session to anchor to.

## 5. Testing

Pure modules carry the coverage (no component tests — vitest here cannot
preprocess `.svelte`):

- **`planExplorer.ts`** — `buildExplorerTree`: grouping, empty groups omitted,
  root-context-first ordering, nested `relPath` labels, absent/`rootMissing`
  tree; `slugFileName`: spaces/punctuation/casing, `.md` suffix, a title that
  slugifies to nothing; `isUnderRoot`: inside, equal, outside, segment-boundary
  (`/root2` is not under `/root`); `statusOptions(board, current)`: column names,
  unmatched current value appended, empty board.
- **`gavinState.ts`** — `patchPlanField`'s new `title` branch.
- **Rust (`gavin.rs`)** — `title` accepted (written surgically, other bytes
  preserved), empty/multiline title rejected, an arbitrary key still rejected
  (the rewritten pre-existing test).
- **Manual** (new Checklist section): tree shows contexts/groups/files with plan
  metadata; creating a plan/doc/spec/context selects the new file and the tree
  catches up within ~3 s; a plan created here appears on the board; changing
  status in the panel moves the card; changing title updates card and tree;
  editing the body then using the panel does **not** raise a conflict banner;
  deleting the selected file in a terminal shows the vanished-file state;
  open-in-split lands the file beside a terminal.

**Risks:** panel/editor double-write (mitigated above); tree rebuild churn on
every push (selection by path); a status typed into a file that matches no column
still lands in an auto column on the board, unchanged from D6.

## 6. What sub-6 consumes

The Mission Control home (D11) embeds this tree as its plan-explorer panel and
reuses `PlanMetadataPanel` beside the main agent session; both are built here as
standalone components precisely so that placement is the only thing sub-6 changes.
