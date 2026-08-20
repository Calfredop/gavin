# Card Model Core Implementation Plan (1 of 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every card becomes a markdown file (`kind: note | task | plan`) with nesting *display*, a two-speed composer, and one kind-aware detail modal; the SQLite free-form card system is wiped.

**Architecture:** The daemon's frontmatter parser/writer grow kind/parent/labels/checklist support; `planBoard.ts` becomes the single card projection (`CardView` with `nestedChildren`); one `BoardCard.svelte` replaces `KanbanCard`/`PlanKanbanCard`; SQLite keeps columns + labels only. Protocol bumps to 3.

**Tech Stack:** Rust daemon (cargo), Svelte 5, TypeScript, vitest. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-20-kanban-card-model-design.md` §1, §2 (display only), §4 (minus run/promote), §6 plan 1. Decisions C1–C5.

## Global Constraints

- Zero new dependencies. Files are truth; `patchPlanField` only after a successful write. `npx svelte-check` stays at 0 errors and 0 kanban-file warnings. All new logic in pure `.ts`/Rust units (no Svelte component tests). Work on `main`, commit per task, no push.
- Trailer for every commit:

  ```
  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01V58rPGKNUn1ptEie618yHf
  ```

- Commands: `cargo test` (root), `cd app && npx vitest run`, `cd app && npx svelte-check`.
- Interfaces defined here are load-bearing for plans 2–3 — do not rename.

---

### Task 1: Protocol v3 — CardKind, extended PlanFileInfo, card wipe

**Files:**
- Modify: `crates/protocol/src/lib.rs`

**Interfaces (produces):**

```rust
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CardKind { Note, Task, Plan }

// PlanFileInfo gains (after `order`):
pub kind: CardKind,
pub parent: Option<String>,   // a card file name in the same context
pub labels: Vec<String>,
pub checklist_done: u32,
pub checklist_total: u32,
```

`Card`, `SessionLink`, and `Column.cards` are REMOVED (`Column { id, name, position }`); `SetBoard`/`BoardLoaded` shapes shrink accordingly. `PROTOCOL_VERSION` 2 → 3.

- [ ] **Step 1:** Add `CardKind` + the five `PlanFileInfo` fields; delete `Card`, `SessionLink`, and `Column.cards`. Bump `PROTOCOL_VERSION` to 3 and update its guard test (rationale comment: PlanFileInfo shape + card removal + new writer keys).
- [ ] **Step 2:** Fix every compile error the removal surfaces in the protocol crate (fixtures, roundtrip tests — delete card-bearing cases, extend the camelCase shape test with `"kind": "plan", "parent": null, "labels": [], "checklistDone": 0, "checklistTotal": 0`).
- [ ] **Step 3:** `cargo test -p protocol` → PASS (daemon/gavin-mcp still broken is expected; they compile again by Task 5).
- [ ] **Step 4:** Commit — `feat(protocol): card kinds + nesting fields; SQLite card types removed (v3)` + the trailer. (If the workspace doesn't compile crate-by-crate cleanly, fold this commit into Task 5's.)

---

### Task 2: Daemon parsing — kind, parent, labels, checklist counts

**Files:**
- Modify: `crates/daemon/src/gavin.rs` (`plan_file_info` ~line 84, tests)

**Interfaces (produces):** parsing rules per spec §1 — `kind` absent = `Plan`, unknown → `parse_warning` + `Plan`; `parent` only meaningful on `Task` (set on other kinds → `parse_warning`, field forced `None`); `labels: a, b` comma-split, trimmed, empties dropped; checklist counts from body lines matching `^\s*- \[( |x)\] ` (case-sensitive `x`).

- [ ] **Step 1: Failing tests** in the gavin.rs test module:

```rust
#[test]
fn plan_kind_parses_defaults_and_flags_garbage() {
    assert_eq!(plan("---\ntitle: A\n---\n").kind, CardKind::Plan);
    assert_eq!(plan("---\nkind: note\n---\n").kind, CardKind::Note);
    assert_eq!(plan("---\nkind: task\n---\n").kind, CardKind::Task);
    let bad = plan("---\nkind: epic\n---\n");
    assert_eq!(bad.kind, CardKind::Plan);
    assert!(bad.parse_warning);
}

