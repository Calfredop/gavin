# Terminal Core — Workspaces — Part 3 (Drag-and-Drop) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add full drag-and-drop to the Workspaces UI: reorder workspaces, reorder or move pages (within/across workspaces), and move/reorder panes and tabs within and between pages — including the case where source and target happen to be the same page, treated as one unified operation rather than a special case.

**Architecture:** Five new pure functions in `layout.ts` (`detachLeaf`/`detachTab`/`graftLeaf`/`mergeIntoActivePane`/`moveTabWithinLeaf`) and two in `workspace.ts` (`reorderWorkspace`/`movePage`) do all the tree/collection restructuring. A new shared module, `dragDrop.ts`, defines the drag payload contract (encoded across multiple MIME types so its *kind* is readable during `dragover`, not just at `drop`) and the pure zone-computation math both `Sidebar.svelte` and `Pane.svelte` need for their hover overlays. `layoutState.ts` gains orchestration actions (`movePaneOrTab`, `reorderTabWithinPane`, `reorderWorkspaceAction`, `movePageAction`) that call the pure functions and persist — no daemon calls are ever needed for any of this, since moving/reordering is pure data restructuring.

**Tech Stack:** Native HTML5 Drag and Drop API (`draggable`, `dragstart`/`dragover`/`drop`, `DataTransfer`) — no new dependency. Svelte 5 runes for the two new hover-overlay UI states.

## Global Constraints

