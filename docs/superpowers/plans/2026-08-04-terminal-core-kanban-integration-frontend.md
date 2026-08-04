# Kanban Integration Layer — Frontend (Part 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the frontend half of the kanban-to-terminal-session integration — linking a card to a session (existing or freshly created), showing its live status on the card face, jumping to/re-launching/unlinking it from the card's detail modal, and prompting before deleting a card whose linked session is still running.

**Architecture:** Pure data-model and mutation-logic additions land first (`kanban.ts`'s `SessionLink`/`linkSession`/`unlinkSession`/`updateSessionLink`, `workspace.ts`'s `findSessionLocation`), then their thin stateful wrappers (`kanbanState.ts`'s `*Action` functions, `layoutState.ts`'s new `createSessionForCard` orchestration action), then the UI itself (`KanbanCard.svelte`'s status dot and delete button, a new `DeleteCardWithSessionPrompt.svelte` wired into `KanbanColumn.svelte`, and `CardDetailModal.svelte`'s new Session section). Part 1 (Backend) already shipped everything this plan's UI needs on the wire: `SessionLink` round-trips through `GetBoard`/`SetBoard` via `Card.sessionLink`, and `backend.createSession(cwd?, command?)` already accepts the two new optional parameters.

**Tech Stack:** Svelte 5 (runes), TypeScript, Vitest.

## Global Constraints