#[test]
fn parent_only_lives_on_tasks() {
    let t = plan("---\nkind: task\nparent: auth.md\n---\n");
    assert_eq!(t.parent.as_deref(), Some("auth.md"));
    assert!(!t.parse_warning);
    let n = plan("---\nkind: note\nparent: auth.md\n---\n");
    assert_eq!(n.parent, None);
    assert!(n.parse_warning);
}

#[test]
fn labels_split_and_trim() {
    assert_eq!(plan("---\nlabels: bug,  ui , \n---\n").labels, vec!["bug", "ui"]);
    assert!(plan("---\ntitle: A\n---\n").labels.is_empty());
}

#[test]
fn checklist_counts_from_body() {
    let p = plan("---\nkind: plan\n---\n# P\n- [ ] one\n  - [x] nested\n- [x] two\nnot - [ ] a list\n");
    assert_eq!((p.checklist_done, p.checklist_total), (2, 3));
}
```

- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement in `plan_file_info` (kind parse with warning fallback, parent gating, label split, a `count_checklist(content_after_frontmatter)` helper — count only body lines, i.e. lines after the closing `---` when frontmatter is present). **Step 4:** `cargo test -p gavin-daemon gavin::` → PASS. **Step 5:** Commit — `feat(daemon): parse card kind/parent/labels/checklist counts` + the trailer.

---

### Task 3: Writer — new keys + empty-value-removes-line

**Files:**
- Modify: `crates/daemon/src/gavin.rs` (`write_plan_field`, `set_plan_field`, tests)

**Interfaces (produces):** allow-list gains `kind` (note|task|plan), `parent` (`[A-Za-z0-9._-]+\.md`), `labels` (single line). `set_plan_field(path, key, "")` **removes** the key's line for `status`/`parent`/`labels` (no-op if absent); empty stays an error for every other key.

- [ ] **Step 1: Failing tests:**

```rust
#[test]
fn empty_value_removes_the_line_for_status_parent_labels() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("p.md");
    std::fs::write(&path, "---\ntitle: T\nstatus: To Do\nparent: a.md\nlabels: x\n---\nbody\n").unwrap();
    set_plan_field(&path, "status", "").unwrap();
    set_plan_field(&path, "parent", "").unwrap();
    set_plan_field(&path, "labels", "").unwrap();
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "---\ntitle: T\n---\nbody\n");
    set_plan_field(&path, "status", "").unwrap(); // absent -> no-op, no error
    assert!(set_plan_field(&path, "title", "").is_err());
    assert!(set_plan_field(&path, "priority", "").is_err());
}