- No Rust/Tauri files are touched.
- No daemon calls (`backend.createSession`/`killSession`) are ever made by anything in this plan — every operation here is pure data restructuring of the already-loaded `workspaces` array, then a persist.
- `Page.layout` is still never `null`/optional. A source page emptied by a detach is removed via the existing `workspace.removePage`, exactly as Part 2 already established for tab-close.
- Reordering a workspace/page to the position it's already at is a no-op, not an error. Dropping a pane/tab onto a page that still has other content left after the detach is a genuine rearrangement (even if it's the same page it came from) — the only true no-op is detaching a page's *only* pane and dropping it back onto that now-just-removed page, which resolves naturally via `movePaneOrTab`'s existing "target page not found" fallback rather than a separate same-page special case (see that function's own comment for why an explicit guard would have wrongly blocked legitimate same-page, multi-pane rearrangement).
- `npm run check`, `npm test`, `npm run build` (all run from `app/`) must stay green as of the final commit.
- The existing pure functions in `layout.ts` and `workspace.ts` from Milestone C / Part 1 / Part 2 are never modified by this plan — only added to.

---

### Task 1: `layout.ts` — detach/graft/merge/reorder pure functions

**Files:**
- Modify: `app/src/lib/layout.ts`
- Modify: `app/src/lib/layout.test.ts`

**Interfaces:**
- Produces: `detachLeaf(tree, anchorSessionId): { tree: LayoutNode | null; detached: Extract<LayoutNode, {type: "leaf"}> } | null`, `detachTab(tree, sessionId): { tree: LayoutNode | null; detached: Extract<LayoutNode, {type: "leaf"}> } | null`, `GraftMode = "left" | "right" | "top" | "bottom"`, `graftLeaf(targetTree: LayoutNode | null, incoming: Extract<LayoutNode, {type: "leaf"}>, mode: GraftMode): LayoutNode`, `mergeIntoActivePane(targetTree: LayoutNode, targetFocusedSessionId: string | null, incoming: Extract<LayoutNode, {type: "leaf"}>): LayoutNode`, `moveTabWithinLeaf(tree: LayoutNode, sessionId: string, targetIndex: number): LayoutNode`.
- Consumes: this file's own existing private `replaceAtPath` helper (do not export it — these new functions live in the same file and can call it directly), and the existing exported `findLeafPath`/`getNodeAtPath`/`closeTab`/`allSessionIds`.

This task only touches `layout.ts` — nothing outside it changes, and nothing outside it needs to change to consume this task's additions (that's Task 4's job).

- [ ] **Step 1: Add the 5 new functions**

Add these functions to `app/src/lib/layout.ts`, placed after the existing `closeTab` function (so they sit near the other tab/leaf-removal logic) and before `switchTab`:

```typescript
// Locates the leaf containing anchorSessionId and removes it from the
// tree entirely (reusing replaceAtPath's existing collapse-on-null
// mechanics -- the same removal path closeTab already relies on),
// returning both the resulting tree (possibly null, if that leaf was the
// whole tree) and the detached leaf intact, ready to be grafted
// elsewhere. Returns null if anchorSessionId isn't in the tree at all.
export function detachLeaf(
  tree: LayoutNode,
  anchorSessionId: string
): { tree: LayoutNode | null; detached: Extract<LayoutNode, { type: "leaf" }> } | null {
  const path = findLeafPath(tree, anchorSessionId);
  if (!path) return null;
  const detached = getNodeAtPath(tree, path);
  if (detached.type !== "leaf") return null;
  const newTree = replaceAtPath(tree, path, () => null);
  return { tree: newTree, detached };
}

// Removes one tab from its leaf -- collapsing the leaf if it was the last
// tab (identical to closeTab's own removal semantics) -- and returns a
// new standalone single-tab leaf holding the removed session as the
// "detached" piece. Returns null if sessionId isn't in the tree.
export function detachTab(
  tree: LayoutNode,
  sessionId: string
): { tree: LayoutNode | null; detached: Extract<LayoutNode, { type: "leaf" }> } | null {
  if (!findLeafPath(tree, sessionId)) return null;
  const newTree = closeTab(tree, sessionId);
  const detached: LayoutNode = { type: "leaf", tabs: [sessionId], activeTabIndex: 0 };
  return { tree: newTree, detached };
}

export type GraftMode = "left" | "right" | "top" | "bottom";

// Grafts `incoming` onto `targetTree`. If targetTree is null (an empty
// page), incoming simply becomes the whole tree. Otherwise wraps the
// existing tree and incoming into a new top-level split -- left/right
// produce a row split, top/bottom a column split; left/top place
// incoming first in the children array (so it renders on that side),
// right/bottom place it last.
export function graftLeaf(
  targetTree: LayoutNode | null,
  incoming: Extract<LayoutNode, { type: "leaf" }>,
  mode: GraftMode
): LayoutNode {
  if (!targetTree) return incoming;
  const direction: Direction = mode === "left" || mode === "right" ? "row" : "column";
  const children: LayoutNode[] =
    mode === "left" || mode === "top" ? [incoming, targetTree] : [targetTree, incoming];
  return { type: "split", direction, children, sizes: [0.5, 0.5] };
}

// Appends every tab from `incoming` onto the leaf identified by
// targetFocusedSessionId (falling back to the tree's first leaf if that
// id isn't present, or is null), mirroring addTab's "new tab becomes
// active" behavior for the last of incoming's tabs.
export function mergeIntoActivePane(
  targetTree: LayoutNode,
  targetFocusedSessionId: string | null,
  incoming: Extract<LayoutNode, { type: "leaf" }>
): LayoutNode {
  const anchorId =
    targetFocusedSessionId && findLeafPath(targetTree, targetFocusedSessionId)
      ? targetFocusedSessionId
      : allSessionIds(targetTree)[0];
  if (anchorId === undefined) return targetTree;
  const path = findLeafPath(targetTree, anchorId);
  if (!path) return targetTree;
  return (
    replaceAtPath(targetTree, path, (node) => {
      if (node.type !== "leaf") return node;
      return { type: "leaf", tabs: [...node.tabs, ...incoming.tabs], activeTabIndex: node.tabs.length };
    }) ?? targetTree
  );
}

// Reorders a tab within its own leaf's tabs array, keeping activeTabIndex
// pointing at whichever session was active before the move (which may or
// may not be the session that just moved).
export function moveTabWithinLeaf(tree: LayoutNode, sessionId: string, targetIndex: number): LayoutNode {
  const path = findLeafPath(tree, sessionId);
  if (!path) return tree;
  return (
    replaceAtPath(tree, path, (node) => {
      if (node.type !== "leaf") return node;
      const activeId = node.tabs[node.activeTabIndex];
      const currentIndex = node.tabs.indexOf(sessionId);
      if (currentIndex === -1) return node;
      const tabs = [...node.tabs];
      tabs.splice(currentIndex, 1);
      const clampedTarget = Math.max(0, Math.min(targetIndex, tabs.length));
      tabs.splice(clampedTarget, 0, sessionId);
      return { type: "leaf", tabs, activeTabIndex: tabs.indexOf(activeId) };
    }) ?? tree
  );
}
```

- [ ] **Step 2: Add tests**

Add these tests to `app/src/lib/layout.test.ts`, matching the file's existing style (full literal `LayoutNode` objects, no shared builder helpers). Add the 5 new function names to the existing `import { ... } from "./layout";` list at the top of the file, and add a new `describe` block per function at the end of the file:

```typescript
describe("detachLeaf", () => {
  it("removes a leaf from a split, returning the shrunken tree and the detached leaf", () => {
    const tree: LayoutNode = {
      type: "split",
      direction: "row",
      sizes: [0.5, 0.5],
      children: [
        { type: "leaf", tabs: ["a"], activeTabIndex: 0 },
        { type: "leaf", tabs: ["b", "c"], activeTabIndex: 0 },
      ],
    };
    const result = detachLeaf(tree, "a");
    expect(result).not.toBeNull();
    expect(result?.tree).toEqual({ type: "leaf", tabs: ["b", "c"], activeTabIndex: 0 });
    expect(result?.detached).toEqual({ type: "leaf", tabs: ["a"], activeTabIndex: 0 });
  });

  it("returns a null tree when detaching the whole tree's only leaf", () => {
    const tree: LayoutNode = { type: "leaf", tabs: ["a"], activeTabIndex: 0 };
    const result = detachLeaf(tree, "a");
    expect(result?.tree).toBeNull();
    expect(result?.detached).toEqual({ type: "leaf", tabs: ["a"], activeTabIndex: 0 });
  });

  it("returns null when the session isn't in the tree", () => {
    const tree: LayoutNode = { type: "leaf", tabs: ["a"], activeTabIndex: 0 };
    expect(detachLeaf(tree, "z")).toBeNull();
  });
});

describe("detachTab", () => {
  it("removes one tab from a multi-tab leaf, returning it as a standalone detached leaf", () => {
    const tree: LayoutNode = { type: "leaf", tabs: ["a", "b"], activeTabIndex: 1 };
    const result = detachTab(tree, "b");
    expect(result?.tree).toEqual({ type: "leaf", tabs: ["a"], activeTabIndex: 0 });
    expect(result?.detached).toEqual({ type: "leaf", tabs: ["b"], activeTabIndex: 0 });
  });

  it("collapses to null when detaching the last tab in a leaf", () => {
    const tree: LayoutNode = { type: "leaf", tabs: ["a"], activeTabIndex: 0 };
    const result = detachTab(tree, "a");
    expect(result?.tree).toBeNull();
    expect(result?.detached).toEqual({ type: "leaf", tabs: ["a"], activeTabIndex: 0 });
  });

  it("returns null when the session isn't in the tree", () => {
    const tree: LayoutNode = { type: "leaf", tabs: ["a"], activeTabIndex: 0 };
    expect(detachTab(tree, "z")).toBeNull();
  });
});

describe("graftLeaf", () => {
  const incoming: LayoutNode = { type: "leaf", tabs: ["new"], activeTabIndex: 0 };

  it("becomes the whole tree when the target is null (an empty page)", () => {
    expect(graftLeaf(null, incoming, "right")).toEqual(incoming);
  });

  it("wraps into a row split with incoming last, for mode right", () => {
    const target: LayoutNode = { type: "leaf", tabs: ["a"], activeTabIndex: 0 };
    expect(graftLeaf(target, incoming, "right")).toEqual({
      type: "split",
      direction: "row",
      sizes: [0.5, 0.5],
      children: [target, incoming],
    });
  });

  it("wraps into a row split with incoming first, for mode left", () => {
    const target: LayoutNode = { type: "leaf", tabs: ["a"], activeTabIndex: 0 };
    expect(graftLeaf(target, incoming, "left")).toEqual({
      type: "split",
      direction: "row",
      sizes: [0.5, 0.5],
      children: [incoming, target],
    });
  });

  it("wraps into a column split for mode top/bottom", () => {
    const target: LayoutNode = { type: "leaf", tabs: ["a"], activeTabIndex: 0 };
    expect(graftLeaf(target, incoming, "bottom")).toEqual({
      type: "split",
      direction: "column",
      sizes: [0.5, 0.5],
      children: [target, incoming],
    });
    expect(graftLeaf(target, incoming, "top")).toEqual({
      type: "split",
      direction: "column",
      sizes: [0.5, 0.5],
      children: [incoming, target],
    });
  });
});

describe("mergeIntoActivePane", () => {
  it("appends incoming's tabs onto the leaf matching targetFocusedSessionId", () => {
    const target: LayoutNode = {
      type: "split",
      direction: "row",
      sizes: [0.5, 0.5],
      children: [
        { type: "leaf", tabs: ["a"], activeTabIndex: 0 },
        { type: "leaf", tabs: ["b"], activeTabIndex: 0 },
      ],
    };
    const incoming: LayoutNode = { type: "leaf", tabs: ["new"], activeTabIndex: 0 };
    const result = mergeIntoActivePane(target, "b", incoming);
    expect(result).toEqual({
      type: "split",
      direction: "row",
      sizes: [0.5, 0.5],
      children: [
        { type: "leaf", tabs: ["a"], activeTabIndex: 0 },
        { type: "leaf", tabs: ["b", "new"], activeTabIndex: 1 },
      ],
    });
  });

  it("falls back to the tree's first leaf when targetFocusedSessionId is null", () => {
    const target: LayoutNode = { type: "leaf", tabs: ["a"], activeTabIndex: 0 };
    const incoming: LayoutNode = { type: "leaf", tabs: ["new"], activeTabIndex: 0 };
    expect(mergeIntoActivePane(target, null, incoming)).toEqual({
      type: "leaf",
      tabs: ["a", "new"],
      activeTabIndex: 1,
    });
  });

  it("falls back to the tree's first leaf when targetFocusedSessionId is stale", () => {
    const target: LayoutNode = { type: "leaf", tabs: ["a"], activeTabIndex: 0 };
    const incoming: LayoutNode = { type: "leaf", tabs: ["new"], activeTabIndex: 0 };
    expect(mergeIntoActivePane(target, "gone", incoming)).toEqual({
      type: "leaf",
      tabs: ["a", "new"],
      activeTabIndex: 1,
    });
  });

  it("merges multiple incoming tabs at once", () => {
    const target: LayoutNode = { type: "leaf", tabs: ["a"], activeTabIndex: 0 };
    const incoming: LayoutNode = { type: "leaf", tabs: ["x", "y"], activeTabIndex: 0 };
    expect(mergeIntoActivePane(target, "a", incoming)).toEqual({
      type: "leaf",
      tabs: ["a", "x", "y"],
      activeTabIndex: 1,
    });
  });
});

describe("moveTabWithinLeaf", () => {
  it("moves a tab to a later index, keeping the same session active", () => {
    const tree: LayoutNode = { type: "leaf", tabs: ["a", "b", "c"], activeTabIndex: 1 };
    expect(moveTabWithinLeaf(tree, "a", 2)).toEqual({ type: "leaf", tabs: ["b", "c", "a"], activeTabIndex: 0 });
  });

  it("moves a tab to an earlier index", () => {
    const tree: LayoutNode = { type: "leaf", tabs: ["a", "b", "c"], activeTabIndex: 0 };
    expect(moveTabWithinLeaf(tree, "c", 0)).toEqual({ type: "leaf", tabs: ["c", "a", "b"], activeTabIndex: 1 });
  });

  it("moving the active tab itself keeps it active at its new position", () => {
    const tree: LayoutNode = { type: "leaf", tabs: ["a", "b", "c"], activeTabIndex: 0 };
    expect(moveTabWithinLeaf(tree, "a", 2)).toEqual({ type: "leaf", tabs: ["b", "c", "a"], activeTabIndex: 2 });
  });

  it("clamps an out-of-range target index", () => {
    const tree: LayoutNode = { type: "leaf", tabs: ["a", "b"], activeTabIndex: 0 };
    expect(moveTabWithinLeaf(tree, "a", 99)).toEqual({ type: "leaf", tabs: ["b", "a"], activeTabIndex: 1 });
  });

  it("is a no-op when the session isn't in the tree", () => {
    const tree: LayoutNode = { type: "leaf", tabs: ["a", "b"], activeTabIndex: 0 };
    expect(moveTabWithinLeaf(tree, "z", 0)).toEqual(tree);
  });
});
```

- [ ] **Step 3: Run the tests**

Run: `cd /Users/coalpila/CloudStation/Coding/gavin/app && npm run check && npm test -- --run layout.test.ts`
Expected: 0 type errors, PASS — 27 existing + 22 new = 49 tests.

- [ ] **Step 4: Commit**

```bash
git add app/src/lib/layout.ts app/src/lib/layout.test.ts
git commit -m "feat(app): add detach/graft/merge/reorder pure functions to layout.ts"
```

---

### Task 2: `workspace.ts` — `reorderWorkspace`/`movePage` pure functions

**Files:**
- Modify: `app/src/lib/workspace.ts`
- Modify: `app/src/lib/workspace.test.ts`

**Interfaces:**
- Produces: `reorderWorkspace(state: WorkspacesData, workspaceId: string, targetIndex: number): WorkspacesData`, `movePage(state: WorkspacesData, pageId: string, targetWorkspaceId: string, targetIndex: number): WorkspacesData`.
- Consumes: nothing new — pure array restructuring on the existing `WorkspacesData`/`Workspace`/`Page` types.

This task only touches `workspace.ts`, independent of Task 1 (both are pure, standalone additions to their own files).

- [ ] **Step 1: Add the two new functions**

Add these to `app/src/lib/workspace.ts`, placed after `removeWorkspace` and `removePage` respectively (so each sits near its sibling operation on the same collection):

```typescript
// Moves a workspace to a new index within the workspaces array. Clamped
// to the valid range. A no-op (returns state unchanged in effect) if
// workspaceId isn't found or targetIndex already matches its position.
export function reorderWorkspace(state: WorkspacesData, workspaceId: string, targetIndex: number): WorkspacesData {
  const currentIndex = state.workspaces.findIndex((w) => w.id === workspaceId);
  if (currentIndex === -1) return state;
  const workspaces = [...state.workspaces];
  const [moved] = workspaces.splice(currentIndex, 1);
  const clamped = Math.max(0, Math.min(targetIndex, workspaces.length));
  workspaces.splice(clamped, 0, moved);
  return { ...state, workspaces };
}

// Moves a page to a new position -- either within its current workspace
// (reorder) or into a different workspace (move). Both are the same
// operation, differing only in whether the source and target workspace
// ids happen to match. If the moved page was its source workspace's
// active page, that workspace's activePageId falls back to a sibling (or
// null) -- the same rule removePage already uses. The target workspace's
// own activePageId is left untouched by the move itself (a caller that
// wants the moved page to also become active, e.g. because it was the
// one the user was looking at, does that separately via switchWorkspace/
// switchPage).
export function movePage(
  state: WorkspacesData,
  pageId: string,
  targetWorkspaceId: string,
  targetIndex: number
): WorkspacesData {
  const sourceWorkspace = state.workspaces.find((w) => w.pages.some((p) => p.id === pageId));
  if (!sourceWorkspace) return state;
  const page = sourceWorkspace.pages.find((p) => p.id === pageId);
  if (!page) return state;
  const targetWorkspace = state.workspaces.find((w) => w.id === targetWorkspaceId);
  if (!targetWorkspace) return state;

  const workspaces = state.workspaces.map((w) => {
    if (w.id === sourceWorkspace.id && w.id === targetWorkspaceId) {
      const pages = w.pages.filter((p) => p.id !== pageId);
      const clamped = Math.max(0, Math.min(targetIndex, pages.length));
      pages.splice(clamped, 0, page);
      return { ...w, pages };
    }
    if (w.id === sourceWorkspace.id) {
      const pages = w.pages.filter((p) => p.id !== pageId);
      const activePageId = w.activePageId === pageId ? (pages[0]?.id ?? null) : w.activePageId;
      return { ...w, pages, activePageId };
    }
    if (w.id === targetWorkspaceId) {
      const pages = [...w.pages];
      const clamped = Math.max(0, Math.min(targetIndex, pages.length));
      pages.splice(clamped, 0, page);
      return { ...w, pages };
    }
    return w;
  });

  return { ...state, workspaces };
}
```

- [ ] **Step 2: Add tests**

Add these tests to `app/src/lib/workspace.test.ts`, following the file's existing style (reusing its `createWorkspace`/`createPage`/`empty`/`leaf` helpers already defined at the top of the file). Add `reorderWorkspace` and `movePage` to the existing import list from `./workspace`.

```typescript
describe("reorderWorkspace", () => {
  it("moves a workspace to a later index", () => {
    let state = createWorkspace(empty, "ws-1", "A");
    state = createWorkspace(state, "ws-2", "B");
    state = createWorkspace(state, "ws-3", "C");
    const reordered = reorderWorkspace(state, "ws-1", 2);
    expect(reordered.workspaces.map((w) => w.id)).toEqual(["ws-2", "ws-3", "ws-1"]);
  });

  it("moves a workspace to an earlier index", () => {
    let state = createWorkspace(empty, "ws-1", "A");
    state = createWorkspace(state, "ws-2", "B");
    state = createWorkspace(state, "ws-3", "C");
    const reordered = reorderWorkspace(state, "ws-3", 0);
    expect(reordered.workspaces.map((w) => w.id)).toEqual(["ws-3", "ws-1", "ws-2"]);
  });

  it("is a no-op when the workspace id isn't found", () => {
    const state = createWorkspace(empty, "ws-1", "A");
    expect(reorderWorkspace(state, "missing", 0)).toEqual(state);
  });
});

describe("movePage", () => {
  it("reorders a page within its own workspace when source and target workspace match", () => {
    let state = createWorkspace(empty, "ws-1", "A");
    state = createPage(state, "ws-1", "page-1", "Page 1", leaf(["a"]));
    state = createPage(state, "ws-1", "page-2", "Page 2", leaf(["b"]));
    state = createPage(state, "ws-1", "page-3", "Page 3", leaf(["c"]));
    const moved = movePage(state, "page-1", "ws-1", 2);
    expect(moved.workspaces[0].pages.map((p) => p.id)).toEqual(["page-2", "page-3", "page-1"]);
  });

  it("moves a page to a different workspace, inserting at the target index", () => {
    let state = createWorkspace(empty, "ws-1", "A");
    state = createWorkspace(state, "ws-2", "B");
    state = createPage(state, "ws-1", "page-1", "Page 1", leaf(["a"]));
    state = createPage(state, "ws-2", "page-2", "Page 2", leaf(["b"]));
    const moved = movePage(state, "page-1", "ws-2", 0);
    expect(moved.workspaces[0].pages.map((p) => p.id)).toEqual([]);
    expect(moved.workspaces[1].pages.map((p) => p.id)).toEqual(["page-1", "page-2"]);
  });

  it("falls back the source workspace's activePageId to a sibling when the moved page was active", () => {
    let state = createWorkspace(empty, "ws-1", "A");
    state = createWorkspace(state, "ws-2", "B");
    state = createPage(state, "ws-1", "page-1", "Page 1", leaf(["a"]));
    state = createPage(state, "ws-1", "page-2", "Page 2", leaf(["b"]));
    const moved = movePage(state, "page-2", "ws-2", 0);
    expect(moved.workspaces[0].activePageId).toBe("page-1");
  });

  it("falls back to null when moving a source workspace's only (active) page away", () => {
    let state = createWorkspace(empty, "ws-1", "A");
    state = createWorkspace(state, "ws-2", "B");
    state = createPage(state, "ws-1", "page-1", "Page 1", leaf(["a"]));
    const moved = movePage(state, "page-1", "ws-2", 0);
    expect(moved.workspaces[0].activePageId).toBeNull();
  });

  it("is a no-op when the page id isn't found", () => {
    let state = createWorkspace(empty, "ws-1", "A");
    state = createWorkspace(state, "ws-2", "B");
    expect(movePage(state, "missing", "ws-2", 0)).toEqual(state);
  });

  it("is a no-op when the target workspace id isn't found", () => {
    let state = createWorkspace(empty, "ws-1", "A");
    state = createPage(state, "ws-1", "page-1", "Page 1", leaf(["a"]));
    expect(movePage(state, "page-1", "missing", 0)).toEqual(state);
  });
});
```

- [ ] **Step 3: Run the tests**

Run: `cd /Users/coalpila/CloudStation/Coding/gavin/app && npm run check && npm test -- --run workspace.test.ts`
Expected: 0 type errors, PASS — 22 existing + 9 new = 31 tests.

- [ ] **Step 4: Commit**

```bash
git add app/src/lib/workspace.ts app/src/lib/workspace.test.ts
git commit -m "feat(app): add reorderWorkspace/movePage pure functions to workspace.ts"
```

---

### Task 3: `dragDrop.ts` — shared drag payload contract and zone-computation math

**Files:**
- Create: `app/src/lib/dragDrop.ts`
- Test: `app/src/lib/dragDrop.test.ts`

**Interfaces:**
- Produces: `DragPayload` (discriminated union type), `setDragPayload(event, payload)`, `getDragKind(event): DragPayload["kind"] | null`, `getDragPayload(event): DragPayload | null`, `DropZone = "left" | "right" | "top" | "bottom" | "center"`, `computeDropZone(rect, clientX, clientY): DropZone`, `ReorderPosition = "before" | "after"`, `computeReorderPosition(rect, clientY): ReorderPosition`.
- Consumes: nothing from this project — only the browser's native `DragEvent`/`DataTransfer`/`DOMRect` types.

This is genuinely new infrastructure, not a continuation of an existing module — both `Sidebar.svelte` (Task 5) and `Pane.svelte` (Task 6) will import from it, so it has to exist and be correct before either of those tasks starts.

**Background the implementer needs:** the native HTML5 Drag and Drop API's `DataTransfer.getData()` — which reads the actual payload *value* — only reliably returns data during the `drop` event in most browsers, for security reasons; during `dragover` (needed continuously while the pointer moves, to decide which hover-zone overlay to show) only `DataTransfer.types` — an array of MIME type *strings*, no values — is readable. This module works around that by encoding the payload's `kind` directly into the MIME type string itself (e.g. `"application/x-gavin-drag-pane"`), so `getDragKind()` can answer "what's being dragged" during `dragover` using only `types`, while the full payload (with ids) is only ever read via `getDragPayload()` at `drop` time.

- [ ] **Step 1: Write `dragDrop.ts`**

```typescript
// Discriminates what's being dragged. For "pane"/"tab", sessionId is the
// dragged content's identity within its source page: for "pane" it's any
// one of that pane's tab session ids (used with detachLeaf, which locates
// the whole leaf from any single tab inside it); for "tab" it's that
// specific tab's session id (used with detachTab). workspaceId/pageId
// always identify the SOURCE location -- the page the drag started
// from, which is always the currently active page, since that's the only
// page ever rendered.
export type DragPayload =
  | { kind: "workspace"; workspaceId: string }
  | { kind: "page"; workspaceId: string; pageId: string }
  | { kind: "pane"; workspaceId: string; pageId: string; sessionId: string }
  | { kind: "tab"; workspaceId: string; pageId: string; sessionId: string };

const DRAG_TYPE_PREFIX = "application/x-gavin-drag-";
const DRAG_KINDS: readonly DragPayload["kind"][] = ["workspace", "page", "pane", "tab"];

export function setDragPayload(event: DragEvent, payload: DragPayload): void {
  if (!event.dataTransfer) return;
  event.dataTransfer.setData(DRAG_TYPE_PREFIX + payload.kind, JSON.stringify(payload));
  event.dataTransfer.effectAllowed = "move";
}

// Readable during dragover (dataTransfer.types is always available,
// unlike getData's value) -- use this to decide which hover-overlay style
// to show without needing the full payload yet.
export function getDragKind(event: DragEvent): DragPayload["kind"] | null {
  const types = event.dataTransfer?.types ?? [];
  for (const kind of DRAG_KINDS) {
    if (types.includes(DRAG_TYPE_PREFIX + kind)) return kind;
  }
  return null;
}

// Only reliably readable at drop time (see this file's module-level
// background above).
export function getDragPayload(event: DragEvent): DragPayload | null {
  const kind = getDragKind(event);
  if (!kind) return null;
  const raw = event.dataTransfer?.getData(DRAG_TYPE_PREFIX + kind);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as DragPayload;
  } catch {
    return null;
  }
}

export type DropZone = "left" | "right" | "top" | "bottom" | "center";

// Given a drop target's bounding rect and the current pointer position,
// computes which of the 5 zones the pointer is over: outer ~25% bands on
// each edge for a directional split, the center ~50% for "add as tab."
export function computeDropZone(rect: DOMRect, clientX: number, clientY: number): DropZone {
  const x = (clientX - rect.left) / rect.width;
  const y = (clientY - rect.top) / rect.height;
  const EDGE = 0.25;
  if (x < EDGE) return "left";
  if (x > 1 - EDGE) return "right";
  if (y < EDGE) return "top";
  if (y > 1 - EDGE) return "bottom";
  return "center";
}

export type ReorderPosition = "before" | "after";

// Given a sidebar row's bounding rect and the current pointer Y position,
// computes whether a reordering drop should insert before or after that
// row -- the simple top-half/bottom-half split used for list reordering,
// distinct from computeDropZone's 5-way split used for grafting a
// pane/tab onto a page.
export function computeReorderPosition(rect: DOMRect, clientY: number): ReorderPosition {
  const y = (clientY - rect.top) / rect.height;
  return y < 0.5 ? "before" : "after";
}
```

- [ ] **Step 2: Write `dragDrop.test.ts`**

`app/vite.config.js` sets no `test.environment`, so Vitest runs this project's tests under its default `node` environment — `DragEvent`/`DataTransfer` are not available globals there. The tests below use a minimal hand-built fake implementing just the `dataTransfer.types`/`getData`/`setData`/`effectAllowed` surface this module actually reads/writes, cast to `DragEvent` via `as unknown as DragEvent` — do not reach for `jsdom`/`happy-dom` or try to construct a real `DragEvent`, neither is installed or configured in this project. The zone-computation tests (`computeDropZone`/`computeReorderPosition`) need no browser APIs at all — a plain object literal satisfying the `DOMRect` shape (`{ left, top, width, height }`, cast via `as DOMRect` since the real `DOMRect` interface has a few more read-only properties this code never touches) is sufficient.

```typescript
import { describe, it, expect } from "vitest";
import {
  setDragPayload,
  getDragKind,
  getDragPayload,
  computeDropZone,
  computeReorderPosition,
  type DragPayload,
} from "./dragDrop";

// Minimal fake covering only the DataTransfer members this module
// actually reads/writes -- avoids depending on a specific test
// environment providing a real DataTransfer implementation.
function fakeDragEvent(): { event: DragEvent; dataTransfer: { types: string[]; data: Map<string, string> } } {
  const dataTransfer = { types: [] as string[], data: new Map<string, string>() };
  const fakeDataTransfer = {
    get types() {
      return dataTransfer.types;
    },
    effectAllowed: "none",
    setData(type: string, value: string) {
      dataTransfer.data.set(type, value);
      if (!dataTransfer.types.includes(type)) dataTransfer.types.push(type);
    },
    getData(type: string) {
      return dataTransfer.data.get(type) ?? "";
    },
  };
  const event = { dataTransfer: fakeDataTransfer } as unknown as DragEvent;
  return { event, dataTransfer };
}

describe("setDragPayload / getDragKind / getDragPayload", () => {
  it("roundtrips a workspace payload", () => {
    const { event } = fakeDragEvent();
    const payload: DragPayload = { kind: "workspace", workspaceId: "ws-1" };
    setDragPayload(event, payload);
    expect(getDragKind(event)).toBe("workspace");
    expect(getDragPayload(event)).toEqual(payload);
  });

  it("roundtrips a pane payload", () => {
    const { event } = fakeDragEvent();
    const payload: DragPayload = { kind: "pane", workspaceId: "ws-1", pageId: "page-1", sessionId: "s1" };
    setDragPayload(event, payload);
    expect(getDragKind(event)).toBe("pane");
    expect(getDragPayload(event)).toEqual(payload);
  });

  it("getDragKind returns null when nothing was set", () => {
    const { event } = fakeDragEvent();
    expect(getDragKind(event)).toBeNull();
  });

  it("getDragPayload returns null when nothing was set", () => {
    const { event } = fakeDragEvent();
    expect(getDragPayload(event)).toBeNull();
  });
});

describe("computeDropZone", () => {
  const rect = { left: 0, top: 0, width: 100, height: 100 } as DOMRect;

  it("returns left for the left edge band", () => {
    expect(computeDropZone(rect, 10, 50)).toBe("left");
  });

  it("returns right for the right edge band", () => {
    expect(computeDropZone(rect, 90, 50)).toBe("right");
  });

  it("returns top for the top edge band", () => {
    expect(computeDropZone(rect, 50, 10)).toBe("top");
  });

  it("returns bottom for the bottom edge band", () => {
    expect(computeDropZone(rect, 50, 90)).toBe("bottom");
  });

  it("returns center for the middle region", () => {
    expect(computeDropZone(rect, 50, 50)).toBe("center");
  });
});

describe("computeReorderPosition", () => {
  const rect = { left: 0, top: 0, width: 100, height: 20 } as DOMRect;

  it("returns before for the top half", () => {
    expect(computeReorderPosition(rect, 5)).toBe("before");
  });

  it("returns after for the bottom half", () => {
    expect(computeReorderPosition(rect, 15)).toBe("after");
  });
});
```

- [ ] **Step 3: Run the tests**

Run: `cd /Users/coalpila/CloudStation/Coding/gavin/app && npm run check && npm test -- --run dragDrop.test.ts`
Expected: 0 type errors, PASS — 11 tests.

- [ ] **Step 4: Commit**

```bash
git add app/src/lib/dragDrop.ts app/src/lib/dragDrop.test.ts
git commit -m "feat(app): add dragDrop.ts, the shared drag-payload contract and zone math"
```

---

### Task 4: `layoutState.ts` — drag-and-drop orchestration actions

**Files:**
- Modify: `app/src/lib/layoutState.ts`
- Modify: `app/src/lib/layoutState.test.ts`

**Interfaces:**
- Consumes: Task 1's `detachLeaf`/`detachTab`/`graftLeaf`/`mergeIntoActivePane`/`moveTabWithinLeaf` from `./layout`; Task 2's `reorderWorkspace`/`movePage` from `./workspace`; nothing from Task 3 (`dragDrop.ts`'s types/functions are consumed by Tasks 5/6, the UI layer — `layoutState.ts` only deals in plain ids and modes, not `DragEvent`s).
- Produces: `type DropTarget = { kind: "page"; workspaceId: string; pageId: string; mode: "left" | "right" | "top" | "bottom" | "center" } | { kind: "workspace"; workspaceId: string }`, `movePaneOrTab(source: { kind: "pane" | "tab"; workspaceId: string; pageId: string; sessionId: string }, target: DropTarget): Promise<void>`, `reorderTabWithinPane(sessionId: string, targetIndex: number): Promise<void>`, `reorderWorkspaceAction(workspaceId: string, targetIndex: number): Promise<void>`, `movePageAction(pageId: string, targetWorkspaceId: string, targetIndex: number): Promise<void>`.

This is the only task that touches `layoutState.ts` in this plan — no daemon calls are made by anything added here (moving/reordering is pure data restructuring of already-loaded state, then a persist).

- [ ] **Step 1: Add the import**

At the top of `app/src/lib/layoutState.ts`, change the existing `import * as layout from "./layout";` line's usage is unaffected (it's already a namespace import, so newly-added `layout.detachLeaf` etc. need no new import statement) — no import changes needed for `layout.ts`'s additions. Same for `workspace.ts`: it's already imported as `import * as workspace from "./workspace";`, so Task 2's additions are already reachable as `workspace.reorderWorkspace`/`workspace.movePage` with no new import line needed either. Skip this step — there is nothing to add here. (This step exists only to tell you not to search for an import to add; proceed directly to Step 2.)

- [ ] **Step 2: Add the four new actions**

Add these functions to `app/src/lib/layoutState.ts`, placed after the existing `closePage` function (at the end of the file):

```typescript
export type DropTarget =
  | { kind: "page"; workspaceId: string; pageId: string; mode: "left" | "right" | "top" | "bottom" | "center" }
  | { kind: "workspace"; workspaceId: string };

// Moves a whole pane (source.kind === "pane") or a single tab
// (source.kind === "tab") from wherever it currently lives to the given
// target. Handles cross-page and same-page moves uniformly -- when
// source and target page happen to be identical, detach+graft still
// applies, they just both land on that one page's own layout, producing
// a single write instead of two. Dropping onto a workspace (not a
// specific page) always creates a brand-new page there; dropping onto a
// page either grafts a new split in one of 4 directions, or merges as a
// new tab into that page's remembered focused pane (mode "center"). No
// daemon calls are ever made -- this is pure restructuring of the
// already-loaded workspaces array, then a persist.
export async function movePaneOrTab(
  source: { kind: "pane" | "tab"; workspaceId: string; pageId: string; sessionId: string },
  target: DropTarget
): Promise<void> {
  const state = get(layoutState);
  const sourcePage = state.workspaces
    .find((w) => w.id === source.workspaceId)
    ?.pages.find((p) => p.id === source.pageId);
  if (!sourcePage) return;

  // No explicit "same page = no-op" guard here, deliberately: a page can
  // hold multiple panes (e.g. a 2x2 grid), and dragging one pane onto
  // another pane *within that same page* is a legitimate rearrangement,
  // not a no-op -- it produces a genuinely different tree (detach pane A,
  // graft it back in next to pane B in the chosen direction). The one
  // truly degenerate case -- detaching a page's ONLY pane and dropping it
  // back onto that same, now-just-removed page -- is already handled
  // correctly below without a special case: after workspace.removePage
  // runs, that page id no longer exists in `data` at all, so the
  // `if (!targetPage) return;` check further down fails to find it and
  // the whole operation aborts cleanly, before anything is written to the
  // store or persisted.
  const detachResult =
    source.kind === "pane"
      ? layout.detachLeaf(sourcePage.layout, source.sessionId)
      : layout.detachTab(sourcePage.layout, source.sessionId);
  if (!detachResult) return;
  const { tree: sourceTreeAfterDetach, detached } = detachResult;

  let data = sourceTreeAfterDetach
    ? workspace.updatePageLayout(state, source.workspaceId, source.pageId, sourceTreeAfterDetach)
    : workspace.removePage(state, source.workspaceId, source.pageId);

  if (target.kind === "workspace") {
    const targetWs = data.workspaces.find((w) => w.id === target.workspaceId);
    if (!targetWs) return;
    const pageId = crypto.randomUUID();
    data = workspace.createPage(
      data,
      target.workspaceId,
      pageId,
      `Page ${targetWs.pages.length + 1}`,
      detached
    );
  } else {
    const targetPage = data.workspaces
      .find((w) => w.id === target.workspaceId)
      ?.pages.find((p) => p.id === target.pageId);
    if (!targetPage) return;
    const newTargetTree =
      target.mode === "center"
        ? layout.mergeIntoActivePane(targetPage.layout, targetPage.focusedSessionId, detached)
        : layout.graftLeaf(targetPage.layout, detached, target.mode);
    data = workspace.updatePageLayout(data, target.workspaceId, target.pageId, newTargetTree);
  }

  const resolved = workspace.resolveActiveFocus(data);
  layoutState.update((s) => ({
    ...s,
    workspaces: resolved.state.workspaces,
    activeWorkspaceId: resolved.state.activeWorkspaceId,
    focusedSessionId: resolved.focusedSessionId,
  }));
  await persistWorkspaces(resolved.state.workspaces, resolved.state.activeWorkspaceId);
}

// Reorders a tab within its own pane's tab bar -- always scoped to the
// active page, since dragging to reorder only ever happens on something
// currently rendered on screen.
export async function reorderTabWithinPane(sessionId: string, targetIndex: number): Promise<void> {
  const state = get(layoutState);
  const location = activePageLocation(state);
  if (!location) return;
  const newTree = layout.moveTabWithinLeaf(location.tree, sessionId, targetIndex);
  const data = workspace.updatePageLayout(state, location.workspaceId, location.pageId, newTree);
  layoutState.update((s) => ({ ...s, workspaces: data.workspaces }));
  await persistWorkspaces(data.workspaces, state.activeWorkspaceId);
}

export async function reorderWorkspaceAction(workspaceId: string, targetIndex: number): Promise<void> {
  const state = get(layoutState);
  const data = workspace.reorderWorkspace(state, workspaceId, targetIndex);
  layoutState.update((s) => ({ ...s, workspaces: data.workspaces }));
  await persistWorkspaces(data.workspaces, data.activeWorkspaceId);
}

// Moves a page to a new position (reorder within its workspace, or move
// to a different one). If the moved page was the currently active one,
// the app follows it -- activeWorkspaceId (and that workspace's own
// activePageId) switch to keep showing the same page, rather than
// silently changing what's on screen out from under the user mid-drag.
export async function movePageAction(pageId: string, targetWorkspaceId: string, targetIndex: number): Promise<void> {
  const state = get(layoutState);
  const wasActivePage = workspace.getActivePage(state)?.id === pageId;
  let data = workspace.movePage(state, pageId, targetWorkspaceId, targetIndex);
  if (wasActivePage) {
    data = workspace.switchWorkspace(workspace.switchPage(data, targetWorkspaceId, pageId), targetWorkspaceId);
  }
  const resolved = workspace.resolveActiveFocus(data);
  layoutState.update((s) => ({
    ...s,
    workspaces: resolved.state.workspaces,
    activeWorkspaceId: resolved.state.activeWorkspaceId,
    focusedSessionId: resolved.focusedSessionId,
  }));
  await persistWorkspaces(resolved.state.workspaces, resolved.state.activeWorkspaceId);
}
```

- [ ] **Step 3: Add tests**

Add a helper and these tests to `app/src/lib/layoutState.test.ts`. Add `movePaneOrTab`, `reorderTabWithinPane`, `reorderWorkspaceAction`, `movePageAction` to the existing `import { ... } from "./layoutState";` list.

```typescript
describe("movePaneOrTab", () => {
  it("moves a whole pane (all its tabs together) to a different page, grafting right", async () => {
    // page-1 has TWO panes: a 2-tab leaf ["a","b"] and a separate 1-tab
    // leaf ["z"]. Dragging the pane anchored at "a" must detach the
    // WHOLE leaf it belongs to -- both "a" and "b" together -- not just
    // "a" alone, since detachLeaf detaches the entire pane a session id
    // is found in.
    setState(
      [
        ws(
          "ws-1",
          [
            page("page-1", {
              type: "split",
              direction: "row",
              sizes: [0.5, 0.5],
              children: [leaf(["a", "b"]), leaf(["z"])],
            }),
            page("page-2", leaf(["c"])),
          ],
          "page-1"
        ),
      ],
      "ws-1",
      "a"
    );

    await movePaneOrTab(
      { kind: "pane", workspaceId: "ws-1", pageId: "page-1", sessionId: "a" },
      { kind: "page", workspaceId: "ws-1", pageId: "page-2", mode: "right" }
    );

    const state = get(layoutState);
    expect(state.workspaces[0].pages[0].layout).toEqual(leaf(["z"]));
    expect(state.workspaces[0].pages[1].layout).toEqual({
      type: "split",
      direction: "row",
      sizes: [0.5, 0.5],
      children: [leaf(["c"]), leaf(["a", "b"])],
    });
  });

  it("removes the source page entirely when detaching its only pane", async () => {
    setState(
      [ws("ws-1", [page("page-1", leaf(["a"])), page("page-2", leaf(["b"]))], "page-1")],
      "ws-1",
      "a"
    );

    await movePaneOrTab(
      { kind: "pane", workspaceId: "ws-1", pageId: "page-1", sessionId: "a" },
      { kind: "page", workspaceId: "ws-1", pageId: "page-2", mode: "left" }
    );

    const state = get(layoutState);
    expect(state.workspaces[0].pages.map((p) => p.id)).toEqual(["page-2"]);
  });

  it("moves a single tab, merging it as a new tab via mode center", async () => {
    setState(
      [ws("ws-1", [page("page-1", leaf(["a", "b"])), page("page-2", leaf(["c"]))], "page-1")],
      "ws-1",
      "a"
    );

    await movePaneOrTab(
      { kind: "tab", workspaceId: "ws-1", pageId: "page-1", sessionId: "b" },
      { kind: "page", workspaceId: "ws-1", pageId: "page-2", mode: "center" }
    );

    const state = get(layoutState);
    expect(state.workspaces[0].pages[0].layout).toEqual(leaf(["a"]));
    expect(state.workspaces[0].pages[1].layout).toEqual(leaf(["c", "b"], 1));
  });

  it("creates a new page when the drop target is a workspace, not a specific page", async () => {
    // Same reasoning as the previous test: page-1 needs two SEPARATE
    // panes for detaching one of them to leave the page non-empty and to
    // correctly carry both of the detached pane's tabs together.
    setState(
      [
        ws("ws-1", [
          page("page-1", {
            type: "split",
            direction: "row",
            sizes: [0.5, 0.5],
            children: [leaf(["a", "b"]), leaf(["z"])],
          }),
        ]),
        ws("ws-2", []),
      ],
      "ws-1",
      "a"
    );

    await movePaneOrTab(
      { kind: "pane", workspaceId: "ws-1", pageId: "page-1", sessionId: "a" },
      { kind: "workspace", workspaceId: "ws-2" }
    );

    const state = get(layoutState);
    expect(state.workspaces[0].pages[0].layout).toEqual(leaf(["z"]));
    expect(state.workspaces[1].pages).toHaveLength(1);
    expect(state.workspaces[1].pages[0].layout).toEqual(leaf(["a", "b"]));
  });

  it("is a no-op when the whole page's only pane is dropped back onto that same, now-empty page", async () => {
    // page-1's tree is a single leaf holding both "a" and "b" -- one
    // pane, two tabs -- so dragging that whole pane detaches the page's
    // entire tree, removing the page. There's no page left to graft back
    // into, so this resolves via the natural "target page not found"
    // fallback, not an explicit same-page guard (see movePaneOrTab's own
    // comment on why there isn't one).
    setState([ws("ws-1", [page("page-1", leaf(["a", "b"]))])], "ws-1", "a");

    await movePaneOrTab(
      { kind: "pane", workspaceId: "ws-1", pageId: "page-1", sessionId: "a" },
      { kind: "page", workspaceId: "ws-1", pageId: "page-1", mode: "right" }
    );

    expect(get(layoutState).workspaces[0].pages[0].layout).toEqual(leaf(["a", "b"]));
    expect(backend.setWorkspacesState).not.toHaveBeenCalled();
  });

  it("rearranges panes within the same page when the page has more than one pane", async () => {
    // page-1 has TWO panes (two separate leaves, "a" and "b"), unlike the
    // single-pane-two-tabs case above -- dragging pane "a" onto the same
    // page is a genuine rearrangement here (detach "a", the page still
    // has "b" left, graft "a" back in next to it), not a no-op.
    setState(
      [
        ws(
          "ws-1",
          [
            page("page-1", {
              type: "split",
              direction: "row",
              sizes: [0.5, 0.5],
              children: [leaf(["a"]), leaf(["b"])],
            }),
          ]
        ),
      ],
      "ws-1",
      "a"
    );

    await movePaneOrTab(
      { kind: "pane", workspaceId: "ws-1", pageId: "page-1", sessionId: "a" },
      { kind: "page", workspaceId: "ws-1", pageId: "page-1", mode: "bottom" }
    );

    const state = get(layoutState);
    expect(state.workspaces[0].pages[0].layout).toEqual({
      type: "split",
      direction: "column",
      sizes: [0.5, 0.5],
      children: [leaf(["b"]), leaf(["a"])],
    });
    expect(backend.setWorkspacesState).toHaveBeenCalled();
  });
});

describe("reorderTabWithinPane", () => {
  it("reorders a tab within the active page's pane and persists", async () => {
    setState([ws("ws-1", [page("page-1", leaf(["a", "b", "c"], 0))])], "ws-1", "a");

    await reorderTabWithinPane("a", 2);

    expect(get(layoutState).workspaces[0].pages[0].layout).toEqual(leaf(["b", "c", "a"], 2));
  });
});

describe("reorderWorkspaceAction", () => {
  it("reorders workspaces and persists", async () => {
    setState([ws("ws-1", []), ws("ws-2", []), ws("ws-3", [])], "ws-1", null);

    await reorderWorkspaceAction("ws-3", 0);

    expect(get(layoutState).workspaces.map((w) => w.id)).toEqual(["ws-3", "ws-1", "ws-2"]);
  });
});

describe("movePageAction", () => {
  it("moves a non-active page without changing activeWorkspaceId", async () => {
    setState(
      [
        ws("ws-1", [page("page-1", leaf(["a"])), page("page-2", leaf(["b"]))], "page-1"),
        ws("ws-2", []),
      ],
      "ws-1",
      "a"
    );

    await movePageAction("page-2", "ws-2", 0);

    const state = get(layoutState);
    expect(state.activeWorkspaceId).toBe("ws-1");
    expect(state.workspaces[1].pages.map((p) => p.id)).toEqual(["page-2"]);
  });

  it("follows the moved page when it was the active one", async () => {
    setState(
      [ws("ws-1", [page("page-1", leaf(["a"]))], "page-1"), ws("ws-2", [])],
      "ws-1",
      "a"
    );

    await movePageAction("page-1", "ws-2", 0);

    const state = get(layoutState);
    expect(state.activeWorkspaceId).toBe("ws-2");
    expect(state.workspaces[1].activePageId).toBe("page-1");
    expect(state.focusedSessionId).toBe("a");
  });
});
```

- [ ] **Step 4: Run the full frontend test suite and type checker**

Run: `cd /Users/coalpila/CloudStation/Coding/gavin/app && npm run check && npm test -- --run`
Expected: 0 type errors in `layoutState.ts`/`layoutState.test.ts` (other files — `Sidebar.svelte`, `Pane.svelte` — are untouched by this task and unaffected). All tests pass, including the new ones above.

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/layoutState.ts app/src/lib/layoutState.test.ts
git commit -m "feat(app): add drag-and-drop orchestration actions to layoutState.ts"
```

---

### Task 5: `Sidebar.svelte` — drag source and drop targets for workspace/page rows

**Files:**
- Modify: `app/src/lib/Sidebar.svelte`

**Interfaces:**
- Consumes: `setDragPayload`/`getDragKind`/`getDragPayload`/`computeDropZone`/`computeReorderPosition`/`DropZone`/`ReorderPosition` from `./dragDrop` (Task 3); `movePaneOrTab`/`reorderWorkspaceAction`/`movePageAction` from `./layoutState` (Task 4).

This is GUI-only, same established limitation as every other Svelte-component task in this project — verification is `npm run check` only; the actual drag interactions need a human at the keyboard. This task makes **targeted additions** to the existing `Sidebar.svelte` from Part 2 (draggable attributes, new event handlers, new hover-state tracking, new CSS) — it does not rewrite the whole file, and must not disturb the existing expand/collapse, rename, or close logic already in place.

**Background:** every workspace and page row becomes both a drag source (you can pick it up to reorder/move it) and a drop target (other things can be dropped onto it). What a drop *means* depends on what's being dragged, determined live during `dragover` via `getDragKind` (not `getDragPayload`, which is only reliable at `drop` — see `dragDrop.ts`'s own module comment): dropping a `"workspace"` or `"page"` payload means reordering (a thin insertion-line highlight, before/after the hovered row); dropping a `"pane"`/`"tab"` payload onto a **page** row means grafting via the 5-zone overlay; dropping a `"pane"`/`"tab"` payload onto a **workspace** row always means "create a new page there" (a single highlighted state, no sub-zones, since there's no existing page layout to graft into).

- [ ] **Step 1: Add imports and hover-state tracking**

Add to `Sidebar.svelte`'s existing `<script lang="ts">` block, alongside its current imports:

```typescript
  import {
    setDragPayload,
    getDragKind,
    getDragPayload,
    computeDropZone,
    computeReorderPosition,
    type DropZone,
    type ReorderPosition,
  } from "./dragDrop";
  import { movePaneOrTab, reorderWorkspaceAction, movePageAction } from "./layoutState";
  import type { Workspace, Page } from "./workspace";
```

Add this state near the component's other `$state` declarations:

```typescript
  // Tracks which row is currently being hovered during a drag, and how --
  // recomputed fresh on every dragover, so a stale highlight left behind
  // by an imperfect dragleave (a well-known HTML5 DnD fragility -- it
  // fires when the pointer crosses a CHILD element's boundary too, not
  // just when truly leaving the row) gets corrected the moment the
  // pointer moves onto whatever row is actually now under it. Cleared
  // unconditionally on dragend/drop so nothing lingers after the
  // operation completes.
  type HoverState =
    | { targetId: string; kind: "reorder"; position: ReorderPosition }
    | { targetId: string; kind: "zone"; zone: DropZone }
    | { targetId: string; kind: "append" };
  let hoverState: HoverState | null = $state(null);

  function clearHover(): void {
    hoverState = null;
  }
```

- [ ] **Step 2: Add the drag/drop handler functions**

Add these functions, near the component's other functions (e.g. after `quickAddPage`):

```typescript
  function handleWorkspaceDragStart(event: DragEvent, workspaceId: string): void {
    setDragPayload(event, { kind: "workspace", workspaceId });
  }

  function handleWorkspaceDragOver(event: DragEvent, workspaceId: string): void {
    const kind = getDragKind(event);
    if (!kind) return;
    event.preventDefault();
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    if (kind === "workspace" || kind === "page") {
      hoverState = { targetId: workspaceId, kind: "reorder", position: computeReorderPosition(rect, event.clientY) };
    } else {
      hoverState = { targetId: workspaceId, kind: "append" };
    }
  }

  async function handleWorkspaceDrop(event: DragEvent, ws: Workspace, index: number): Promise<void> {
    event.preventDefault();
    const payload = getDragPayload(event);
    clearHover();
    if (!payload) return;
    if (payload.kind === "workspace") {
      // Simple index/index+1 relative to the currently rendered array --
      // an approximation (dragging past an immediate neighbor can land
      // one position off in edge cases, since reorderWorkspace removes
      // the moved item before re-inserting, which can shift indices).
      // Acceptable for a first cut of a manually-tested drag interaction;
      // refine later if it feels wrong in practice.
      const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
      const position = computeReorderPosition(rect, event.clientY);
      const targetIndex = position === "before" ? index : index + 1;
      await reorderWorkspaceAction(payload.workspaceId, targetIndex);
    } else if (payload.kind === "page") {
      await movePageAction(payload.pageId, ws.id, ws.pages.length);
    } else {
      await movePaneOrTab(
        { kind: payload.kind, workspaceId: payload.workspaceId, pageId: payload.pageId, sessionId: payload.sessionId },
        { kind: "workspace", workspaceId: ws.id }
      );
    }
  }

  function handlePageDragStart(event: DragEvent, workspaceId: string, pageId: string): void {
    setDragPayload(event, { kind: "page", workspaceId, pageId });
  }

  function handlePageDragOver(event: DragEvent, pageId: string): void {
    const kind = getDragKind(event);
    if (!kind || kind === "workspace") return;
    event.preventDefault();
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    if (kind === "page") {
      hoverState = { targetId: pageId, kind: "reorder", position: computeReorderPosition(rect, event.clientY) };
    } else {
      hoverState = { targetId: pageId, kind: "zone", zone: computeDropZone(rect, event.clientX, event.clientY) };
    }
  }

  async function handlePageDrop(event: DragEvent, ws: Workspace, page: Page, index: number): Promise<void> {
    event.preventDefault();
    const payload = getDragPayload(event);
    clearHover();
    if (!payload || payload.kind === "workspace") return;
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    if (payload.kind === "page") {
      const position = computeReorderPosition(rect, event.clientY);
      const targetIndex = position === "before" ? index : index + 1;
      await movePageAction(payload.pageId, ws.id, targetIndex);
    } else {
      const zone = computeDropZone(rect, event.clientX, event.clientY);
      await movePaneOrTab(
        { kind: payload.kind, workspaceId: payload.workspaceId, pageId: payload.pageId, sessionId: payload.sessionId },
        { kind: "page", workspaceId: ws.id, pageId: page.id, mode: zone }
      );
    }
  }
```

- [ ] **Step 3: Wire the template**

In the existing `{#each $layoutState.workspaces as ws (ws.id)}` loop, add an index binding: change it to `{#each $layoutState.workspaces as ws, wsIndex (ws.id)}`.

Add these attributes to the existing `<div class="workspace-row" ...>` element (keep its existing `class:active` and all its existing child content exactly as-is — only add the following: two more `class:` directives, `draggable`, and 4 new event handlers):

```svelte
          class:drop-before={hoverState?.targetId === ws.id &&
            hoverState.kind === "reorder" &&
            hoverState.position === "before"}
          class:drop-after={hoverState?.targetId === ws.id &&
            hoverState.kind === "reorder" &&
            hoverState.position === "after"}
          class:drop-append={hoverState?.targetId === ws.id && hoverState.kind === "append"}
          draggable="true"
          ondragstart={(e) => handleWorkspaceDragStart(e, ws.id)}
          ondragover={(e) => handleWorkspaceDragOver(e, ws.id)}
          ondragleave={clearHover}
          ondragend={clearHover}
          ondrop={(e) => handleWorkspaceDrop(e, ws, wsIndex)}
```

In the nested `{#each ws.pages as page (page.id)}` loop, add an index binding: change it to `{#each ws.pages as page, pageIndex (page.id)}`.

Add these attributes to the existing `<div class="page-row" ...>` element (keep its existing `class:active` and all its existing child content exactly as-is — only add the following):

```svelte
              class:drop-before={hoverState?.targetId === page.id &&
                hoverState.kind === "reorder" &&
                hoverState.position === "before"}
              class:drop-after={hoverState?.targetId === page.id &&
                hoverState.kind === "reorder" &&
                hoverState.position === "after"}
              class:drop-zone-left={hoverState?.targetId === page.id &&
                hoverState.kind === "zone" &&
                hoverState.zone === "left"}
              class:drop-zone-right={hoverState?.targetId === page.id &&
                hoverState.kind === "zone" &&
                hoverState.zone === "right"}
              class:drop-zone-top={hoverState?.targetId === page.id &&
                hoverState.kind === "zone" &&
                hoverState.zone === "top"}
              class:drop-zone-bottom={hoverState?.targetId === page.id &&
                hoverState.kind === "zone" &&
                hoverState.zone === "bottom"}
              class:drop-zone-center={hoverState?.targetId === page.id &&
                hoverState.kind === "zone" &&
                hoverState.zone === "center"}
              draggable="true"
              ondragstart={(e) => handlePageDragStart(e, ws.id, page.id)}
              ondragover={(e) => handlePageDragOver(e, page.id)}
              ondragleave={clearHover}
              ondragend={clearHover}
              ondrop={(e) => handlePageDrop(e, ws, page, pageIndex)}
```

- [ ] **Step 4: Add the drop-indicator CSS**

Add to the `<style>` block, after the existing `.page-row.active` rule:

```css
  .workspace-row.drop-before,
  .page-row.drop-before {
    box-shadow: inset 0 2px 0 0 #4a9eff;
  }
  .workspace-row.drop-after,
  .page-row.drop-after {
    box-shadow: inset 0 -2px 0 0 #4a9eff;
  }
  .workspace-row.drop-append {
    background: #2d4a6a;
  }
  .page-row.drop-zone-left {
    box-shadow: inset 2px 0 0 0 #4a9eff;
  }
  .page-row.drop-zone-right {
    box-shadow: inset -2px 0 0 0 #4a9eff;
  }
  .page-row.drop-zone-top {
    box-shadow: inset 0 2px 0 0 #4a9eff;
  }
  .page-row.drop-zone-bottom {
    box-shadow: inset 0 -2px 0 0 #4a9eff;
  }
  .page-row.drop-zone-center {
    background: #2d4a6a;
  }
```

- [ ] **Step 5: Type-check**

Run: `cd /Users/coalpila/CloudStation/Coding/gavin/app && npm run check`
Expected: 0 errors in `Sidebar.svelte` specifically (Task 6 hasn't landed yet, so `Pane.svelte` is unaffected either way — there should be no errors anywhere at this point since Task 6 doesn't remove or change any existing exports Sidebar.svelte or anything else depends on).

- [ ] **Step 6: Commit**

```bash
git add app/src/lib/Sidebar.svelte
git commit -m "feat(app): wire drag-and-drop into Sidebar.svelte's workspace/page rows"
```

---

### Task 6: `Pane.svelte` — drag source, live 5-zone drop target, and same-pane tab reordering

**Files:**
- Modify: `app/src/lib/Pane.svelte`

**Interfaces:**
- Consumes: `setDragPayload`/`getDragKind`/`getDragPayload`/`computeDropZone`/`type DropZone` from `./dragDrop` (Task 3); `movePaneOrTab`/`reorderTabWithinPane` from `./layoutState` (Task 4); `getActiveWorkspace`/`getActivePage` from `./workspace` (already used indirectly elsewhere, not yet imported into this file).

This is GUI-only, same limitation as Task 5 — verification is `npm run check` only. This task makes **targeted additions** to the existing `Pane.svelte` from Milestone C/Part 2 — it must not disturb the existing tab-bar rendering, double-click-rename, or focus-indicator logic already in place.

**Key simplification, worth understanding before writing this task:** `Pane.svelte` is only ever rendered for the currently active page — `+page.svelte` mounts `<LayoutTree node={activeTree} .../>` (which recursively renders `Pane.svelte`) only inside its `status === "ready"` branch, for whichever page is active. This means every drag that *originates* from a `Pane.svelte` instance is, by construction, always from the active workspace/page — there's no need to thread `workspaceId`/`pageId` down through new props; a small helper reads them directly from `$layoutState` via `getActiveWorkspace`/`getActivePage` (both already imported and used by other files in this codebase).

**A real HTML5 DnD bubbling subtlety this task must get right:** `dragstart` events bubble. If both a `.tab` button and its parent `.tab-bar` are `draggable="true"` with their own `ondragstart` handlers, starting a drag on a `.tab` fires that tab's own `dragstart` handler *and then* bubbles up to also fire the `.tab-bar`'s handler on the same event/`dataTransfer` — both `setDragPayload` calls would then write to the *same* `dataTransfer` object (under different MIME types, since payload kind is encoded in the type string), and `getDragKind`'s fixed iteration order (`workspace`, `page`, `pane`, `tab`) would find `"pane"` before `"tab"`, silently turning a single-tab drag into a whole-pane drag. The tab-level handler must call `event.stopPropagation()` to prevent this.

- [ ] **Step 1: Add imports and a helper for the active location**

Add to `Pane.svelte`'s existing `<script lang="ts">` block, alongside its current imports:

```typescript
  import {
    setDragPayload,
    getDragKind,
    getDragPayload,
    computeDropZone,
    type DropZone,
  } from "./dragDrop";
  import { movePaneOrTab, reorderTabWithinPane } from "./layoutState";
  import { getActiveWorkspace, getActivePage } from "./workspace";
```

Add this helper near the component's other functions:

```typescript
  function activeLocation(): { workspaceId: string; pageId: string } | null {
    const ws = getActiveWorkspace($layoutState);
    const page = getActivePage($layoutState);
    if (!ws || !page) return null;
    return { workspaceId: ws.id, pageId: page.id };
  }
```

Add this state near the component's other `$state` declarations:

```typescript
  // Hover feedback for the two different drop surfaces this pane offers:
  // contentDropZone for the 5-zone overlay on .content (grafting from
  // elsewhere, cross-page or same-page), tabReorderState for the
  // before/after insertion indicator when dragging a tab across this
  // pane's own tab-bar.
  let contentDropZone: DropZone | null = $state(null);
  let tabReorderState: { sessionId: string; position: "before" | "after" } | null = $state(null);
```

- [ ] **Step 2: Add the drag-source and drop-target handler functions**

Add these functions near the component's other functions:

```typescript
  function handlePaneDragStart(event: DragEvent): void {
    const location = activeLocation();
    if (!location) return;
    setDragPayload(event, { kind: "pane", workspaceId: location.workspaceId, pageId: location.pageId, sessionId: active });
  }

  function handleTabDragStart(event: DragEvent, sessionId: string): void {
    // Prevents this event from also triggering the parent .tab-bar's own
    // dragstart handler via bubbling -- see this task's module-level note
    // on why that would silently turn a single-tab drag into a
    // whole-pane drag.
    event.stopPropagation();
    const location = activeLocation();
    if (!location) return;
    setDragPayload(event, { kind: "tab", workspaceId: location.workspaceId, pageId: location.pageId, sessionId });
  }

  function handleTabDragOver(event: DragEvent, sessionId: string): void {
    if (getDragKind(event) !== "tab") return;
    event.preventDefault();
    event.stopPropagation();
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const x = (event.clientX - rect.left) / rect.width;
    tabReorderState = { sessionId, position: x < 0.5 ? "before" : "after" };
  }

  function clearTabReorder(): void {
    tabReorderState = null;
  }

  async function handleTabDrop(event: DragEvent, sessionId: string, index: number): Promise<void> {
    event.preventDefault();
    event.stopPropagation();
    const payload = getDragPayload(event);
    tabReorderState = null;
    if (!payload || payload.kind !== "tab") return;
    const location = activeLocation();
    if (!location) return;
    if (
      leaf.tabs.includes(payload.sessionId) &&
      payload.workspaceId === location.workspaceId &&
      payload.pageId === location.pageId
    ) {
      // Reordering within this same pane's own tab bar.
      const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
      const x = (event.clientX - rect.left) / rect.width;
      const targetIndex = x < 0.5 ? index : index + 1;
      await reorderTabWithinPane(payload.sessionId, targetIndex);
    } else {
      // A tab from elsewhere, dropped onto a specific tab in this pane --
      // merge it in as a new tab here, same as dropping on .content's
      // center zone.
      await movePaneOrTab(
        { kind: "tab", workspaceId: payload.workspaceId, pageId: payload.pageId, sessionId: payload.sessionId },
        { kind: "page", workspaceId: location.workspaceId, pageId: location.pageId, mode: "center" }
      );
    }
  }

  function handleContentDragOver(event: DragEvent): void {
    const kind = getDragKind(event);
    if (kind !== "pane" && kind !== "tab") return;
    event.preventDefault();
    const rect = containerEl.getBoundingClientRect();
    contentDropZone = computeDropZone(rect, event.clientX, event.clientY);
  }

  function clearContentDrop(): void {
    contentDropZone = null;
  }

  async function handleContentDrop(event: DragEvent): Promise<void> {
    event.preventDefault();
    const payload = getDragPayload(event);
    clearContentDrop();
    if (!payload || (payload.kind !== "pane" && payload.kind !== "tab")) return;
    const location = activeLocation();
    if (!location) return;
    const rect = containerEl.getBoundingClientRect();
    const zone = computeDropZone(rect, event.clientX, event.clientY);
    await movePaneOrTab(
      { kind: payload.kind, workspaceId: payload.workspaceId, pageId: payload.pageId, sessionId: payload.sessionId },
      { kind: "page", workspaceId: location.workspaceId, pageId: location.pageId, mode: zone }
    );
  }
```

- [ ] **Step 3: Wire the template**

On the existing `<div class="tab-bar">` element, add `draggable="true"` and `ondragstart={handlePaneDragStart}` (this is the whole-pane drag source — dragging from the tab-bar's own background, not from a specific `.tab` button, which has its own nearer, stopPropagation-guarded handler per Step 2).

On the existing `{#each leaf.tabs as sessionId (sessionId)}` loop, add an index binding: change it to `{#each leaf.tabs as sessionId, tabIndex (sessionId)}`.

On the existing `<button class="tab" ...>` element, add: `draggable="true"`, two more `class:` directives, and 4 new event handlers (keep everything else on this element exactly as it is):

```svelte
        class:drop-before={tabReorderState?.sessionId === sessionId && tabReorderState.position === "before"}
        class:drop-after={tabReorderState?.sessionId === sessionId && tabReorderState.position === "after"}
        draggable="true"
        ondragstart={(e) => handleTabDragStart(e, sessionId)}
        ondragover={(e) => handleTabDragOver(e, sessionId)}
        ondragleave={clearTabReorder}
        ondragend={clearTabReorder}
        ondrop={(e) => handleTabDrop(e, sessionId, tabIndex)}
```

On the existing `<div class="content" bind:this={containerEl} onmousedown={...}>` element, add 4 new event handlers and one `class:` directive (keep its existing `bind:this` and `onmousedown` exactly as they are):

```svelte
    class:drop-zone-left={contentDropZone === "left"}
    class:drop-zone-right={contentDropZone === "right"}
    class:drop-zone-top={contentDropZone === "top"}
    class:drop-zone-bottom={contentDropZone === "bottom"}
    class:drop-zone-center={contentDropZone === "center"}
    ondragover={handleContentDragOver}
    ondragleave={clearContentDrop}
    ondragend={clearContentDrop}
    ondrop={handleContentDrop}
```

(This adds 5 `class:` directives total, one per zone — list them all; each is independently `false` unless `contentDropZone` matches exactly.)

- [ ] **Step 4: Add the drop-indicator CSS**

Add to the `<style>` block, after the existing `.tab.focused` rule:

```css
  .tab.drop-before {
    box-shadow: inset 2px 0 0 0 #4a9eff;
  }
  .tab.drop-after {
    box-shadow: inset -2px 0 0 0 #4a9eff;
  }
```

Add to the `<style>` block, after the existing `.content` rule. Since `.content` is `position: relative`, these zone overlays use `::after` on a modifier class so they don't require extra markup — each shows a translucent highlight covering roughly the relevant edge or the center:

```css
  .content.drop-zone-left::after,
  .content.drop-zone-right::after,
  .content.drop-zone-top::after,
  .content.drop-zone-bottom::after,
  .content.drop-zone-center::after {
    content: "";
    position: absolute;
    background: rgba(74, 158, 255, 0.35);
    pointer-events: none;
    z-index: 2;
  }
  .content.drop-zone-left::after {
    inset: 0 75% 0 0;
  }
  .content.drop-zone-right::after {
    inset: 0 0 0 75%;
  }
  .content.drop-zone-top::after {
    inset: 0 0 75% 0;
  }
  .content.drop-zone-bottom::after {
    inset: 75% 0 0 0;
  }
  .content.drop-zone-center::after {
    inset: 25%;
  }
```

- [ ] **Step 5: Type-check and full verification**

Run: `cd /Users/coalpila/CloudStation/Coding/gavin/app && npm run check && npm test -- --run && npm run build`
Expected: `npm run check`: 0 errors (only the same pre-existing a11y-style warnings from before this whole plan, plus whatever new ones this task's added interactive elements pick up — same category, not blocking, matching every other component in this codebase). `npm test`: all tests pass — this task adds no new test file, since it's pure UI wiring with no new pure logic (everything it calls was already tested in Tasks 1-4). `npm run build`: succeeds.

- [ ] **Step 6: Commit**

```bash
git add app/src/lib/Pane.svelte
git commit -m "feat(app): wire drag-and-drop into Pane.svelte (source, 5-zone drop target, tab reorder)"
```