- Part 1 (Backend) is already merged to `main` (commits `f90057b`..`4040c15`) — do not modify `crates/protocol`, `crates/daemon`, or `app/src-tauri`. `backend.createSession(cwd?: string, command?: string): Promise<string>` and `Card.sessionLink?: SessionLink` (wire shape) already exist; this plan is TypeScript/Svelte only.
- `SessionLink` (TypeScript, `app/src/lib/kanban.ts`): `{ sessionId: string; cwd: string; command: string | null }` — matches the already-shipped Rust shape (`camelCase` on the wire) exactly. `Card.sessionLink?: SessionLink` — optional, so no existing `Card` object literal in this codebase needs updating (TypeScript's structural optionality, unlike Rust's struct-literal field-completeness requirement that Part 1 had to work around).
- No session exclusivity: a session may be referenced by multiple cards. Never add code that treats `sessionId` as unique across cards.
- A card's own `sessionLink` only ever stores a bare `sessionId` — never cache `workspaceId`/`pageId` alongside it anywhere. Every place that needs to know where a linked session currently lives calls `findSessionLocation` fresh, at the moment it's needed.
- The delete-card-with-linked-session prompt only appears when `findSessionLocation` finds the linked session present in *some* page (not necessarily the card's own workspace) — an already-exited link skips the prompt.
- User works directly on `main` (no worktree) — standing preference for this project.
- This session has hit the 200-subagent spawn cap seven times so far, always on a fresh plan's very first dispatch, each time resolved by the user choosing direct controller implementation. Expect this may happen again; it is not a sign anything is wrong with this plan.
- Testing scope: only `kanban.ts`, `workspace.ts`, `kanbanState.ts`, and `layoutState.ts` get automated tests (pure functions plus their thin stateful wrappers, matching this codebase's own established testing convention for `layoutState.ts`/`kanbanState.ts` action functions). The Svelte components (`KanbanCard.svelte`, `KanbanColumn.svelte`, `DeleteCardWithSessionPrompt.svelte`, `CardDetailModal.svelte`) get **no automated tests** — this codebase has never had rendering/interaction test coverage for any Svelte component, and this plan does not introduce that. Each component task's own "testing" step is `npm run check` (type-check) plus running the full suite to confirm no regressions; a manual GUI smoke test is called out explicitly as the real verification for those tasks.
- Every commit stages only the files that specific task actually needs — never `git add -A` / `git add .`.

---

### Task 1: `kanban.ts` — `SessionLink` data model + pure link/unlink/update functions

**Files:**
- Modify: `app/src/lib/kanban.ts`
- Test: `app/src/lib/kanban.test.ts`

**Interfaces:**
- Produces: `export interface SessionLink { sessionId: string; cwd: string; command: string | null }`; `Card.sessionLink?: SessionLink`; `linkSession(board: Board, cardId: string, sessionLink: SessionLink): Board`; `unlinkSession(board: Board, cardId: string): Board`; `updateSessionLink(board: Board, cardId: string, sessionId: string): Board`.

- [ ] **Step 1: Write the failing tests**

Add to `app/src/lib/kanban.test.ts`, after the existing `describe("deleteCard", ...)` block:

```ts
describe("linkSession", () => {
  it("sets the card's sessionLink", () => {
    const b = board([{ id: "c1", cards: [card("card-1", 0)] }]);
    const link = { sessionId: "s1", cwd: "/tmp", command: null };
    const updated = linkSession(b, "card-1", link);
    expect(updated.columns[0].cards[0].sessionLink).toEqual(link);
  });

  it("leaves other cards untouched", () => {
    const b = board([{ id: "c1", cards: [card("card-1", 0), card("card-2", 1)] }]);
    const updated = linkSession(b, "card-1", { sessionId: "s1", cwd: "/tmp", command: null });
    expect(updated.columns[0].cards[1].sessionLink).toBeUndefined();
  });
});

describe("unlinkSession", () => {
  it("clears the card's sessionLink", () => {
    const linked = { ...card("card-1", 0), sessionLink: { sessionId: "s1", cwd: "/tmp", command: null } };
    const b = board([{ id: "c1", cards: [linked] }]);
    const updated = unlinkSession(b, "card-1");
    expect(updated.columns[0].cards[0].sessionLink).toBeUndefined();
  });
});

describe("updateSessionLink", () => {
  it("replaces the sessionId while preserving cwd/command", () => {
    const linked = { ...card("card-1", 0), sessionLink: { sessionId: "old", cwd: "/tmp/project", command: "npm test" } };
    const b = board([{ id: "c1", cards: [linked] }]);
    const updated = updateSessionLink(b, "card-1", "new");
    expect(updated.columns[0].cards[0].sessionLink).toEqual({ sessionId: "new", cwd: "/tmp/project", command: "npm test" });
  });

  it("is a no-op when the card has no existing link", () => {
    const b = board([{ id: "c1", cards: [card("card-1", 0)] }]);
    const updated = updateSessionLink(b, "card-1", "new");
    expect(updated.columns[0].cards[0].sessionLink).toBeUndefined();
  });
});
```

Add `linkSession`, `unlinkSession`, `updateSessionLink` to the existing `import { ... } from "./kanban";` block at the top of the file.

- [ ] **Step 2: Run the tests to verify they fail**

Run (from `app/`): `npm test -- src/lib/kanban.test.ts`
Expected: FAIL to compile — `linkSession`/`unlinkSession`/`updateSessionLink` don't exist yet.

- [ ] **Step 3: Add `SessionLink`, `Card.sessionLink`, and the three functions**

In `app/src/lib/kanban.ts`, add a new interface right before `export interface Card`:

```ts
export interface SessionLink {
  sessionId: string;
  cwd: string;
  command: string | null;
}
```

Add `sessionLink` as `Card`'s last field:

```ts
export interface Card {
  id: string;
  title: string;
  description: string;
  labelIds: string[];
  priority: Priority;
  position: number;
  sessionLink?: SessionLink;
}
```

Add the three functions after `deleteCard`:

```ts
export function linkSession(board: Board, cardId: string, sessionLink: SessionLink): Board {
  return {
    ...board,
    columns: board.columns.map((c) => ({
      ...c,
      cards: c.cards.map((card) => (card.id === cardId ? { ...card, sessionLink } : card)),
    })),
  };
}

export function unlinkSession(board: Board, cardId: string): Board {
  return {
    ...board,
    columns: board.columns.map((c) => ({
      ...c,
      cards: c.cards.map((card) => (card.id === cardId ? { ...card, sessionLink: undefined } : card)),
    })),
  };
}

// Replaces just the linked sessionId, preserving the remembered cwd/command
// -- used by "re-launch," which recreates a session at the same cwd/command
// as the one that exited, then points the card at the fresh id.
export function updateSessionLink(board: Board, cardId: string, sessionId: string): Board {
  return {
    ...board,
    columns: board.columns.map((c) => ({
      ...c,
      cards: c.cards.map((card) =>
        card.id === cardId && card.sessionLink ? { ...card, sessionLink: { ...card.sessionLink, sessionId } } : card
      ),
    })),
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- src/lib/kanban.test.ts`
Expected: PASS, all tests (23 total: 18 existing + 5 new — 2 for `linkSession`, 1 for `unlinkSession`, 2 for `updateSessionLink`).

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/kanban.ts app/src/lib/kanban.test.ts
git commit -m "feat(kanban): add SessionLink type and linkSession/unlinkSession/updateSessionLink"
```

---

### Task 2: `workspace.ts` — `findSessionLocation`

**Files:**
- Modify: `app/src/lib/workspace.ts`
- Test: `app/src/lib/workspace.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1 (independent).
- Produces: `findSessionLocation(state: WorkspacesData, sessionId: string): { workspaceId: string; pageId: string } | null`.

- [ ] **Step 1: Write the failing tests**

Add to `app/src/lib/workspace.test.ts`, after the existing `describe("allSessionIdsInWorkspace", ...)` block:

```ts
describe("findSessionLocation", () => {
  it("finds a session in its own workspace", () => {
    const state: WorkspacesData = {
      workspaces: [{ id: "ws-1", name: "A", pages: [page("page-1", leaf(["s1", "s2"]))], activePageId: "page-1" }],
      activeWorkspaceId: "ws-1",
    };
    expect(findSessionLocation(state, "s2")).toEqual({ workspaceId: "ws-1", pageId: "page-1" });
  });

  it("finds a session after it's moved to a different workspace", () => {
    const state: WorkspacesData = {
      workspaces: [
        { id: "ws-1", name: "A", pages: [page("page-1", leaf(["s1"]))], activePageId: "page-1" },
        { id: "ws-2", name: "B", pages: [page("page-2", leaf(["s2"]))], activePageId: "page-2" },
      ],
      activeWorkspaceId: "ws-1",
    };
    expect(findSessionLocation(state, "s2")).toEqual({ workspaceId: "ws-2", pageId: "page-2" });
  });

  it("returns null for a session that's exited or not present in any page", () => {
    const state: WorkspacesData = {
      workspaces: [{ id: "ws-1", name: "A", pages: [page("page-1", leaf(["s1"]))], activePageId: "page-1" }],
      activeWorkspaceId: "ws-1",
    };
    expect(findSessionLocation(state, "gone")).toBeNull();
  });
});
```

Add `findSessionLocation` to the existing `import { ... } from "./workspace";` block at the top of the file.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- src/lib/workspace.test.ts`
Expected: FAIL to compile — `findSessionLocation` doesn't exist yet.

- [ ] **Step 3: Add `findSessionLocation`**

In `app/src/lib/workspace.ts`, add after `allSessionIdsInWorkspace`:

```ts
// Searches every workspace's every page for sessionId, fresh at call time
// (never cached) -- a card's sessionLink only stores a bare sessionId, and
// this is how "jump to session"/"is this session still alive" resolve
// which workspace/page currently hosts it, since a tab can move between
// pages and workspaces after a card links to it.
export function findSessionLocation(
  state: WorkspacesData,
  sessionId: string
): { workspaceId: string; pageId: string } | null {
  for (const ws of state.workspaces) {
    for (const page of ws.pages) {
      if (allSessionIds(page.layout).includes(sessionId)) {
        return { workspaceId: ws.id, pageId: page.id };
      }
    }
  }
  return null;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- src/lib/workspace.test.ts`
Expected: PASS, all tests (3 new, plus all existing passing).

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/workspace.ts app/src/lib/workspace.test.ts
git commit -m "feat(workspace): add findSessionLocation"
```

---

### Task 3: `kanbanState.ts` — link/unlink/update session actions

**Files:**
- Modify: `app/src/lib/kanbanState.ts`
- Test: `app/src/lib/kanbanState.test.ts`

**Interfaces:**
- Consumes: Task 1's `linkSession`, `unlinkSession`, `updateSessionLink`, `SessionLink`.
- Produces: `linkSessionAction(workspaceId: string, cardId: string, sessionLink: SessionLink): Promise<void>`; `unlinkSessionAction(workspaceId: string, cardId: string): Promise<void>`; `updateSessionLinkAction(workspaceId: string, cardId: string, sessionId: string): Promise<void>`.

- [ ] **Step 1: Write the failing tests**

Add to `app/src/lib/kanbanState.test.ts`, after the existing `describe("deleteColumnCascadeAction", ...)` block:

```ts
describe("linkSessionAction", () => {
  it("mutates local state immediately and persists via setBoard", async () => {
    vi.mocked(backend.getBoard).mockResolvedValue({
      columns: [
        {
          id: "c1",
          name: "To Do",
          position: 0,
          cards: [{ id: "card-1", title: "Card", description: "", labelIds: [], priority: "none", position: 0 }],
        },
      ],
      labels: [],
    });
    await fetchBoard("ws-1");

    await linkSessionAction("ws-1", "card-1", { sessionId: "s1", cwd: "/tmp", command: null });

    expect(get(kanbanState)["ws-1"].columns[0].cards[0].sessionLink).toEqual({
      sessionId: "s1",
      cwd: "/tmp",
      command: null,
    });
    expect(backend.setBoard).toHaveBeenCalledWith("ws-1", get(kanbanState)["ws-1"].columns, []);
  });
});

describe("unlinkSessionAction", () => {
  it("clears the card's sessionLink and persists", async () => {
    vi.mocked(backend.getBoard).mockResolvedValue({
      columns: [
        {
          id: "c1",
          name: "To Do",
          position: 0,
          cards: [
            {
              id: "card-1",
              title: "Card",
              description: "",
              labelIds: [],
              priority: "none",
              position: 0,
              sessionLink: { sessionId: "s1", cwd: "/tmp", command: null },
            },
          ],
        },
      ],
      labels: [],
    });
    await fetchBoard("ws-1");

    await unlinkSessionAction("ws-1", "card-1");

    expect(get(kanbanState)["ws-1"].columns[0].cards[0].sessionLink).toBeUndefined();
  });
});

describe("updateSessionLinkAction", () => {
  it("replaces the linked sessionId and persists", async () => {
    vi.mocked(backend.getBoard).mockResolvedValue({
      columns: [
        {
          id: "c1",
          name: "To Do",
          position: 0,
          cards: [
            {
              id: "card-1",
              title: "Card",
              description: "",
              labelIds: [],
              priority: "none",
              position: 0,
              sessionLink: { sessionId: "old", cwd: "/tmp", command: null },
            },
          ],
        },
      ],
      labels: [],
    });
    await fetchBoard("ws-1");

    await updateSessionLinkAction("ws-1", "card-1", "new");

    expect(get(kanbanState)["ws-1"].columns[0].cards[0].sessionLink?.sessionId).toBe("new");
  });
});
```

Add `linkSessionAction`, `unlinkSessionAction`, `updateSessionLinkAction` to the existing `import { ... } from "./kanbanState";` block at the top of the file.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- src/lib/kanbanState.test.ts`
Expected: FAIL to compile — the three actions don't exist yet.

- [ ] **Step 3: Add the three actions**

In `app/src/lib/kanbanState.ts`, change the type import at the top from:

```ts
import type { Board, Card, Column, Label } from "./kanban";
```

to:

```ts
import type { Board, Card, Column, Label, SessionLink } from "./kanban";
```

Add after `deleteCardAction`:

```ts
export function linkSessionAction(workspaceId: string, cardId: string, sessionLink: SessionLink): Promise<void> {
  return mutateAndPersist(workspaceId, (b) => kanban.linkSession(b, cardId, sessionLink));
}

export function unlinkSessionAction(workspaceId: string, cardId: string): Promise<void> {
  return mutateAndPersist(workspaceId, (b) => kanban.unlinkSession(b, cardId));
}

export function updateSessionLinkAction(workspaceId: string, cardId: string, sessionId: string): Promise<void> {
  return mutateAndPersist(workspaceId, (b) => kanban.updateSessionLink(b, cardId, sessionId));
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- src/lib/kanbanState.test.ts`
Expected: PASS, all tests (3 new, plus all existing passing).

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/kanbanState.ts app/src/lib/kanbanState.test.ts
git commit -m "feat(kanbanState): add linkSessionAction/unlinkSessionAction/updateSessionLinkAction"
```

---

### Task 4: `layoutState.ts` — `createSessionForCard`

**Files:**
- Modify: `app/src/lib/layoutState.ts`
- Test: `app/src/lib/layoutState.test.ts`

**Interfaces:**
- Consumes: nothing from Tasks 1-3 (independent — this task only creates and homes a session, it doesn't touch kanban data at all). Uses the already-shipped `backend.createSession(cwd?: string, command?: string): Promise<string>` (Part 1), and this file's own existing `workspace.createPage`, `workspace.setPageFocus`, `workspace.updatePageLayout`, `layout.presetSingle`, `layout.addTab`, `layout.allSessionIds`, `persistWorkspaces`, `setError`.
- Produces: `createSessionForCard(workspaceId: string, cwd: string, command: string | null): Promise<string | null>`.

- [ ] **Step 1: Write the failing tests**

Add to `app/src/lib/layoutState.test.ts`, after the existing `describe("createPage", ...)` block, and add `createSessionForCard` to the existing `import { ... } from "./layoutState";` block at the top of the file:

```ts
describe("createSessionForCard", () => {
  it("creates a page and homes the session there when the workspace has zero pages", async () => {
    setState([ws("ws-1", [])], "ws-1", null);
    vi.mocked(backend.createSession).mockResolvedValue("s1");

    const sessionId = await createSessionForCard("ws-1", "", null);

    expect(sessionId).toBe("s1");
    const state = get(layoutState);
    expect(state.workspaces[0].pages).toHaveLength(1);
    expect(state.workspaces[0].pages[0].layout).toEqual(leaf(["s1"]));
    expect(state.focusedSessionId).toBe("s1");
  });

  it("adds a tab to the workspace's active page when it already has pages", async () => {
    setState([ws("ws-1", [page("page-1", leaf(["a"]))])], "ws-1", "a");
    vi.mocked(backend.createSession).mockResolvedValue("s1");

    const sessionId = await createSessionForCard("ws-1", "/tmp", "npm test");

    expect(sessionId).toBe("s1");
    const state = get(layoutState);
    expect(state.workspaces[0].pages[0].layout).toEqual(leaf(["a", "s1"], 1));
  });

  it("passes a non-blank cwd/command straight through to backend.createSession", async () => {
    setState([ws("ws-1", [page("page-1", leaf(["a"]))])], "ws-1", "a");
    vi.mocked(backend.createSession).mockResolvedValue("s1");

    await createSessionForCard("ws-1", "/tmp/project", "npm test");

    expect(backend.createSession).toHaveBeenCalledWith("/tmp/project", "npm test");
  });

  it("converts a blank cwd and a null command to undefined for backend.createSession", async () => {
    setState([ws("ws-1", [])], "ws-1", null);
    vi.mocked(backend.createSession).mockResolvedValue("s1");

    await createSessionForCard("ws-1", "", null);

    expect(backend.createSession).toHaveBeenCalledWith(undefined, undefined);
  });

  it("returns null and surfaces an error when session creation fails", async () => {
    setState([ws("ws-1", [])], "ws-1", null);
    vi.mocked(backend.createSession).mockRejectedValue(new Error("daemon unreachable"));

    const sessionId = await createSessionForCard("ws-1", "", null);

    expect(sessionId).toBeNull();
    expect(get(layoutState).status).toBe("error");
  });

  it("is a no-op for an unknown workspace id", async () => {
    setState([ws("ws-1", [])], "ws-1", null);

    const sessionId = await createSessionForCard("missing", "", null);

    expect(sessionId).toBeNull();
    expect(backend.createSession).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- src/lib/layoutState.test.ts`
Expected: FAIL to compile — `createSessionForCard` doesn't exist yet.

- [ ] **Step 3: Add `createSessionForCard`**

In `app/src/lib/layoutState.ts`, add after `createPage`:

```ts
// Creates a fresh session for a kanban card link, homing it in the given
// workspace: added as a new tab on the workspace's active page if it has
// one, or a freshly created single-pane page (mirroring createPage's own
// default preset) if the workspace has zero pages yet. Unlike
// splitPane/addTab, this always targets an explicit workspaceId rather
// than "whichever page/workspace is currently active" -- the kanban hub
// this is called from is not necessarily showing a terminal view at all.
// cwd/command mirror SessionLink's own shape ("" / null both mean
// "use the default"), converted to undefined here -- the one place that
// conversion happens, so every caller (create-new, re-launch) can just
// pass a SessionLink's fields straight through.
export async function createSessionForCard(
  workspaceId: string,
  cwd: string,
  command: string | null
): Promise<string | null> {
  const state = get(layoutState);
  const ws = state.workspaces.find((w) => w.id === workspaceId);
  if (!ws) return null;

  let sessionId: string;
  try {
    sessionId = await backend.createSession(cwd || undefined, command ?? undefined);
  } catch (e) {
    setError(String(e));
    return null;
  }

  if (ws.pages.length === 0) {
    const pageId = crypto.randomUUID();
    const created = workspace.createPage(state, workspaceId, pageId, "Page 1", layout.presetSingle(sessionId));
    const data = workspace.setPageFocus(created, workspaceId, pageId, sessionId);
    layoutState.update((s) => ({
      ...s,
      workspaces: data.workspaces,
      activeWorkspaceId: workspaceId,
      focusedSessionId: sessionId,
    }));
    await persistWorkspaces(data.workspaces, data.activeWorkspaceId);
    return sessionId;
  }

  const pageId = ws.activePageId ?? ws.pages[0].id;
  const page = ws.pages.find((p) => p.id === pageId);
  if (!page) return sessionId;
  const anchor = layout.allSessionIds(page.layout)[0];
  const newTree = anchor ? layout.addTab(page.layout, anchor, sessionId) : layout.presetSingle(sessionId);
  const withTree = workspace.updatePageLayout(state, workspaceId, pageId, newTree);
  const data = workspace.setPageFocus(withTree, workspaceId, pageId, sessionId);
  layoutState.update((s) => ({ ...s, workspaces: data.workspaces }));
  await persistWorkspaces(data.workspaces, state.activeWorkspaceId);
  return sessionId;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- src/lib/layoutState.test.ts`
Expected: PASS, all tests (6 new, plus all existing passing).

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/layoutState.ts app/src/lib/layoutState.test.ts
git commit -m "feat(layoutState): add createSessionForCard"
```

---

### Task 5: `KanbanCard.svelte` — status dot + delete button

**Files:**
- Modify: `app/src/lib/KanbanCard.svelte`

**Interfaces:**
- Consumes: Task 2's `findSessionLocation`. Reads `$layoutState.sessionStatusById` (already exists).
- Produces: `KanbanCard` gains a new required prop `onDelete: () => void`.

- [ ] **Step 1: Replace the file**

Replace the full contents of `app/src/lib/KanbanCard.svelte`:

```svelte
<script lang="ts">
  import type { Card, Label } from "./kanban";
  import { setDragPayload } from "./dragDrop";
  import { layoutState } from "./layoutState";
  import { findSessionLocation } from "./workspace";

  interface Props {
    card: Card;
    columnId: string;
    labels: Label[];
    onOpen: () => void;
    onDelete: () => void;
  }
  let { card, columnId, labels, onOpen, onDelete }: Props = $props();

  const cardLabels = $derived(labels.filter((l) => card.labelIds.includes(l.id)));

  function handleDragStart(event: DragEvent): void {
    setDragPayload(event, { kind: "kanban-card", cardId: card.id, sourceColumnId: columnId });
  }

  function handleDelete(event: MouseEvent): void {
    event.stopPropagation();
    onDelete();
  }

  // Reuses Pane.svelte's status-dot styling/meaning for working/waiting,
  // but unlike a tab (where "no dot" already means idle), a linked card
  // always shows *something* -- idle gets its own dot, and a session no
  // longer present in any page (exited, or never found) reads as a
  // distinct, dimmer state, since a card can stay linked to a long-gone
  // session indefinitely.
  function sessionDot(): { class: string; title: string } | null {
    if (!card.sessionLink) return null;
    const location = findSessionLocation($layoutState, card.sessionLink.sessionId);
    const status = location ? $layoutState.sessionStatusById[card.sessionLink.sessionId] : undefined;
    if (status === "working") return { class: "status-working", title: "Working" };
    if (status === "waiting_for_input") return { class: "status-waiting", title: "Request attention" };
    if (status === "idle") return { class: "status-idle", title: "Idle" };
    return { class: "status-exited", title: "Session exited" };
  }
</script>

<div class="card" draggable="true" ondragstart={handleDragStart} onclick={onOpen} role="button" tabindex="0">
  <div class="header">
    {#if card.priority !== "none"}
      <span class="priority priority-{card.priority}" title="Priority: {card.priority}"></span>
    {/if}
    {#if sessionDot()}
      {@const dot = sessionDot()}
      <span class="status-dot {dot?.class}" title={dot?.title}></span>
    {/if}
    <button type="button" class="delete" aria-label="Delete card" onclick={handleDelete}>×</button>
  </div>
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
  .header {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 4px;
  }
  .priority {
    display: inline-block;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex: 0 0 auto;
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
  .status-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    flex: 0 0 auto;
  }
  .status-dot.status-working {
    background: #4a9eff;
  }
  .status-dot.status-waiting {
    background: #e0524a;
  }
  .status-dot.status-idle {
    background: #6b8e6b;
  }
  .status-dot.status-exited {
    background: transparent;
    border: 1px solid #666;
  }
  .delete {
    background: transparent;
    border: none;
    color: #999;
    cursor: pointer;
    font-size: 1.1em;
    margin-left: auto;
    padding: 0;
    line-height: 1;
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

- [ ] **Step 2: Type-check**

Run (from `app/`): `npm run check`
Expected: FAILS at this point — `KanbanColumn.svelte` (Task 6) hasn't been updated yet to pass the new required `onDelete` prop to `<KanbanCard>`. This is expected; Task 6 fixes it. Confirm the only new error is exactly this missing-prop error on `KanbanColumn.svelte`'s `<KanbanCard ... />` call site, and that `KanbanCard.svelte` itself has no errors.

- [ ] **Step 3: Commit**

```bash
git add app/src/lib/KanbanCard.svelte
git commit -m "feat(KanbanCard): add session status dot and delete button"
```

---

### Task 6: `KanbanColumn.svelte` + `DeleteCardWithSessionPrompt.svelte` — delete-with-linked-session prompt

**Files:**
- Create: `app/src/lib/DeleteCardWithSessionPrompt.svelte`
- Modify: `app/src/lib/KanbanColumn.svelte`

**Interfaces:**
- Consumes: Task 2's `findSessionLocation`, Task 5's `KanbanCard` `onDelete` prop. Uses the already-existing `deleteCardAction` (`kanbanState.ts`) and `closeSession` (`layoutState.ts`).
- Produces: `KanbanColumn.svelte` now passes `onDelete` to every `<KanbanCard>`, fixing Task 5's expected type-check failure.

- [ ] **Step 1: Create `DeleteCardWithSessionPrompt.svelte`**

```svelte
<script lang="ts">
  import Modal from "./Modal.svelte";

  interface Props {
    onConfirm: () => void;
    onCancel: () => void;
  }
  let { onConfirm, onCancel }: Props = $props();
</script>

<Modal onClose={onCancel}>
  <p>Delete this card? Its linked session is still running and will be killed too.</p>
  <div class="actions">
    <button type="button" onclick={onCancel}>Cancel</button>
    <button type="button" class="danger" onclick={onConfirm}>Delete card &amp; kill session</button>
  </div>
</Modal>

<style>
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

- [ ] **Step 2: Wire it into `KanbanColumn.svelte`**

In `app/src/lib/KanbanColumn.svelte`, change the imports at the top from:

```ts
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
```

to:

```ts
  import type { Column, Label } from "./kanban";
  import KanbanCard from "./KanbanCard.svelte";
  import DeleteColumnPrompt from "./DeleteColumnPrompt.svelte";
  import DeleteCardWithSessionPrompt from "./DeleteCardWithSessionPrompt.svelte";
  import { setDragPayload, getDragKind, getDragPayload, computeReorderPosition } from "./dragDrop";
  import {
    moveCardAction,
    reorderColumnAction,
    renameColumnAction,
    deleteColumnCascadeAction,
    moveCardsOutOfColumnAndDeleteAction,
    deleteCardAction,
  } from "./kanbanState";
  import { layoutState, closeSession } from "./layoutState";
  import { findSessionLocation } from "./workspace";
```

Add a new state variable alongside the existing `showDeletePrompt`:

```ts
  let showDeletePrompt = $state(false);
  let pendingDeleteCardId = $state<string | null>(null);
```

Add two new functions after `requestDeleteColumn`:

```ts
  function requestDeleteCard(cardId: string): void {
    const target = column.cards.find((c) => c.id === cardId);
    const location = target?.sessionLink ? findSessionLocation($layoutState, target.sessionLink.sessionId) : null;
    if (location) {
      pendingDeleteCardId = cardId;
    } else {
      void deleteCardAction(workspaceId, cardId);
    }
  }

  async function confirmDeleteCard(): Promise<void> {
    const cardId = pendingDeleteCardId;
    pendingDeleteCardId = null;
    if (!cardId) return;
    const target = column.cards.find((c) => c.id === cardId);
    if (target?.sessionLink) await closeSession(target.sessionLink.sessionId);
    await deleteCardAction(workspaceId, cardId);
  }
```

Update the `<KanbanCard>` call site — change:

```svelte
        <KanbanCard {card} columnId={column.id} {labels} onOpen={() => onOpenCard(card.id)} />
```

to:

```svelte
        <KanbanCard
          {card}
          columnId={column.id}
          {labels}
          onOpen={() => onOpenCard(card.id)}
          onDelete={() => requestDeleteCard(card.id)}
        />
```

Add the new prompt's markup right after the existing `{#if showDeletePrompt}...{/if}` block:

```svelte
{#if pendingDeleteCardId}
  <DeleteCardWithSessionPrompt onConfirm={confirmDeleteCard} onCancel={() => (pendingDeleteCardId = null)} />
{/if}
```

- [ ] **Step 3: Type-check and run the full test suite**

Run (from `app/`): `npm run check`
Expected: 0 errors — Task 5's expected failure is now fixed. Same warning count as this project's established baseline (34).

Run: `npm test`
Expected: PASS, all tests (no regressions — this task adds no new automated tests, per this plan's Global Constraints on Svelte-component testing scope).

- [ ] **Step 4: Commit**

```bash
git add app/src/lib/DeleteCardWithSessionPrompt.svelte app/src/lib/KanbanColumn.svelte
git commit -m "feat(kanban): prompt before deleting a card with a still-running linked session"
```

---

### Task 7: `CardDetailModal.svelte` + `KanbanBoard.svelte` — the Session section

**Files:**
- Modify: `app/src/lib/CardDetailModal.svelte`
- Modify: `app/src/lib/KanbanBoard.svelte`

**Interfaces:**
- Consumes: Task 1's `SessionLink`; Task 2's `findSessionLocation`; Task 3's `linkSessionAction`, `unlinkSessionAction`, `updateSessionLinkAction`; Task 4's `createSessionForCard`. Uses the already-existing `switchWorkspaceView`, `switchToSessionInPage` (`layoutState.ts`), `allSessionIdsInWorkspace` (`workspace.ts`), `sessionLabel` (`paths.ts`).
- Produces: `CardDetailModal` gains a new required prop `workspaceId: string`.

- [ ] **Step 1: Thread `workspaceId` through from `KanbanBoard.svelte`**

In `app/src/lib/KanbanBoard.svelte`, change the `<CardDetailModal>` call site from:

```svelte
    <CardDetailModal
      card={openCard}
      labels={board.labels}
      onSave={(patch) => void updateCardAction(workspaceId, openCard.id, patch)}
      onClose={() => (openCardId = null)}
    />
```

to:

```svelte
    <CardDetailModal
      card={openCard}
      labels={board.labels}
      {workspaceId}
      onSave={(patch) => void updateCardAction(workspaceId, openCard.id, patch)}
      onClose={() => (openCardId = null)}
    />
```

- [ ] **Step 2: Replace `CardDetailModal.svelte`**

Replace the full contents of `app/src/lib/CardDetailModal.svelte`:

```svelte
<script lang="ts">
  import Modal from "./Modal.svelte";
  import type { Card, Label, Priority, SessionLink } from "./kanban";
  import { linkSessionAction, unlinkSessionAction, updateSessionLinkAction } from "./kanbanState";
  import { layoutState, switchWorkspaceView, switchToSessionInPage, createSessionForCard } from "./layoutState";
  import { findSessionLocation, allSessionIdsInWorkspace } from "./workspace";
  import { sessionLabel } from "./paths";

  interface Props {
    card: Card;
    labels: Label[];
    workspaceId: string;
    onSave: (patch: { title: string; description: string; priority: Priority; labelIds: string[] }) => void;
    onClose: () => void;
  }
  let { card, labels, workspaceId, onSave, onClose }: Props = $props();

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

  const workspaceSessionIds = $derived.by(() => {
    const ws = $layoutState.workspaces.find((w) => w.id === workspaceId);
    return ws ? allSessionIdsInWorkspace(ws) : [];
  });

  function labelFor(sessionId: string): string {
    return sessionLabel($layoutState.sessionNames, $layoutState.cwdBySessionId, sessionId);
  }

  let selectedExistingSessionId = $state("");
  let newSessionCwd = $state("");
  let newSessionCommand = $state("");

  async function linkExisting(): Promise<void> {
    if (!selectedExistingSessionId) return;
    const link: SessionLink = {
      sessionId: selectedExistingSessionId,
      cwd: $layoutState.cwdBySessionId[selectedExistingSessionId] ?? "",
      command: null,
    };
    await linkSessionAction(workspaceId, card.id, link);
    selectedExistingSessionId = "";
  }

  async function createAndLink(): Promise<void> {
    const cwd = newSessionCwd.trim();
    const command = newSessionCommand.trim() || null;
    const sessionId = await createSessionForCard(workspaceId, cwd, command);
    if (!sessionId) return;
    await linkSessionAction(workspaceId, card.id, { sessionId, cwd, command });
    newSessionCwd = "";
    newSessionCommand = "";
  }

  const linkedLocation = $derived(
    card.sessionLink ? findSessionLocation($layoutState, card.sessionLink.sessionId) : null
  );
  const linkedStatus = $derived(
    card.sessionLink && linkedLocation ? ($layoutState.sessionStatusById[card.sessionLink.sessionId] ?? "idle") : null
  );

  async function jumpToSession(): Promise<void> {
    if (!card.sessionLink || !linkedLocation) return;
    await switchWorkspaceView(linkedLocation.workspaceId, "terminal");
    await switchToSessionInPage(linkedLocation.workspaceId, linkedLocation.pageId, card.sessionLink.sessionId);
    onClose();
  }

  async function relaunchSession(): Promise<void> {
    if (!card.sessionLink) return;
    const sessionId = await createSessionForCard(workspaceId, card.sessionLink.cwd, card.sessionLink.command);
    if (!sessionId) return;
    await updateSessionLinkAction(workspaceId, card.id, sessionId);
  }

  async function unlinkSession(): Promise<void> {
    await unlinkSessionAction(workspaceId, card.id);
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
  <div class="field">
    Session
    {#if card.sessionLink}
      <div class="session-info">
        <span class="session-status" class:exited={!linkedLocation}>{linkedLocation ? linkedStatus : "exited"}</span>
        <span class="session-cwd">{card.sessionLink.cwd || "(default)"}</span>
      </div>
      <div class="session-actions">
        <button type="button" disabled={!linkedLocation} onclick={jumpToSession}>Jump to session</button>
        <button type="button" disabled={!!linkedLocation} onclick={relaunchSession}>Re-launch</button>
        <button type="button" onclick={unlinkSession}>Unlink</button>
      </div>
    {:else}
      <div class="session-link-existing">
        <select bind:value={selectedExistingSessionId}>
          <option value="">Select a session…</option>
          {#each workspaceSessionIds as sessionId (sessionId)}
            <option value={sessionId}>{labelFor(sessionId)}</option>
          {/each}
        </select>
        <button type="button" disabled={!selectedExistingSessionId} onclick={linkExisting}>Link existing session</button>
      </div>
      <div class="session-create-new">
        <input type="text" placeholder="Command (optional)" bind:value={newSessionCommand} />
        <input type="text" placeholder="Working directory (optional)" bind:value={newSessionCwd} />
        <button type="button" onclick={createAndLink}>Create new session</button>
      </div>
    {/if}
  </div>
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
  .session-info {
    display: flex;
    justify-content: space-between;
    font-size: 0.85em;
    opacity: 0.85;
  }
  .session-status.exited {
    opacity: 0.6;
  }
  .session-actions,
  .session-link-existing,
  .session-create-new {
    display: flex;
    gap: 6px;
    margin-top: 6px;
  }
  .session-create-new {
    flex-direction: column;
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

- [ ] **Step 3: Type-check and run the full test suite**

Run (from `app/`): `npm run check`
Expected: 0 errors, same warning count as this project's established baseline (34).

Run: `npm test`
Expected: PASS, all tests. `kanban.test.ts` 23 (18 pre-plan + 5 from Task 1), `workspace.test.ts` 45 (42 pre-plan + 3 from Task 2), `kanbanState.test.ts` 10 (7 pre-plan + 3 from Task 3), `layoutState.test.ts` 72 (66 pre-plan + 6 from Task 4), every other existing test file unchanged. No regressions anywhere.

- [ ] **Step 4: Commit**

```bash
git add app/src/lib/CardDetailModal.svelte app/src/lib/KanbanBoard.svelte
git commit -m "feat(CardDetailModal): add the Session section (link, create, jump, re-launch, unlink)"
```

- [ ] **Step 5: Manual GUI smoke test (not automated — record the outcome, don't skip)**

With the app running, for a workspace with an existing kanban board:
1. Open a card with no session link. Confirm "Link existing session" (populated with the workspace's current sessions) and "Create new session" (command/cwd fields) both appear.
2. Link an existing session. Confirm the card face now shows a status dot, and the modal switches to the "already linked" view (status, cwd, Jump/Re-launch/Unlink).
3. Click "Jump to session." Confirm the hub exits, the correct workspace/page becomes active, and the linked session is focused.
4. Re-open the card, click "Unlink." Confirm the card returns to the no-link view and the session itself keeps running (check the sidebar/terminal view).
5. Create a new session from a card in a workspace with zero pages. Confirm a page is auto-created and the new session appears there, and the card becomes linked to it.
6. Exit that session (e.g. type `exit` in the shell). Confirm the card's status dot goes dim/exited, "Jump to session" becomes disabled, and "Re-launch" becomes enabled. Click "Re-launch" and confirm a fresh session starts at the remembered cwd/command and the card re-links to it.
7. Delete a card whose session is still running. Confirm the "delete card & kill session" prompt appears, and confirm both the card and the session are gone after confirming.
8. Delete a card whose linked session has already exited. Confirm no prompt appears — it deletes immediately.
9. Delete a card with no session link at all. Confirm no prompt appears — it deletes immediately (this is also the first-ever exercise of card deletion in this app, since no UI trigger existed before this plan).
