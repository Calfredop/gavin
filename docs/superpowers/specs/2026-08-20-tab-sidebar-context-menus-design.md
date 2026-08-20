# Tab & Sidebar Context Menus — Design Spec

**Goal:** right-click menus on the three navigation surfaces that have none
today — pane tabs, sidebar workspace rows and page rows (plus the session
rows inside a page's expanded git detail) — and browser-style tab pinning,
using the in-app HTML context menu (`contextMenu.ts` + `ContextMenu.svelte`,
landed in `64fedda`) so the menus read as part of the UI, consistent with
the kanban and plan-explorer menus.

**Out of scope:** submenus, keyboard shortcuts for menu items, migrating the
kanban/plans menus to anything else, native `NSMenu` popups, pinning pages or
workspaces, per-tab icons for pinned tabs beyond a glyph.

---

## 1. Infrastructure

### One menu layer

`<ContextMenu />` is mounted **once**, in `+page.svelte`, as the last child of
`.app`. The store behind it (`contextMenu`) is a global singleton, so the
current per-surface mounts in `KanbanBoard.svelte` and `BoardPane.svelte`
render a duplicate menu whenever two surfaces are on screen together (a
board pane beside a terminal pane, for instance). Those two mounts are
removed. `PlanTree.svelte` is being reworked by another session at the time
of writing; its mount is left alone and noted as a follow-up.

### Builders

Menus are built by pure modules that return `ContextMenuEntry[]`, exactly
like `cardMenu.ts`: state in, entries out, side effects behind a `hooks`
object the surface supplies. That keeps them unit-testable by label /
`disabled` / `danger` without a DOM.

- `app/src/lib/tabMenu.ts` — `buildTabMenuEntries(ctx, hooks)`
- `app/src/lib/sidebarMenu.ts` — `buildWorkspaceMenuEntries`,
  `buildPageMenuEntries`, `buildSessionRowMenuEntries`

Surfaces open a menu with `openContextMenu(e.clientX, e.clientY, entries)`
from an `oncontextmenu` handler that calls `e.preventDefault()` and
`e.stopPropagation()`.

### Errors

Actions that can fail outside our state (Finder open/reveal, clipboard,
folder picker) report through `hooks.reportError(message)`. Both surfaces implement
it with the dialog plugin's `message(text, { title: "gavin", kind: "error" })`
— the same native-dialog family the close confirms already use — plus
`console.error`. No new toast/strip component.

---

## 2. Tab menu

Right-click on a tab button in `Pane.svelte`. The context the builder gets:

```ts
interface TabMenuContext {
  tabId: string;
  kind: "terminal" | "file" | "board";
  /** cwd for a terminal, the file for a file tab, the context folder for a board tab; null if unknown. */
  path: string | null;
  pinned: boolean;
  /** The owning leaf's tabs, in order, and which of them are pinned. */
  tabs: string[];
  pinnedTabs: string[];
}
```

Entries, top to bottom (separators between groups):

| Entry | Enabled when | Action |
|---|---|---|
| Close | always | `confirmTabClose` → `closeSession` |
| Close Others | ≥1 other **unpinned** tab | `closeTabs(others)` |
| Close to the Right | ≥1 unpinned tab after it | `closeTabs(right)` |
| Close to the Left | ≥1 unpinned tab before it | `closeTabs(left)` |
| Pin / Unpin | always | `setTabPinned(tabId, !pinned)` |
| Split Right | terminal | `splitPane(tabId, "row")` |
| Split Down | terminal | `splitPane(tabId, "column")` |
| Rename… | terminal | `hooks.startRename(tabId)` (existing inline editor) |
| Reveal in Finder (file) / Open Folder in Finder (terminal, board) | `path !== null` | file: `revealItemInDir(path)` selects the file; folders: `openPath(path)` opens them |
| Copy Path | `path !== null` | `writeText(path)` |

Disabled entries stay visible (the shared component renders them dimmed);
Split/Rename are omitted, not disabled, for file and board tabs since they
never apply.

### Bulk close

`closeTabs(ids)` in `layoutState.ts` closes sequentially, awaiting
`confirmTabClose(id)` before each `closeSession(id)`. The prompt only fires
when a close would empty the pane, so "Close Others" on a three-tab pane
asks nothing; closing the last unpinned neighbour of a lone pinned tab asks
nothing either (the pinned tab remains). A declined prompt stops the
sequence.

Which ids the three bulk items target is decided by a pure function in
`layout.ts`:

```ts
export function bulkCloseTargets(
  tabs: string[], pinned: string[], tabId: string, mode: "others" | "right" | "left"
): string[]
```

Pinned tabs are never in the result; the clicked tab is never in the result.

---

## 3. Pin model

### State

`LayoutNode` leaf gains `pinned`:

```ts
{ type: "leaf"; tabs: string[]; activeTabIndex: number; pinned?: string[] }
```

```rust
Leaf {
    tabs: Vec<String>,
    #[serde(rename = "activeTabIndex")] active_tab_index: usize,
    #[serde(default, skip_serializing_if = "Vec::is_empty")] pinned: Vec<String>,
}
```

`pinned` is a subset of `tabs`; an id in `pinned` but not in `tabs` is
ignored and dropped on the next write. Legacy state without the field
deserializes with no pinned tabs (Rust test).

### Invariant: pinned tabs are a prefix of `tabs`

Every mutation keeps pinned tabs first, in their own order, followed by
unpinned tabs in theirs. Pure functions in `layout.ts`:

- `pinTab(tree, tabId)` — adds to `pinned`, moves the tab to the end of the
  pinned block. `activeTabIndex` follows the active tab.
- `unpinTab(tree, tabId)` — removes from `pinned`, moves the tab to the
  start of the unpinned block (directly after the pinned ones).
- `isPinned(leaf, tabId)`.
- `clampReorderIndex(leaf, tabId, targetIndex)` — a pinned tab can only
  land inside the pinned block, an unpinned one only outside it.
  `reorderTabWithinPane` applies it.
- Removing a tab (close, move away) also removes it from `pinned`.
- Moving a tab into another pane (`movePaneOrTab`) keeps it pinned and
  inserts it at the end of that pane's pinned block; unpinned tabs insert
  where they do today.

### Presentation (`Pane.svelte`)

- Pinned tab: a `Pin` glyph (`@lucide/svelte`, 10px) before the label; the
  `×` close control is not rendered. Pinned tabs have `class="tab pinned"`
  so the style can be tightened later.
- Label, status dot, git dot, dirty dot, restored badge: unchanged.
- `⌘W` (`keyboard.ts`) is a no-op when the focused tab is pinned. The menu's
  explicit **Close** still closes a pinned tab.

---

## 4. Sidebar menus

### Workspace row

Regular workspace:

| Entry | Enabled when | Action |
|---|---|---|
| Rename… | always | `hooks.startRename(ws.id)` (existing inline editor) |
| New Page | always | existing `quickAddPage(ws.id)` |
| Open Root in Finder | `ws.rootPath` set | `openPath(rootPath)` |
| Change Root Folder… | always | see below |
| Close Workspace | always (danger) | `confirmWorkspaceClose` → `closeWorkspace` |

The **Unfiled** workspace (`UNFILED_WORKSPACE_ID`) gets only **New Page**.

**Change Root Folder…** opens the directory picker (`open({ directory: true })`).
If the picked folder already has a gavin root (`backend.gavinRootExists`),
`setWorkspaceRoot` is called directly. Otherwise the menu does not replicate
the initialise-or-bind flow that `WorkspaceRootControl` owns: it switches the
workspace to the Home view (`switchWorkspaceView(ws.id, "home")`) and reports
*"That folder has no .gavin-root yet — use the root control on the Home tab
to initialise or bind it."* via `reportError`.

### Page row

| Entry | Enabled when | Action |
|---|---|---|
| Rename… | always | `hooks.startRename(page.id)` |
| New Page | always | `quickAddPage(ws.id)` |
| Move to *«Workspace»* | one entry per **other** workspace (Unfiled included), flat | `movePageAction(page.id, target.id, target.pages.length)` |
| Close Other Pages | ≥1 other page (danger) | sequential `confirmPageClose` → `closePage` |
| Close Page | always (danger) | `confirmPageClose` → `closePage` |

### Session row (inside the expanded git detail)

| Entry | Enabled when | Action |
|---|---|---|
| Jump to Session | always | `switchWorkspaceView(ws.id, "terminal")` + `switchToSessionInPage` |
| Open cwd in Finder | cwd known | `openPath(cwd)` |
| Close Session | always (danger) | `confirmTabClose` → `closeSession` |

---

## 5. Permissions

Already granted in `capabilities/default.json`: `opener:default` (covers
`allow-reveal-item-in-dir` and `open-path` for the configured paths),
`dialog:default`, `clipboard-manager:allow-write-text`. No capability change
expected; verified during implementation.

---

## 6. Testing

- `tabMenu.test.ts` / `sidebarMenu.test.ts`: entry labels, order, `disabled`
  and `danger` flags for each state (pinned vs not, single tab, only pinned
  neighbours, Unfiled, workspace without root, page alone, N workspaces);
  hooks are stubs, actions are asserted by which hook/store call fires.
- `layout.test.ts`: `pinTab` / `unpinTab` prefix invariant and
  `activeTabIndex` tracking, `bulkCloseTargets` for all three modes,
  `clampReorderIndex`, pinned survives a cross-pane move, close drops the id
  from `pinned`.
- Rust `layout.rs`: a leaf JSON without `pinned` deserializes; an empty
  `pinned` is not serialized.
- `svelte-check` clean; full vitest and cargo test suites green.
- Manual: right-click each surface, pin/unpin and drag-reorder, ⌘W on a
  pinned tab, Close Others with a pinned neighbour, Change Root Folder on a
  plain folder, Move page between workspaces.
