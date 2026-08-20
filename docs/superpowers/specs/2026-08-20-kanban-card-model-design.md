# Kanban Card Model — Final Form — Design Spec

The board's real-world gavin integration: every card is a markdown file, and a
card can be a **note** (reminder), a **task** (a single agent prompt, runnable),
or a **plan** (multi-task, with checklists and promotable child tasks).
Decisions C1–C5 live in
`docs/superpowers/brainstorms/2026-08-20-kanban-card-model-brainstorm.md`.
Phase constraints still govern: files are truth (D2), column names are the
status vocabulary (D6), spawns are always visible (D19), repo writes are
consented (D20), agent profile seam (D4/D34). The pointer-drag engine and
board component structure are the Trello rework's (K1–K8).

**Goal:** one card ontology, fully file-backed and agent-operable — creation,
nesting, execution, and progress all flow through `.gavin*/plans/*.md` plus the
existing MCP tools, with SQLite reduced to columns, the label vocabulary, and
runtime session bindings.

**Out of scope (v1):** parent recursion (plans inside plans), cross-context
parents, changing a card's `kind` from the UI (hand-edit the file), any
auto-completion of statuses, migration tooling (C5: dev state — the daemon
drops the SQLite cards table outright), notes as run targets, board-level
swimlanes.

---

## 1. The card file (C1, C2)

One `.md` per card in a `.gavin*/plans/` folder. Flat `key: value` frontmatter
(the existing line-based parser), three new keys:

| Key | Values | Rules |
|---|---|---|
| `kind` | `note` \| `task` \| `plan` | **Absent = `plan`** — every existing plan file and `gavin_create_plan` call stays valid. Unknown value → `parse_warning`, treated as `plan`. |
| `parent` | a card's file name, e.g. `auth-rework.md` | Same context folder only; meaningful on `task` cards only (elsewhere → `parse_warning`, ignored). Missing/non-plan target degrades visibly (§2), never hides the card. |
| `labels` | comma-separated names, e.g. `bug, ui` | Slug-matched (same rule as columns) against the board's label vocabulary; unknown names render as plain chips with no color. |

Existing keys unchanged: `title`, `status` (the column ref — the user's
categorization lives in the file), `priority`, `order`.

**The nesting rule:** a card with `parent:` and **no `status:`** is *nested* —
it renders inside its parent plan card, in no column. Writing a `status:`
frees it into that column (the `parent:` link and chip persist). No status and
no parent → first column, as today.

**Body semantics:** note → free text (optional; title-only files are legal);
task → **the body is the agent prompt**; plan → description plus ordinary
markdown checklists. The daemon counts every `- [ ]` / `- [x]` body line
(regardless of indentation) into `checklist_done` / `checklist_total`.

**Parsing:** `PlanFileInfo` gains `kind`, `parent`, `labels: Vec<String>`,
`checklist_done`, `checklist_total` (camelCase over the wire, shape-tested).
`PROTOCOL_VERSION` bumps.

**Writer extensions** (`write_plan_field` / `set_plan_field`):

- Allow-list gains `kind` (validated vocabulary), `parent` (validated
  `[A-Za-z0-9._-]+\.md`), `labels` (single line, no newline).
- **Empty value removes the line** — permitted for `status`, `parent`, and
  `labels` (nesting, un-parenting, and clearing the last label need it);
  empty remains invalid for every other key.

**The wipe (C5):** the daemon drops the SQLite `cards` table (columns + labels
tables remain); `kanban.rs` card CRUD, `kanban.ts` card mutations
(`addCard`/`moveCard`/`updateCard`/`deleteCard`/session-link functions), the
SQLite card rendering path, and the free-form/plan two-block board split are
deleted. `moveCardsOutOfColumn` and the delete-column card prompt reduce to
column-only concerns (a column deletion never touches files — its plan cards
simply fall back to auto columns by status). The board's card surface is 100%
file-backed and single-block; `order:` covers all of it.

## 2. Nesting-aware board (C2)

