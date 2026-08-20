# Tab & Sidebar Context Menus Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Right-click menus on pane tabs, sidebar workspace rows, page rows and session rows, plus browser-style tab pinning persisted in the layout tree.

**Architecture:** Pure menu-builder modules (`tabMenu.ts`, `sidebarMenu.ts`) return `ContextMenuEntry[]` for the existing `contextMenu.ts` store, rendered by a single root-level `<ContextMenu />`. Pin state is a `pinned: string[]` field on layout leaves, kept as a prefix of `tabs` by pure functions in `layout.ts` and mirrored in the Rust `LayoutNode` with a serde default so old state loads.

**Tech Stack:** Svelte 5 (runes), TypeScript, vitest, Tauri 2 (`plugin-opener`, `plugin-dialog`, `plugin-clipboard-manager`), Rust/serde.

**Spec:** `docs/superpowers/specs/2026-08-20-tab-sidebar-context-menus-design.md`

## Global Constraints

- Builders are pure: no DOM, side effects only through `hooks` or imported store actions (mockable in tests), exactly like `app/src/lib/cardMenu.ts`.
- Pinned tabs are always a **prefix** of a leaf's `tabs`; every layout mutation must preserve it (`normalizeLeaf`).
- Bulk closes and `⌘W` never close a pinned tab; the explicit menu **Close** does.
- Errors from Finder/clipboard/picker go through `hooks.reportError` → `message(text, { title: "gavin", kind: "error" })` from `@tauri-apps/plugin-dialog` plus `console.error`.
- Folders open with `openPath`, files reveal with `revealItemInDir` (both `@tauri-apps/plugin-opener`).
- Leave `PlanTree.svelte` untouched (another session is editing it).
- All commands run from `app/` unless a path says otherwise. Commit messages end with the `Co-Authored-By` / `Claude-Session` trailer used in this repo.

---

### Task 1: Rust — `pinned` on layout leaves

**Files:**
- Modify: `app/src-tauri/src/layout.rs:12-22` (enum) and its tests
- Modify: `app/src-tauri/src/config.rs:148-151`, `app/src-tauri/src/session.rs:631` (leaf constructors in tests)

**Interfaces:**
- Produces: `LayoutNode::Leaf { tabs, active_tab_index, pinned: Vec<String> }` serialized as `{"type":"leaf","tabs":[...],"activeTabIndex":n,"pinned":[...]}`; `pinned` omitted when empty; missing on input → empty.

- [ ] **Step 1: Write the failing tests** — append inside `mod tests` in `app/src-tauri/src/layout.rs`:

```rust
    #[test]
    fn leaf_without_pinned_deserializes_with_no_pinned_tabs() {
        let json = serde_json::json!({ "type": "leaf", "tabs": ["s1", "s2"], "activeTabIndex": 1 });
        let tree: LayoutNode = serde_json::from_value(json).unwrap();
        assert_eq!(
            tree,
            LayoutNode::Leaf {
                tabs: vec!["s1".to_string(), "s2".to_string()],
                active_tab_index: 1,
                pinned: Vec::new(),
            }
        );
    }

    #[test]
    fn pinned_round_trips_and_is_omitted_when_empty() {
        let pinned = LayoutNode::Leaf {
            tabs: vec!["s1".to_string(), "s2".to_string()],
            active_tab_index: 0,
            pinned: vec!["s1".to_string()],
        };
        let json = serde_json::to_value(&pinned).unwrap();
        assert_eq!(json["pinned"], serde_json::json!(["s1"]));
        assert_eq!(serde_json::from_value::<LayoutNode>(json).unwrap(), pinned);

        let plain = serde_json::to_value(&leaf(&["s1"])).unwrap();
        assert!(plain.get("pinned").is_none(), "empty pinned must not be serialized");
    }
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd app/src-tauri && cargo test -p app layout::tests 2>&1 | tail -20`
Expected: compile error — `variant LayoutNode::Leaf has no field named pinned`.

- [ ] **Step 3: Add the field and fix constructors**

In `app/src-tauri/src/layout.rs` replace the `Leaf` variant:

```rust
    Leaf {
        tabs: Vec<String>,
        #[serde(rename = "activeTabIndex")]
        active_tab_index: usize,
        /// Pinned tab ids (a subset of `tabs`). Absent in state written
        /// before pinning existed, hence the default; omitted again when
        /// empty so old and new state stay byte-identical until used.
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        pinned: Vec<String>,
    },
```

Add `pinned: Vec::new(),` to every struct-literal construction of `LayoutNode::Leaf`:
- `layout.rs` test helper `fn leaf(...)` (line ~42)
- `config.rs` `fn sample_layout()` (line ~148)
- `session.rs` `fn leaf(...)` (line ~631)

(`match` arms already use `..` and need no change.)

- [ ] **Step 4: Run to verify they pass**

Run: `cd app/src-tauri && cargo test -p app 2>&1 | grep -E 'test result|FAILED'`
Expected: all `test result: ok`.

- [ ] **Step 5: Commit**

```bash
git add app/src-tauri/src/layout.rs app/src-tauri/src/config.rs app/src-tauri/src/session.rs
git commit -m "feat(layout): pinned tab ids on layout leaves (serde default)"
```

---

### Task 2: `layout.ts` — pin model and bulk-close targets

**Files:**
- Modify: `app/src/lib/layout.ts`
- Test: `app/src/lib/layout.test.ts`

**Interfaces:**
- Produces (all exported from `./layout`):
  - type `Leaf = Extract<LayoutNode, { type: "leaf" }>`; `LayoutNode` leaf gains `pinned?: string[]`
  - `normalizeLeaf(leaf: Leaf): Leaf`
  - `isPinned(tree: LayoutNode, tabId: string): boolean`
  - `pinTab(tree: LayoutNode, tabId: string): LayoutNode`
  - `unpinTab(tree: LayoutNode, tabId: string): LayoutNode`
  - `clampReorderIndex(leaf: Leaf, tabId: string, targetIndex: number): number`
  - `bulkCloseTargets(tabs: string[], pinned: string[], tabId: string, mode: "others" | "right" | "left"): string[]`
  - `addTab`, `closeTab`, `detachTab`, `mergeIntoActivePane`, `moveTabWithinLeaf` now preserve `pinned`.

- [ ] **Step 1: Write the failing tests** — append to `app/src/lib/layout.test.ts` (extend the import list with `normalizeLeaf, isPinned, pinTab, unpinTab, clampReorderIndex, bulkCloseTargets`):

