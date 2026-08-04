# Kanban Board — Frontend (Part 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the workspace-level tab framework (Terminal relocated under a tab, unchanged; Kanban as the new second tab) and the full Kanban board UI on top of Part 1's already-shipped backend (`crates/protocol`'s `Board`/`Column`/`Card`/`Label`/`Priority` types, and the `get_board`/`set_board`/`delete_board` Tauri commands).

**Architecture:** A small static view registry drives a new tab bar in `+page.svelte`'s content area. `kanban.ts` holds pure types and mutation functions (mirroring `layout.ts`'s pure-tree-logic pattern); `kanbanState.ts` is the Svelte store + async fetch/persist layer on top of it (mirroring `layoutState.ts`'s relationship to `workspace.ts`/`layout.ts`). Four new Svelte components render the board; card/column dragging reuses the existing shared `dragDrop.ts` primitives (the same ones `Sidebar.svelte` already uses for workspace/page reordering), extended with two new drag kinds.

**Tech Stack:** Svelte 5 (runes), TypeScript, `@lucide/svelte` (already a dependency — `Terminal` and `Kanban` icons confirmed present at `app/node_modules/@lucide/svelte/dist/icons/{terminal,kanban}.svelte`), native HTML5 drag-and-drop (no new dependency).

## Global Constraints

- This is Part 2 (frontend only), building on Part 1's already-shipped, already-tested backend (`docs/superpowers/plans/2026-08-04-terminal-core-kanban-backend.md`, commits `dc9bde1..4ba237f`). Do not modify `crates/protocol`, `crates/daemon`, or `app/src-tauri/src/session.rs`'s Tauri commands — they're done. `app/src-tauri/src/config.rs` is the one exception (Task 1 below), since it's Tauri-side persistence glue the frontend's new state needs, not daemon/protocol logic.
- `Priority` is the TypeScript union `"none" | "low" | "medium" | "high" | "urgent"` (lowercase strings) — matches `crates/protocol`'s `Priority::as_str()` exactly, already verified by Part 1's own `priority_serializes_to_lowercase_strings` test.
- `Board`/`Column`/`Card`/`Label` TypeScript interfaces use the exact camelCase field names Part 1's Rust types already serialize as (verified by Part 1's `card_serializes_to_the_camel_case_shape_the_frontend_expects` test) — `labelIds` not `label_ids`, etc.
- Card/column drag-and-drop reuses `app/src/lib/dragDrop.ts`'s existing `setDragPayload`/`getDragKind`/`getDragPayload`/`computeReorderPosition` — do not add a new drag-and-drop library or a parallel drag system.
- No dedicated automated test for actual drag-and-drop interaction, modal rendering, or tab-switching visual behavior — GUI-only, matching this project's consistent limitation across every prior milestone. A manual smoke test is expected after this plan, not simulated here.
- The user works directly on `main`, no git worktree — standing preference.
- Execute via `superpowers:subagent-driven-development`, this project's established process. Note for whoever executes: this session has hit the 200-subagent spawn cap four times already (each time resolved by the user choosing direct controller implementation) — don't be surprised if it happens again.
- Every commit stages only the files that specific task actually needs — never `git add -A` / `git add .`.

---

### Task 1: Kanban types, backend wrappers, and workspace-view tab state

**Files:**
- Create: `app/src/lib/kanban.ts` (types only in this task — `Priority`, `Label`, `Card`, `Column`, `Board`)
- Modify: `app/src/lib/backend.ts` (add `getBoard`/`setBoard`/`deleteBoard`)
- Modify: `app/src/lib/workspace.ts` (`Workspace.activeView?`, `getActiveView`, `switchWorkspaceView`)
- Modify: `app/src/lib/layoutState.ts` (`switchWorkspaceView` action)
- Modify: `app/src-tauri/src/config.rs` (`Workspace.active_view: Option<String>`)
- Test: `app/src/lib/workspace.test.ts`
- Test: `app/src/lib/layoutState.test.ts`
- Test: `app/src-tauri/src/config.rs`'s own `#[cfg(test)] mod tests`

**Interfaces:**
- Produces: `Priority`, `Label`, `Card`, `Column`, `Board` TypeScript types (`kanban.ts`); `backend.getBoard(workspaceId: string): Promise<Board>`, `backend.setBoard(workspaceId: string, columns: Column[], labels: Label[]): Promise<void>`, `backend.deleteBoard(workspaceId: string): Promise<void>`; `workspace.getActiveView(ws: Workspace): string` (defaults to `"terminal"`), `workspace.switchWorkspaceView(state: WorkspacesData, workspaceId: string, view: string): WorkspacesData`; `layoutState.switchWorkspaceView(workspaceId: string, view: string): Promise<void>`.

**Design note carried from this plan's own grounding, not the spec's prose**: `Workspace.activeView` is deliberately **optional** in TypeScript (`activeView?: string`) rather than required. A required field would force updating every test file that constructs a `Workspace` object literal directly (`workspace.test.ts`, `layoutState.test.ts`, `confirmClose.test.ts` all do this) — the exact "new required field breaks every literal" trap this project has hit twice before (documented in project history). Making it optional, read only through `getActiveView()`, sidesteps that entirely: no existing literal needs to change. The Rust side mirrors this with `Option<String>` (not a `#[serde(default = "...")]`-defaulted `String`) — matching the sibling `active_page_id: Option<String>` field's own existing, unadorned precedent exactly, since serde already treats a missing `Option<T>` JSON key as `None` with no extra attribute needed.

- [ ] **Step 1: Write the failing tests**

Add to `app/src/lib/workspace.test.ts` (new `describe` block, alongside the existing `switchWorkspace`/`switchPage` tests — use this file's own existing `ws()`/`page()` fixture helpers, don't redefine them):

```ts
describe("getActiveView", () => {
  it("defaults to terminal when activeView is unset", () => {
    const w = ws("ws-1", []);
    expect(getActiveView(w)).toBe("terminal");
  });

  it("returns the workspace's own activeView when set", () => {
    const w = { ...ws("ws-1", []), activeView: "kanban" };
    expect(getActiveView(w)).toBe("kanban");
  });
});

describe("switchWorkspaceView", () => {
  it("sets the given workspace's activeView, leaving others untouched", () => {
    const state = { workspaces: [ws("ws-1", []), ws("ws-2", [])], activeWorkspaceId: "ws-1" };
    const updated = switchWorkspaceView(state, "ws-1", "kanban");
    expect(getActiveView(updated.workspaces[0])).toBe("kanban");
    expect(getActiveView(updated.workspaces[1])).toBe("terminal");
  });

  it("is a no-op when the workspace id doesn't exist", () => {
    const state = { workspaces: [ws("ws-1", [])], activeWorkspaceId: "ws-1" };
    const updated = switchWorkspaceView(state, "does-not-exist", "kanban");
    expect(updated).toEqual(state);
  });
});
```

Add the two new imports (`getActiveView`, `switchWorkspaceView`) to this test file's existing import line from `./workspace`.

