# Plans ⇄ Kanban — Design Spec

Sub-project **2 of 6** of the agent-orchestration phase. Phase decisions live in
`docs/superpowers/brainstorms/2026-08-06-agent-orchestration-brainstorm.md`; this
sub-project is governed by **D2** (files are truth), **D6** (one merged board,
column ↔ status by name), **D7** (per-session boards), and its own **D14–D17**.
Foundations (sub-1, shipped) provides the projection source: live `GavinTree`
pushes with `PlanFileInfo { path, fileName, title, status, priority,
parseWarning }`, plus the tested surgical frontmatter writer.

**Goal:** plan files appear as cards on the workspace board (and on per-session
context boards), dragging a card writes the file's `status:` line, and agent edits
to plan files update the boards live.

**Out of scope:** creating/deleting plan files from the board (sub-5's explorer),
editing plan bodies (sub-4), any change to free-form card behavior, MCP (sub-3).

---

## 1. Projection and merge (D14: frontend, pure)

New module `app/src/lib/planBoard.ts` — no I/O, fully unit-tested.

**Slug rule:** `slugStatus(s)` = lowercase, trim, collapse every run of
non-alphanumeric characters to a single `-` (also trimming leading/trailing `-`).
`"In Progress"`, `in-progress`, `in_progress`, `" IN  PROGRESS "` are all equal.

**View types:**

```typescript
export interface PlanCardView {
  id: string;            // the plan file's absolute path — stable identity
  title: string;
  status: string | null;
  priority: PlanFileInfo["priority"];
  contextName: string;   // owning GavinContext.name
  fileName: string;
  parseWarning: boolean;
}
export interface DisplayColumn { column: Column; planCards: PlanCardView[] }
export interface AutoColumn { status: string; planCards: PlanCardView[] }
```

**`mergePlanCards(board, tree, filter?)`** → `{ columns: DisplayColumn[],
autoColumns: AutoColumn[] }`:

- Plans come from **all contexts** of the tree (root board), or from the single
  context whose `folderPath` equals `filter.contextFolder` (per-session board —
  which also **excludes free-form cards entirely**: its `DisplayColumn`s carry the
  real columns for structure, but only plan cards populate them).
- A plan joins the real column whose `slugStatus(name)` matches
  `slugStatus(plan.status)`. **No status → the first column** (a status whose slug
  is empty — e.g. `status: "—"` — is treated as no status). No matching column →
  grouped into an `AutoColumn` per distinct raw status string, appended after the
  real columns.
- Plan cards render **after** a column's free-form cards, sorted by
  (`contextFolder`, `fileName`) — stable across pushes.
- `tree` absent or `root_missing` → zero plan cards, no auto columns; free-form
  cards are never affected.

**`nearestContext(tree, cwd)`** (same module): the context with the **longest**
`folderPath` that is an ancestor of or equal to `cwd` (path-segment-aware — 
`/a/auth2` is not under `/a/auth`), or `null`. The root context participates.

**Rendering.** `KanbanColumn` gains `planCards: PlanCardView[]` +
`onOpenPlanCard(path)` props and renders them after its cards via a new small
`PlanKanbanCard.svelte` (file glyph, context badge, priority chip, ⚠ when
`parseWarning`, **no delete button**, not a `Card`). Auto columns are rendered by
`KanbanBoard` as simplified read-only column shells (raw status as header, no
rename/delete/add affordances) sharing `PlanKanbanCard`. Plan cards are draggable
with a **new drag kind** `{ kind: "plan-card", path }` in `dragDrop.ts`'s payload
union; existing `kanban-card` handling is untouched, and column drop handlers
accept both kinds (a `plan-card` drop triggers write-back instead of
`moveCardAction`; drop **position** within a column is ignored — plan ordering is
deterministic, not manual).

## 2. Write-back

**Protocol:** `Request::SetPlanFrontmatterField { path, key, value }` → `Ok` /
`Error`. The daemon validates `key` against the allow-list `["status",
"priority"]` (this must never become an arbitrary line writer), and when
`key == "priority"` validates `value` against the priority vocabulary
(case-insensitive `none|low|medium|high|urgent`); `status` values are free text.

**Daemon:** the shipped `write_plan_status` **generalizes in place** to
`write_plan_field(path, key, value)` — identical three-case surgical semantics
(replace the existing `key:` line; insert as the block's first line when the block
lacks it; prepend a new block when the file has none), byte-preservation guarantee
intact, existing tests updated, new priority + rejection tests added. No wrapper
kept (nothing calls `write_plan_status` yet). The daemon **re-reads the file at
write time**, so a concurrent agent edit means last-write-wins on that one line
with every other byte preserved — accepted semantics.

**Tauri/frontend:** command + wrapper `setPlanFrontmatterField(path, key, value)`.

**Latency bridge.** The confirming `GavinTreeChanged` push arrives only after the
watcher's 500 ms debounce + 2 s floor. Every successful write is therefore
followed by an **optimistic local patch**: `patchPlanField(workspaceId, path, key,
value)` in `gavinState.ts` updates the plan inside `gavinTrees` immediately; the
eventual push carries the same tree and re-renders as a no-op. On write failure
nothing is patched — the card stays put and the error strip (§4) names the file.

**Drop semantics:** real column → `value = column.name` (verbatim); auto column →
`value =` that column's raw status text.

## 3. Per-session boards (D7 + D17)

**Affordance.** A kanban-glyph button (lucide, matching `HUB_VIEWS`' icon set) at
the right end of a pane's tab bar, rendered only when the active tab is a
terminal session whose `nearestContext(gavinTrees[wsId], cwdBySessionId[id])` is
non-null; tooltip `Open board · {contextName}`. Click →
`openBoardInSplit(anchorSessionId, workspaceId, contextFolder)`.

**Board tabs** mirror file tabs field-for-field:

- TS: `boardTabsById: Record<string, BoardTab>` in `LayoutState`, with
  `interface BoardTab { workspaceId: string; contextFolder: string }`.
- Rust: `AppConfig.board_tabs: HashMap<String, BoardTabRecord>` with
  `#[serde(default)]`, `BoardTabRecord { workspace_id, context_folder }`
  (`rename_all = "camelCase"` — it crosses to the frontend). Commands
  `get_board_tabs` / `set_board_tabs`; `persist_workspaces` gains the fifth
  always-carried param (every call site updated); a `BoardTabs` managed state.
- Bootstrap hydrates `boardTabsById`, and **both** `resolve_workspaces` and the
  Attach loop skip the **union** of file-tab and board-tab ids.
- `openBoardInSplit` mirrors `openFileInSplit` exactly (fresh tab id, split
  beside anchor, persist via `set_board_tabs`).
- Close paths: a board tab is pruned from the map and persisted — no
  `killSession`, no unwatch (tree watching is workspace-level). Close-confirmation
  counting (`confirmClose.ts`) excludes board-tab ids exactly as file-tab ids;
  `endTabs` and the prune helper generalize to both maps.

**Pinning.** A board tab is bound to the context captured at open time — the icon
follows the live cwd, the opened tab does not. If that context leaves the tree
(folder deleted, root unbound), `BoardPane` shows an empty state naming the
missing context; the tab closes normally.

**`BoardPane.svelte`** (third `Pane.svelte` dispatch branch, keyed by
`boardTabsById`; no-op `fit()`; label `{contextName} · board` with
folder-basename fallback, not renameable): calls the existing idempotent
`fetchBoard(workspaceId)` on mount, renders
`mergePlanCards(board, tree, { contextFolder })` — real columns for structure,
plan cards only, that context's auto columns, no column management, no add-card.
Drag and card-click behave identically to the root board. A board-fetch failure
shows the same error-with-retry state `KanbanBoard` uses.

## 4. Detail modal and errors

**`PlanDetailModal.svelte`** (opened by plan-card click on either board): title,
context name + file name, selectable full path, status (read-only — drag is the
status mechanism), **priority select** as the single write control (D15 — same
request + optimistic patch), a plain-language note when `parseWarning` is set
("this plan's frontmatter has issues; status or priority may not be readable"),
an **Open externally** button (existing opener wiring), Modal.svelte conventions.

**Errors:** a failed `SetPlanFrontmatterField` shows a dismissible strip above
the board — `Couldn't update {fileName}: {message}` — distinct from the existing
full-board fetch-error overlay, cleared on dismiss or on the next successful
write. Board-fetch errors, `root_missing`, and absent trees behave as today /
as §1.

## 5. Testing

Conventions unchanged (pure-logic Vitest with mocked backend; tempdir Rust unit
tests; socket-level integration; **no Svelte component tests** — components are
covered by the manual smoke list).

- **planBoard.ts:** slug rule table; merge — status matching, missing status →
  first column, auto-column grouping, plan-after-free-form ordering and
  (context, fileName) sort, context filter excluding free-form cards, absent/
  `root_missing` tree; `nearestContext` — equal, ancestor, deepest-wins,
  segment-boundary (`/a/auth2` vs `/a/auth`), root context, none.
- **gavinState.ts:** `patchPlanField` updates the right plan and leaves the rest
  of the tree identical.
- **Daemon:** `write_plan_field` — status replace/insert/prepend (updated
  existing tests), priority replace/insert, byte preservation, allow-list
  rejection, invalid-priority rejection; socket-level `SetPlanFrontmatterField`
  happy path + error reply.
- **Config:** `board_tabs` roundtrip + absent-field default + camelCase shape.
- **layoutState:** `openBoardInSplit` (mirrors the `openFileInSplit` tests),
  board-tab pruning through `endTabs`, `confirmClose` exclusion counting for
  mixed session/file/board tabs.
- **Manual GUI smoke:** plan cards materialize from this repo's own
  `.gavin-root/plans/`; drag a card → `git diff` shows only the `status:` line
  changed; `echo` an agent-style status edit in a terminal → board updates within
  ~3 s; parse-warning card renders ⚠ and explains in the modal; priority change
  from the modal → file diff; a plan with an unmatched status renders an auto
  column, and dragging it into a real column re-statuses the file and dissolves
  the auto column; pane icon appears only inside a context, opens the board tab,
  which survives an app restart; deleting the context folder turns the tab into
  the missing-context state.

## 6. What later sub-projects consume

- **Sub-3 (MCP):** `SetPlanFrontmatterField` as a ready-made tool implementation;
  the slug rule as the documented status vocabulary contract for the skill.
- **Sub-5 (explorer):** `PlanDetailModal`'s "open in editor" upgrade path;
  `planBoard.ts` view types for plan listings.
- **Sub-6 (home):** the mini-board tile reuses `mergePlanCards` output counts.