```ts
describe("pinning", () => {
  const leaf = (tabs: string[], activeTabIndex = 0, pinned?: string[]): LayoutNode =>
    pinned ? { type: "leaf", tabs, activeTabIndex, pinned } : { type: "leaf", tabs, activeTabIndex };

  it("pinTab moves the tab to the end of the pinned block and records it", () => {
    const tree = pinTab(leaf(["a", "b", "c"], 2, ["a"]), "c");
    expect(tree).toEqual(leaf(["a", "c", "b"], 1, ["a", "c"]));
  });

  it("pinTab keeps the active tab active when another tab is pinned", () => {
    const tree = pinTab(leaf(["a", "b", "c"], 1), "c");
    expect(tree).toEqual(leaf(["c", "a", "b"], 2, ["c"]));
  });

  it("unpinTab moves the tab to the start of the unpinned block", () => {
    const tree = unpinTab(leaf(["a", "b", "c", "d"], 0, ["a", "b"]), "a");
    expect(tree).toEqual(leaf(["b", "a", "c", "d"], 1, ["b"]));
  });

  it("unpinning the last pinned tab drops the pinned field entirely", () => {
    const tree = unpinTab(leaf(["a", "b"], 0, ["a"]), "a");
    expect(tree).toEqual({ type: "leaf", tabs: ["a", "b"], activeTabIndex: 0 });
    expect("pinned" in tree).toBe(false);
  });

  it("isPinned finds the tab anywhere in a split", () => {
    const tree: LayoutNode = {
      type: "split",
      direction: "row",
      children: [leaf(["a"]), leaf(["b", "c"], 0, ["b"])],
      sizes: [0.5, 0.5],
    };
    expect(isPinned(tree, "b")).toBe(true);
    expect(isPinned(tree, "c")).toBe(false);
    expect(isPinned(tree, "zzz")).toBe(false);
  });

  it("normalizeLeaf drops pinned ids that are not tabs and reorders pinned first", () => {
    const out = normalizeLeaf({ type: "leaf", tabs: ["a", "b", "c"], activeTabIndex: 2, pinned: ["c", "ghost"] });
    expect(out).toEqual(leaf(["c", "a", "b"], 0, ["c"]));
  });

  it("closeTab removes the id from pinned too", () => {
    const tree = closeTab(leaf(["a", "b"], 1, ["a"]), "a");
    expect(tree).toEqual({ type: "leaf", tabs: ["b"], activeTabIndex: 0 });
  });

  it("addTab appends after the pinned block and keeps pinned", () => {
    const tree = addTab(leaf(["a", "b"], 0, ["a"]), "a", "n");
    expect(tree).toEqual(leaf(["a", "b", "n"], 2, ["a"]));
  });

  it("detachTab carries the pinned flag on the detached leaf", () => {
    const result = detachTab(leaf(["a", "b"], 0, ["a"]), "a");
    expect(result?.detached).toEqual(leaf(["a"], 0, ["a"]));
    expect(result?.tree).toEqual({ type: "leaf", tabs: ["b"], activeTabIndex: 0 });
  });

  it("mergeIntoActivePane puts an incoming pinned tab at the end of the pinned block", () => {
    const target = leaf(["p", "u"], 1, ["p"]);
    const incoming = leaf(["x"], 0, ["x"]) as Extract<LayoutNode, { type: "leaf" }>;
    expect(mergeIntoActivePane(target, "u", incoming)).toEqual(leaf(["p", "x", "u"], 1, ["p", "x"]));
  });

  it("moveTabWithinLeaf clamps a pinned tab inside the pinned block", () => {
    const tree = moveTabWithinLeaf(leaf(["a", "b", "c", "d"], 0, ["a", "b"]), "a", 3);
    expect(tree).toEqual(leaf(["b", "a", "c", "d"], 1, ["a", "b"]));
  });

  it("moveTabWithinLeaf clamps an unpinned tab outside the pinned block", () => {
    const tree = moveTabWithinLeaf(leaf(["a", "b", "c", "d"], 0, ["a", "b"]), "d", 0);
    expect(tree).toEqual(leaf(["a", "b", "d", "c"], 0, ["a", "b"]));
  });

  it("clampReorderIndex bounds by block", () => {
    const l = { type: "leaf", tabs: ["a", "b", "c", "d"], activeTabIndex: 0, pinned: ["a", "b"] } as const;
    expect(clampReorderIndex(l, "a", 3)).toBe(1);
    expect(clampReorderIndex(l, "b", 0)).toBe(0);
    expect(clampReorderIndex(l, "d", 0)).toBe(2);
    expect(clampReorderIndex(l, "c", 9)).toBe(3);
  });
});

describe("bulkCloseTargets", () => {
  const tabs = ["p", "a", "b", "c"];
  const pinned = ["p"];
  it("others excludes the clicked tab and pinned tabs", () => {
    expect(bulkCloseTargets(tabs, pinned, "b", "others")).toEqual(["a", "c"]);
  });
  it("right takes only tabs after the clicked one", () => {
    expect(bulkCloseTargets(tabs, pinned, "a", "right")).toEqual(["b", "c"]);
  });
  it("left takes only tabs before the clicked one, never pinned", () => {
    expect(bulkCloseTargets(tabs, pinned, "c", "left")).toEqual(["a", "b"]);
  });
  it("is empty when only pinned neighbours remain", () => {
    expect(bulkCloseTargets(["p", "a"], ["p"], "a", "others")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/lib/layout.test.ts 2>&1 | tail -15`
Expected: FAIL — `pinTab is not a function` (and siblings).

- [ ] **Step 3: Implement**

In `app/src/lib/layout.ts`:

Change the leaf type and add helpers right after `LayoutNode`:

```ts
export type LayoutNode =
  | { type: "leaf"; tabs: string[]; activeTabIndex: number; pinned?: string[] }
  | { type: "split"; direction: Direction; children: LayoutNode[]; sizes: number[] };

export type Leaf = Extract<LayoutNode, { type: "leaf" }>;

// Pinned tabs live as a PREFIX of `tabs` (browser-style). Every mutation
// funnels through this so the invariant holds: pinned ids not in `tabs`
// are dropped, pinned tabs are moved first keeping their relative order,
// the active tab stays active, and an empty `pinned` is omitted so state
// written before pinning existed stays byte-identical.
export function normalizeLeaf(leaf: Leaf): Leaf {
  const pinned = (leaf.pinned ?? []).filter((id) => leaf.tabs.includes(id));
  const pinnedSet = new Set(pinned);
  const activeId = leaf.tabs[leaf.activeTabIndex];
  const tabs = [...leaf.tabs.filter((t) => pinnedSet.has(t)), ...leaf.tabs.filter((t) => !pinnedSet.has(t))];
  const activeTabIndex = Math.max(0, tabs.indexOf(activeId));
  const orderedPinned = tabs.filter((t) => pinnedSet.has(t));
  return orderedPinned.length > 0
    ? { type: "leaf", tabs, activeTabIndex, pinned: orderedPinned }
    : { type: "leaf", tabs, activeTabIndex };
}

function updateLeafOf(tree: LayoutNode, tabId: string, update: (leaf: Leaf) => Leaf): LayoutNode {
  const path = findLeafPath(tree, tabId);
  if (!path) return tree;
  return (
    replaceAtPath(tree, path, (node) => (node.type === "leaf" ? update(node) : node)) ?? tree
  );
}

export function isPinned(tree: LayoutNode, tabId: string): boolean {
  const path = findLeafPath(tree, tabId);
  if (!path) return false;
  const node = getNodeAtPath(tree, path);
  return node.type === "leaf" && (node.pinned ?? []).includes(tabId);
}

export function pinTab(tree: LayoutNode, tabId: string): LayoutNode {
  return updateLeafOf(tree, tabId, (leaf) => normalizeLeaf({ ...leaf, pinned: [...(leaf.pinned ?? []), tabId] }));
}

export function unpinTab(tree: LayoutNode, tabId: string): LayoutNode {
  return updateLeafOf(tree, tabId, (leaf) =>
    normalizeLeaf({ ...leaf, pinned: (leaf.pinned ?? []).filter((id) => id !== tabId) })
  );
}

// Target index for a reorder, measured in the array AFTER the moving tab
// is removed (which is how moveTabWithinLeaf splices). A pinned tab may
// only land inside the pinned block, an unpinned one only after it.
export function clampReorderIndex(leaf: Leaf, tabId: string, targetIndex: number): number {
  const pinned = leaf.pinned ?? [];
  const pinnedCount = leaf.tabs.filter((t) => pinned.includes(t)).length;
  if (pinned.includes(tabId)) return Math.max(0, Math.min(targetIndex, pinnedCount - 1));
  return Math.max(pinnedCount, Math.min(targetIndex, leaf.tabs.length - 1));
}

// Which tabs "Close Others" / "Close to the Right" / "Close to the Left"
// act on: never the clicked tab, never a pinned one.
export function bulkCloseTargets(
  tabs: string[],
  pinned: string[],
  tabId: string,
  mode: "others" | "right" | "left"
): string[] {
  const index = tabs.indexOf(tabId);
  const candidates = mode === "others" ? tabs : mode === "right" ? tabs.slice(index + 1) : tabs.slice(0, index);
  return candidates.filter((id) => id !== tabId && !pinned.includes(id));
}
```