#[test]
fn kind_and_parent_values_are_validated() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("p.md");
    std::fs::write(&path, "---\ntitle: T\n---\n").unwrap();
    assert!(set_plan_field(&path, "kind", "epic").is_err());
    assert!(set_plan_field(&path, "parent", "../evil.md").is_err());
    assert!(set_plan_field(&path, "parent", "no-md").is_err());
    set_plan_field(&path, "kind", "task").unwrap();
    set_plan_field(&path, "parent", "plan-1.md").unwrap();
}
```

- [ ] **Step 2:** FAIL. **Step 3:** Implement — `write_plan_field` gains the remove branch (find line in block → remove; absent → leave file untouched, still Ok; preserve trailing-newline rule); `set_plan_field` validates per key and routes empties. **Step 4:** PASS + full `cargo test -p gavin-daemon`. **Step 5:** Commit — `feat(daemon): writer accepts kind/parent/labels; empty value removes removable keys` + the trailer.

---

### Task 4: CreatePlan gains kind/parent (daemon + protocol + MCP schema)

**Files:**
- Modify: `crates/protocol/src/lib.rs` (`Request::CreatePlan` gains `kind: Option<String>`, `parent: Option<String>`), `crates/daemon/src/gavin.rs` (`create_plan_file`), `crates/daemon/src/server.rs` (handler passthrough), `crates/gavin-mcp/src/main.rs` (schema + forward)

**Interfaces (produces):** `create_plan_file(context_folder, file_name, title, status, priority, body, kind, parent)`; frontmatter written in canonical order `kind` (omitted when plan), `title`, `status` (omitted when kind is task **and** parent is set — a nested child has no status; otherwise default "To Do"), `parent` (when set), `priority` (when set). Validation: kind vocabulary; parent filename rule; parent requires kind task.

- [ ] **Step 1: Failing tests** (canonical bytes):

```rust
#[test]
fn create_plan_file_writes_kind_and_parent() {
    // context scaffolded via init helper as in existing tests
    let p = create_plan_file(ctx, "child.md", "Child", None, None, None, Some("task"), Some("parent-plan.md")).unwrap();
    assert_eq!(std::fs::read_to_string(&p).unwrap(), "---\nkind: task\ntitle: Child\nparent: parent-plan.md\n---\n# Child\n");
    let n = create_plan_file(ctx, "note.md", "Note", Some("Done"), None, None, Some("note"), None).unwrap();
    assert!(std::fs::read_to_string(&n).unwrap().starts_with("---\nkind: note\ntitle: Note\nstatus: Done\n"));
    assert!(create_plan_file(ctx, "x.md", "X", None, None, None, Some("epic"), None).is_err());
    assert!(create_plan_file(ctx, "y.md", "Y", None, None, None, Some("note"), Some("p.md")).is_err()); // parent needs task
}
```

- [ ] **Step 2:** FAIL. **Step 3:** Implement + thread through `server.rs` and the MCP tool schema (`kind": { "enum": ["note","task","plan"] }`, `parent`; description mentions kinds). Existing callers (plan explorer Tauri command) pass `None, None`; `backend.createPlan` TS signature gains `kind?`, `parent?`. **Step 4:** `cargo test` all green. **Step 5:** Commit — `feat(daemon): create_plan_file kinds + parent; MCP create_plan schema` + the trailer.

---

### Task 5: The wipe — SQLite cards die

**Files:**
- Modify: `crates/daemon/src/kanban.rs`, `crates/daemon/src/server.rs`, `app/src-tauri/src/session.rs` (kanban command layer if it forwards cards), `crates/gavin-mcp/src/main.rs` (`gavin_get_board` description)

- [ ] **Step 1:** In `kanban.rs`: startup runs `DROP TABLE IF EXISTS kanban_card_labels; DROP TABLE IF EXISTS kanban_cards;` (comment: C5 dev wipe); delete card CRUD, `add_session_link_columns_if_missing`, and card (de)serialization; `replace_board`/`load_board` handle columns + labels only. Update every test that builds cards (delete card assertions, keep column/label coverage).
- [ ] **Step 2:** Chase compile errors through `server.rs` (SetBoard/GetBoard handlers) and the Tauri command layer; `gavin_get_board` description → "Get the board's columns (the status vocabulary) and label vocabulary." Check `seed_smoke_test_data` — it writes plan **files** only; if any SQLite-card seeding exists, delete it.
- [ ] **Step 3:** `cargo test` all green (protocol + daemon + mcp now compile together). **Step 4:** Commit — `feat(daemon): drop SQLite cards — the board is file-backed (C5)` + the trailer.

---

### Task 6: Frontend plumbing — types, stores, backend