**Projection** (`planBoard.ts`, pure): the card view gains `kind`, `parent`,
`labels`, `checklistDone/Total`, and plan views gain `nestedChildren:
CardView[]` — cards whose `parent` resolves to that plan and that have no
status, sorted by the usual `(order ?? ∞, folder, fileName)` key. Free-standing
children stay in their status columns wearing a **parent chip** (plan title,
click-through). A `parent` pointing nowhere (or at a non-plan) renders the
child free-standing with a broken-link chip — the auto-column philosophy
applied to nesting: nothing is ever invisible.

**Card anatomy** (one component, kind variants — replaces
`KanbanCard`/`PlanKanbanCard`):

- **note** — minimal: title, labels, priority dot.
- **task** — + status dot when a session is bound (§3), run affordance on
  hover, parent chip when applicable.
- **plan** — + progress (`3/7` from checklist ticks), chevron with child
  count; expanding reveals the **nested area**: slim child sub-cards, in
  order, draggable and clickable. Expansion is per-card, session-local UI
  state, default collapsed; auto-expands while a task drag hovers the card.

**Drag semantics** (extends the pointer engine; hit-testing stays pure):

- `computeDropTarget` gains a **nest target** for task drags: a plan card's
  interior maps to `{ nest: planPath }` (edge bands keep meaning
  before/after-in-column); an expanded plan's nested area maps to a position
  among its children. Placeholder renders inside the plan card accordingly.
- **Task dropped on a plan** → write `parent: <file>`, remove `status`
  (empty-value write) → nested.
- **Nested child dragged to a column** → write `status` (+ `order` per drop
  position) → free-standing; `parent` untouched.
- **Un-parent is a detail-view action only** (removes the `parent` line) —
  never a drag side-effect.
- Notes and plans cannot nest; a plan moving between columns restatuses only
  itself; all other Trello-rework behavior (placeholder, flip, auto-scroll,
  drop-hold while writes are in flight) applies unchanged to every kind.

Both surfaces (hub board, per-context `BoardPane`) share this via the existing
components; `BoardPane` additionally gains the composer (§5) pinned to its
context.

## 3. Executable cards (C3)

**Run** (tasks and plans; card hover + detail view). Spawn = the workspace's
`agentCommand` (D34) + a generated prompt, cwd = the card's context folder,
landing on the **Agents page** exactly like MCP spawns (attached first, no
focus steal, kill-if-unplaceable). On launch the app writes
`status: In Progress` (surgical; skipped when the card already sits in a
slug-matching column). The app **never auto-completes**.

Prompt templates (pure module, unit-tested):

- **task:** header naming the card file and title, then the body verbatim,
  then: *"While you work, keep this card's `status` current with
  `gavin_set_plan_field` on `<path>`; set it to the board's done column when
  finished."*
- **plan:** *"Read `<path>` and execute that plan. Work its checklist top to
  bottom: tick items (`- [x]`) as you complete them, promote items that need
  their own agent with `gavin_promote_task`, and keep the plan's `status`
  current with `gavin_set_plan_field`."*

**Bindings** — a daemon SQLite table replacing `session_link`:

```
card_sessions(workspace_id TEXT, path TEXT, session_id TEXT, cwd TEXT,
              command TEXT, PRIMARY KEY (workspace_id, path))
```

Runtime state only — never in files. Protocol: `LinkCardSession`,
`UnlinkCardSession`, and the `Board` reply gains `card_sessions` so one fetch
hydrates the board. The card shows the familiar status dot
(working/waiting/idle/exited via `sessionStatusById`); the detail view keeps
jump-to-session, re-launch (same cwd/command, updates the binding), unlink.
**One live session per card**: Run with a live binding jumps instead of
spawning.

**Checklist toggling:** the plan detail renders real checkboxes; a tick sends
a new validated daemon op — `SetChecklistItem { path, line_index,
expected_text, checked }` — which rewrites exactly that line and errors when
`expected_text` no longer matches (an agent edited the file meanwhile; the UI
refetches and retries by hand). Byte-preserving elsewhere, like
`write_plan_field`.

