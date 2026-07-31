# Terminal Core — Workspaces — Design Spec

Date: 2026-07-31
Status: Approved

## Context

This is the next milestone after Milestone C (split panes, shipped). The
original terminal-core concept ("organize sessions into folder-like
workspaces, split panes...") deliberately deferred the "workspaces" part out
of Milestone C so it could stay split-panes-only. This spec covers that
deferred scope, expanded with a new organizational layer the user asked for
mid-brainstorm: **pages**.

Today the app has exactly one implicit workspace: the whole app is one split-
pane tree (`LayoutNode`), one `config.json`, one daemon. This spec introduces
a persistent **left sidebar** listing multiple **workspaces**, each of which
holds one or more **pages** — a page is exactly what the app renders today
(a whole split-pane tree of panes and tabs). Nothing about the daemon's
session model changes; workspaces and pages are a purely frontend/app-side
organizational layer on top of the existing per-session daemon protocol,
the same way Milestone C's split panes needed zero daemon changes.

## Goals

- A persistent left sidebar listing workspaces, each expandable to show its
  pages nested underneath (file-explorer-style tree).
- A workspace is an arbitrary named grouping — no required directory
  binding (unlike the original terminal-core spec's sketch). Directory
  binding / per-workspace git status remains future scope (Milestone D+).
- A page is a full split-pane tree, identical in every respect to what the
  app renders today under `LayoutTree.svelte` — multiple panes, each with
  its own tab bar.
- Create / rename (double-click, matching the existing tab-rename pattern)
  / switch / close for both workspaces and pages.
- Closing a page or workspace kills every session inside it, with a confirm
  prompt naming the total session count — same escalation pattern as
  today's "Close Pane."
- The toolbar's 3 layout presets (Single / Side by Side / 2×2 Grid) stop
  replacing the current page's layout and instead **create a new page** in
  the active workspace — the one, unified way to add a page.
- Full drag-and-drop: reorder workspaces; reorder pages within a workspace,
  or move a page to a different workspace; move a whole pane or a single
  tab between pages (including across workspaces); reorder tabs within a
  pane, or move a tab directly onto a different pane within the same
  visible page.

## Non-goals (this spec)

- Auto-migrating the current live session tree into the new structure. On
  first launch after this ships, the app starts with **zero workspaces** —
  today's sessions stay running in the daemon but become unreachable from
  the UI (accepted data loss from the app's perspective; the underlying
  processes are untouched, and this is a single-developer install).
- Directory-binding a workspace to a path, or any git-status surfacing.
  Workspaces are pure named groupings for now.
- Keyboard shortcuts for switching workspaces/pages (mouse/sidebar only,
  can follow later — the existing `Cmd+D`/`Cmd+Shift+D`/`Cmd+T`/`Cmd+W`
  shortcuts keep their current meaning, scoped to whichever page is active).
- Sidebar collapse/resize — fixed width for v1.
- Placing a dropped pane/tab at a precise position within an existing
  nested split (deeper than "append a new top-level split in one of 4
  directions"). See the Drag-and-drop section.

## Data model

`app/src-tauri/src/config.rs`:

```rust
pub struct Page {
    pub id: String,
    pub name: String,
    pub layout: LayoutNode,
    /// The leaf (pane) last focused while this page was active. Needed so
    /// "add as tab" drag-drops have a well-defined target pane even when
    /// this page isn't the one currently rendered. Kept in sync with the
    /// live focus while this page IS active; simply retained otherwise.
    pub focused_session_id: Option<String>,
}

pub struct Workspace {
    pub id: String,
    pub name: String,
    pub pages: Vec<Page>,
    pub active_page_id: Option<String>,
}

pub struct AppConfig {
    pub workspaces: Vec<Workspace>,
    pub active_workspace_id: Option<String>,
    pub session_names: HashMap<String, String>,  // unchanged, still flat
}
```

This replaces the current top-level `layout: Option<LayoutNode>` field
entirely — a breaking config-format change, acceptable given the "start
empty" decision above. `AppConfig` doesn't use `deny_unknown_fields`, so an
old config file's now-unrecognized `layout` key is silently dropped by
serde (same precedent as Milestone C's own migration off the Milestone-B
config shape), and the new `workspaces`/`active_workspace_id` fields
default to `[]`/`None` via `#[serde(default)]`, same pattern already used
for `session_names`.
`session_names` stays flat and unscoped, since session ids are already
globally unique across the whole daemon regardless of which page/workspace
they're grouped under.

Workspace/page `id`s are generated frontend-side via `crypto.randomUUID()`
— pure client-config concepts, unlike session ids (which the daemon
generates via the `uuid` crate, unchanged).

## Backend architecture (Rust)

The existing per-tree reconciliation logic (`resolve_sessions` in
`session.rs`) already operates on one `LayoutNode` at a time and needs zero
internal changes — it's called once per page instead of once globally.

**Tauri-managed state:** `CurrentLayout(Mutex<LayoutNode>)` becomes
`WorkspacesState(Mutex<WorkspacesData>)`, where
`WorkspacesData { workspaces: Vec<Workspace>, active_workspace_id: Option<String> }`
mirrors `AppConfig` minus `session_names` (which keeps its own existing,
separately-managed `SessionNames` state).

**Commands:**
- `get_workspaces_state() -> WorkspacesData` replaces `get_current_layout`.
- `set_workspaces_state(workspaces, active_workspace_id) -> Result<(), String>`
  replaces `set_layout` — still read-modify-writes `session_names`
  alongside it before saving, same clobber-avoidance rule already
  established for `set_layout`/`set_session_name`.
- `get_session_names` / `set_session_name` / `create_session` /
  `kill_session` / `write_input` / `resize_session` are untouched — all
  per-session, not layout-aware.

**`bootstrap()` changes:**
1. Load config. If `config.workspaces` is empty, there's nothing to
   resolve or Attach — no auto-created default session. The current
   `resolve_layout`'s `None → create one fresh session` fallback is
   removed; there's no longer an implicit "must have exactly one tree"
   invariant.
2. Otherwise, call `ListSessions` **once** (hoisted out of `resolve_layout`
   into a `list_valid_session_ids()` helper, rather than once per page) to
   get the daemon's live-session set.
3. Walk every page of every workspace, calling the existing
   `resolve_sessions(&mut page.layout, &command_conn, &valid_ids)`
   unchanged, replacing any stale ids in place.
4. Save the reconciled config back (as today).
5. Flatten all session ids across every page of every workspace and send
   `Attach` for each.
6. Manage `WorkspacesState`, emit a new `workspaces-ready` event
   (replacing `layout-ready`) carrying the resolved `WorkspacesData`.

No Rust commands exist for workspace/page create/rename/close/reorder —
those are all pure frontend state mutations (next section), persisted
through the same `set_workspaces_state` call. This mirrors how the
existing frontend already "orchestrates persistence" for tree mutations
(the resolved open question from Milestone C Part 1) rather than pushing
that logic into Rust.

## Frontend architecture

**New pure module `workspace.ts`** (same style as `layout.ts` — no
framework dependency, fully unit-testable): operates on a
`WorkspacesData`-shaped value.
- `createWorkspace(state, name)`, `renameWorkspace(state, id, name)`,
  `closeWorkspace(state, id)` (returns the updated state plus every
  session id that needs killing), `switchWorkspace(state, id)`.
- `createPage(state, workspaceId, name, layout)`, `renamePage`,
  `closePage` (same "returns killed session ids" shape as
  `closeWorkspace`), `switchPage`.
- `reorderWorkspace(state, workspaceId, targetIndex)` — array splice.
- `movePage(state, pageId, targetWorkspaceId, targetIndex)` — handles both
  same-workspace reorder and cross-workspace move as one function (they
  differ only in whether source and target workspace ids match);
  reassigns the source workspace's `active_page_id` to a sibling (or null)
  if the moved page was active there, same rule as `closePage`.

**`layout.ts` gains 5 new pure functions** (same file, same exhaustive
testing style as its existing 27 tests):
- `detachLeaf(tree, anchorSessionId)` — locates the leaf via the existing
  `findLeafPath`, removes it from the tree, returns both the resulting
  tree (possibly `null`) and the detached leaf intact.
- `detachTab(tree, sessionId)` — removes one tab from its leaf (collapsing
  the leaf if it was the last tab, exactly like the existing `closeTab`),
  returns a new one-tab leaf `{type: "leaf", tabs: [sessionId], activeTabIndex: 0}`
  as the detached piece.
- `graftLeaf(targetTree, incoming, mode)` — `mode` is
  `"left" | "right" | "top" | "bottom"`. If `targetTree` is `null` (empty
  page), the incoming leaf becomes the whole tree. Otherwise wraps the
  existing tree and the incoming leaf into a new top-level split
  (`left`/`right` → `row`, `top`/`bottom` → `column`; `left`/`top` place
  the incoming leaf first in the children array, `right`/`bottom` place it
  last, so it visually lands on the side it was dropped on).
- `mergeIntoActivePane(targetTree, targetFocusedSessionId, incoming)` —
  locates the target's focused leaf via `findLeafPath` (falling back to
  the tree's first leaf if nothing was ever focused there), appends all of
  `incoming`'s tabs onto that leaf's `tabs`, mirroring `addTab`'s existing
  "new tab becomes active" behavior.
- `moveTabWithinLeaf(tree, sessionId, targetIndex)` — reorders a tab
  within its own leaf's `tabs` array; `activeTabIndex` is adjusted to keep
  pointing at the same session after the move.

**`layoutState.ts` restructuring:** `tree: LayoutNode | null` is replaced
by `workspaces: Workspace[]` + `activeWorkspaceId: string | null`. Small
derived selectors (`activeWorkspace()`, `activePage()`, `activeTree()`)
replace direct reads of `state.tree` everywhere. Every existing
tree-mutating action (`splitPane`, `addTab`, `closeSession`, `switchToTab`,
`previewResizePane`, `commitLayout`, `handleSessionExited`, `closePane`)
keeps its internal logic unchanged — it reads the active page's
`LayoutNode`, applies the same pure function, writes the result back into
that page's slot, and persists via `backend.setWorkspacesState(...)`
instead of `backend.setLayout(...)`. Today's `applyPreset` is retired in
favor of a new `createPage(workspaceId, buildTree, sessionCount)` action
with the same mechanics (create N fresh daemon sessions, build the tree via
the existing `presetSingle`/`presetSideBySide`/`presetGrid2x2` generators)
but it appends a new page instead of replacing the current one.

**New `Sidebar.svelte`:** renders `workspaces` as a nested list — each
workspace row (expand/collapse chevron, name with double-click-to-rename,
a "+" that adds a page via the "Single" preset as a fast path, a close
button with a confirm naming the total session count); each page nested
underneath (name, double-click-to-rename, click-to-switch, close button
with its own confirm+count). Reuses `Tooltip.svelte`, the lucide icon set,
and `confirmClose.ts`'s pattern (`confirmPageClose`/`confirmWorkspaceClose`
added alongside the existing `confirmTabClose`/`confirmPaneClose`).

**`+page.svelte`:** `.app` becomes a row: `<Sidebar />` beside the existing
content area, which now reads `activeTree()` instead of `$layoutState.tree`.
Empty states get one more level: no workspaces → "create a workspace"
prompt; a workspace with no pages → "add a page" prompt (the 3 preset
buttons). `Sidebar` only renders once `status === "ready"` (same gating as
the main content area) — `TitleBar` remains the sole exception rendering
unconditionally, per the existing rule from the custom-chrome milestone
(it's the only way to close the window in any state).

**`TitleBar.svelte`:** the 3 preset buttons call the new `createPage`
instead of `applyPreset`. "Split Right"/"Split Down"/"Close Pane" are
unchanged — they still act on the focused pane within whichever page is
currently active.

## Data flow

1. **Launch:** Rust resolves and Attaches every session across every
   page/workspace, emits `workspaces-ready`. Frontend sets
   `workspaces`/`activeWorkspaceId` (falling back to the first workspace if
   the saved active id no longer matches, same silent-fallback pattern
   already used for stale session ids).
2. **Create workspace:** sidebar "+ New Workspace" → inline name input
   (same pattern as tab rename) → appended, made active, persisted.
3. **Create page:** a TitleBar preset button (or a workspace's "+") →
   daemon sessions created → page appended to the active workspace, made
   that workspace's active page, persisted.
4. **Switch workspace/page:** pure local state change, no daemon calls,
   persisted so relaunch resumes the same spot — exactly like today's tab
   switching.
5. **Close page / workspace:** confirm prompt naming the session count →
   kill every session involved → remove the page/workspace → re-activate a
   sibling (or null) → persist.
6. **Drag-and-drop** (see below): pure data restructuring, zero daemon
   calls, persisted the same way as any other mutation.

Sessions in a non-active workspace or page keep running exactly like
today's inactive tabs — `terminalRegistry.ts` already persists xterm
instances independent of visibility, and bootstrap Attaches every session
regardless of which page is "active," so nothing there needs to change.

## Drag-and-drop

The key simplification: dragging a tab from one pane onto a *different*
pane within the same currently-visible page is not a special case — it's
the general cross-page mechanic (`detachLeaf`/`detachTab` then
`graftLeaf`/`mergeIntoActivePane`) where source and target page just happen
to be identical, resulting in one write back into that one page instead of
two. No separate code path is needed for "within the same page" versus
"across pages/workspaces."

**Full matrix:**

| Drag source | Drop target | Effect |
|---|---|---|
| Sidebar workspace row | Another workspace row | Reorder (`reorderWorkspace`) |
| Sidebar page row | A page row in the same workspace | Reorder within that workspace |
| Sidebar page row | A page row in a different workspace, or that workspace's own row | Move the page there (`movePage`) |
| Pane tab-bar background (whole pane) | Sidebar page row, sidebar workspace row, or another rendered pane | 5-zone split/merge (`detachLeaf` + `graftLeaf`/`mergeIntoActivePane`) |
| A single tab button | Same 3 target kinds as above | Same 5-zone logic, using `detachTab` instead of `detachLeaf` |
| A tab button | Another position within its own pane's tab bar | Reorder within that pane (`moveTabWithinLeaf`) |

**Drop UX, two distinct styles** depending on what's being dragged:
- **Reordering** (workspace rows, page rows within/across workspaces) shows
  a thin insertion line between rows, standard list-reorder affordance.
- **Grafting a pane/tab** (onto a sidebar page row, or onto a live pane)
  shows a 5-zone hover overlay: outer ~25% bands on each edge
  (top/bottom/left/right) for a directional split, and the center ~50% for
  "add as tab." The zone under the pointer highlights live via `dragover`;
  releasing there commits that mode. Dropping onto a workspace row (rather
  than a specific page) always means "new page," since there's no existing
  layout to graft into.

Implemented via native HTML5 drag-and-drop — no new dependency. Each drag
payload carries its `kind` (`"workspace" | "page" | "pane" | "tab"`) plus
enough identity to locate its source (session id for pane/tab drags —
their source workspace/page is always whichever page is currently active,
since that's the only page ever rendered; workspace/page id for
sidebar-row drags). A drop target reads the payload's `kind` to decide
which of the table's rows applies — the same sidebar row, or the same live
pane, can receive different drag kinds with different meaning.

**Explicit trade-off:** a graft always appends as a new top-level split in
one of 4 directions (or merges into the target's focused pane) — it can't
land at a precise position deeper inside an existing nested split (e.g.
specifically into the bottom-right cell of an existing 2×2 grid). Given a
cross-page target usually isn't rendered during the drag, this is the
right ceiling for v1; finer placement would need a fundamentally different
(and much larger) UI.

## Error handling

- No workspaces → sidebar empty, main area shows "create a workspace." A
  workspace with no pages → main area shows "add a page" (the 3 preset
  buttons).
- A saved `active_workspace_id` / `active_page_id` / `Page.focused_session_id`
  that no longer matches anything (stale/edited config) falls back
  silently to the first available item — same silent-fallback rule already
  used for stale session ids.
- A drag whose source pane/tab/page/workspace id can't be found anymore
  (e.g. removed via a race with another action) is a no-op, not an error —
  same defensive pattern as `handleSessionExited`'s existing guard.
- Dropping outside any valid zone, back onto a pane/tab's own current page,
  or reordering something to the position it's already at, is a no-op.
- Daemon-unreachable handling is completely unchanged (still the existing
  `daemon-error` event/overlay from Milestone B).

## Testing

- `layout.ts`'s 5 new pure functions get vitest coverage in the same
  exhaustive style as its existing 27 tests (including edge cases: grafting
  onto a `null`/empty target, detaching the only leaf in a tree, reordering
  a tab to its current position).
- New `workspace.ts` pure module gets its own test file, same style,
  covering create/rename/close/switch for both levels plus
  `reorderWorkspace`/`movePage` (including the cross-workspace active-page
  reassignment case).
- `layoutState.ts`'s restructured actions extend the existing 19-test
  suite (same file, same pattern used for every prior change to this
  project).
- Rust: `config.rs` gets roundtrip + migration-default tests for the new
  `Workspace`/`Page` shape (mirroring the existing
  `session_names_roundtrip_alongside_layout` pattern); `session.rs`'s
  generalized reconciliation gets tests verifying it walks multiple
  pages/workspaces correctly, calls `ListSessions` exactly once regardless
  of page count, and that an empty config produces zero `Attach` calls.
- Drag-and-drop interaction itself is GUI-only, same documented limitation
  as every other mouse-driven feature in this project (confirm dialogs,
  resizing, tab switching) — needs a human at the keyboard, no synthetic
  pointer events available in the verification environment.

## Plan decomposition

Sequential, each part depending on the previous — same precedent as
Milestone C's own Part 1/Part 2 split:

1. **Part 1 (Backend):** `config.rs` `Workspace`/`Page` structs (including
   `Page.focused_session_id`, needed by Part 3 but natural to land here
   alongside the rest of the schema), `session.rs` bootstrap generalized to
   reconcile N pages via one `ListSessions` call, `get_workspaces_state`/
   `set_workspaces_state` commands, `workspaces-ready` event.
2. **Part 2 (Frontend core — click-only, no drag yet):** `workspace.ts`'s
   create/rename/close/switch functions, `layoutState.ts` restructuring,
   new `Sidebar.svelte`, `+page.svelte` layout change, `TitleBar.svelte`
   preset buttons switched to `createPage`, new confirm-prompt variants.
   Ships a fully working, testable sidebar on its own — no drag-and-drop
   yet, matching the "each plan produces working software on its own"
   principle.
3. **Part 3 (Drag-and-drop):** the 5 new `layout.ts` functions,
   `workspace.ts`'s `reorderWorkspace`/`movePage`, drag-source wiring in
   `Pane.svelte`, drag-target wiring in both `Sidebar.svelte` and
   `Pane.svelte` (the two drop-UX styles), payload/kind dispatch.
