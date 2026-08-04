# Terminal Core — Workspace Tabs & Kanban Board — Design Spec

## Context

Roadmap item 2 ("Kanban board — task/card board with persistence") is the
next sub-project after terminal-core's own A–F milestones, all now shipped.
The original terminal-core spec explicitly scoped kanban out entirely
("Kanban board UI or persistence" was a non-goal), and the roadmap has
always treated it as its own future spec.

Today, a workspace has no "view" concept at all: `+page.svelte` shows the
sidebar plus, directly, the active page's pane-tree (`LayoutTree`) — there
is no tab bar, toolbar, or any other content the main area can show. The
user's framing for this milestone — "selecting the workspace item in the
sidebar should open a tabbed view with the workspace features, like the
kanban board" — asks for a new navigation layer, not just a board bolted
onto the existing screen. Kanban is the first concrete tab; the user has
several more in mind for later (Notes, a pinned PRD document, a kanban
archive, Settings), which is why the tab mechanism itself is designed to
be genuinely extensible rather than a two-way `if` hardcoding Terminal vs.
Kanban.

This spec covers two things together, since a tab framework with nothing
but the pre-existing Terminal view has no user-visible value on its own:

1. A **workspace-level tab framework** (a small view registry + tab bar).
2. The **Kanban board** itself, as the framework's first new tab.

Notes, PRD, Archive, and Settings are explicitly out of scope — each is
its own future spec, added to the registry later without touching Terminal
or Kanban's code.

## Goals

- Selecting a workspace shows a tab bar with (today) two tabs: Terminal
  and Kanban. Terminal is the existing pane-tree content-area experience,
  unchanged, just relocated under a tab — the sidebar's page list itself
  doesn't move or change.
- The sidebar's page list stays visible and functional regardless of
  which tab is active. Clicking a page switches the active tab back to
  Terminal (if needed) and makes that page active — pages remain a
  Terminal-specific concept, not a peer of Kanban.
- One kanban board per workspace. Custom columns (add/rename/reorder/
  delete), seeded with To Do / In Progress / Done on creation. Cards have
  a title, a free-text/markdown description, a priority
  (None/Low/Medium/High/Urgent), and reusable board-level labels
  (name + color, applied by reference).
- Cards and columns are dragged via native HTML5 drag-and-drop, matching
  the pattern `Sidebar.svelte` already uses for reordering workspaces and
  pages — no new dependency.
- Kanban board data is durable, daemon-owned state (a new SQLite table),
  consistent with how sessions and git status already work — not more
  fields in the GUI-only local config file.
- A Kanban-tab failure (fetch or save) is isolated to that tab. It must
  never trigger the app-wide `daemon-error` path that blanks the entire
  window — the same failure-isolation principle the restored-session-UX
  milestone existed to establish for Attach failures.

## Non-goals

- Notes, a pinned PRD tab, a kanban archive tab, and Settings — each is
  its own future spec that adds an entry to the view registry.
- Linking cards to terminal sessions (launching/switching sessions from a
  card) — this is the separately-planned "Integration layer" roadmap item.
  Cards are plain data in this milestone, with no session association.
- Multi-board workspaces, board sharing/collaboration, or any
  conflict-resolution beyond last-write-wins — this is a single-user,
  single-frontend, single-daemon app; there is exactly one writer.
- Due dates or assignees on cards — no one to assign to, nothing enforcing
  dates, in a single-user local app.
- Real-time collaborative editing, undo/redo history, or board templates.

## Architecture

### 1. The workspace-view registry (frontend)

A small, static registry drives the tab bar:

```ts
interface WorkspaceView {
  id: string;             // "terminal" | "kanban" | ...
  label: string;
  icon: ComponentType;
  component: ComponentType;
}
```

Two entries ship now: `terminal` (wraps the existing content-area
`LayoutTree` rendering, unchanged — the registry only governs the content
area, not the sidebar) and `kanban` (the new board). Adding a
future tab means adding one registry entry and its own component — no
change to Terminal's or Kanban's own code, which is the whole point of
building a registry instead of a two-armed `if`.

`Workspace` (in `app/src/lib/workspace.ts`) gains one new field:
`activeView: string` (defaults to `"terminal"`), persisted the same way
`activePageId` already is — same local config file, same mechanism, no
new persistence path for this piece. This is lightweight UI state, not
kanban's actual data.