Add to `app/src/lib/layoutState.test.ts` (new `describe` block, alongside the existing `switchWorkspace` tests — use this file's own `setState`/`ws`/`page`/`leaf` helpers):

```ts
describe("switchWorkspaceView", () => {
  it("persists the new activeView for the given workspace", async () => {
    setState([ws("ws-1", [page("page-1", leaf(["a"]))])], "ws-1", "a");

    await switchWorkspaceView("ws-1", "kanban");

    const state = get(layoutState);
    expect(getActiveView(state.workspaces[0])).toBe("kanban");
    expect(backend.setWorkspacesState).toHaveBeenCalled();
  });
});
```

Add `switchWorkspaceView` to this test file's existing import line from `./layoutState`, and `getActiveView` to its existing import line from `./workspace`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- workspace.test.ts layoutState.test.ts` (from `app/`)
Expected: FAIL to compile/run — `getActiveView`, `switchWorkspaceView` don't exist in either module yet.

- [ ] **Step 3: Create `app/src/lib/kanban.ts` with the types**

```ts
export type Priority = "none" | "low" | "medium" | "high" | "urgent";

export interface Label {
  id: string;
  name: string;
  color: string;
}

export interface Card {
  id: string;
  title: string;
  description: string;
  labelIds: string[];
  priority: Priority;
  position: number;
}

export interface Column {
  id: string;
  name: string;
  position: number;
  cards: Card[];
}

export interface Board {
  columns: Column[];
  labels: Label[];
}
```

- [ ] **Step 4: Add the backend wrappers**

In `app/src/lib/backend.ts`, add near the top:

```ts
import type { Board, Column, Label } from "./kanban";
```

Add at the end of the file:

```ts
export function getBoard(workspaceId: string): Promise<Board> {
  return invoke("get_board", { workspaceId });
}

export function setBoard(workspaceId: string, columns: Column[], labels: Label[]): Promise<void> {
  return invoke("set_board", { workspaceId, columns, labels });
}

export function deleteBoard(workspaceId: string): Promise<void> {
  return invoke("delete_board", { workspaceId });
}
```

- [ ] **Step 5: Add `activeView`/`getActiveView`/`switchWorkspaceView` to `workspace.ts`**

Update the `Workspace` interface:

```ts
export interface Workspace {
  id: string;
  name: string;
  pages: Page[];
  activePageId: string | null;
  activeView?: string;
}
```

Add near `getActiveWorkspace`/`getActivePage`/`getActiveTree`:

```ts
export function getActiveView(ws: Workspace): string {
  return ws.activeView ?? "terminal";
}

export function switchWorkspaceView(state: WorkspacesData, workspaceId: string, view: string): WorkspacesData {
  return {
    ...state,
    workspaces: state.workspaces.map((w) => (w.id === workspaceId ? { ...w, activeView: view } : w)),
  };
}
```

- [ ] **Step 6: Add the `switchWorkspaceView` action to `layoutState.ts`**

Add right after the existing `switchWorkspace` action:

```ts
export async function switchWorkspaceView(workspaceId: string, view: string): Promise<void> {
  const state = get(layoutState);
  const data = workspace.switchWorkspaceView(state, workspaceId, view);
  layoutState.update((s) => ({ ...s, workspaces: data.workspaces }));
  await persistWorkspaces(data.workspaces, data.activeWorkspaceId);
}
```

- [ ] **Step 7: Update the Rust `Workspace` struct**

In `app/src-tauri/src/config.rs`, update the struct:

```rust
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub id: String,
    pub name: String,
    pub pages: Vec<Page>,
    pub active_page_id: Option<String>,
    pub active_view: Option<String>,
}
```

Add a test to this file's `#[cfg(test)] mod tests` block, next to `load_defaults_workspaces_and_active_workspace_id_when_absent_from_an_older_config_file`:

```rust
    #[test]
    fn load_defaults_a_workspaces_active_view_to_none_when_absent_from_an_older_workspace_object() {
        let dir = tempfile::tempdir().unwrap();
        // Mirrors a real pre-this-milestone Workspace object: has
        // activePageId, has no activeView key at all.
        std::fs::write(
            config_path(dir.path()),
            r#"{"workspaces": [{"id": "ws-1", "name": "A", "pages": [], "activePageId": null}]}"#,
        )
        .unwrap();

        let config = load(dir.path()).unwrap();
        assert_eq!(config.workspaces.len(), 1);
        assert_eq!(config.workspaces[0].active_view, None);
    }
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npm test -- workspace.test.ts layoutState.test.ts` (from `app/`)
Expected: PASS, all tests including the new ones.

Run: `source "$HOME/.cargo/env" && cargo test -p app` (from the repo root)
Expected: PASS, all tests including the new migration test.

- [ ] **Step 9: Run the frontend type checker**

Run: `npm run check` (from `app/`)
Expected: 0 errors (the same pre-existing a11y warnings as before this task, no new ones — `activeView`'s optionality means no existing `Workspace` literal needs updating).

- [ ] **Step 10: Commit**

```bash
git add app/src/lib/kanban.ts app/src/lib/backend.ts app/src/lib/workspace.ts app/src/lib/workspace.test.ts app/src/lib/layoutState.ts app/src/lib/layoutState.test.ts app/src-tauri/src/config.rs
git commit -m "feat(app): add kanban types, backend wrappers, and workspace-view tab state"
```

---

### Task 2: `kanban.ts` — card and label pure mutations

**Files:**
- Modify: `app/src/lib/kanban.ts`
- Create: `app/src/lib/kanban.test.ts`

**Interfaces:**
- Consumes: `Board`/`Column`/`Card`/`Label`/`Priority` (Task 1).
- Produces: `addCard(board: Board, columnId: string, card: Card): Board`, `updateCard(board: Board, cardId: string, patch: Partial<Pick<Card, "title" | "description" | "priority" | "labelIds">>): Board`, `moveCard(board: Board, cardId: string, targetColumnId: string, targetIndex: number): Board`, `deleteCard(board: Board, cardId: string): Board`, `addLabel(board: Board, label: Label): Board`, `updateLabel(board: Board, labelId: string, patch: Partial<Pick<Label, "name" | "color">>): Board`, `deleteLabel(board: Board, labelId: string): Board` (also strips the label id from every card's `labelIds`).

- [ ] **Step 1: Write the failing tests**

Create `app/src/lib/kanban.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  addCard,
  updateCard,
  moveCard,
  deleteCard,
  addLabel,
  updateLabel,
  deleteLabel,
  type Board,
  type Card,
  type Label,
} from "./kanban";

function card(id: string, position: number, labelIds: string[] = []): Card {
  return { id, title: id, description: "", labelIds, priority: "none", position };
}

function label(id: string, name: string): Label {
  return { id, name, color: "#ff0000" };
}

function board(columns: { id: string; cards: Card[] }[], labels: Label[] = []): Board {
  return { columns: columns.map((c, i) => ({ id: c.id, name: c.id, position: i, cards: c.cards })), labels };
}

describe("addCard", () => {
  it("appends the card to the given column", () => {
    const b = board([{ id: "c1", cards: [] }]);
    const updated = addCard(b, "c1", card("card-1", 0));
    expect(updated.columns[0].cards).toEqual([card("card-1", 0)]);
  });

  it("leaves other columns untouched", () => {
    const b = board([{ id: "c1", cards: [] }, { id: "c2", cards: [card("existing", 0)] }]);
    const updated = addCard(b, "c1", card("card-1", 0));
    expect(updated.columns[1].cards).toEqual([card("existing", 0)]);
  });
});

describe("updateCard", () => {
  it("patches only the given fields", () => {
    const b = board([{ id: "c1", cards: [card("card-1", 0)] }]);
    const updated = updateCard(b, "card-1", { title: "New title", priority: "high" });
    expect(updated.columns[0].cards[0].title).toBe("New title");
    expect(updated.columns[0].cards[0].priority).toBe("high");
    expect(updated.columns[0].cards[0].description).toBe("");
  });

  it("is a no-op when the card id doesn't exist", () => {
    const b = board([{ id: "c1", cards: [card("card-1", 0)] }]);
    const updated = updateCard(b, "does-not-exist", { title: "X" });
    expect(updated).toEqual(b);
  });
});

describe("moveCard", () => {
  it("moves a card to a different column at the given index", () => {
    const b = board([
      { id: "c1", cards: [card("card-1", 0), card("card-2", 1)] },
      { id: "c2", cards: [] },
    ]);
    const updated = moveCard(b, "card-1", "c2", 0);
    expect(updated.columns[0].cards.map((c) => c.id)).toEqual(["card-2"]);
    expect(updated.columns[1].cards.map((c) => c.id)).toEqual(["card-1"]);
  });

  it("reindexes position within the source column after removal", () => {
    const b = board([{ id: "c1", cards: [card("card-1", 0), card("card-2", 1)] }, { id: "c2", cards: [] }]);
    const updated = moveCard(b, "card-1", "c2", 0);
    expect(updated.columns[0].cards[0].position).toBe(0);
  });

  it("reorders within the same column", () => {
    const b = board([{ id: "c1", cards: [card("a", 0), card("b", 1), card("c", 2)] }]);
    const updated = moveCard(b, "c", "c1", 0);
    expect(updated.columns[0].cards.map((c) => c.id)).toEqual(["c", "a", "b"]);
  });
});

describe("deleteCard", () => {
  it("removes the card from its column", () => {
    const b = board([{ id: "c1", cards: [card("card-1", 0), card("card-2", 1)] }]);
    const updated = deleteCard(b, "card-1");
    expect(updated.columns[0].cards.map((c) => c.id)).toEqual(["card-2"]);
  });
});

describe("addLabel", () => {
  it("appends the label to the board", () => {
    const b = board([]);
    const updated = addLabel(b, label("l1", "urgent"));
    expect(updated.labels).toEqual([label("l1", "urgent")]);
  });
});

describe("updateLabel", () => {
  it("patches the given label's name/color", () => {
    const b = board([], [label("l1", "urgent")]);
    const updated = updateLabel(b, "l1", { name: "critical" });
    expect(updated.labels[0].name).toBe("critical");
    expect(updated.labels[0].color).toBe("#ff0000");
  });
});

describe("deleteLabel", () => {
  it("removes the label from the board", () => {
    const b = board([], [label("l1", "urgent")]);
    const updated = deleteLabel(b, "l1");
    expect(updated.labels).toEqual([]);
  });

  it("strips the deleted label's id from every card referencing it", () => {
    const b = board([{ id: "c1", cards: [card("card-1", 0, ["l1", "l2"])] }], [label("l1", "urgent")]);
    const updated = deleteLabel(b, "l1");
    expect(updated.columns[0].cards[0].labelIds).toEqual(["l2"]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- kanban.test.ts` (from `app/`)
Expected: FAIL to compile — none of these functions exist in `kanban.ts` yet.

- [ ] **Step 3: Implement the card and label mutation functions**

Append to `app/src/lib/kanban.ts`:

```ts
export function addCard(board: Board, columnId: string, card: Card): Board {
  return {
    ...board,
    columns: board.columns.map((c) => (c.id === columnId ? { ...c, cards: [...c.cards, card] } : c)),
  };
}

export function updateCard(
  board: Board,
  cardId: string,
  patch: Partial<Pick<Card, "title" | "description" | "priority" | "labelIds">>
): Board {
  return {
    ...board,
    columns: board.columns.map((c) => ({
      ...c,
      cards: c.cards.map((card) => (card.id === cardId ? { ...card, ...patch } : card)),
    })),
  };
}

// Removes the card from wherever it currently is, reindexes that
// column's remaining cards' `position` to stay contiguous from 0, then
// inserts it into the target column at targetIndex (clamped) with
// `position` reindexed there too. Reordering within the same column is
// the same operation with source and target columns equal.
export function moveCard(board: Board, cardId: string, targetColumnId: string, targetIndex: number): Board {
  let moved: Card | null = null;
  const withoutCard = board.columns.map((c) => {
    const found = c.cards.find((card) => card.id === cardId);
    if (!found) return c;
    moved = found;
    return { ...c, cards: c.cards.filter((card) => card.id !== cardId).map((card, i) => ({ ...card, position: i })) };
  });
  if (!moved) return board;

  return {
    ...board,
    columns: withoutCard.map((c) => {
      if (c.id !== targetColumnId) return c;
      const clamped = Math.max(0, Math.min(targetIndex, c.cards.length));
      const cards = [...c.cards];
      cards.splice(clamped, 0, moved as Card);
      return { ...c, cards: cards.map((card, i) => ({ ...card, position: i })) };
    }),
  };
}

export function deleteCard(board: Board, cardId: string): Board {
  return {
    ...board,
    columns: board.columns.map((c) => ({
      ...c,
      cards: c.cards.filter((card) => card.id !== cardId).map((card, i) => ({ ...card, position: i })),
    })),
  };
}

export function addLabel(board: Board, label: Label): Board {
  return { ...board, labels: [...board.labels, label] };
}

export function updateLabel(board: Board, labelId: string, patch: Partial<Pick<Label, "name" | "color">>): Board {
  return {
    ...board,
    labels: board.labels.map((l) => (l.id === labelId ? { ...l, ...patch } : l)),
  };
}

export function deleteLabel(board: Board, labelId: string): Board {
  return {
    ...board,
    labels: board.labels.filter((l) => l.id !== labelId),
    columns: board.columns.map((c) => ({
      ...c,
      cards: c.cards.map((card) => ({ ...card, labelIds: card.labelIds.filter((id) => id !== labelId) })),
    })),
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- kanban.test.ts` (from `app/`)
Expected: PASS, all tests.

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/kanban.ts app/src/lib/kanban.test.ts
git commit -m "feat(app): add kanban card and label pure mutation functions"
```

---

### Task 3: `kanban.ts` — column pure mutations, including delete-with-cards

**Files:**
- Modify: `app/src/lib/kanban.ts`
- Modify: `app/src/lib/kanban.test.ts`

**Interfaces:**
- Consumes: `Board`/`Column` (Task 1), the same file's card functions (Task 2, for `deleteColumnCascade`'s reuse of card removal semantics).
- Produces: `addColumn(board: Board, column: Column): Board`, `renameColumn(board: Board, columnId: string, name: string): Board`, `reorderColumn(board: Board, columnId: string, targetIndex: number): Board`, `deleteColumnCascade(board: Board, columnId: string): Board` (deletes the column and every card in it), `moveCardsOutOfColumn(board: Board, sourceColumnId: string, targetColumnId: string): Board` (relocates every card from source to the end of target, used before deleting a column when the user chooses "move" instead of "delete").

- [ ] **Step 1: Write the failing tests**

Append to `app/src/lib/kanban.test.ts` (add the new imports to the existing import line from `./kanban`):

```ts
describe("addColumn", () => {
  it("appends the column to the board", () => {
    const b = board([{ id: "c1", cards: [] }]);
    const updated = addColumn(b, { id: "c2", name: "New", position: 1, cards: [] });
    expect(updated.columns.map((c) => c.id)).toEqual(["c1", "c2"]);
  });
});

describe("renameColumn", () => {
  it("renames the given column, leaving others untouched", () => {
    const b = board([{ id: "c1", cards: [] }, { id: "c2", cards: [] }]);
    const updated = renameColumn(b, "c1", "Renamed");
    expect(updated.columns[0].name).toBe("Renamed");
    expect(updated.columns[1].name).toBe("c2");
  });
});

describe("reorderColumn", () => {
  it("moves a column to the given index", () => {
    const b = board([{ id: "a", cards: [] }, { id: "b", cards: [] }, { id: "c", cards: [] }]);
    const updated = reorderColumn(b, "c", 0);
    expect(updated.columns.map((c) => c.id)).toEqual(["c", "a", "b"]);
  });

  it("reindexes position after reordering", () => {
    const b = board([{ id: "a", cards: [] }, { id: "b", cards: [] }]);
    const updated = reorderColumn(b, "b", 0);
    expect(updated.columns.map((c) => c.position)).toEqual([0, 1]);
  });
});

describe("deleteColumnCascade", () => {
  it("removes the column and every card inside it", () => {
    const b = board([
      { id: "c1", cards: [card("card-1", 0)] },
      { id: "c2", cards: [] },
    ]);
    const updated = deleteColumnCascade(b, "c1");
    expect(updated.columns.map((c) => c.id)).toEqual(["c2"]);
  });
});

describe("moveCardsOutOfColumn", () => {
  it("relocates every card from source to the end of target, then the caller deletes the empty source", () => {
    const b = board([
      { id: "c1", cards: [card("card-1", 0), card("card-2", 1)] },
      { id: "c2", cards: [card("existing", 0)] },
    ]);
    const moved = moveCardsOutOfColumn(b, "c1", "c2");
    expect(moved.columns[0].cards).toEqual([]);
    expect(moved.columns[1].cards.map((c) => c.id)).toEqual(["existing", "card-1", "card-2"]);

    const updated = deleteColumnCascade(moved, "c1");
    expect(updated.columns.map((c) => c.id)).toEqual(["c2"]);
    expect(updated.columns[0].cards.map((c) => c.id)).toEqual(["existing", "card-1", "card-2"]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- kanban.test.ts` (from `app/`)
Expected: FAIL to compile — `addColumn`/`renameColumn`/`reorderColumn`/`deleteColumnCascade`/`moveCardsOutOfColumn` don't exist yet.

- [ ] **Step 3: Implement the column mutation functions**

Append to `app/src/lib/kanban.ts`:

```ts
export function addColumn(board: Board, column: Column): Board {
  return { ...board, columns: [...board.columns, column] };
}

export function renameColumn(board: Board, columnId: string, name: string): Board {
  return {
    ...board,
    columns: board.columns.map((c) => (c.id === columnId ? { ...c, name } : c)),
  };
}

export function reorderColumn(board: Board, columnId: string, targetIndex: number): Board {
  const currentIndex = board.columns.findIndex((c) => c.id === columnId);
  if (currentIndex === -1) return board;
  const columns = [...board.columns];
  const [moved] = columns.splice(currentIndex, 1);
  const clamped = Math.max(0, Math.min(targetIndex, columns.length));
  columns.splice(clamped, 0, moved);
  return { ...board, columns: columns.map((c, i) => ({ ...c, position: i })) };
}

export function deleteColumnCascade(board: Board, columnId: string): Board {
  return {
    ...board,
    columns: board.columns.filter((c) => c.id !== columnId).map((c, i) => ({ ...c, position: i })),
  };
}

// Moves every card currently in sourceColumnId to the end of
// targetColumnId's card list, leaving sourceColumnId empty. Callers that
// want to relocate-then-delete (the "move cards" branch of the
// delete-non-empty-column prompt) call this first, then
// deleteColumnCascade on the now-empty source -- two composed primitives
// rather than one combined function, so each stays independently
// testable and reusable (a future "merge two columns" feature could use
// this alone, without deleting anything).
export function moveCardsOutOfColumn(board: Board, sourceColumnId: string, targetColumnId: string): Board {
  const source = board.columns.find((c) => c.id === sourceColumnId);
  if (!source) return board;
  const movingCards = source.cards;
  return {
    ...board,
    columns: board.columns.map((c) => {
      if (c.id === sourceColumnId) return { ...c, cards: [] };
      if (c.id === targetColumnId) {
        const cards = [...c.cards, ...movingCards];
        return { ...c, cards: cards.map((card, i) => ({ ...card, position: i })) };
      }
      return c;
    }),
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- kanban.test.ts` (from `app/`)
Expected: PASS, all tests.

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/kanban.ts app/src/lib/kanban.test.ts
git commit -m "feat(app): add kanban column pure mutation functions"
```

---

### Task 4: `kanbanState.ts` — the board store and fetch/persist actions

**Files:**
- Create: `app/src/lib/kanbanState.ts`
- Create: `app/src/lib/kanbanState.test.ts`

**Interfaces:**
- Consumes: `Board`/`Column`/`Label`/`Card` (Task 1), every `kanban.ts` mutation function (Tasks 2-3), `backend.getBoard`/`backend.setBoard` (Task 1).
- Produces: `kanbanState: Writable<Record<string, Board>>` (a plain Svelte store, keyed by workspace id — boards not yet fetched simply aren't present as a key), `fetchBoard(workspaceId: string): Promise<void>` (no-op if already fetched; sets a per-workspace error string on failure, read by `KanbanBoard.svelte` for its inline retry UI in Task 7 -- never touches the app-wide `daemon-error` state), `boardError(workspaceId: string): string | null` (a plain reader, not a store, for `KanbanBoard.svelte` to call), `retryFetchBoard(workspaceId: string): Promise<void>` (clears the error and re-fetches), and one action per `kanban.ts` mutation function that (1) mutates local state immediately, (2) calls `backend.setBoard` to persist, (3) is a no-op if the workspace's board was never fetched: `addCardAction`, `updateCardAction`, `moveCardAction`, `deleteCardAction`, `addColumnAction`, `renameColumnAction`, `reorderColumnAction`, `deleteColumnCascadeAction`, `moveCardsOutOfColumnAndDeleteAction` (composes `moveCardsOutOfColumn` + `deleteColumnCascade` + one persist, for the "move cards" branch of the delete prompt), `addLabelAction`, `updateLabelAction`, `deleteLabelAction`.

- [ ] **Step 1: Write the failing tests**

Create `app/src/lib/kanbanState.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { get } from "svelte/store";

vi.mock("./backend", () => ({
  getBoard: vi.fn(),
  setBoard: vi.fn(),
}));

import * as backend from "./backend";
import {
  kanbanState,
  fetchBoard,
  boardError,
  retryFetchBoard,
  addCardAction,
  deleteColumnCascadeAction,
} from "./kanbanState";
import type { Board } from "./kanban";

function emptyBoard(): Board {
  return { columns: [{ id: "c1", name: "To Do", position: 0, cards: [] }], labels: [] };
}

beforeEach(() => {
  vi.clearAllMocks();
  kanbanState.set({});
});

describe("fetchBoard", () => {
  it("fetches and stores the board for a workspace", async () => {
    vi.mocked(backend.getBoard).mockResolvedValue(emptyBoard());

    await fetchBoard("ws-1");

    expect(get(kanbanState)["ws-1"]).toEqual(emptyBoard());
  });

  it("does not re-fetch a workspace whose board is already loaded", async () => {
    vi.mocked(backend.getBoard).mockResolvedValue(emptyBoard());
    await fetchBoard("ws-1");

    await fetchBoard("ws-1");

    expect(backend.getBoard).toHaveBeenCalledTimes(1);
  });

  it("records a per-workspace error on failure instead of throwing", async () => {
    vi.mocked(backend.getBoard).mockRejectedValue(new Error("daemon unreachable"));

    await fetchBoard("ws-1");

    expect(boardError("ws-1")).toBe("daemon unreachable");
    expect(get(kanbanState)["ws-1"]).toBeUndefined();
  });
});

describe("retryFetchBoard", () => {
  it("clears the error and re-fetches successfully", async () => {
    vi.mocked(backend.getBoard).mockRejectedValueOnce(new Error("daemon unreachable"));
    await fetchBoard("ws-1");
    expect(boardError("ws-1")).toBe("daemon unreachable");

    vi.mocked(backend.getBoard).mockResolvedValueOnce(emptyBoard());
    await retryFetchBoard("ws-1");

    expect(boardError("ws-1")).toBeNull();
    expect(get(kanbanState)["ws-1"]).toEqual(emptyBoard());
  });
});

describe("addCardAction", () => {
  it("mutates local state immediately and persists via setBoard", async () => {
    vi.mocked(backend.getBoard).mockResolvedValue(emptyBoard());
    await fetchBoard("ws-1");

    await addCardAction("ws-1", "c1", { id: "card-1", title: "New", description: "", labelIds: [], priority: "none", position: 0 });

    expect(get(kanbanState)["ws-1"].columns[0].cards).toHaveLength(1);
    expect(backend.setBoard).toHaveBeenCalledWith("ws-1", get(kanbanState)["ws-1"].columns, []);
  });

  it("is a no-op when the workspace's board was never fetched", async () => {
    await addCardAction("ws-1", "c1", { id: "card-1", title: "New", description: "", labelIds: [], priority: "none", position: 0 });

    expect(get(kanbanState)["ws-1"]).toBeUndefined();
    expect(backend.setBoard).not.toHaveBeenCalled();
  });
});

describe("deleteColumnCascadeAction", () => {
  it("mutates local state and persists", async () => {
    vi.mocked(backend.getBoard).mockResolvedValue(emptyBoard());
    await fetchBoard("ws-1");

    await deleteColumnCascadeAction("ws-1", "c1");

    expect(get(kanbanState)["ws-1"].columns).toEqual([]);
    expect(backend.setBoard).toHaveBeenCalledWith("ws-1", [], []);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- kanbanState.test.ts` (from `app/`)
Expected: FAIL to compile — `kanbanState.ts` doesn't exist yet.

- [ ] **Step 3: Implement `kanbanState.ts`**

```ts
import { writable, get } from "svelte/store";
import * as backend from "./backend";
import * as kanban from "./kanban";
import type { Board, Card, Column, Label } from "./kanban";

export const kanbanState = writable<Record<string, Board>>({});

const errors = writable<Record<string, string>>({});

export function boardError(workspaceId: string): string | null {
  return get(errors)[workspaceId] ?? null;
}

function clearError(workspaceId: string): void {
  errors.update((e) => {
    if (!(workspaceId in e)) return e;
    const { [workspaceId]: _removed, ...rest } = e;
    return rest;
  });
}

export async function fetchBoard(workspaceId: string): Promise<void> {
  if (workspaceId in get(kanbanState)) return;
  try {
    const board = await backend.getBoard(workspaceId);
    kanbanState.update((s) => ({ ...s, [workspaceId]: board }));
    clearError(workspaceId);
  } catch (e) {
    errors.update((err) => ({ ...err, [workspaceId]: String(e instanceof Error ? e.message : e) }));
  }
}

export async function retryFetchBoard(workspaceId: string): Promise<void> {
  clearError(workspaceId);
  kanbanState.update((s) => {
    if (!(workspaceId in s)) return s;
    const { [workspaceId]: _removed, ...rest } = s;
    return rest;
  });
  await fetchBoard(workspaceId);
}

// Shared by every mutation action below: applies `mutate` to the
// workspace's current board (a no-op if it was never fetched -- there is
// nothing to mutate or persist), writes the result to the store, and
// persists the whole board via setBoard, matching how pane-tree edits
// already flow through layoutState.ts to the daemon.
async function mutateAndPersist(workspaceId: string, mutate: (board: Board) => Board): Promise<void> {
  const current = get(kanbanState)[workspaceId];
  if (!current) return;
  const updated = mutate(current);
  kanbanState.update((s) => ({ ...s, [workspaceId]: updated }));
  await backend.setBoard(workspaceId, updated.columns, updated.labels);
}

export function addCardAction(workspaceId: string, columnId: string, card: Card): Promise<void> {
  return mutateAndPersist(workspaceId, (b) => kanban.addCard(b, columnId, card));
}

export function updateCardAction(
  workspaceId: string,
  cardId: string,
  patch: Partial<Pick<Card, "title" | "description" | "priority" | "labelIds">>
): Promise<void> {
  return mutateAndPersist(workspaceId, (b) => kanban.updateCard(b, cardId, patch));
}

export function moveCardAction(
  workspaceId: string,
  cardId: string,
  targetColumnId: string,
  targetIndex: number
): Promise<void> {
  return mutateAndPersist(workspaceId, (b) => kanban.moveCard(b, cardId, targetColumnId, targetIndex));
}

export function deleteCardAction(workspaceId: string, cardId: string): Promise<void> {
  return mutateAndPersist(workspaceId, (b) => kanban.deleteCard(b, cardId));
}

export function addColumnAction(workspaceId: string, column: Column): Promise<void> {
  return mutateAndPersist(workspaceId, (b) => kanban.addColumn(b, column));
}

export function renameColumnAction(workspaceId: string, columnId: string, name: string): Promise<void> {
  return mutateAndPersist(workspaceId, (b) => kanban.renameColumn(b, columnId, name));
}

export function reorderColumnAction(workspaceId: string, columnId: string, targetIndex: number): Promise<void> {
  return mutateAndPersist(workspaceId, (b) => kanban.reorderColumn(b, columnId, targetIndex));
}

export function deleteColumnCascadeAction(workspaceId: string, columnId: string): Promise<void> {
  return mutateAndPersist(workspaceId, (b) => kanban.deleteColumnCascade(b, columnId));
}

export function moveCardsOutOfColumnAndDeleteAction(
  workspaceId: string,
  sourceColumnId: string,
  targetColumnId: string
): Promise<void> {
  return mutateAndPersist(workspaceId, (b) =>
    kanban.deleteColumnCascade(kanban.moveCardsOutOfColumn(b, sourceColumnId, targetColumnId), sourceColumnId)
  );
}

export function addLabelAction(workspaceId: string, label: Label): Promise<void> {
  return mutateAndPersist(workspaceId, (b) => kanban.addLabel(b, label));
}

export function updateLabelAction(
  workspaceId: string,
  labelId: string,
  patch: Partial<Pick<Label, "name" | "color">>
): Promise<void> {
  return mutateAndPersist(workspaceId, (b) => kanban.updateLabel(b, labelId, patch));
}

export function deleteLabelAction(workspaceId: string, labelId: string): Promise<void> {
  return mutateAndPersist(workspaceId, (b) => kanban.deleteLabel(b, labelId));
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- kanbanState.test.ts` (from `app/`)
Expected: PASS, all tests.

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/kanbanState.ts app/src/lib/kanbanState.test.ts
git commit -m "feat(app): add kanbanState store with lazy fetch and mutation actions"
```

---

### Task 5: Wire `closeWorkspace` to `deleteBoard`

**Files:**
- Modify: `app/src/lib/layoutState.ts`
- Modify: `app/src/lib/layoutState.test.ts`

**Interfaces:**
- Consumes: `backend.deleteBoard` (Task 1).

This closes the gap Part 1's own plan explicitly deferred: `delete_board`/`DeleteBoard` was built as a capability with no caller, since workspace deletion is a frontend-only concept the daemon has no hook for.

- [ ] **Step 1: Write the failing test**

Add to `app/src/lib/layoutState.test.ts`'s existing `describe("closeWorkspace", ...)` block (find it — it already has tests for killing every session in the workspace; add this as one more `it` inside that same block, using whatever session/workspace fixture setup the existing tests there already use):

```ts
  it("deletes the workspace's kanban board", async () => {
    setState([ws("ws-1", [page("page-1", leaf(["a"]))])], "ws-1", "a");
    vi.mocked(backend.killSession).mockResolvedValue(undefined);

    await closeWorkspace("ws-1");

    expect(backend.deleteBoard).toHaveBeenCalledWith("ws-1");
  });
```

Add `deleteBoard: vi.fn()` to this file's top-level `vi.mock("./backend", () => ({...}))` factory object, alongside the other mocked functions.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- layoutState.test.ts` (from `app/`)
Expected: FAIL — `backend.deleteBoard` is never called by the current `closeWorkspace`.

- [ ] **Step 3: Call `backend.deleteBoard` from `closeWorkspace`**

In `app/src/lib/layoutState.ts`, update `closeWorkspace` — add the `deleteBoard` call right after the session-killing loop, before the local state is updated (mirrors the existing session-kill loop's own error handling: a failure here surfaces via `setError`, matching every other failure path in this function, and stops before mutating local state):

```ts
export async function closeWorkspace(workspaceId: string): Promise<void> {
  const state = get(layoutState);
  const ws = state.workspaces.find((w) => w.id === workspaceId);
  if (!ws) return;
  const sessionIds = workspace.allSessionIdsInWorkspace(ws);

  for (const id of sessionIds) {
    try {
      await backend.killSession(id);
    } catch (e) {
      setError(String(e));
      return;
    }
  }
  for (const id of sessionIds) {
    terminalRegistry.destroyTerminal(id);
  }

  try {
    await backend.deleteBoard(workspaceId);
  } catch (e) {
    setError(String(e));
    return;
  }

  let updated = workspace.removeWorkspace(state, workspaceId);
  let focusedSessionId = state.focusedSessionId;
  if (sessionIds.includes(state.focusedSessionId ?? "")) {
    const resolved = workspace.resolveActiveFocus(updated);
    updated = resolved.state;
    focusedSessionId = resolved.focusedSessionId;
  }

  layoutState.update((s) => ({
    ...s,
    workspaces: updated.workspaces,
    activeWorkspaceId: updated.activeWorkspaceId,
    focusedSessionId,
  }));
  await persistWorkspaces(updated.workspaces, updated.activeWorkspaceId);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- layoutState.test.ts` (from `app/`)
Expected: PASS, all tests including the new one and every pre-existing `closeWorkspace` test (they'll now also implicitly exercise the mocked `deleteBoard` call — confirm none of them assert an exact call count/sequence on `backend` that this new call would break; if one does, add `vi.mocked(backend.deleteBoard).mockResolvedValue(undefined)` to that test's own setup, matching how `killSession` is already mocked there).

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/layoutState.ts app/src/lib/layoutState.test.ts
git commit -m "feat(app): cascade-delete a workspace's kanban board when the workspace is closed"
```

---

### Task 6: Modal primitive, `CardDetailModal.svelte`, and the delete-column prompt

**Files:**
- Create: `app/src/lib/Modal.svelte`
- Create: `app/src/lib/CardDetailModal.svelte`
- Create: `app/src/lib/DeleteColumnPrompt.svelte`

**Interfaces:**
- Consumes: `Card`/`Label`/`Priority` (Task 1), `Column` (Task 1).
- Produces: `Modal.svelte` (props: `onClose: () => void`; slot content for its own body — this is this codebase's first custom in-app modal, existing dialogs are all native OS `confirm()` via `@tauri-apps/plugin-dialog`), `CardDetailModal.svelte` (props: `card: Card`, `labels: Label[]`, `onSave: (patch: {title: string; description: string; priority: Priority; labelIds: string[]}) => void`, `onClose: () => void`), `DeleteColumnPrompt.svelte` (props: `columnName: string`, `cardCount: number`, `otherColumns: {id: string; name: string}[]`, `onDeleteCards: () => void`, `onMoveCards: (targetColumnId: string) => void`, `onCancel: () => void`).

No dedicated test for these three components — GUI-only, matching this project's consistent limitation (no automated rendering/interaction tests exist for any Svelte component in this codebase).

- [ ] **Step 1: Create `Modal.svelte`**

```svelte
<script lang="ts">
  interface Props {
    onClose: () => void;
    children?: import("svelte").Snippet;
  }
  let { onClose, children }: Props = $props();

  function handleBackdropClick(event: MouseEvent): void {
    if (event.target === event.currentTarget) onClose();
  }

  function handleKeydown(event: KeyboardEvent): void {
    if (event.key === "Escape") onClose();
  }
</script>

<svelte:window onkeydown={handleKeydown} />

<div class="backdrop" onclick={handleBackdropClick} role="presentation">
  <div class="panel" role="dialog" aria-modal="true">
    {@render children?.()}
  </div>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.5);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 100;
  }
  .panel {
    background: #2a2a2a;
    border: 1px solid #444;
    border-radius: 8px;
    padding: 20px;
    min-width: 320px;
    max-width: 480px;
    max-height: 80vh;
    overflow-y: auto;
    color: #eee;
    font-family: monospace;
  }
</style>
```

- [ ] **Step 2: Create `CardDetailModal.svelte`**

```svelte
<script lang="ts">
  import Modal from "./Modal.svelte";
  import type { Card, Label, Priority } from "./kanban";

  interface Props {
    card: Card;
    labels: Label[];
    onSave: (patch: { title: string; description: string; priority: Priority; labelIds: string[] }) => void;
    onClose: () => void;
  }
  let { card, labels, onSave, onClose }: Props = $props();

  let title = $state(card.title);
  let description = $state(card.description);
  let priority = $state<Priority>(card.priority);
  let labelIds = $state<string[]>([...card.labelIds]);

  const PRIORITIES: Priority[] = ["none", "low", "medium", "high", "urgent"];

  function toggleLabel(labelId: string): void {
    labelIds = labelIds.includes(labelId) ? labelIds.filter((id) => id !== labelId) : [...labelIds, labelId];
  }

  function handleSave(): void {
    onSave({ title, description, priority, labelIds });
    onClose();
  }
</script>

<Modal {onClose}>
  <label class="field">
    Title
    <input type="text" bind:value={title} />
  </label>
  <label class="field">
    Description
    <textarea bind:value={description} rows="4"></textarea>
  </label>
  <label class="field">
    Priority
    <select bind:value={priority}>
      {#each PRIORITIES as p (p)}
        <option value={p}>{p}</option>
      {/each}
    </select>
  </label>
  {#if labels.length > 0}
    <div class="field">
      Labels
      <div class="labels">
        {#each labels as label (label.id)}
          <button
            type="button"
            class="label-chip"
            class:active={labelIds.includes(label.id)}
            style:border-color={label.color}
            onclick={() => toggleLabel(label.id)}
          >
            {label.name}
          </button>
        {/each}
      </div>
    </div>
  {/if}
  <div class="actions">
    <button type="button" onclick={onClose}>Cancel</button>
    <button type="button" onclick={handleSave}>Save</button>
  </div>
</Modal>

<style>
  .field {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin-bottom: 12px;
    font-size: 0.85em;
  }
  input,
  textarea,
  select {
    background: #1e1e1e;
    border: 1px solid #444;
    color: #eee;
    font-family: monospace;
    padding: 4px 6px;
    border-radius: 4px;
  }
  .labels {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .label-chip {
    background: transparent;
    border: 1px solid #666;
    color: #eee;
    border-radius: 12px;
    padding: 2px 10px;
    font-size: 0.8em;
    cursor: pointer;
  }
  .label-chip.active {
    background: #3a3a3a;
    border-width: 2px;
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 16px;
  }
  .actions button {
    background: #3a3a3a;
    border: none;
    color: #eee;
    padding: 6px 14px;
    border-radius: 4px;
    cursor: pointer;
    font-family: monospace;
  }
</style>
```

- [ ] **Step 3: Create `DeleteColumnPrompt.svelte`**

```svelte
<script lang="ts">
  import Modal from "./Modal.svelte";

  interface Props {
    columnName: string;
    cardCount: number;
    otherColumns: { id: string; name: string }[];
    onDeleteCards: () => void;
    onMoveCards: (targetColumnId: string) => void;
    onCancel: () => void;
  }
  let { columnName, cardCount, otherColumns, onDeleteCards, onMoveCards, onCancel }: Props = $props();

  let selectedTarget = $state(otherColumns[0]?.id ?? "");
</script>

<Modal onClose={onCancel}>
  <p>
    "{columnName}" has {cardCount} {cardCount === 1 ? "card" : "cards"}. Delete them along with the column, or move
    them somewhere else first?
  </p>
  {#if otherColumns.length > 0}
    <label class="field">
      Move to
      <select bind:value={selectedTarget}>
        {#each otherColumns as col (col.id)}
          <option value={col.id}>{col.name}</option>
        {/each}
      </select>
    </label>
  {/if}
  <div class="actions">
    <button type="button" onclick={onCancel}>Cancel</button>
    {#if otherColumns.length > 0}
      <button type="button" onclick={() => onMoveCards(selectedTarget)}>Move cards</button>
    {/if}
    <button type="button" class="danger" onclick={onDeleteCards}>Delete cards</button>
  </div>
</Modal>

<style>
  .field {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin: 12px 0;
    font-size: 0.85em;
  }
  select {
    background: #1e1e1e;
    border: 1px solid #444;
    color: #eee;
    font-family: monospace;
    padding: 4px 6px;
    border-radius: 4px;
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 16px;
  }
  .actions button {
    background: #3a3a3a;
    border: none;
    color: #eee;
    padding: 6px 14px;
    border-radius: 4px;
    cursor: pointer;
    font-family: monospace;
  }
  .actions button.danger {
    background: #6b2b2b;
  }
</style>
```

- [ ] **Step 4: Run the frontend type checker**

Run: `npm run check` (from `app/`)
Expected: 0 errors (same pre-existing a11y warnings as before — `Modal.svelte`'s backdrop `role="presentation"` and `onclick` are the same pattern this codebase already uses elsewhere for click-outside-to-close, not a new a11y gap).

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/Modal.svelte app/src/lib/CardDetailModal.svelte app/src/lib/DeleteColumnPrompt.svelte
git commit -m "feat(app): add Modal primitive, CardDetailModal, and DeleteColumnPrompt"
```

---

### Task 7: `KanbanCard.svelte`, `KanbanColumn.svelte`, `KanbanBoard.svelte`, and drag-and-drop

**Files:**
- Modify: `app/src/lib/dragDrop.ts` (extend `DragPayload`/`DRAG_KINDS` with two new kinds)
- Create: `app/src/lib/KanbanCard.svelte`
- Create: `app/src/lib/KanbanColumn.svelte`
- Create: `app/src/lib/KanbanBoard.svelte`

**Interfaces:**
- Consumes: `kanbanState`/`fetchBoard`/`boardError`/`retryFetchBoard`/every mutation action (Task 4), `CardDetailModal`/`DeleteColumnPrompt` (Task 6), `setDragPayload`/`getDragKind`/`getDragPayload`/`computeReorderPosition` (this task extends `dragDrop.ts`, then all three new components use it).
- Produces: `KanbanBoard.svelte` (props: `workspaceId: string` — this is what Task 8's registry will reference as the `"kanban"` view's component).

- [ ] **Step 1: Extend `dragDrop.ts` with two new drag kinds**

In `app/src/lib/dragDrop.ts`, update the `DragPayload` union and `DRAG_KINDS` array:

```ts
export type DragPayload =
  | { kind: "workspace"; workspaceId: string }
  | { kind: "page"; workspaceId: string; pageId: string }
  | { kind: "pane"; workspaceId: string; pageId: string; sessionId: string }
  | { kind: "tab"; workspaceId: string; pageId: string; sessionId: string }
  | { kind: "kanban-card"; cardId: string; sourceColumnId: string }
  | { kind: "kanban-column"; columnId: string };

const DRAG_TYPE_PREFIX = "application/x-gavin-drag-";
const DRAG_KINDS: readonly DragPayload["kind"][] = [
  "workspace",
  "page",
  "pane",
  "tab",
  "kanban-card",
  "kanban-column",
];
```

Everything else in this file (`setDragPayload`, `getDragKind`, `getDragPayload`, `computeReorderPosition`, `computeDropZone`) is generic over `DragPayload["kind"]` already and needs no other change.

- [ ] **Step 2: Run the frontend type checker to confirm the extension compiles**

Run: `npm run check` (from `app/`)
Expected: 0 errors — this step only widens a union type, existing `DragPayload`-consuming code (`Sidebar.svelte`'s `if (payload.kind === "workspace")`-style checks) narrows correctly regardless of how many kinds exist.

- [ ] **Step 3: Create `KanbanCard.svelte`**

```svelte
<script lang="ts">
  import type { Card, Label } from "./kanban";
  import { setDragPayload } from "./dragDrop";

  interface Props {
    card: Card;
    columnId: string;
    labels: Label[];
    onOpen: () => void;
  }
  let { card, columnId, labels, onOpen }: Props = $props();

  const cardLabels = $derived(labels.filter((l) => card.labelIds.includes(l.id)));

  function handleDragStart(event: DragEvent): void {
    setDragPayload(event, { kind: "kanban-card", cardId: card.id, sourceColumnId: columnId });
  }
</script>

<div class="card" draggable="true" ondragstart={handleDragStart} onclick={onOpen} role="button" tabindex="0">
  {#if card.priority !== "none"}
    <span class="priority priority-{card.priority}" title="Priority: {card.priority}"></span>
  {/if}
  <div class="title">{card.title}</div>
  {#if cardLabels.length > 0}
    <div class="labels">
      {#each cardLabels as label (label.id)}
        <span class="label-chip" style:border-color={label.color}>{label.name}</span>
      {/each}
    </div>
  {/if}
</div>

<style>
  .card {
    background: #2a2a2a;
    border: 1px solid #444;
    border-radius: 6px;
    padding: 8px;
    margin-bottom: 6px;
    cursor: pointer;
    color: #eee;
    font-family: monospace;
    font-size: 0.85em;
  }
  .priority {
    display: inline-block;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    margin-bottom: 4px;
  }
  .priority-low {
    background: #6b8e6b;
  }
  .priority-medium {
    background: #d9a648;
  }
  .priority-high {
    background: #d97748;
  }
  .priority-urgent {
    background: #d94848;
  }
  .title {
    word-break: break-word;
  }
  .labels {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin-top: 6px;
  }
  .label-chip {
    border: 1px solid #666;
    border-radius: 10px;
    padding: 1px 6px;
    font-size: 0.85em;
  }
</style>
```

- [ ] **Step 4: Create `KanbanColumn.svelte`**

```svelte
<script lang="ts">
  import type { Column, Label } from "./kanban";
  import KanbanCard from "./KanbanCard.svelte";
  import DeleteColumnPrompt from "./DeleteColumnPrompt.svelte";
  import { setDragPayload, getDragKind, getDragPayload, computeReorderPosition } from "./dragDrop";
  import {
    moveCardAction,
    reorderColumnAction,
    renameColumnAction,
    deleteColumnCascadeAction,
    moveCardsOutOfColumnAndDeleteAction,
  } from "./kanbanState";

  interface Props {
    workspaceId: string;
    column: Column;
    otherColumns: { id: string; name: string }[];
    labels: Label[];
    onOpenCard: (cardId: string) => void;
    onAddCard: () => void;
  }
  let { workspaceId, column, otherColumns, labels, onOpenCard, onAddCard }: Props = $props();

  let editingName = $state(false);
  let nameDraft = $state(column.name);
  let showDeletePrompt = $state(false);

  function startRename(): void {
    nameDraft = column.name;
    editingName = true;
  }

  function commitRename(): void {
    editingName = false;
    const trimmed = nameDraft.trim();
    if (trimmed && trimmed !== column.name) void renameColumnAction(workspaceId, column.id, trimmed);
  }

  function handleColumnDragStart(event: DragEvent): void {
    setDragPayload(event, { kind: "kanban-column", columnId: column.id });
  }

  function handleColumnDragOver(event: DragEvent): void {
    const kind = getDragKind(event);
    if (kind !== "kanban-column") return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
  }

  function handleColumnDrop(event: DragEvent): void {
    event.preventDefault();
    const payload = getDragPayload(event);
    if (!payload || payload.kind !== "kanban-column" || payload.columnId === column.id) return;
    void reorderColumnAction(workspaceId, payload.columnId, column.position);
  }

  function handleCardDragOver(event: DragEvent): void {
    const kind = getDragKind(event);
    if (kind !== "kanban-card") return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
  }

  function handleCardDrop(event: DragEvent, dropIndex: number): void {
    event.preventDefault();
    const payload = getDragPayload(event);
    if (!payload || payload.kind !== "kanban-card") return;
    void moveCardAction(workspaceId, payload.cardId, column.id, dropIndex);
  }

  function handleCardSlotDragOver(event: DragEvent): "before" | "after" | null {
    const kind = getDragKind(event);
    if (kind !== "kanban-card") return null;
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    return computeReorderPosition(rect, event.clientY);
  }

  function requestDeleteColumn(): void {
    if (column.cards.length === 0) {
      void deleteColumnCascadeAction(workspaceId, column.id);
    } else {
      showDeletePrompt = true;
    }
  }
</script>

<div
  class="column"
  draggable="true"
  ondragstart={handleColumnDragStart}
  ondragover={handleColumnDragOver}
  ondrop={handleColumnDrop}
>
  <div class="header">
    {#if editingName}
      <input
        type="text"
        bind:value={nameDraft}
        onblur={commitRename}
        onkeydown={(e) => e.key === "Enter" && commitRename()}
      />
    {:else}
      <span class="name" onclick={startRename} role="button" tabindex="0">{column.name}</span>
    {/if}
    <button type="button" class="delete" aria-label="Delete column" onclick={requestDeleteColumn}>×</button>
  </div>
  <div class="cards" ondragover={handleCardDragOver} ondrop={(e) => handleCardDrop(e, column.cards.length)}>
    {#each column.cards as card, index (card.id)}
      <div
        ondragover={(e) => {
          handleCardDragOver(e);
          e.stopPropagation();
        }}
        ondrop={(e) => {
          const position = handleCardSlotDragOver(e);
          handleCardDrop(e, position === "before" ? index : index + 1);
          e.stopPropagation();
        }}
      >
        <KanbanCard {card} columnId={column.id} {labels} onOpen={() => onOpenCard(card.id)} />
      </div>
    {/each}
  </div>
  <button type="button" class="add-card" onclick={onAddCard}>+ Add card</button>
</div>

{#if showDeletePrompt}
  <DeleteColumnPrompt
    columnName={column.name}
    cardCount={column.cards.length}
    {otherColumns}
    onDeleteCards={() => {
      showDeletePrompt = false;
      void deleteColumnCascadeAction(workspaceId, column.id);
    }}
    onMoveCards={(targetColumnId) => {
      showDeletePrompt = false;
      void moveCardsOutOfColumnAndDeleteAction(workspaceId, column.id, targetColumnId);
    }}
    onCancel={() => (showDeletePrompt = false)}
  />
{/if}

<style>
  .column {
    background: #232323;
    border-radius: 8px;
    padding: 10px;
    width: 240px;
    flex: 0 0 auto;
    display: flex;
    flex-direction: column;
    max-height: 100%;
  }
  .header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 8px;
    color: #eee;
    font-family: monospace;
    font-weight: bold;
  }
  .header input {
    background: #1e1e1e;
    border: 1px solid #444;
    color: #eee;
    font-family: monospace;
    padding: 2px 4px;
    border-radius: 4px;
    flex: 1 1 auto;
    min-width: 0;
  }
  .header .name {
    cursor: text;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .delete {
    background: transparent;
    border: none;
    color: #999;
    cursor: pointer;
    font-size: 1.1em;
  }
  .cards {
    overflow-y: auto;
    flex: 1 1 auto;
  }
  .add-card {
    background: transparent;
    border: none;
    color: #999;
    cursor: pointer;
    font-family: monospace;
    text-align: left;
    padding: 4px 0;
  }
</style>
```

- [ ] **Step 5: Create `KanbanBoard.svelte`**

```svelte
<script lang="ts">
  import { kanbanState, fetchBoard, boardError, retryFetchBoard, addCardAction, addColumnAction, updateCardAction } from "./kanbanState";
  import KanbanColumn from "./KanbanColumn.svelte";
  import CardDetailModal from "./CardDetailModal.svelte";
  import type { Card } from "./kanban";

  interface Props {
    workspaceId: string;
  }
  let { workspaceId }: Props = $props();

  let openCardId = $state<string | null>(null);

  $effect(() => {
    void fetchBoard(workspaceId);
  });

  const board = $derived($kanbanState[workspaceId]);
  const error = $derived(boardError(workspaceId));
  const openCard = $derived<Card | null>(
    board && openCardId ? (board.columns.flatMap((c) => c.cards).find((c) => c.id === openCardId) ?? null) : null
  );

  function addColumn(): void {
    const name = "New column";
    void addColumnAction(workspaceId, {
      id: crypto.randomUUID(),
      name,
      position: board?.columns.length ?? 0,
      cards: [],
    });
  }

  function addCardTo(columnId: string): void {
    void addCardAction(workspaceId, columnId, {
      id: crypto.randomUUID(),
      title: "New card",
      description: "",
      labelIds: [],
      priority: "none",
      position: board?.columns.find((c) => c.id === columnId)?.cards.length ?? 0,
    });
  }
</script>

{#if error}
  <div class="overlay">
    <p>Couldn't load this board.</p>
    <p class="detail">{error}</p>
    <button onclick={() => retryFetchBoard(workspaceId)}>Retry</button>
  </div>
{:else if !board}
  <div class="overlay">
    <p>Loading board…</p>
  </div>
{:else}
  <div class="board">
    {#each board.columns as column (column.id)}
      <KanbanColumn
        {workspaceId}
        {column}
        otherColumns={board.columns.filter((c) => c.id !== column.id).map((c) => ({ id: c.id, name: c.name }))}
        labels={board.labels}
        onOpenCard={(cardId) => (openCardId = cardId)}
        onAddCard={() => addCardTo(column.id)}
      />
    {/each}
    <button type="button" class="add-column" onclick={addColumn}>+ Add column</button>
  </div>
  {#if openCard}
    <CardDetailModal
      card={openCard}
      labels={board.labels}
      onSave={(patch) => void updateCardAction(workspaceId, openCard.id, patch)}
      onClose={() => (openCardId = null)}
    />
  {/if}
{/if}

<style>
  .board {
    display: flex;
    gap: 12px;
    padding: 16px;
    overflow-x: auto;
    height: 100%;
    box-sizing: border-box;
  }
  .add-column {
    background: transparent;
    border: 1px dashed #444;
    border-radius: 8px;
    color: #999;
    cursor: pointer;
    font-family: monospace;
    padding: 10px;
    width: 240px;
    flex: 0 0 auto;
    align-self: flex-start;
  }
  .overlay {
    flex: 1 1 auto;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    color: #eee;
    font-family: monospace;
    height: 100%;
  }
  .detail {
    opacity: 0.7;
    font-size: 0.85em;
  }
  .overlay button {
    margin-top: 12px;
    padding: 8px 16px;
    background: #3a3a3a;
    border: none;
    color: #eee;
    border-radius: 4px;
    cursor: pointer;
    font-family: monospace;
  }
</style>
```

Card deletion isn't exposed in this task's UI (only add/edit via the detail modal), so `deleteCardAction` is deliberately not imported here — a future Notes/Archive-adjacent milestone can add a delete control to `CardDetailModal.svelte` without needing any change to this file.

- [ ] **Step 6: Run the frontend type checker**

Run: `npm run check` (from `app/`)
Expected: 0 errors (same pre-existing a11y warnings as before this task — the new `role="button" tabindex="0"` usages on clickable non-button elements match this codebase's own existing pattern, e.g. `Sidebar.svelte`'s page-name click handlers).

- [ ] **Step 7: Commit**

```bash
git add app/src/lib/dragDrop.ts app/src/lib/KanbanCard.svelte app/src/lib/KanbanColumn.svelte app/src/lib/KanbanBoard.svelte
git commit -m "feat(app): add KanbanBoard/KanbanColumn/KanbanCard with drag-and-drop"
```

---

### Task 8: The workspace-view registry and the tab bar

**Files:**
- Create: `app/src/lib/TerminalView.svelte`
- Create: `app/src/lib/workspaceViews.ts`
- Modify: `app/src/routes/+page.svelte`
- Modify: `app/src/lib/Sidebar.svelte` (page-click switches the active tab back to `"terminal"`)

**Interfaces:**
- Consumes: `KanbanBoard.svelte` (Task 7), `switchWorkspaceView`/`getActiveView` (Task 1), `switchPage` (existing).

**Design note**: the registry must genuinely drive content rendering — a component per view, looked up dynamically — not a hardcoded `{#if activeView === "kanban"}` two-way branch with the registry supplying only tab labels/icons. The spec is explicit about this ("adding a future tab means adding one registry entry and its own component... instead of a two-armed `if`"), and it's the reason the user chose the extensible-registry option over the simpler two-hardcoded-tabs alternative during brainstorming. To make that work, both views need an *identical* prop interface — `{ workspaceId: string }` — so `<svelte:component this={activeViewDef.component} workspaceId={...} />` type-checks regardless of which view is active. `+page.svelte`'s existing Terminal rendering (the empty-state-or-`LayoutTree` logic) isn't self-contained today — it's inlined directly in `+page.svelte`, reading script-level `activeTree`/calling a script-level `addPageToActiveWorkspace`. Step 1 below extracts it into its own `TerminalView.svelte` first, taking `workspaceId` as its only prop (deriving everything else internally from `$layoutState`), so it matches `KanbanBoard.svelte`'s own shape exactly.

- [ ] **Step 1: Create `TerminalView.svelte`**

This extracts `+page.svelte`'s current empty-state-or-`LayoutTree` logic verbatim into its own component:

```svelte
<script lang="ts">
  import { layoutState, createPage } from "./layoutState";
  import { presetSingle } from "./layout";
  import LayoutTree from "./LayoutTree.svelte";

  interface Props {
    workspaceId: string;
  }
  let { workspaceId }: Props = $props();

  const ws = $derived($layoutState.workspaces.find((w) => w.id === workspaceId) ?? null);
  const activeTree = $derived(ws ? (ws.pages.find((p) => p.id === ws.activePageId)?.layout ?? null) : null);

  async function addPage(): Promise<void> {
    if (!ws) return;
    await createPage(ws.id, ([id]) => presetSingle(id), 1, `Page ${ws.pages.length + 1}`);
  }
</script>

{#if !activeTree}
  <div class="overlay">
    <button onclick={addPage}>New Page</button>
  </div>
{:else}
  <div class="tree">
    <LayoutTree node={activeTree} path={[]} />
  </div>
{/if}

<style>
  .tree {
    width: 100%;
    height: 100%;
    position: relative;
  }
  .overlay {
    flex: 1 1 auto;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    color: #eee;
    font-family: monospace;
    height: 100%;
  }
  .overlay button {
    margin-top: 12px;
    padding: 8px 16px;
    background: #3a3a3a;
    border: none;
    color: #eee;
    border-radius: 4px;
    cursor: pointer;
    font-family: monospace;
  }
</style>
```

- [ ] **Step 2: Create the registry**

```ts
// app/src/lib/workspaceViews.ts
import type { Component } from "svelte";
import { Terminal, Kanban } from "@lucide/svelte";
import TerminalView from "./TerminalView.svelte";
import KanbanBoard from "./KanbanBoard.svelte";

export interface WorkspaceView {
  id: string;
  label: string;
  icon: Component;
  component: Component<{ workspaceId: string }>;
}

export const WORKSPACE_VIEWS: WorkspaceView[] = [
  { id: "terminal", label: "Terminal", icon: Terminal, component: TerminalView },
  { id: "kanban", label: "Kanban", icon: Kanban, component: KanbanBoard },
];
```

- [ ] **Step 3: Update `+page.svelte`'s content area**

Read the current file in full before editing — it's short (under 150 lines). In the `<script>` block, add these imports alongside the existing ones, and **remove** the now-unused `LayoutTree`/`presetSingle`/`addPageToActiveWorkspace` pieces (their logic now lives entirely inside `TerminalView.svelte`):

```ts
import { getActiveView, switchWorkspaceView } from "$lib/workspace";
import { WORKSPACE_VIEWS } from "$lib/workspaceViews";
```

Delete the file's existing `import LayoutTree from "$lib/LayoutTree.svelte";` line, the existing `import { presetSingle } from "$lib/layout";` line, and the existing `addPageToActiveWorkspace` function — all three are now owned by `TerminalView.svelte` instead. Keep `activeTree`'s own `$derived` removed too (nothing outside `TerminalView.svelte` needs it anymore); keep `activeWorkspace`'s `$derived` — it's still needed for the tab bar and the `{#if !activeWorkspace}` empty-state check.

Add a derived value for the active view definition, near the (kept) `activeWorkspace` derivation:

```ts
const activeView = $derived(activeWorkspace ? getActiveView(activeWorkspace) : "terminal");
const activeViewDef = $derived(WORKSPACE_VIEWS.find((v) => v.id === activeView) ?? WORKSPACE_VIEWS[0]);
```

Replace the existing content-area block:

```svelte
      {#if !activeWorkspace}
        <div class="overlay">
          <button onclick={createFirstWorkspace}>New Workspace</button>
        </div>
      {:else if !activeTree}
        <div class="overlay">
          <button onclick={addPageToActiveWorkspace}>New Page</button>
        </div>
      {:else}
        <div class="tree">
          <LayoutTree node={activeTree} path={[]} />
        </div>
      {/if}
```

with:

```svelte
      {#if !activeWorkspace}
        <div class="overlay">
          <button onclick={createFirstWorkspace}>New Workspace</button>
        </div>
      {:else}
        <div class="content">
          <div class="tabs">
            {#each WORKSPACE_VIEWS as view (view.id)}
              <button
                type="button"
                class="tab"
                class:active={activeView === view.id}
                onclick={() => switchWorkspaceView(activeWorkspace.id, view.id)}
              >
                <view.icon size={14} />
                {view.label}
              </button>
            {/each}
          </div>
          <div class="view">
            <svelte:component this={activeViewDef.component} workspaceId={activeWorkspace.id} />
          </div>
        </div>
      {/if}
```

This is genuinely registry-driven: a third future tab needs only a new `WORKSPACE_VIEWS` entry and its own component — nothing here changes.

Add to the `<style>` block:

```css
  .content {
    flex: 1 1 auto;
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
  }
  .tabs {
    display: flex;
    gap: 4px;
    padding: 6px 10px 0;
    flex: 0 0 auto;
  }
  .tab {
    display: flex;
    align-items: center;
    gap: 6px;
    background: transparent;
    border: none;
    border-bottom: 2px solid transparent;
    color: #999;
    padding: 6px 10px;
    cursor: pointer;
    font-family: monospace;
    font-size: 0.85em;
  }
  .tab.active {
    color: #eee;
    border-bottom-color: #d9a648;
  }
  .view {
    flex: 1 1 auto;
    min-height: 0;
    position: relative;
  }
```

The existing `.tree` and `.overlay` style rules stay exactly as they are — `.tree` now sits inside `.view` instead of directly inside `.body`, which needs no style change since both are `flex: 1 1 auto` containers.

- [ ] **Step 4: Make clicking a page switch the active tab back to Terminal**

In `app/src/lib/Sidebar.svelte`, find this file's existing `$lib/layoutState`-sourced import line (it already imports action functions like `switchPage`/`switchWorkspace`) and add `switchWorkspaceView` to it — this must be the **async action** from `layoutState.ts` (which persists), not the pure function of the same name from `workspace.ts` (which only computes a new state object).

Find the `onclick={() => switchPage(ws.id, page.id)}` call site (it appears twice in this file — once in the collapsed-multi-repo row rendering, once in the normal page row) and change both to:

```ts
onclick={() => {
  switchWorkspaceView(ws.id, "terminal");
  switchPage(ws.id, page.id);
}}
```

- [ ] **Step 5: Run the frontend type checker**

Run: `npm run check` (from `app/`)
Expected: 0 errors (same pre-existing a11y warnings as before this task).

- [ ] **Step 6: Run the full frontend test suite**

Run: `npm test` (from `app/`)
Expected: PASS, every test across every file — this task doesn't add new pure logic of its own (the registry is a static array, `TerminalView.svelte`/`+page.svelte`/`Sidebar.svelte` are UI wiring with no dedicated automated test per this project's consistent limitation), so no new test count to predict here beyond what Tasks 1-5 already added.

- [ ] **Step 7: Commit**

```bash
git add app/src/lib/TerminalView.svelte app/src/lib/workspaceViews.ts app/src/routes/+page.svelte app/src/lib/Sidebar.svelte
git commit -m "feat(app): add the workspace-view tab bar, wiring in Terminal and Kanban"
```

---

## Manual smoke test (not automated — flag explicitly when this plan is done)

Once all 8 tasks are complete: launch the app, open a workspace, confirm the Terminal/Kanban tab bar appears and Terminal looks unchanged; switch to Kanban, confirm the default To Do/In Progress/Done columns appear; add a card, drag it between columns, click it to open the detail modal and set a priority/label, save; add a second column, delete a column that has cards in it and confirm the move-or-delete prompt appears and both paths work; delete the workspace and confirm no error (the board's `delete_board` call succeeding silently is the whole point — there's no visible confirmation for this specific piece, since the workspace itself disappearing is the visible signal).