**Files:**
- Modify: `app/src/lib/gavin.ts`, `app/src/lib/kanban.ts`, `app/src/lib/kanbanState.ts`, `app/src/lib/backend.ts`, `app/src/lib/gavinState.ts`
- Tests: `kanban.test.ts`, `kanbanState.test.ts`, `gavinState.test.ts` (+ every fixture the type change touches)

**Interfaces (produces):**

```typescript
// gavin.ts PlanFileInfo gains:
kind: "note" | "task" | "plan";
parent: string | null;
labels: string[];
checklistDone: number;
checklistTotal: number;
// kanban.ts: Card/SessionLink and Column.cards REMOVED; Column { id, name, position }.
// Surviving mutations: addColumn, renameColumn, reorderColumn, deleteColumn, label CRUD.
// kanbanState: card/session-link actions removed; columns/labels actions, saveErrors,
// refreshBoard, dismissSaveError survive unchanged.
// backend.ts: setPlanFrontmatterField key union += "kind" | "parent" | "labels";
// createPlan(contextFolder, fileName, title, status?, priority?, body?, kind?, parent?).
// gavinState.patchPlanField key union += "labels" (value = CSV string -> stored as split array)
// and "parent" (value "" -> null).
```

- [ ] **Step 1:** Failing tests first where behavior is new: `patchPlanField("labels", "bug, ui")` stores `["bug","ui"]`; `patchPlanField("parent", "")` stores null; `deleteColumn` (renamed from cascade) removes only the column. Then apply the type surgery and let `svelte-check` enumerate the fallout — fix fixtures mechanically (`kind: "plan", parent: null, labels: [], checklistDone: 0, checklistTotal: 0`).
- [ ] **Step 2:** Delete dead tests (card mutations, session links) — keep every column/label/saveError/refresh test. **Step 3:** `npx vitest run` green; svelte-check will still flag components (fixed in Tasks 7–10) — record the count, ensure it only shrinks from here. **Step 4:** Commit — `feat(app): file-card type plumbing; SQLite card layer removed` + the trailer.

---

### Task 7: Projection — CardView with nesting

**Files:**
- Modify: `app/src/lib/planBoard.ts` (+ test)

**Interfaces (produces):**

```typescript
export interface CardView {
  id: string;            // absolute path
  title: string;
  status: string | null;
  priority: PlanFileInfo["priority"];
  order: number | null;
  kind: "note" | "task" | "plan";
  parent: string | null;
  parentTitle: string | null;   // resolved parent's title (chip)
  parentBroken: boolean;        // parent set but unresolved/non-plan
  labels: string[];
  checklistDone: number;
  checklistTotal: number;
  contextName: string;
  contextFolder: string;        // NEW — composer/run/nesting need it
  fileName: string;
  parseWarning: boolean;
  nestedChildren: CardView[];   // plan kind only; [] otherwise
}
```

`PlanCardView` is renamed to `CardView` everywhere (mechanical; svelte-check enforces). Resolution rules (spec §2): a task with `parent` resolving to a **plan in the same context** and **no status** → into that plan's `nestedChildren` (order-key sorted), excluded from columns; with a status → column card with `parentTitle`; unresolved/self/non-plan parent → free-standing per status rules + `parentBroken`.

- [ ] **Step 1: Failing tests** (extend the existing builder with kind/parent/labels):

```typescript
it("children without status nest under their plan, sorted by order", ...);
it("children with status stay in columns wearing parentTitle", ...);
it("broken parents render free-standing with parentBroken", ...);
it("nested children never appear in any column or auto column", ...);
it("labels and checklist counts pass through", ...);
```

(Write each as a real assertion; e.g. plan `p.md` + tasks `a.md` order 2000/`b.md` order 1000 parented to it, expect `nestedChildren` = [b, a].)

- [ ] **Step 2:** FAIL → implement (two-pass merge: index plans by (contextFolder, fileName), then place tasks) → PASS. Full vitest green. **Step 3:** Commit — `feat(app): CardView projection with nested children` + the trailer.

---

### Task 8: One card component + single-block board