`+page.svelte`'s content area changes from directly rendering
`LayoutTree` to rendering a tab bar plus whichever view's component is
active for `activeWorkspace.activeView`. Clicking a page row in the
sidebar sets `activeView` back to `"terminal"` (if it wasn't already)
in addition to its existing behavior of setting the active page.

### 2. Kanban data model & protocol (shared types)

New types in `crates/protocol`, alongside the existing `SessionSummary`/
`GitStatus`:

```rust
pub struct Board { pub columns: Vec<Column>, pub labels: Vec<Label> }
pub struct Column { pub id: String, pub name: String, pub position: i64, pub cards: Vec<Card> }
pub struct Card {
    pub id: String,
    pub title: String,
    pub description: String,
    pub label_ids: Vec<String>,
    pub priority: Priority,
    pub position: i64,
}
pub struct Label { pub id: String, pub name: String, pub color: String }
pub enum Priority { None, Low, Medium, High, Urgent }
```

Two new `Request`/`Response` variants, following the exact pattern
`set_layout`/`set_workspaces_state` already established — the frontend
orchestrates persistence, mutating its own local state for instant
feedback and then persisting the whole tree, rather than the protocol
carrying fine-grained CRUD-per-field commands:

- `Request::GetBoard { workspace_id }` → `Response::Board { columns,
  labels }`. If no board row exists yet for that `workspace_id`, the
  daemon creates and persists the default three-column seed before
  responding — so this call is always idempotent and its response is
  always well-formed, with no separate "create a board" step anywhere.
- `Request::SetBoard { workspace_id, columns, labels }` → `Response::Ok`.
  Called once after every local mutation (add/edit/move/delete a card,
  add/rename/reorder/delete a column, add/edit/delete a label).

Both travel over the existing `CommandConnection` (the same one-shot
request/response channel `create_session`/`kill_session`/
`get_workspaces_state` already use) — no new connection.

### 3. Daemon-side storage

A new `crates/daemon/src/kanban.rs`, structured like `registry.rs`: a
`KanbanStore` wrapping a `rusqlite::Connection`, with four tables:

- `kanban_columns(id, workspace_id, name, position)`
- `kanban_cards(id, column_id, title, description, priority, position)`
- `kanban_labels(id, workspace_id, name, color)`
- `kanban_card_labels(card_id, label_id)` — join table for the
  many-to-many card↔label relationship

`SessionManager` (or a new sibling struct constructed alongside it in
`server.rs`) owns a `KanbanStore` the same way it owns `Registry` today.
The `Request::GetBoard`/`SetBoard` dispatch arms in `server.rs` call
straight into it — no PTY/session involvement at all, this is pure CRUD
against SQLite, unlike everything else `server.rs` currently handles.

Deleting a workspace cascade-deletes its `kanban_*` rows (all four
tables, scoped by `workspace_id` — cards cascade via their owning
column's `workspace_id`), so no orphaned kanban data survives a deleted
workspace. This mirrors how a killed session's registry row is removed
rather than left behind.

### 4. Frontend state & components

A new `app/src/lib/kanbanState.ts`, mirroring `layoutState.ts`'s shape: a
Svelte store holding fetched boards keyed by workspace id (`Record<string,
Board>`), populated lazily — a workspace's board is fetched via `GetBoard`
the first time its Kanban tab is opened, not upfront for every workspace
at bootstrap. Actions (add/move/delete card; add/rename/reorder/delete
column; add/edit/delete label) mutate the local store immediately, then
call `SetBoard` once to persist — identical shape to how pane-tree edits
already flow through `layoutState.ts` to `set_layout`.

New components: `KanbanBoard.svelte` (top-level, triggers the lazy
fetch, renders columns), `KanbanColumn.svelte` (renders its cards, is a
drop target for both card-moves and column-reordering), `KanbanCard.svelte`
(title, priority marker, label chips; click opens the detail modal),
`CardDetailModal.svelte` (title/description/priority/labels editor).

Drag-and-drop for both cards and columns reuses the native HTML5
`dragstart`/`dragover`/`drop` pattern already implemented in
`Sidebar.svelte` for workspace/page reordering — no new dependency.

`CardDetailModal` is this codebase's first custom in-app modal (existing
dialogs are all native OS confirms via `@tauri-apps/plugin-dialog`) — new,
small, self-contained overlay infrastructure. The delete-non-empty-column
prompt (below) reuses this same modal machinery rather than the native
`confirm()`.

### 5. Edge cases

- **Deleting a non-empty column** prompts the user to choose: delete its
  cards, or move them to another column (picked from the remaining
  columns). This needs a real choice, not a yes/no — hence the custom
  modal rather than `confirm()`.
- **Deleting a label still applied to cards** silently strips it from
  every card's `label_ids` on the next `SetBoard` — no dangling
  references, no confirmation prompt (lower stakes than losing cards).
- **`GetBoard`/`SetBoard` failure** (daemon hiccup, IPC error) shows an
  inline error within the Kanban tab itself (e.g. "couldn't load board,
  retry") and must never reach the app-wide `daemon-error` handling that
  blanks the whole window — the same failure-isolation principle the
  restored-session-UX milestone (`docs/superpowers/specs/2026-08-03-terminal-core-restored-session-design.md`)
  established for a failed `Attach`.
- **Concurrent writes** are not a real concern: one frontend, one daemon,
  one writer. `SetBoard`'s whole-tree replace is safe as-is, matching
  `set_layout`'s existing model.

## Testing

- **Protocol**: roundtrip tests for `Board`/`Column`/`Card`/`Label`/
  `Priority`, plus a shape-assertion test confirming the exact serialized
  JSON matches what the frontend expects (not just a roundtrip — the
  lesson from git-status's own protocol work, where a roundtrip alone had
  missed a real casing gap once already).
- **Daemon** (`crates/daemon/src/kanban.rs`): SQLite CRUD tests (insert/
  read, seed-default-on-first-`GetBoard`, cascade-delete on workspace
  removal), plus `GetBoard`/`SetBoard` request-wiring tests in
  `server.rs`.
- **App/Tauri**: relay-command tests using the existing
  `fake_daemon_replying_with`/`fake_daemon_capturing_requests` test
  helpers (`app/src-tauri/src/session.rs`'s `test_support` module).
- **Frontend** (`kanbanState.ts`): pure mutation-logic tests — add/move/
  delete card, column CRUD including the delete-with-cards prompt flow,
  label CRUD including cascade-strip from cards — mirroring `layout.ts`'s
  existing pure-tree-logic-with-vitest precedent.
- **Not automated**, matching this project's consistent limitation across
  every prior milestone: actual drag-and-drop interaction, modal
  rendering, and tab-switching visual behavior all need a manual GUI
  smoke test rather than an automated one.