Note `replaceAtPath` and `getNodeAtPath` are defined earlier in the file; `updateLeafOf` must be declared after `replaceAtPath` (function declarations hoist, so placing the block right after the `LayoutNode` type is fine).

Then thread `pinned` through the existing mutations:

`addTab` — replace the leaf construction:
```ts
    const tabs = [...leaf.tabs, newSessionId];
    return normalizeLeaf({ type: "leaf", tabs, activeTabIndex: tabs.length - 1, pinned: leaf.pinned });
```

`closeTab` — replace the final `return { type: "leaf", tabs, activeTabIndex };` with:
```ts
    return normalizeLeaf({
      type: "leaf",
      tabs,
      activeTabIndex,
      pinned: (leaf.pinned ?? []).filter((id) => id !== sessionId),
    });
```

`detachTab` — compute pinned before closing:
```ts
  if (!findLeafPath(tree, sessionId)) return null;
  const wasPinned = isPinned(tree, sessionId);
  const newTree = closeTab(tree, sessionId);
  const detached: Leaf = wasPinned
    ? { type: "leaf", tabs: [sessionId], activeTabIndex: 0, pinned: [sessionId] }
    : { type: "leaf", tabs: [sessionId], activeTabIndex: 0 };
  return { tree: newTree, detached };
```

`mergeIntoActivePane` — replace the leaf construction:
```ts
      return normalizeLeaf({
        type: "leaf",
        tabs: [...node.tabs, ...incoming.tabs],
        activeTabIndex: node.tabs.length,
        pinned: [...(node.pinned ?? []), ...(incoming.pinned ?? [])],
      });
```

`moveTabWithinLeaf` — clamp into the tab's block and keep `pinned`:
```ts
      const tabs = [...node.tabs];
      tabs.splice(currentIndex, 1);
      const clampedTarget = clampReorderIndex(node, sessionId, targetIndex);
      tabs.splice(clampedTarget, 0, sessionId);
      return normalizeLeaf({ type: "leaf", tabs, activeTabIndex: tabs.indexOf(activeId), pinned: node.pinned });
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run src/lib/layout.test.ts src/lib/layoutState.test.ts src/lib/workspace.test.ts 2>&1 | tail -8`
Expected: all pass (existing tests compare with `toEqual`, which ignores the absent `pinned` key).

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/layout.ts app/src/lib/layout.test.ts
git commit -m "feat(layout): pin/unpin tabs as a prefix, bulk-close targets, reorder clamping"
```

---

### Task 3: State actions — `setTabPinned`, `closeTabs`, ⌘W guard

**Files:**
- Modify: `app/src/lib/layoutState.ts` (after `reorderTabWithinPane`, ~line 1192)
- Create: `app/src/lib/tabActions.ts`
- Modify: `app/src/lib/keyboard.ts:27-32`
- Test: `app/src/lib/tabActions.test.ts`

**Interfaces:**
- Produces: `setTabPinned(sessionId: string, pinned: boolean): Promise<void>` (layoutState); `closeTabs(sessionIds: string[]): Promise<void>` (tabActions).
- Consumes: `layout.pinTab`/`unpinTab`/`isPinned` (Task 2), `confirmTabClose` (`./confirmClose`), `closeSession` (`./layoutState`).

`closeTabs` lives in its own module because `confirmClose.ts` already imports `layoutState.ts`; importing it back from `layoutState.ts` would create an import cycle.

- [ ] **Step 1: Write the failing test** — create `app/src/lib/tabActions.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./confirmClose", () => ({ confirmTabClose: vi.fn() }));
vi.mock("./layoutState", () => ({ closeSession: vi.fn().mockResolvedValue(undefined) }));

import { confirmTabClose } from "./confirmClose";
import { closeSession } from "./layoutState";
import { closeTabs } from "./tabActions";

beforeEach(() => {
  vi.mocked(confirmTabClose).mockReset();
  vi.mocked(closeSession).mockClear();
});