**Files:**
- Create: `app/src/lib/BoardCard.svelte`
- Delete: `app/src/lib/KanbanCard.svelte`, `app/src/lib/PlanKanbanCard.svelte`, `app/src/lib/DeleteColumnPrompt.svelte`, `app/src/lib/DeleteCardWithSessionPrompt.svelte`, `app/src/lib/CardDetailModal.svelte` (old SQLite one)
- Modify: `app/src/lib/KanbanColumn.svelte`, `app/src/lib/AutoKanbanColumn.svelte`, `app/src/lib/KanbanBoard.svelte`, `app/src/lib/BoardPane.svelte`, `app/src/lib/KanbanDragPreview.svelte`

**BoardCard** (props `{ card: CardView; onOpen: (path: string) => void; nested?: boolean }`): kind visuals — note: solid border, title + label chips + priority dot; task: dashed-light border, file glyph, parent chip (`parentTitle` / broken style), labels; plan: dashed border, progress `{checklistDone}/{checklistTotal}` (hidden when total 0), chevron + child count when `nestedChildren.length > 0`, and when expanded (local `$state`, default false) a `.nested-area` rendering `BoardCard` for each child with `nested` compact styling and its own `data-kb-plan` wrapper (children are real cards — clickable; drag *display* only in this plan, interaction arrives in plan 2). Keyboard: Enter/Space opens. Keep `user-select: none`, hover affordances, the ⚠ badge, and the session-dot slot ready but empty (plan 3 fills it).

- [ ] **Step 1:** Build BoardCard; replace both card components in `KanbanColumn` (delete `cardSlots`, the free-form block, `requestDeleteCard`, both prompt imports — column delete becomes direct `deleteColumnAction`) and `AutoKanbanColumn`; update `KanbanDragPreview` (one lookup path: merged CardViews incl. nested children; render BoardCard). Column count = `planCards.length` in both modes.
- [ ] **Step 2:** svelte-check → 0 errors, kanban warnings 0; vitest green. Manual dev pass: all three kinds render (hand-author a `kind: task` + `parent:` file to see nesting), drag/reorder/status writes still work on every kind, no free-form remnants anywhere.
- [ ] **Step 3:** Commit — `feat(app): BoardCard kind rendering + nested display; single-block columns` + the trailer.

---

### Task 9: Two-speed composer

**Files:**
- Modify: `app/src/lib/KanbanColumn.svelte`, `app/src/lib/KanbanBoard.svelte`, `app/src/lib/BoardPane.svelte`
- Create: `app/src/lib/cardCompose.ts` (+ test)

**cardCompose.ts** (pure, produces):

```typescript
export interface ComposeSpec {
  kind: "note" | "task" | "plan";
  title: string;
  body: string;          // prompt for task, body for plan, "" for note
  contextFolder: string;
  status: string;        // the column's name
}
// Returns the createPlan argument tuple or an error string (empty title,
// unusable slug). File name via planExplorer.slugFileName + a "-2" suffix
// probe list passed in (existing fileNames in that context).
export function buildCreatePlanArgs(spec: ComposeSpec, existingFileNames: string[]):
  | { fileName: string; title: string; status: string; body: string | undefined; kind: string }
  | { error: string };
```