**MCP surface:**

- `gavin_create_plan` gains `kind?` (default `plan`) and `parent?` — agents
  create notes, tasks, and children through the one existing tool.
- **New `gavin_promote_task { plan_path, item }`** (`item` = the checklist
  line's text): creates the child task file in the plan's folder (slugged
  filename, `title` = item text, body = item text, `parent:` set, no status →
  nested), and rewrites **only that line** to
  `- [ ] [item](./<task-file>.md)` — readable, idempotent to re-parse, and the
  link marks promotion. Ambiguous/absent item text → tool error, no writes.
  The daemon op is `PromoteChecklistItem`; the board's promote button (§4)
  calls the same op.
- `gavin_get_board`'s description updates (columns + labels only);
  `SKILL.md` gains the kind vocabulary, the nesting rule, promotion, and the
  tick-when-done convention.

**Progress stays checkbox-only:** a plan's `3/7` counts ticks; promoted items
count when their box is ticked (the skill teaches agents to tick on task
completion). Child statuses appear as chips in the plan detail but never gate
the count — no "which column means done" inference.

## 4. Creation and detail surfaces (C4)

**Two-speed composer.** Fast path unchanged in feel: type, Enter → `kind:
note`, `status:` = that column's name, nearest/root context, slugged filename
(collision → `-2` suffix). Three kind chips (note · task · plan) expand the
composer in place: *task* adds a prompt textarea and a "Run now" checkbox
(create + immediately run); *plan* adds a body textarea; both reveal a context
picker (root context default; `BoardPane`'s composer pins its own context and
hides the picker). Creation goes through the daemon's `CreatePlan` (extended
with `kind`/`parent`; labels are added afterwards through the field writer);
the new card is patched into `gavinTrees` optimistically on success, as usual.

**One kind-aware detail modal** replaces `PlanDetailModal` and the SQLite
`CardDetailModal`: title (editable), status select (column names + current
raw status), priority, label chips (writes `labels:`), rendered body preview.
Tasks add the session block (Run / jump / re-launch / unlink) and the prompt
view. Plans add the interactive checklist with per-item **Promote** buttons,
the children list (status chips, click-through, **Un-parent**), and Run.
Every card keeps "Open in Plans tab" and "Open externally". The Plans tab's
metadata panel (D28) gains the same new fields (kind read-only, labels).

## 5. Verification

- **vitest (pure):** projection (kinds, nesting, orphan degradation, label
  slug-matching, checklist counts pass-through), nest-target hit-testing,
  slot building with nested areas, prompt composition, filename slugging.
- **cargo:** frontmatter parsing matrix (kind/parent/labels/checklists,
  degradation), empty-value-removes-line writer semantics, promote
  line-rewrite (exact bytes, ambiguity errors), `SetChecklistItem` validation,
  `card_sessions` CRUD + Board hydration, cards-table drop on startup,
  protocol roundtrips + version bump, MCP schema/dispatch for the new tool.
- **Manual:** new "Card kinds & nesting" smoke section (compose each kind,
  nest/free a child by drag, promote from detail and via a real agent, run a
  task and watch In Progress + the Agents page, tick a checklist item under
  concurrent agent edits).

## 6. Build order — one spec, three plans

1. **Card model core** — parsing + writer extensions, protocol bump, SQLite
   cards wipe, projection + kind rendering (incl. nested *display*), composer,
   unified detail modal (minus run/promote blocks).
2. **Nesting interaction** — nest drop targets and nested-area drag, promote
   (daemon op + MCP tool + detail buttons), checklist toggling, un-parent.
3. **Run & bindings** — `card_sessions` + protocol, prompt composition, Run
   affordances + Agents-page landing reuse, status dots/jump/re-launch,
   auto–In Progress, `SKILL.md` update.

Each plan lands independently shippable with all gates green.