describe("closeTabs", () => {
  it("confirms then closes each tab in order", async () => {
    vi.mocked(confirmTabClose).mockResolvedValue(true);
    await closeTabs(["a", "b"]);
    expect(vi.mocked(closeSession).mock.calls.map((c) => c[0])).toEqual(["a", "b"]);
  });

  it("stops at the first declined confirm", async () => {
    vi.mocked(confirmTabClose).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await closeTabs(["a", "b", "c"]);
    expect(vi.mocked(closeSession).mock.calls.map((c) => c[0])).toEqual(["a"]);
  });

  it("does nothing for an empty list", async () => {
    await closeTabs([]);
    expect(confirmTabClose).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/tabActions.test.ts 2>&1 | tail -6`
Expected: FAIL — cannot find module `./tabActions`.

- [ ] **Step 3: Implement**

Create `app/src/lib/tabActions.ts`:

```ts
// Multi-tab close used by the tab context menu. Sequential on purpose:
// confirmTabClose only prompts when a close would empty the pane, and a
// declined prompt must stop the rest of the batch.
import { confirmTabClose } from "./confirmClose";
import { closeSession } from "./layoutState";

export async function closeTabs(sessionIds: string[]): Promise<void> {
  for (const id of sessionIds) {
    if (!(await confirmTabClose(id))) return;
    await closeSession(id);
  }
}
```

Append to `app/src/lib/layoutState.ts` after `reorderTabWithinPane`:

```ts
// Pins or unpins a tab in the active page. The layout helpers keep pinned
// tabs as a prefix of the pane's tab list, so the tab visibly moves.
export async function setTabPinned(sessionId: string, pinned: boolean): Promise<void> {
  const state = get(layoutState);
  const location = activePageLocation(state);
  if (!location) return;
  const newTree = pinned
    ? layout.pinTab(location.tree, sessionId)
    : layout.unpinTab(location.tree, sessionId);
  const data = workspace.updatePageLayout(state, location.workspaceId, location.pageId, newTree);
  layoutState.update((s) => ({ ...s, workspaces: data.workspaces }));
  await persistWorkspaces(data.workspaces, state.activeWorkspaceId);
}
```

In `app/src/lib/keyboard.ts`, make ⌘W skip pinned tabs. Add the imports `import { isPinned } from "./layout";` and `import { getActiveTree } from "./workspace";`, then change the `"w"` branch:

```ts
  } else if (key === "w") {
    event.preventDefault();
    event.stopPropagation();
    // A pinned tab is protected from the close shortcut (browser-style);
    // the tab menu's explicit Close still works.
    const tree = getActiveTree(state);
    if (tree && isPinned(tree, state.focusedSessionId)) return;
    if (await confirmTabClose(state.focusedSessionId)) {
      await closeSession(state.focusedSessionId);
    }
```

(`state` is the `get(layoutState)` snapshot already in scope in that handler — check the surrounding code and reuse its variable name.)

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/lib/tabActions.test.ts src/lib/layoutState.test.ts 2>&1 | tail -6 && npm run check 2>&1 | grep -E 'ERRORS|error' | head`
Expected: tests pass; `0 ERRORS`.

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/tabActions.ts app/src/lib/tabActions.test.ts app/src/lib/layoutState.ts app/src/lib/keyboard.ts
git commit -m "feat(app): setTabPinned, sequential closeTabs, and ⌘W skips pinned tabs"
```

---

### Task 4: `tabMenu.ts` builder

**Files:**
- Create: `app/src/lib/tabMenu.ts`
- Test: `app/src/lib/tabMenu.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface TabMenuContext {
    tabId: string;
    kind: "terminal" | "file" | "board";
    path: string | null;
    pinned: boolean;
    tabs: string[];
    pinnedTabs: string[];
  }
  export interface TabMenuHooks {
    startRename: (tabId: string) => void;
    reportError: (message: string) => void;
  }
  export function buildTabMenuEntries(ctx: TabMenuContext, hooks: TabMenuHooks): ContextMenuEntry[]
  ```
- Consumes: `bulkCloseTargets` (Task 2), `setTabPinned`, `splitPane`, `closeSession` (`./layoutState`), `closeTabs` (Task 3), `confirmTabClose`.

- [ ] **Step 1: Write the failing tests** — create `app/src/lib/tabMenu.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@tauri-apps/plugin-opener", () => ({
  openPath: vi.fn().mockResolvedValue(undefined),
  revealItemInDir: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText: vi.fn().mockResolvedValue(undefined) }));
vi.mock("./layoutState", () => ({
  setTabPinned: vi.fn().mockResolvedValue(undefined),
  splitPane: vi.fn().mockResolvedValue(undefined),
  closeSession: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("./tabActions", () => ({ closeTabs: vi.fn().mockResolvedValue(undefined) }));
vi.mock("./confirmClose", () => ({ confirmTabClose: vi.fn().mockResolvedValue(true) }));

import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { setTabPinned, splitPane, closeSession } from "./layoutState";
import { closeTabs } from "./tabActions";
import { buildTabMenuEntries, type TabMenuContext, type TabMenuHooks } from "./tabMenu";
import { isSeparator, type ContextMenuItem } from "./contextMenu";

function ctx(extra: Partial<TabMenuContext> = {}): TabMenuContext {
  return {
    tabId: "b",
    kind: "terminal",
    path: "/repo",
    pinned: false,
    tabs: ["p", "a", "b", "c"],
    pinnedTabs: ["p"],
    ...extra,
  };
}
function hooks(): TabMenuHooks {
  return { startRename: vi.fn(), reportError: vi.fn() };
}
function items(entries: ReturnType<typeof buildTabMenuEntries>): ContextMenuItem[] {
  return entries.filter((e): e is ContextMenuItem => !isSeparator(e));
}
function find(entries: ReturnType<typeof buildTabMenuEntries>, label: string): ContextMenuItem {
  const item = items(entries).find((e) => e.label === label);
  if (!item) throw new Error(`no entry ${label}`);
  return item;
}

beforeEach(() => vi.clearAllMocks());

describe("buildTabMenuEntries", () => {
  it("lists the terminal menu in order", () => {
    expect(items(buildTabMenuEntries(ctx(), hooks())).map((e) => e.label)).toEqual([
      "Close",
      "Close Others",
      "Close to the Right",
      "Close to the Left",
      "Pin",
      "Split Right",
      "Split Down",
      "Rename…",
      "Open Folder in Finder",
      "Copy Path",
    ]);
  });

  it("omits split/rename for file tabs and says Reveal", () => {
    const labels = items(buildTabMenuEntries(ctx({ kind: "file", path: "/repo/a.md" }), hooks())).map((e) => e.label);
    expect(labels).not.toContain("Split Right");
    expect(labels).not.toContain("Rename…");
    expect(labels).toContain("Reveal in Finder");
  });

  it("says Unpin for a pinned tab and pins/unpins through setTabPinned", () => {
    find(buildTabMenuEntries(ctx({ pinned: true }), hooks()), "Unpin").onPick();
    expect(setTabPinned).toHaveBeenCalledWith("b", false);
    find(buildTabMenuEntries(ctx(), hooks()), "Pin").onPick();
    expect(setTabPinned).toHaveBeenCalledWith("b", true);
  });

  it("bulk closes skip pinned tabs and disable when nothing applies", () => {
    const entries = buildTabMenuEntries(ctx(), hooks());
    find(entries, "Close Others").onPick();
    expect(closeTabs).toHaveBeenCalledWith(["a", "c"]);
    find(entries, "Close to the Right").onPick();
    expect(closeTabs).toHaveBeenCalledWith(["c"]);
    find(entries, "Close to the Left").onPick();
    expect(closeTabs).toHaveBeenCalledWith(["a"]);

    const lonely = buildTabMenuEntries(ctx({ tabs: ["p", "b"], tabId: "b" }), hooks());
    expect(find(lonely, "Close Others").disabled).toBe(true);
    expect(find(lonely, "Close to the Right").disabled).toBe(true);
    expect(find(lonely, "Close to the Left").disabled).toBe(true);
  });

  it("Close confirms then closes even a pinned tab", async () => {
    find(buildTabMenuEntries(ctx({ pinned: true }), hooks()), "Close").onPick();
    await Promise.resolve();
    expect(closeSession).toHaveBeenCalledWith("b");
  });

  it("splits and renames the terminal tab", () => {
    const h = hooks();
    const entries = buildTabMenuEntries(ctx(), h);
    find(entries, "Split Right").onPick();
    expect(splitPane).toHaveBeenCalledWith("b", "row");
    find(entries, "Split Down").onPick();
    expect(splitPane).toHaveBeenCalledWith("b", "column");
    find(entries, "Rename…").onPick();
    expect(h.startRename).toHaveBeenCalledWith("b");
  });

  it("opens folders, reveals files, copies the path", () => {
    find(buildTabMenuEntries(ctx(), hooks()), "Open Folder in Finder").onPick();
    expect(openPath).toHaveBeenCalledWith("/repo");
    find(buildTabMenuEntries(ctx({ kind: "file", path: "/repo/a.md" }), hooks()), "Reveal in Finder").onPick();
    expect(revealItemInDir).toHaveBeenCalledWith("/repo/a.md");
    find(buildTabMenuEntries(ctx(), hooks()), "Copy Path").onPick();
    expect(writeText).toHaveBeenCalledWith("/repo");
  });

  it("disables path items without a path", () => {
    const entries = buildTabMenuEntries(ctx({ path: null }), hooks());
    expect(find(entries, "Open Folder in Finder").disabled).toBe(true);
    expect(find(entries, "Copy Path").disabled).toBe(true);
  });

  it("reports opener failures through the hook", async () => {
    vi.mocked(openPath).mockRejectedValueOnce(new Error("nope"));
    const h = hooks();
    find(buildTabMenuEntries(ctx(), h), "Open Folder in Finder").onPick();
    await Promise.resolve();
    await Promise.resolve();
    expect(h.reportError).toHaveBeenCalledWith(expect.stringContaining("nope"));
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/tabMenu.test.ts 2>&1 | tail -6`
Expected: FAIL — cannot find module `./tabMenu`.

- [ ] **Step 3: Implement** — create `app/src/lib/tabMenu.ts`:

```ts
// Builds a pane tab's right-click menu. Pure: state in, entries out;
// side effects go through store actions (mockable) or the hooks.
import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { setTabPinned, splitPane, closeSession } from "./layoutState";
import { closeTabs } from "./tabActions";
import { confirmTabClose } from "./confirmClose";
import { bulkCloseTargets } from "./layout";
import type { ContextMenuEntry } from "./contextMenu";

export interface TabMenuContext {
  tabId: string;
  kind: "terminal" | "file" | "board";
  /** cwd for a terminal, the file for a file tab, the context folder for a board tab. */
  path: string | null;
  pinned: boolean;
  /** The owning leaf's tabs in order, and which of them are pinned. */
  tabs: string[];
  pinnedTabs: string[];
}

export interface TabMenuHooks {
  startRename: (tabId: string) => void;
  reportError: (message: string) => void;
}

export function buildTabMenuEntries(ctx: TabMenuContext, hooks: TabMenuHooks): ContextMenuEntry[] {
  const others = bulkCloseTargets(ctx.tabs, ctx.pinnedTabs, ctx.tabId, "others");
  const right = bulkCloseTargets(ctx.tabs, ctx.pinnedTabs, ctx.tabId, "right");
  const left = bulkCloseTargets(ctx.tabs, ctx.pinnedTabs, ctx.tabId, "left");
  const fail = (what: string) => (e: unknown) => hooks.reportError(`${what}: ${e}`);

  const entries: ContextMenuEntry[] = [
    {
      label: "Close",
      onPick: () => {
        void confirmTabClose(ctx.tabId).then((ok) => (ok ? closeSession(ctx.tabId) : undefined));
      },
    },
    { label: "Close Others", disabled: others.length === 0, onPick: () => void closeTabs(others) },
    { label: "Close to the Right", disabled: right.length === 0, onPick: () => void closeTabs(right) },
    { label: "Close to the Left", disabled: left.length === 0, onPick: () => void closeTabs(left) },
    { separator: true },
    { label: ctx.pinned ? "Unpin" : "Pin", onPick: () => void setTabPinned(ctx.tabId, !ctx.pinned) },
  ];

  if (ctx.kind === "terminal") {
    entries.push(
      { separator: true },
      { label: "Split Right", onPick: () => void splitPane(ctx.tabId, "row") },
      { label: "Split Down", onPick: () => void splitPane(ctx.tabId, "column") },
      { label: "Rename…", onPick: () => hooks.startRename(ctx.tabId) }
    );
  }

  const path = ctx.path;
  entries.push(
    { separator: true },
    ctx.kind === "file"
      ? {
          label: "Reveal in Finder",
          disabled: path === null,
          onPick: () => {
            if (path) revealItemInDir(path).catch(fail("Couldn't reveal in Finder"));
          },
        }
      : {
          label: "Open Folder in Finder",
          disabled: path === null,
          onPick: () => {
            if (path) openPath(path).catch(fail("Couldn't open in Finder"));
          },
        },
    {
      label: "Copy Path",
      disabled: path === null,
      onPick: () => {
        if (path) writeText(path).catch(fail("Couldn't copy path"));
      },
    }
  );

  return entries;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/lib/tabMenu.test.ts 2>&1 | tail -6`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/tabMenu.ts app/src/lib/tabMenu.test.ts
git commit -m "feat(app): tab context-menu builder"
```

---

### Task 5: Wire the tab menu + pinned presentation; single root `<ContextMenu />`

**Files:**
- Modify: `app/src/lib/Pane.svelte` (script imports ~lines 1-30, tab markup ~lines 276-352, styles)
- Modify: `app/src/routes/+page.svelte` (mount `<ContextMenu />` as the last child of `.app`, ~line 138)
- Modify: `app/src/lib/KanbanBoard.svelte:13,239` and `app/src/lib/BoardPane.svelte:13,193` (remove per-surface mounts)

**Interfaces:**
- Consumes: `buildTabMenuEntries` (Task 4), `openContextMenu` (`./contextMenu`), `isPinned` (Task 2), `message` (`@tauri-apps/plugin-dialog`), `Pin` icon (`@lucide/svelte`).

- [ ] **Step 1: Pane.svelte script** — add imports:

```ts
  import { message } from "@tauri-apps/plugin-dialog";
  import { openContextMenu } from "./contextMenu";
  import { buildTabMenuEntries } from "./tabMenu";
  import { X, Plus, RotateCw, Kanban, Pin } from "@lucide/svelte";   // replace the existing lucide import line
```

and, after `startEditing`/`cancelEdit`, the handler:

```ts
  function isPinnedTab(sessionId: string): boolean {
    return (leaf.pinned ?? []).includes(sessionId);
  }

  function reportMenuError(text: string): void {
    console.error(text);
    void message(text, { title: "gavin", kind: "error" });
  }

  function openTabMenu(e: MouseEvent, sessionId: string): void {
    e.preventDefault();
    e.stopPropagation();
    const file = fileTabPath(sessionId);
    const board = boardTab(sessionId);
    const kind = board ? "board" : file ? "file" : "terminal";
    const path = board ? board.contextFolder : (file ?? $layoutState.cwdBySessionId[sessionId] ?? null);
    openContextMenu(
      e.clientX,
      e.clientY,
      buildTabMenuEntries(
        { tabId: sessionId, kind, path, pinned: isPinnedTab(sessionId), tabs: leaf.tabs, pinnedTabs: leaf.pinned ?? [] },
        { startRename: startEditing, reportError: reportMenuError }
      )
    );
  }
```

(`leaf` is the component's existing prop of type `Extract<LayoutNode, { type: "leaf" }>`; with Task 2 it now has `pinned?`.)

- [ ] **Step 2: Pane.svelte markup** — on the tab `<button class="tab" …>` add:

```svelte
        class:pinned={isPinnedTab(sessionId)}
        oncontextmenu={(e) => openTabMenu(e, sessionId)}
```

Before the `{#if editingSessionId === sessionId}` block add the glyph:

```svelte
        {#if isPinnedTab(sessionId)}
          <span class="pin-glyph" title="Pinned"><Pin size={10} /></span>
        {/if}
```

Wrap the existing close control so pinned tabs have none:

```svelte
        {#if !isPinnedTab(sessionId)}
          <span class="close" aria-label="Close Tab" title="Close Tab" onclick={async (e) => { … existing body … }}>
            <X size={12} />
          </span>
        {/if}
```

Add styles next to `.tab-label`:

```css
  .pin-glyph {
    display: inline-flex;
    align-items: center;
    color: #999;
    margin-right: 2px;
  }
  .tab.pinned {
    padding-right: 10px;
  }
```

- [ ] **Step 3: Root mount** — in `app/src/routes/+page.svelte` add `import ContextMenu from "$lib/ContextMenu.svelte";` (match the file's existing import style for `$lib`/relative) and place `<ContextMenu />` as the last child inside the `.app` div (directly before its closing `</div>` at ~line 139). Remove the `import ContextMenu …` line and the `<ContextMenu />` element from `KanbanBoard.svelte` (lines 13 and 239) and `BoardPane.svelte` (lines 13 and 193). Leave their `openContextMenu` usage intact.

- [ ] **Step 4: Verify**

Run: `npm run check 2>&1 | grep -E 'ERRORS|Pane.svelte|\+page.svelte|KanbanBoard|BoardPane' | head` and `npx vitest run 2>&1 | tail -4`
Expected: `0 ERRORS`, no new warnings in the touched files, all tests pass.

Then launch the app (`npm run tauri dev`) and check by hand: right-click a tab shows the menu; Pin moves the tab left, hides ×, shows the glyph; Unpin restores; Close Others leaves the pinned tab; a board pane next to a terminal pane shows ONE menu on right-click.

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/Pane.svelte app/src/routes/+page.svelte app/src/lib/KanbanBoard.svelte app/src/lib/BoardPane.svelte
git commit -m "feat(app): tab right-click menu, pinned tab presentation, single context-menu layer"
```

---

### Task 6: `sidebarMenu.ts` builders

**Files:**
- Create: `app/src/lib/sidebarMenu.ts`
- Test: `app/src/lib/sidebarMenu.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface SidebarMenuHooks {
    startRenameWorkspace: (workspaceId: string) => void;
    startRenamePage: (pageId: string) => void;
    newPage: (workspaceId: string) => void;
    reportError: (message: string) => void;
  }
  export function buildWorkspaceMenuEntries(ws: Workspace, hooks: SidebarMenuHooks): ContextMenuEntry[]
  export function buildPageMenuEntries(ws: Workspace, page: Page, allWorkspaces: Workspace[], hooks: SidebarMenuHooks): ContextMenuEntry[]
  export function buildSessionRowMenuEntries(ws: Workspace, page: Page, sessionId: string, cwd: string | null, hooks: SidebarMenuHooks): ContextMenuEntry[]
  export async function changeWorkspaceRoot(workspaceId: string, reportError: (m: string) => void): Promise<void>
  ```
- Consumes: `closeWorkspace`, `closePage`, `movePageAction`, `switchWorkspaceView`, `switchToSessionInPage`, `closeSession`, `setWorkspaceRoot` (`./layoutState`); `confirmWorkspaceClose`, `confirmPageClose`, `confirmTabClose` (`./confirmClose`); `gavinRootExists` (`./backend`); `open` (`@tauri-apps/plugin-dialog`); `UNFILED_WORKSPACE_ID` (`./workspace`).

- [ ] **Step 1: Write the failing tests** — create `app/src/lib/sidebarMenu.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@tauri-apps/plugin-opener", () => ({ openPath: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("./backend", () => ({ gavinRootExists: vi.fn() }));
vi.mock("./layoutState", () => ({
  closeWorkspace: vi.fn().mockResolvedValue(undefined),
  closePage: vi.fn().mockResolvedValue(undefined),
  movePageAction: vi.fn().mockResolvedValue(undefined),
  switchWorkspaceView: vi.fn().mockResolvedValue(undefined),
  switchToSessionInPage: vi.fn().mockResolvedValue(undefined),
  closeSession: vi.fn().mockResolvedValue(undefined),
  setWorkspaceRoot: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("./confirmClose", () => ({
  confirmWorkspaceClose: vi.fn().mockResolvedValue(true),
  confirmPageClose: vi.fn().mockResolvedValue(true),
  confirmTabClose: vi.fn().mockResolvedValue(true),
}));

import { openPath } from "@tauri-apps/plugin-opener";
import { open } from "@tauri-apps/plugin-dialog";
import { gavinRootExists } from "./backend";
import {
  closeWorkspace, closePage, movePageAction, switchWorkspaceView, switchToSessionInPage, closeSession, setWorkspaceRoot,
} from "./layoutState";
import { confirmPageClose } from "./confirmClose";
import {
  buildWorkspaceMenuEntries, buildPageMenuEntries, buildSessionRowMenuEntries, changeWorkspaceRoot, type SidebarMenuHooks,
} from "./sidebarMenu";
import { isSeparator, type ContextMenuItem, type ContextMenuEntry } from "./contextMenu";
import { UNFILED_WORKSPACE_ID, type Workspace, type Page } from "./workspace";

const page = (id: string): Page => ({ id, name: id, layout: { type: "leaf", tabs: [`${id}-s`], activeTabIndex: 0 }, focusedSessionId: null });
const ws = (id: string, pages: Page[], rootPath?: string): Workspace =>
  ({ id, name: id, pages, activePageId: pages[0]?.id ?? null, ...(rootPath ? { rootPath } : {}) }) as Workspace;

function hooks(): SidebarMenuHooks {
  return { startRenameWorkspace: vi.fn(), startRenamePage: vi.fn(), newPage: vi.fn(), reportError: vi.fn() };
}
const items = (entries: ContextMenuEntry[]) => entries.filter((e): e is ContextMenuItem => !isSeparator(e));
const find = (entries: ContextMenuEntry[], label: string) => {
  const item = items(entries).find((e) => e.label === label);
  if (!item) throw new Error(`no entry ${label}`);
  return item;
};
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => vi.clearAllMocks());

describe("buildWorkspaceMenuEntries", () => {
  it("lists the regular workspace menu", () => {
    const labels = items(buildWorkspaceMenuEntries(ws("w1", [page("p1")], "/r"), hooks())).map((e) => e.label);
    expect(labels).toEqual(["Rename…", "New Page", "Open Root in Finder", "Change Root Folder…", "Close Workspace"]);
  });
  it("gives Unfiled only New Page", () => {
    const entries = buildWorkspaceMenuEntries(ws(UNFILED_WORKSPACE_ID, []), hooks());
    expect(items(entries).map((e) => e.label)).toEqual(["New Page"]);
  });
  it("disables Open Root without a root and opens it with one", () => {
    expect(find(buildWorkspaceMenuEntries(ws("w1", []), hooks()), "Open Root in Finder").disabled).toBe(true);
    find(buildWorkspaceMenuEntries(ws("w1", [], "/r"), hooks()), "Open Root in Finder").onPick();
    expect(openPath).toHaveBeenCalledWith("/r");
  });
  it("renames, adds pages, and closes (danger) through the right calls", async () => {
    const h = hooks();
    const entries = buildWorkspaceMenuEntries(ws("w1", [], "/r"), h);
    find(entries, "Rename…").onPick();
    expect(h.startRenameWorkspace).toHaveBeenCalledWith("w1");
    find(entries, "New Page").onPick();
    expect(h.newPage).toHaveBeenCalledWith("w1");
    const close = find(entries, "Close Workspace");
    expect(close.danger).toBe(true);
    close.onPick();
    await flush();
    expect(closeWorkspace).toHaveBeenCalledWith("w1");
  });
});

describe("changeWorkspaceRoot", () => {
  it("sets the root directly when the folder already has a gavin root", async () => {
    vi.mocked(open).mockResolvedValue("/new");
    vi.mocked(gavinRootExists).mockResolvedValue(true);
    await changeWorkspaceRoot("w1", vi.fn());
    expect(setWorkspaceRoot).toHaveBeenCalledWith("w1", "/new");
  });
  it("sends the user to the Home tab when the folder is not initialised", async () => {
    vi.mocked(open).mockResolvedValue("/plain");
    vi.mocked(gavinRootExists).mockResolvedValue(false);
    const report = vi.fn();
    await changeWorkspaceRoot("w1", report);
    expect(setWorkspaceRoot).not.toHaveBeenCalled();
    expect(switchWorkspaceView).toHaveBeenCalledWith("w1", "home");
    expect(report).toHaveBeenCalledWith(expect.stringContaining("Home tab"));
  });
  it("does nothing when the picker is cancelled", async () => {
    vi.mocked(open).mockResolvedValue(null);
    await changeWorkspaceRoot("w1", vi.fn());
    expect(gavinRootExists).not.toHaveBeenCalled();
  });
});

describe("buildPageMenuEntries", () => {
  const all = [ws("w1", [page("p1"), page("p2")]), ws("w2", [page("q1")]), ws(UNFILED_WORKSPACE_ID, [])];
  it("lists the page menu with a Move entry per other workspace", () => {
    const labels = items(buildPageMenuEntries(all[0], all[0].pages[0], all, hooks())).map((e) => e.label);
    expect(labels).toEqual(["Rename…", "New Page", "Move to w2", `Move to ${UNFILED_WORKSPACE_ID}`, "Close Other Pages", "Close Page"]);
  });
  it("moves a page to the end of the target workspace", () => {
    find(buildPageMenuEntries(all[0], all[0].pages[0], all, hooks()), "Move to w2").onPick();
    expect(movePageAction).toHaveBeenCalledWith("p1", "w2", 1);
  });
  it("closes other pages sequentially with confirms and stops on decline", async () => {
    vi.mocked(confirmPageClose).mockResolvedValueOnce(true);
    find(buildPageMenuEntries(all[0], all[0].pages[0], all, hooks()), "Close Other Pages").onPick();
    await flush();
    expect(closePage).toHaveBeenCalledWith("w1", "p2");
    expect(closePage).not.toHaveBeenCalledWith("w1", "p1");
  });
  it("disables Close Other Pages when the page is alone", () => {
    const entries = buildPageMenuEntries(all[1], all[1].pages[0], all, hooks());
    expect(find(entries, "Close Other Pages").disabled).toBe(true);
    expect(find(entries, "Close Page").danger).toBe(true);
  });
});

describe("buildSessionRowMenuEntries", () => {
  const w = ws("w1", [page("p1")]);
  it("jumps, opens cwd, closes", async () => {
    const entries = buildSessionRowMenuEntries(w, w.pages[0], "s1", "/cwd", hooks());
    expect(items(entries).map((e) => e.label)).toEqual(["Jump to Session", "Open cwd in Finder", "Close Session"]);
    find(entries, "Jump to Session").onPick();
    expect(switchWorkspaceView).toHaveBeenCalledWith("w1", "terminal");
    expect(switchToSessionInPage).toHaveBeenCalledWith("w1", "p1", "s1");
    find(entries, "Open cwd in Finder").onPick();
    expect(openPath).toHaveBeenCalledWith("/cwd");
    find(entries, "Close Session").onPick();
    await flush();
    expect(closeSession).toHaveBeenCalledWith("s1");
  });
  it("disables Open cwd without a cwd", () => {
    expect(find(buildSessionRowMenuEntries(w, w.pages[0], "s1", null, hooks()), "Open cwd in Finder").disabled).toBe(true);
  });
});
```

Check `Page`/`Workspace` required fields in `app/src/lib/workspace.ts:4-28` before running; if `Page` or `Workspace` has extra required fields, add them to the `page`/`ws` helpers (the `as Workspace` cast covers optional ones only).

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/sidebarMenu.test.ts 2>&1 | tail -6`
Expected: FAIL — cannot find module `./sidebarMenu`.

- [ ] **Step 3: Implement** — create `app/src/lib/sidebarMenu.ts`:

```ts
// Right-click menus for the sidebar: workspace rows, page rows, and the
// session rows inside a page's expanded git detail. Pure builders; the
// Sidebar supplies inline-rename / new-page / error hooks.
import { openPath } from "@tauri-apps/plugin-opener";
import { open } from "@tauri-apps/plugin-dialog";
import * as backend from "./backend";
import {
  closeWorkspace,
  closePage,
  movePageAction,
  switchWorkspaceView,
  switchToSessionInPage,
  closeSession,
  setWorkspaceRoot,
} from "./layoutState";
import { confirmWorkspaceClose, confirmPageClose, confirmTabClose } from "./confirmClose";
import { UNFILED_WORKSPACE_ID, type Workspace, type Page } from "./workspace";
import type { ContextMenuEntry } from "./contextMenu";

export interface SidebarMenuHooks {
  startRenameWorkspace: (workspaceId: string) => void;
  startRenamePage: (pageId: string) => void;
  newPage: (workspaceId: string) => void;
  reportError: (message: string) => void;
}

const fail = (report: (m: string) => void, what: string) => (e: unknown) => report(`${what}: ${e}`);

export function buildWorkspaceMenuEntries(ws: Workspace, hooks: SidebarMenuHooks): ContextMenuEntry[] {
  if (ws.id === UNFILED_WORKSPACE_ID) {
    return [{ label: "New Page", onPick: () => hooks.newPage(ws.id) }];
  }
  const root = ws.rootPath ?? null;
  return [
    { label: "Rename…", onPick: () => hooks.startRenameWorkspace(ws.id) },
    { label: "New Page", onPick: () => hooks.newPage(ws.id) },
    { separator: true },
    {
      label: "Open Root in Finder",
      disabled: root === null,
      onPick: () => {
        if (root) openPath(root).catch(fail(hooks.reportError, "Couldn't open in Finder"));
      },
    },
    { label: "Change Root Folder…", onPick: () => void changeWorkspaceRoot(ws.id, hooks.reportError) },
    { separator: true },
    {
      label: "Close Workspace",
      danger: true,
      onPick: () => {
        void confirmWorkspaceClose(ws.id).then((ok) => (ok ? closeWorkspace(ws.id) : undefined));
      },
    },
  ];
}

// Picks a folder and binds it when it already is a gavin root. The
// initialise-or-bind flow for a plain folder belongs to the root control
// on the Home tab, so that is where a plain folder sends the user.
export async function changeWorkspaceRoot(workspaceId: string, reportError: (m: string) => void): Promise<void> {
  const picked = await open({ directory: true, multiple: false, title: "Choose workspace root" });
  if (typeof picked !== "string") return;
  if (await backend.gavinRootExists(picked)) {
    await setWorkspaceRoot(workspaceId, picked);
    return;
  }
  await switchWorkspaceView(workspaceId, "home");
  reportError("That folder has no .gavin-root yet — use the root control on the Home tab to initialise or bind it.");
}

export function buildPageMenuEntries(
  ws: Workspace,
  page: Page,
  allWorkspaces: Workspace[],
  hooks: SidebarMenuHooks
): ContextMenuEntry[] {
  const others = ws.pages.filter((p) => p.id !== page.id);
  const entries: ContextMenuEntry[] = [
    { label: "Rename…", onPick: () => hooks.startRenamePage(page.id) },
    { label: "New Page", onPick: () => hooks.newPage(ws.id) },
  ];
  const targets = allWorkspaces.filter((w) => w.id !== ws.id);
  if (targets.length > 0) {
    entries.push({ separator: true });
    for (const target of targets) {
      entries.push({
        label: `Move to ${target.name}`,
        onPick: () => void movePageAction(page.id, target.id, target.pages.length),
      });
    }
  }
  entries.push(
    { separator: true },
    {
      label: "Close Other Pages",
      danger: true,
      disabled: others.length === 0,
      onPick: () => {
        void (async () => {
          for (const p of others) {
            if (!(await confirmPageClose(ws.id, p.id))) return;
            await closePage(ws.id, p.id);
          }
        })();
      },
    },
    {
      label: "Close Page",
      danger: true,
      onPick: () => {
        void confirmPageClose(ws.id, page.id).then((ok) => (ok ? closePage(ws.id, page.id) : undefined));
      },
    }
  );
  return entries;
}

export function buildSessionRowMenuEntries(
  ws: Workspace,
  page: Page,
  sessionId: string,
  cwd: string | null,
  hooks: SidebarMenuHooks
): ContextMenuEntry[] {
  return [
    {
      label: "Jump to Session",
      onPick: () => {
        void switchWorkspaceView(ws.id, "terminal");
        void switchToSessionInPage(ws.id, page.id, sessionId);
      },
    },
    {
      label: "Open cwd in Finder",
      disabled: cwd === null,
      onPick: () => {
        if (cwd) openPath(cwd).catch(fail(hooks.reportError, "Couldn't open in Finder"));
      },
    },
    { separator: true },
    {
      label: "Close Session",
      danger: true,
      onPick: () => {
        void confirmTabClose(sessionId).then((ok) => (ok ? closeSession(sessionId) : undefined));
      },
    },
  ];
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/lib/sidebarMenu.test.ts 2>&1 | tail -6`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/sidebarMenu.ts app/src/lib/sidebarMenu.test.ts
git commit -m "feat(app): sidebar context-menu builders (workspace, page, session row)"
```

---

### Task 7: Wire the sidebar menus

**Files:**
- Modify: `app/src/lib/Sidebar.svelte` (imports ~lines 1-30; workspace rows ~lines 503-515 and 540-557; page row ~lines 350-371; session row ~lines 446-451)

**Interfaces:**
- Consumes: the three builders from Task 6, `openContextMenu`, `message` from `@tauri-apps/plugin-dialog`, and the component's existing `startEditingWorkspace(id, name)`, `startEditingPage(id, name)`, `quickAddPage(id)`.

- [ ] **Step 1: Script** — add imports and helpers:

```ts
  import { message } from "@tauri-apps/plugin-dialog";
  import { openContextMenu } from "./contextMenu";
  import { buildWorkspaceMenuEntries, buildPageMenuEntries, buildSessionRowMenuEntries, type SidebarMenuHooks } from "./sidebarMenu";
```

```ts
  function reportMenuError(text: string): void {
    console.error(text);
    void message(text, { title: "gavin", kind: "error" });
  }

  function menuHooks(): SidebarMenuHooks {
    return {
      startRenameWorkspace: (id) => {
        const w = $layoutState.workspaces.find((x) => x.id === id);
        if (w) startEditingWorkspace(w.id, w.name);
      },
      startRenamePage: (id) => {
        const p = $layoutState.workspaces.flatMap((w) => w.pages).find((x) => x.id === id);
        if (p) startEditingPage(p.id, p.name);
      },
      newPage: quickAddPage,
      reportError: reportMenuError,
    };
  }

  function openWorkspaceMenu(e: MouseEvent, ws: Workspace): void {
    e.preventDefault();
    e.stopPropagation();
    openContextMenu(e.clientX, e.clientY, buildWorkspaceMenuEntries(ws, menuHooks()));
  }

  function openPageMenu(e: MouseEvent, ws: Workspace, page: Page): void {
    e.preventDefault();
    e.stopPropagation();
    openContextMenu(e.clientX, e.clientY, buildPageMenuEntries(ws, page, $layoutState.workspaces, menuHooks()));
  }

  function openSessionRowMenu(e: MouseEvent, ws: Workspace, page: Page, sessionId: string): void {
    e.preventDefault();
    e.stopPropagation();
    const cwd = $layoutState.cwdBySessionId[sessionId] ?? null;
    openContextMenu(e.clientX, e.clientY, buildSessionRowMenuEntries(ws, page, sessionId, cwd, menuHooks()));
  }
```

- [ ] **Step 2: Markup** — add `oncontextmenu` to:
  - both workspace rows (`<div class="workspace-row pinned" …>` for Unfiled and `<div class="workspace-row" …>` in the regular loop): `oncontextmenu={(e) => openWorkspaceMenu(e, ws)}`
  - the page row `<div class="page-row" …>`: `oncontextmenu={(e) => openPageMenu(e, ws, page)}`
  - the session row `<div class="git-session-row" …>`: `oncontextmenu={(e) => openSessionRowMenu(e, ws, page, sessionId)}`

The page row is rendered inside the `pageList` snippet, which receives `ws` — check its parameter name at the snippet definition and use it.

- [ ] **Step 3: Verify**

Run: `npm run check 2>&1 | grep -E 'ERRORS|Sidebar.svelte' | head` and `npx vitest run 2>&1 | tail -4`
Expected: `0 ERRORS`, no new warnings beyond the existing a11y class in Sidebar, all tests pass.

Launch the app and check: right-click a workspace (regular and Unfiled), a page, and an expanded session row; Rename… opens the inline editor; Move to … moves the page; Change Root Folder… on a plain folder switches to Home with the error dialog.

- [ ] **Step 4: Commit**

```bash
git add app/src/lib/Sidebar.svelte
git commit -m "feat(app): right-click menus on sidebar workspaces, pages, and session rows"
```

---

### Task 8: Full verification and gavin card

**Files:**
- Modify: `.gavin-root/plans/tab-sidebar-context-menus.md` (the card created when execution starts; tick items as tasks land)

- [ ] **Step 1: Full suites**

Run from `app/`: `npm run check 2>&1 | tail -1`, `npx vitest run 2>&1 | tail -4`; from `app/src-tauri/`: `cargo test -p app 2>&1 | grep -E 'test result|FAILED'`.
Expected: 0 errors, all green.

- [ ] **Step 2: Manual pass (record outcomes in the card)**

1. Pin two tabs in a three-tab pane → both leftmost, no ×, glyph shown; drag an unpinned tab onto the pinned block → it lands after the block.
2. ⌘W on a pinned tab → nothing; menu Close → closes.
3. Close Others with a pinned neighbour → pinned stays.
4. Move a pinned tab to another pane by drag → still pinned, leftmost there.
5. Restart the app → pins persisted.
6. Board pane + terminal pane side by side → one menu only.
7. Sidebar: all three row menus, Move to …, Change Root Folder… on a plain folder.

- [ ] **Step 3: Card status**

Set the card's status to `Done` (`gavin_set_plan_field` or edit the frontmatter) once Step 2 passes; leave `In Progress` with the failing item unticked otherwise.

---

## Self-review notes

- Spec §1 (single mount, builders, errors) → Tasks 4, 5, 6, 7. §2 (tab menu table, bulk close) → Tasks 2, 3, 4, 5. §3 (pin model, prefix invariant, presentation, ⌘W) → Tasks 1, 2, 3, 5. §4 (sidebar menus, change-root flow) → Tasks 6, 7. §5 permissions → no change needed (`opener:default` includes `allow-reveal-item-in-dir`; `dialog:default` includes `message`/`open`; clipboard write is granted). §6 testing → each task's tests + Task 8.
- `isPinned` takes the tree (spec wrote `leaf`); the tree form is what `keyboard.ts` needs and Pane uses `leaf.pinned` directly.