- [ ] **Step 1: Failing tests:** slug + suffix collision (`demo.md` exists → `demo-2.md`), empty-title error, note gets no body, task body passes through. **Step 2:** implement → PASS.
- [ ] **Step 3:** Composer UI: the existing textarea keeps the fast path (Enter → note in that column). Add a chip row (`note · task · plan`, note preselected); picking task/plan expands in place: body/prompt textarea (Shift-Enter newlines, Enter commits), context select (options from `$gavinTrees[workspaceId].contexts` → `folderPath`/`name`, root context default; hidden in BoardPane which pins `contextFolder`). Commit calls `backend.createPlan(...)` then patches the tree optimistically via a new `patchPlanCreated(workspaceId, PlanFileInfo)` helper in gavinState (insert into the context's plans; the watcher push reconciles). Failure → the board's error strip.
- [ ] **Step 4:** svelte-check 0, vitest green, manual: each kind composes into the right context/column; collision suffixes; BoardPane composes into its own context. **Step 5:** Commit — `feat(app): two-speed composer creating file cards` + the trailer.

---

### Task 10: Unified detail modal

**Files:**
- Create: `app/src/lib/CardDetailModal.svelte` (new, kind-aware), `app/src/lib/planChecklist.ts` (+ test)
- Delete: `app/src/lib/PlanDetailModal.svelte`
- Modify: `app/src/lib/KanbanBoard.svelte`, `app/src/lib/BoardPane.svelte` (open path — one modal for every card)

**planChecklist.ts** (pure, produces — plan 2 reuses it for toggling):

```typescript
export interface ChecklistItem { lineIndex: number; text: string; checked: boolean; promotedFile: string | null }
export function parseChecklist(body: string): ChecklistItem[]
// `- [ ] [text](./file.md)` -> promotedFile "file.md"; lineIndex is the
// 0-based index within the FULL file content (frontmatter included), so
// writers can address the exact line.
export function stripFrontmatter(content: string): string
```

- [ ] **Step 1: Failing tests:** plain/checked/promoted/indented items, lineIndex against full content with and without frontmatter, stripFrontmatter edge cases (no frontmatter, unterminated). **Step 2:** implement → PASS.
- [ ] **Step 3:** Modal: loads content via `backend.readFileForViewer(card.id)`; header kind badge + context/fileName/path (+ ⚠); editable title (blur/Enter → `set_plan_field title` + patch); status select (column names + the raw current status when unmatched; change → status write + patch; a nested child shows "(nested in <parent>)" and selecting a status frees it); priority select (existing pattern); label chips from `$kanbanState` labels vocabulary (toggle → write `labels` CSV or `""` when none + patch); body preview rendered with marked+DOMPurify (the file-viewer pipeline's config); plans append a read-only checklist listing (checkbox glyphs + promoted-link names) and a children list (`nestedChildren` + free children of this plan with their status text). Footer: "Open in Plans tab" (existing hub-view switch + selection path used by the plan explorer), "Open externally", Close.
- [ ] **Step 4:** The Plans tab's metadata panel (D28 — the component the plan explorer renders above the editor) gains the same new fields: a read-only kind badge and the label chips (same write path). Locate it via `grep -rl "metadata" app/src/lib` / the sub-5 spec; reuse the modal's chip markup.
- [ ] **Step 5:** svelte-check 0, vitest green; manual: every field round-trips into the file (`cat` it), labels clear removes the line, unmatched status shows raw, the Plans tab shows kind + labels. **Step 6:** Commit — `feat(app): unified kind-aware card detail modal` + the trailer.

---

### Task 11: Checklist, docs, sweep

**Files:**
- Modify: `app/src/lib/smokeChecklist.ts` (+ its test), `test-fixtures/gavin-orchestration/README.md`, `docs/superpowers/brainstorms/2026-08-20-kanban-card-model-brainstorm.md`

- [ ] **Step 1:** New smoke section "Card kinds" (ids: `kind-compose-note/task/plan`, `kind-nested-display`, `kind-detail-roundtrip`, `kind-labels`, `kind-wipe` — "no free-form cards anywhere; old boards show columns only"). Update the seeder-dependent README items where wording references free-form cards (B7 becomes the note-composer step).
- [ ] **Step 2:** Full gates: `cargo test`, `npx vitest run`, `npx svelte-check` (0 errors, 0 kanban warnings), `npm run build`. Append execution notes to the brainstorm log; set the gavin plan card for plan 1 to Done.
- [ ] **Step 3:** Commit — `docs: card-model core checklist + execution log` + the trailer.
