# Terminal Core — Milestone C, Part 2: Frontend Split Panes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Milestone B's single-hardcoded-session `Terminal.svelte` with a full split-pane, multi-tab-per-pane terminal UI — split/new-tab/close via keyboard and a toolbar, layout presets, drag-to-resize dividers, and `Cmd+C`/`Cmd+V` clipboard copy/paste — backed entirely by the commands and events Part 1 already shipped.

**Architecture:** A pure, fully-unit-tested TypeScript module (`layout.ts`) owns tree-shape logic (split/add-tab/close-tab/resize/presets as pure functions over `LayoutNode`). A `svelte/store`-based state module (`layoutState.ts`) owns the live app state (the resolved tree, which session currently has focus) and orchestrates backend calls: it mutates its local copy of the tree via `layout.ts`, then calls the `create_session`/`kill_session`/`set_layout` commands to keep the daemon and `config.json` in sync — resolving the open question Part 1 left for this plan: **the frontend orchestrates persistence**, calling `set_layout` explicitly after every tree mutation (this matches `set_layout`'s actual shipped signature, which takes a whole `LayoutNode` rather than a delta). A small tree of Svelte components (`TerminalPane` → `Pane` → `LayoutTree`) renders the resolved tree recursively; every tab's `TerminalPane` stays mounted for the pane's lifetime (never destroyed on tab switch), positioned via `visibility:hidden` (not `display:none`) so every tab keeps real, measurable dimensions at all times.

**Tech Stack:** Svelte 5 (runes for component-local state, `svelte/store` for shared app state) + SvelteKit (static adapter, unchanged) + xterm.js (unchanged) + a new `tauri-plugin-clipboard-manager` dependency + `vitest` (new dev dependency, for the two purely-logical modules only — no GUI test runner is introduced, consistent with the spec's own testing section).

## Global Constraints

- **`LayoutNode` shape** (already shipped by Part 1, serde-verified — do not deviate):
  ```typescript
  type LayoutNode =
    | { type: "leaf"; tabs: string[]; activeTabIndex: number }
    | { type: "split"; direction: "row" | "column"; children: LayoutNode[]; sizes: number[] };
  ```
- **`direction` semantics**: `"row"` means children are arranged left-to-right with a vertical divider between them (`flex-direction: row`) — this is what "Split Right" produces. `"column"` means children are arranged top-to-bottom with a horizontal divider (`flex-direction: column`) — this is what "Split Down" produces.
- **Backend commands** (shipped by Part 1, in `app/src-tauri/src/session.rs`, registered in `app/src-tauri/src/lib.rs`'s `invoke_handler!`): `create_session() -> Result<String, String>`, `kill_session(session_id: String) -> Result<(), String>`, `get_current_layout() -> LayoutNode`, `set_layout(layout: LayoutNode) -> Result<(), String>`, `write_input(session_id: String, data: String) -> Result<(), String>`, `resize_session(session_id: String, cols: u16, rows: u16) -> Result<(), String>`, `signal_frontend_ready()`, `get_bootstrap_error() -> Option<String>`. Tauri's default IPC argument casing means JS callers pass camelCase keys (e.g. `{ sessionId, data }`) which map automatically onto the Rust snake_case parameter names — this already works for Milestone B's existing calls and needs no special handling.
- **Tauri events**: `"layout-ready"` (payload: the resolved `LayoutNode`, fires once at startup — replaces Milestone B's `"session-ready"`), `"pty-output"` (payload: `[session_id: string, data: string]`, unchanged shape, now genuinely multi-session), `"session-exited"` (payload: `[session_id: string, exit_code: number]`, unchanged shape), `"daemon-error"` (payload: `string`, unchanged — can fire for one bad session's `Attach` failure at startup as well as later command failures; per Part 1's whole-branch review this surfaces as a whole-window error, a known limitation this plan does not need to special-case).
- **Focus model**: `focusedSessionId` (a single session id, or `null`) is the sole source of truth for "the currently focused pane" — there is no separate pane/leaf identifier. "The focused pane" always means "whichever leaf's `tabs` array contains `focusedSessionId`." Focus is not persisted (matches the spec) and resets to the first session in the resolved tree on every launch.
- **Persistence rule for the empty-tree case**: `set_layout` requires a `LayoutNode` — it cannot represent "no layout." When closing a tab makes the *entire* tree empty (the last pane's last tab), the frontend must **not** call `set_layout` at all; it only updates its own local `tree: null` state to show the "New Session" affordance. The now-stale reference left in `config.json` self-heals via Part 1's existing stale/exited-session fallback the next time the app launches (it silently becomes a fresh session). Do not attempt to persist emptiness — there's no backend representation for it, and none is needed.
- **Module boundary**: Svelte components never call `layout.ts`'s pure functions directly, and never call `app/src/lib/backend.ts`'s command wrappers directly — they only call the exported actions from `layoutState.ts`. This keeps tree-mutation-plus-persistence atomic and in one place. `layoutState.ts` is the only module that imports both `layout.ts` and `backend.ts`.
- **Kill-then-mutate ordering**: when a user-initiated action removes a session (`closeSession`), the daemon-side `kill_session` call happens **first**; the local tree is only mutated (and only then persisted) if that call succeeds. If `kill_session` fails, the tree is left untouched and the error is surfaced via the same full-window error overlay Milestone B already uses for command failures — silently dropping a session from the tree whose daemon-side kill failed would orphan a still-running session with no way to ever reference it again (there is no session picker, per the spec's non-goals). This is a deliberate asymmetry from `applyPreset` (Task 2), which kills old sessions best-effort *after* already committing to the new tree, since applying a preset is spec'd as an already-deliberate, already-committed action.
- **Hidden-tab CSS**: inactive tabs within a pane use `visibility: hidden` with `position: absolute; inset: 0` — **never** `display: none`. `display:none` collapses an element's layout box to zero size, which breaks xterm.js's `FitAddon` (it cannot compute columns/rows from a zero-size container) and would make it impossible to satisfy the spec's requirement that every tab in a pane — not just the active one — gets resized when the pane's rectangle changes. Keeping every tab absolutely positioned to fill the same parent means all tabs in a pane share identical, always-real dimensions regardless of which is currently visible.
- **Keyboard shortcuts use capture-phase listeners** (`window.addEventListener("keydown", handler, true)`), never bubble-phase — established the hard way during Milestone B: xterm.js's own keydown handler stops propagation before a bubble-phase `window` listener would ever see the event.
- **Capability grants are verified, never assumed**: Milestone B hit a real gap once already (`core:default` looked like it should cover window close/destroy; it didn't). Task 6 (clipboard) must check the actual compiled ACL after adding the new plugin and permission, the same way, rather than trusting documentation.
- **Testing**: this plan follows the design spec's own testing section — `layout.ts` (Task 1) and `layoutState.ts` (Task 2) are pure/mockable logic and get real, automated `vitest` tests (no mocks needed for Task 1; `backend.ts` is mocked via `vi.mock` for Task 2). Every other task (3 through 7) is Svelte component/DOM work with no automated GUI test runner available (per the spec, the agent environment lacks the OS Accessibility permission needed for synthetic keyboard/mouse input) — verification for those tasks is `npm run check` (svelte-check, catches type errors) and `npm run build` (catches compile errors) as the automated floor, plus whatever can be confirmed by reading the rendered DOM/structure without synthetic input. Each of those tasks' reports must explicitly list which interactive behaviors remain unverified pending a human at the keyboard, mirroring Milestone B's precedent.
- **Product decisions carried from the design spec** (do not relitigate): closing the *app* never kills sessions; closing a tab, closing a pane, or a session exiting on its own (typing `exit`) all kill that session explicitly; tabs stay mounted (never destroyed) when you switch away from them; `Cmd+C` copies the focused pane's active-tab selection to the OS clipboard and is never forwarded to the shell (does nothing if there's no selection); `Ctrl+C` remains the only way to send an interrupt; applying a layout preset replaces the whole current tree and kills every existing session (a deliberate action, not a casual default); every new tab/pane always gets a brand new session (no session picker, no move/duplicate).

---

### Task 1: Layout tree pure logic + vitest setup

**Files:**
- Create: `app/src/lib/layout.ts`
- Create: `app/src/lib/layout.test.ts`
- Modify: `app/package.json` (add `vitest` dev dependency + `test` script)
- Modify: `app/vite.config.js` (add a `test` block)

**Interfaces:**
- Produces: `LayoutNode` type; `findLeafPath(node, sessionId): number[] | null`; `getNodeAtPath(node, path): LayoutNode`; `splitLeaf(tree, targetSessionId, direction, newSessionId): LayoutNode`; `addTab(tree, targetSessionId, newSessionId): LayoutNode`; `closeTab(tree, sessionId): LayoutNode | null`; `switchTab(tree, sessionId): LayoutNode`; `resizeSplit(tree, splitPath, sizes): LayoutNode`; `allSessionIds(node): string[]`; `activeSessionId(leaf): string`; `presetSingle(sessionId): LayoutNode`; `presetSideBySide(leftId, rightId): LayoutNode`; `presetGrid2x2(topLeft, topRight, bottomLeft, bottomRight): LayoutNode`. All consumed exclusively by Task 2's `layoutState.ts` — no other task imports this file directly (see Global Constraints' module-boundary rule).

- [ ] **Step 1: Add vitest**

```bash
cd app && npm install --save-dev vitest
```

- [ ] **Step 2: Wire vitest into the existing Vite config**

Open `app/vite.config.js`. Add a `test` key to the object returned by `defineConfig`:

```js
import { defineConfig } from "vite";
import { sveltekit } from "@sveltejs/kit/vite";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [sveltekit()],
  test: {
    include: ["src/**/*.{test,spec}.ts"],
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
```

(Only the `test` key is new — everything else in the file is unchanged.)

Add a `test` script to `app/package.json`'s `"scripts"` block, alongside the existing `dev`/`build`/`preview`/`check`/`check:watch`/`tauri` entries:

```json
"test": "vitest run",
```

- [ ] **Step 3: Write the failing tests**

Create `app/src/lib/layout.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import {
  findLeafPath,
  getNodeAtPath,
  splitLeaf,
  addTab,
  closeTab,
  switchTab,
  resizeSplit,
  allSessionIds,
  activeSessionId,
  presetSingle,
  presetSideBySide,
  presetGrid2x2,
} from "./layout";
import type { LayoutNode } from "./layout";

describe("findLeafPath", () => {
  it("finds a leaf at the root", () => {
    const tree: LayoutNode = { type: "leaf", tabs: ["a"], activeTabIndex: 0 };
    expect(findLeafPath(tree, "a")).toEqual([]);
  });

  it("finds a leaf nested inside splits", () => {
    const tree: LayoutNode = {
      type: "split",
      direction: "row",
      sizes: [0.5, 0.5],
      children: [
        { type: "leaf", tabs: ["a"], activeTabIndex: 0 },
        {
          type: "split",
          direction: "column",
          sizes: [0.5, 0.5],
          children: [
            { type: "leaf", tabs: ["b"], activeTabIndex: 0 },
            { type: "leaf", tabs: ["c", "d"], activeTabIndex: 1 },
          ],
        },
      ],
    };
    expect(findLeafPath(tree, "d")).toEqual([1, 1]);
  });

  it("returns null when the session isn't in the tree", () => {
    const tree: LayoutNode = { type: "leaf", tabs: ["a"], activeTabIndex: 0 };
    expect(findLeafPath(tree, "z")).toBeNull();
  });
});

describe("getNodeAtPath", () => {
  it("returns the root when path is empty", () => {
    const tree: LayoutNode = { type: "leaf", tabs: ["a"], activeTabIndex: 0 };
    expect(getNodeAtPath(tree, [])).toEqual(tree);
  });

  it("walks nested splits", () => {
    const tree: LayoutNode = {
      type: "split",
      direction: "row",
      sizes: [0.5, 0.5],
      children: [
        { type: "leaf", tabs: ["a"], activeTabIndex: 0 },
        { type: "leaf", tabs: ["b"], activeTabIndex: 0 },
      ],
    };
    expect(getNodeAtPath(tree, [1])).toEqual({ type: "leaf", tabs: ["b"], activeTabIndex: 0 });
  });
});

describe("splitLeaf", () => {
  it("wraps a root leaf in a new row split", () => {
    const tree: LayoutNode = { type: "leaf", tabs: ["a"], activeTabIndex: 0 };
    const result = splitLeaf(tree, "a", "row", "b");
    expect(result).toEqual({
      type: "split",
      direction: "row",
      sizes: [0.5, 0.5],
      children: [
        { type: "leaf", tabs: ["a"], activeTabIndex: 0 },
        { type: "leaf", tabs: ["b"], activeTabIndex: 0 },
      ],
    });
  });

  it("splits a leaf nested inside an existing split without disturbing siblings", () => {
    const tree: LayoutNode = {
      type: "split",
      direction: "row",
      sizes: [0.5, 0.5],
      children: [
        { type: "leaf", tabs: ["a"], activeTabIndex: 0 },
        { type: "leaf", tabs: ["b"], activeTabIndex: 0 },
      ],
    };
    const result = splitLeaf(tree, "b", "column", "c");
    expect(result).toEqual({
      type: "split",
      direction: "row",
      sizes: [0.5, 0.5],
      children: [
        { type: "leaf", tabs: ["a"], activeTabIndex: 0 },
        {
          type: "split",
          direction: "column",
          sizes: [0.5, 0.5],
          children: [
            { type: "leaf", tabs: ["b"], activeTabIndex: 0 },
            { type: "leaf", tabs: ["c"], activeTabIndex: 0 },
          ],
        },
      ],
    });
  });

  it("throws when the target session isn't in the tree", () => {
    const tree: LayoutNode = { type: "leaf", tabs: ["a"], activeTabIndex: 0 };
    expect(() => splitLeaf(tree, "missing", "row", "b")).toThrow();
  });
});

describe("addTab", () => {
  it("appends a tab and makes it active", () => {
    const tree: LayoutNode = { type: "leaf", tabs: ["a"], activeTabIndex: 0 };
    const result = addTab(tree, "a", "b");
    expect(result).toEqual({ type: "leaf", tabs: ["a", "b"], activeTabIndex: 1 });
  });

  it("adds to the correct leaf when nested inside a split", () => {
    const tree: LayoutNode = {
      type: "split",
      direction: "row",
      sizes: [0.5, 0.5],
      children: [
        { type: "leaf", tabs: ["a"], activeTabIndex: 0 },
        { type: "leaf", tabs: ["b"], activeTabIndex: 0 },
      ],
    };
    const result = addTab(tree, "b", "c");
    expect(result).toEqual({
      type: "split",
      direction: "row",
      sizes: [0.5, 0.5],
      children: [
        { type: "leaf", tabs: ["a"], activeTabIndex: 0 },
        { type: "leaf", tabs: ["b", "c"], activeTabIndex: 1 },
      ],
    });
  });
});

describe("closeTab", () => {
  it("removes a tab and shifts activeTabIndex left when needed", () => {
    const tree: LayoutNode = { type: "leaf", tabs: ["a", "b", "c"], activeTabIndex: 2 };
    const result = closeTab(tree, "b");
    expect(result).toEqual({ type: "leaf", tabs: ["a", "c"], activeTabIndex: 1 });
  });

  it("keeps activeTabIndex in bounds when closing the active tab", () => {
    const tree: LayoutNode = { type: "leaf", tabs: ["a", "b"], activeTabIndex: 1 };
    const result = closeTab(tree, "b");
    expect(result).toEqual({ type: "leaf", tabs: ["a"], activeTabIndex: 0 });
  });

  it("collapses a two-child split down to the remaining leaf", () => {
    const tree: LayoutNode = {
      type: "split",
      direction: "row",
      sizes: [0.5, 0.5],
      children: [
        { type: "leaf", tabs: ["a"], activeTabIndex: 0 },
        { type: "leaf", tabs: ["b"], activeTabIndex: 0 },
      ],
    };
    const result = closeTab(tree, "b");
    expect(result).toEqual({ type: "leaf", tabs: ["a"], activeTabIndex: 0 });
  });

  it("returns null when closing the tree's very last tab", () => {
    const tree: LayoutNode = { type: "leaf", tabs: ["a"], activeTabIndex: 0 };
    expect(closeTab(tree, "a")).toBeNull();
  });

  it("collapsing a nested split doesn't disturb its sibling subtree", () => {
    const tree: LayoutNode = {
      type: "split",
      direction: "row",
      sizes: [0.5, 0.5],
      children: [
        { type: "leaf", tabs: ["untouched"], activeTabIndex: 0 },
        {
          type: "split",
          direction: "column",
          sizes: [0.5, 0.5],
          children: [
            { type: "leaf", tabs: ["b"], activeTabIndex: 0 },
            { type: "leaf", tabs: ["c"], activeTabIndex: 0 },
          ],
        },
      ],
    };
    const result = closeTab(tree, "c");
    expect(result).toEqual({
      type: "split",
      direction: "row",
      sizes: [0.5, 0.5],
      children: [
        { type: "leaf", tabs: ["untouched"], activeTabIndex: 0 },
        { type: "leaf", tabs: ["b"], activeTabIndex: 0 },
      ],
    });
  });
});

describe("switchTab", () => {
  it("updates activeTabIndex to point at the given session", () => {
    const tree: LayoutNode = { type: "leaf", tabs: ["a", "b", "c"], activeTabIndex: 0 };
    const result = switchTab(tree, "c");
    expect(result).toEqual({ type: "leaf", tabs: ["a", "b", "c"], activeTabIndex: 2 });
  });
});

describe("resizeSplit", () => {
  it("updates only the targeted split's sizes", () => {
    const tree: LayoutNode = {
      type: "split",
      direction: "row",
      sizes: [0.5, 0.5],
      children: [
        { type: "leaf", tabs: ["a"], activeTabIndex: 0 },
        { type: "leaf", tabs: ["b"], activeTabIndex: 0 },
      ],
    };
    const result = resizeSplit(tree, [], [0.3, 0.7]);
    expect(result).toEqual({ ...tree, sizes: [0.3, 0.7] });
  });

  it("updates a nested split without disturbing its parent's sizes", () => {
    const tree: LayoutNode = {
      type: "split",
      direction: "row",
      sizes: [0.5, 0.5],
      children: [
        { type: "leaf", tabs: ["a"], activeTabIndex: 0 },
        {
          type: "split",
          direction: "column",
          sizes: [0.5, 0.5],
          children: [
            { type: "leaf", tabs: ["b"], activeTabIndex: 0 },
            { type: "leaf", tabs: ["c"], activeTabIndex: 0 },
          ],
        },
      ],
    };
    const result = resizeSplit(tree, [1], [0.2, 0.8]);
    expect(result).toEqual({
      ...tree,
      children: [tree.children[0], { ...(tree.children[1] as LayoutNode & { type: "split" }), sizes: [0.2, 0.8] }],
    });
  });
});

describe("allSessionIds", () => {
  it("collects every tab across nested splits", () => {
    const tree: LayoutNode = {
      type: "split",
      direction: "row",
      sizes: [0.5, 0.5],
      children: [
        { type: "leaf", tabs: ["a", "b"], activeTabIndex: 0 },
        { type: "leaf", tabs: ["c"], activeTabIndex: 0 },
      ],
    };
    expect(allSessionIds(tree)).toEqual(["a", "b", "c"]);
  });
});

describe("activeSessionId", () => {
  it("returns the tab at activeTabIndex", () => {
    const leaf: LayoutNode & { type: "leaf" } = { type: "leaf", tabs: ["a", "b"], activeTabIndex: 1 };
    expect(activeSessionId(leaf)).toBe("b");
  });
});

describe("presets", () => {
  it("presetSingle builds a one-tab leaf", () => {
    expect(presetSingle("a")).toEqual({ type: "leaf", tabs: ["a"], activeTabIndex: 0 });
  });

  it("presetSideBySide builds a row split of two single-tab leaves", () => {
    expect(presetSideBySide("a", "b")).toEqual({
      type: "split",
      direction: "row",
      sizes: [0.5, 0.5],
      children: [
        { type: "leaf", tabs: ["a"], activeTabIndex: 0 },
        { type: "leaf", tabs: ["b"], activeTabIndex: 0 },
      ],
    });
  });

  it("presetGrid2x2 builds a column split of two row splits", () => {
    const result = presetGrid2x2("a", "b", "c", "d");
    expect(result).toEqual({
      type: "split",
      direction: "column",
      sizes: [0.5, 0.5],
      children: [
        {
          type: "split",
          direction: "row",
          sizes: [0.5, 0.5],
          children: [
            { type: "leaf", tabs: ["a"], activeTabIndex: 0 },
            { type: "leaf", tabs: ["b"], activeTabIndex: 0 },
          ],
        },
        {
          type: "split",
          direction: "row",
          sizes: [0.5, 0.5],
          children: [
            { type: "leaf", tabs: ["c"], activeTabIndex: 0 },
            { type: "leaf", tabs: ["d"], activeTabIndex: 0 },
          ],
        },
      ],
    });
  });
});
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `cd app && npm test`
Expected: FAIL — `layout.ts` does not exist yet, so every import in `layout.test.ts` fails to resolve.

- [ ] **Step 5: Implement `layout.ts`**

Create `app/src/lib/layout.ts`:

```typescript
export type LayoutNode =
  | { type: "leaf"; tabs: string[]; activeTabIndex: number }
  | { type: "split"; direction: "row" | "column"; children: LayoutNode[]; sizes: number[] };

export function findLeafPath(node: LayoutNode, sessionId: string, path: number[] = []): number[] | null {
  if (node.type === "leaf") {
    return node.tabs.includes(sessionId) ? path : null;
  }
  for (let i = 0; i < node.children.length; i++) {
    const found = findLeafPath(node.children[i], sessionId, [...path, i]);
    if (found) return found;
  }
  return null;
}

export function getNodeAtPath(node: LayoutNode, path: number[]): LayoutNode {
  let current = node;
  for (const index of path) {
    if (current.type !== "split") throw new Error("path descends into a leaf");
    current = current.children[index];
  }
  return current;
}

function normalizeSizes(sizes: number[]): number[] {
  const total = sizes.reduce((sum, s) => sum + s, 0);
  return total > 0 ? sizes.map((s) => s / total) : sizes.map(() => 1 / sizes.length);
}

function replaceAtPath(
  node: LayoutNode,
  path: number[],
  updater: (target: LayoutNode) => LayoutNode | null
): LayoutNode | null {
  if (path.length === 0) {
    return updater(node);
  }
  if (node.type !== "split") {
    throw new Error("path descends into a leaf");
  }
  const [index, ...rest] = path;
  const updatedChild = replaceAtPath(node.children[index], rest, updater);

  if (updatedChild === null) {
    const children = node.children.filter((_, i) => i !== index);
    const sizes = node.sizes.filter((_, i) => i !== index);
    if (children.length === 1) {
      return children[0];
    }
    return { ...node, children, sizes: normalizeSizes(sizes) };
  }

  const children = node.children.map((child, i) => (i === index ? updatedChild : child));
  return { ...node, children };
}

export function splitLeaf(
  tree: LayoutNode,
  targetSessionId: string,
  direction: "row" | "column",
  newSessionId: string
): LayoutNode {
  const path = findLeafPath(tree, targetSessionId);
  if (!path) throw new Error(`session ${targetSessionId} not found in layout`);
  const result = replaceAtPath(tree, path, (leaf) => ({
    type: "split",
    direction,
    children: [leaf, { type: "leaf", tabs: [newSessionId], activeTabIndex: 0 }],
    sizes: [0.5, 0.5],
  }));
  return result as LayoutNode;
}

export function addTab(tree: LayoutNode, targetSessionId: string, newSessionId: string): LayoutNode {
  const path = findLeafPath(tree, targetSessionId);
  if (!path) throw new Error(`session ${targetSessionId} not found in layout`);
  const result = replaceAtPath(tree, path, (leaf) => {
    if (leaf.type !== "leaf") throw new Error("expected a leaf at the found path");
    const tabs = [...leaf.tabs, newSessionId];
    return { type: "leaf", tabs, activeTabIndex: tabs.length - 1 };
  });
  return result as LayoutNode;
}

export function closeTab(tree: LayoutNode, sessionId: string): LayoutNode | null {
  const path = findLeafPath(tree, sessionId);
  if (!path) throw new Error(`session ${sessionId} not found in layout`);
  return replaceAtPath(tree, path, (leaf) => {
    if (leaf.type !== "leaf") throw new Error("expected a leaf at the found path");
    const removedIndex = leaf.tabs.indexOf(sessionId);
    const tabs = leaf.tabs.filter((id) => id !== sessionId);
    if (tabs.length === 0) return null;
    const activeTabIndex =
      leaf.activeTabIndex > removedIndex ? leaf.activeTabIndex - 1 : Math.min(leaf.activeTabIndex, tabs.length - 1);
    return { type: "leaf", tabs, activeTabIndex };
  });
}

export function switchTab(tree: LayoutNode, sessionId: string): LayoutNode {
  const path = findLeafPath(tree, sessionId);
  if (!path) throw new Error(`session ${sessionId} not found in layout`);
  const result = replaceAtPath(tree, path, (leaf) => {
    if (leaf.type !== "leaf") throw new Error("expected a leaf at the found path");
    return { ...leaf, activeTabIndex: leaf.tabs.indexOf(sessionId) };
  });
  return result as LayoutNode;
}

export function resizeSplit(tree: LayoutNode, splitPath: number[], sizes: number[]): LayoutNode {
  const result = replaceAtPath(tree, splitPath, (node) => {
    if (node.type !== "split") throw new Error("expected a split at the given path");
    if (sizes.length !== node.children.length) throw new Error("sizes length mismatch");
    return { ...node, sizes };
  });
  return result as LayoutNode;
}

export function allSessionIds(node: LayoutNode): string[] {
  if (node.type === "leaf") return [...node.tabs];
  return node.children.flatMap(allSessionIds);
}

export function activeSessionId(leaf: Extract<LayoutNode, { type: "leaf" }>): string {
  return leaf.tabs[leaf.activeTabIndex];
}

export function presetSingle(sessionId: string): LayoutNode {
  return { type: "leaf", tabs: [sessionId], activeTabIndex: 0 };
}

export function presetSideBySide(leftId: string, rightId: string): LayoutNode {
  return {
    type: "split",
    direction: "row",
    children: [presetSingle(leftId), presetSingle(rightId)],
    sizes: [0.5, 0.5],
  };
}

export function presetGrid2x2(
  topLeft: string,
  topRight: string,
  bottomLeft: string,
  bottomRight: string
): LayoutNode {
  return {
    type: "split",
    direction: "column",
    children: [
      {
        type: "split",
        direction: "row",
        children: [presetSingle(topLeft), presetSingle(topRight)],
        sizes: [0.5, 0.5],
      },
      {
        type: "split",
        direction: "row",
        children: [presetSingle(bottomLeft), presetSingle(bottomRight)],
        sizes: [0.5, 0.5],
      },
    ],
    sizes: [0.5, 0.5],
  };
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd app && npm test`
Expected: PASS — all tests in `layout.test.ts` green.

- [ ] **Step 7: Commit**

```bash
git add app/src/lib/layout.ts app/src/lib/layout.test.ts app/package.json app/package-lock.json app/vite.config.js
git commit -m "feat(app): add pure layout-tree logic module + vitest setup"
```

---

### Task 2: Backend bindings + reactive layout state store

**Files:**
- Create: `app/src/lib/backend.ts`
- Create: `app/src/lib/layoutState.ts`
- Create: `app/src/lib/layoutState.test.ts`

**Interfaces:**
- Consumes: everything from Task 1's `layout.ts` (imported as `import * as layout from "./layout"` inside `layoutState.ts` — this is intentional, not a naming collision; see Global Constraints' module-boundary rule for why `layout.addTab` and this file's own exported `addTab` action are distinct identifiers in different modules).
- Produces (from `backend.ts`, thin `invoke()` wrappers — one per Part 1 command, no logic beyond the call itself): `createSession(): Promise<string>`, `killSession(sessionId: string): Promise<void>`, `getCurrentLayout(): Promise<LayoutNode>`, `setLayout(layout: LayoutNode): Promise<void>`, `writeInput(sessionId: string, data: string): Promise<void>`, `resizeSession(sessionId: string, cols: number, rows: number): Promise<void>`, `signalFrontendReady(): Promise<void>`, `getBootstrapError(): Promise<string | null>`.
- Produces (from `layoutState.ts`): the store `layoutState` (a `svelte/store` `Writable<{ status: "connecting" | "ready" | "error"; errorMessage: string; tree: LayoutNode | null; focusedSessionId: string | null }>`), and actions `bootstrap(): Promise<void>`, `teardown(): void`, `splitPane(targetSessionId: string, direction: "row" | "column"): Promise<void>`, `addTab(targetSessionId: string): Promise<void>`, `closeSession(sessionId: string): Promise<void>`, `switchToTab(sessionId: string): Promise<void>`, `focusPane(sessionId: string): void`, `resizePane(splitPath: number[], sizes: number[]): Promise<void>`, `applyPreset(buildTree: (freshIds: string[]) => LayoutNode, sessionCount: number): Promise<void>`, `newSessionFromEmpty(): Promise<void>`, `handleSessionExited(sessionId: string): void`. Every task from here on (3 through 7) imports actions from this file only — never from `layout.ts` or `backend.ts` directly.

- [ ] **Step 1: Implement `backend.ts`**

Create `app/src/lib/backend.ts`:

```typescript
import { invoke } from "@tauri-apps/api/core";
import type { LayoutNode } from "./layout";

export function createSession(): Promise<string> {
  return invoke("create_session");
}

export function killSession(sessionId: string): Promise<void> {
  return invoke("kill_session", { sessionId });
}

export function getCurrentLayout(): Promise<LayoutNode> {
  return invoke("get_current_layout");
}

export function setLayout(layout: LayoutNode): Promise<void> {
  return invoke("set_layout", { layout });
}

export function writeInput(sessionId: string, data: string): Promise<void> {
  return invoke("write_input", { sessionId, data });
}

export function resizeSession(sessionId: string, cols: number, rows: number): Promise<void> {
  return invoke("resize_session", { sessionId, cols, rows });
}

export function signalFrontendReady(): Promise<void> {
  return invoke("signal_frontend_ready");
}

export function getBootstrapError(): Promise<string | null> {
  return invoke("get_bootstrap_error");
}
```

There is no automated test for this file — it has no logic beyond a direct `invoke()` call per function, and `invoke()` requires a live Tauri runtime unavailable in a unit test. This mirrors why Part 1 never unit-tested its `#[tauri::command]` wrapper functions individually.

- [ ] **Step 2: Write the failing tests for `layoutState.ts`**

Create `app/src/lib/layoutState.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { get } from "svelte/store";
import type { LayoutNode } from "./layout";

vi.mock("./backend", () => ({
  createSession: vi.fn(),
  killSession: vi.fn(),
  setLayout: vi.fn(),
  getCurrentLayout: vi.fn(),
  getBootstrapError: vi.fn(),
  writeInput: vi.fn(),
  resizeSession: vi.fn(),
  signalFrontendReady: vi.fn(),
}));

import * as backend from "./backend";
import {
  layoutState,
  splitPane,
  addTab,
  closeSession,
  switchToTab,
  focusPane,
  handleSessionExited,
} from "./layoutState";

function setState(partial: {
  tree: LayoutNode | null;
  focusedSessionId: string | null;
}): void {
  layoutState.update((s) => ({ ...s, status: "ready", ...partial }));
}

beforeEach(() => {
  vi.clearAllMocks();
  layoutState.set({ status: "connecting", errorMessage: "", tree: null, focusedSessionId: null });
});

describe("splitPane", () => {
  it("creates a session, splits the tree around the target, and persists", async () => {
    const tree: LayoutNode = { type: "leaf", tabs: ["a"], activeTabIndex: 0 };
    setState({ tree, focusedSessionId: "a" });
    vi.mocked(backend.createSession).mockResolvedValue("b");

    await splitPane("a", "row");

    expect(backend.createSession).toHaveBeenCalledOnce();
    const state = get(layoutState);
    expect(state.tree).toEqual({
      type: "split",
      direction: "row",
      sizes: [0.5, 0.5],
      children: [
        { type: "leaf", tabs: ["a"], activeTabIndex: 0 },
        { type: "leaf", tabs: ["b"], activeTabIndex: 0 },
      ],
    });
    expect(state.focusedSessionId).toBe("b");
    expect(backend.setLayout).toHaveBeenCalledWith(state.tree);
  });

  it("surfaces an error and leaves the tree unchanged when create_session fails", async () => {
    const tree: LayoutNode = { type: "leaf", tabs: ["a"], activeTabIndex: 0 };
    setState({ tree, focusedSessionId: "a" });
    vi.mocked(backend.createSession).mockRejectedValue(new Error("daemon unreachable"));

    await splitPane("a", "row");

    const state = get(layoutState);
    expect(state.tree).toEqual(tree);
    expect(state.status).toBe("error");
    expect(backend.setLayout).not.toHaveBeenCalled();
  });
});

describe("addTab", () => {
  it("creates a session, appends it as a new active tab, and persists", async () => {
    const tree: LayoutNode = { type: "leaf", tabs: ["a"], activeTabIndex: 0 };
    setState({ tree, focusedSessionId: "a" });
    vi.mocked(backend.createSession).mockResolvedValue("b");

    await addTab("a");

    const state = get(layoutState);
    expect(state.tree).toEqual({ type: "leaf", tabs: ["a", "b"], activeTabIndex: 1 });
    expect(state.focusedSessionId).toBe("b");
    expect(backend.setLayout).toHaveBeenCalledWith(state.tree);
  });
});

describe("closeSession", () => {
  it("kills the session then removes it from the tree", async () => {
    const tree: LayoutNode = { type: "leaf", tabs: ["a", "b"], activeTabIndex: 1 };
    setState({ tree, focusedSessionId: "b" });
    vi.mocked(backend.killSession).mockResolvedValue(undefined);

    await closeSession("b");

    expect(backend.killSession).toHaveBeenCalledWith("b");
    const state = get(layoutState);
    expect(state.tree).toEqual({ type: "leaf", tabs: ["a"], activeTabIndex: 0 });
    expect(backend.setLayout).toHaveBeenCalledWith(state.tree);
  });

  it("does not remove the session from the tree when the daemon kill fails", async () => {
    const tree: LayoutNode = { type: "leaf", tabs: ["a", "b"], activeTabIndex: 1 };
    setState({ tree, focusedSessionId: "b" });
    vi.mocked(backend.killSession).mockRejectedValue(new Error("no such session"));

    await closeSession("b");

    const state = get(layoutState);
    expect(state.tree).toEqual(tree);
    expect(state.status).toBe("error");
    expect(backend.setLayout).not.toHaveBeenCalled();
  });

  it("does not persist when closing the tree's very last session", async () => {
    const tree: LayoutNode = { type: "leaf", tabs: ["a"], activeTabIndex: 0 };
    setState({ tree, focusedSessionId: "a" });
    vi.mocked(backend.killSession).mockResolvedValue(undefined);

    await closeSession("a");

    const state = get(layoutState);
    expect(state.tree).toBeNull();
    expect(backend.setLayout).not.toHaveBeenCalled();
  });
});

describe("handleSessionExited", () => {
  it("removes the exited session without calling killSession", () => {
    const tree: LayoutNode = { type: "leaf", tabs: ["a", "b"], activeTabIndex: 1 };
    setState({ tree, focusedSessionId: "b" });

    handleSessionExited("b");

    expect(backend.killSession).not.toHaveBeenCalled();
    const state = get(layoutState);
    expect(state.tree).toEqual({ type: "leaf", tabs: ["a"], activeTabIndex: 0 });
  });

  it("reassigns focus when the focused session is the one that exited", () => {
    const tree: LayoutNode = {
      type: "split",
      direction: "row",
      sizes: [0.5, 0.5],
      children: [
        { type: "leaf", tabs: ["a"], activeTabIndex: 0 },
        { type: "leaf", tabs: ["b"], activeTabIndex: 0 },
      ],
    };
    setState({ tree, focusedSessionId: "b" });

    handleSessionExited("b");

    const state = get(layoutState);
    expect(state.focusedSessionId).toBe("a");
  });

  it("leaves focus untouched when a background (non-focused) session exits", () => {
    const tree: LayoutNode = { type: "leaf", tabs: ["a", "b"], activeTabIndex: 1 };
    setState({ tree, focusedSessionId: "a" });

    handleSessionExited("b");

    const state = get(layoutState);
    expect(state.focusedSessionId).toBe("a");
  });
});

describe("switchToTab", () => {
  it("updates activeTabIndex and focus, and persists", async () => {
    const tree: LayoutNode = { type: "leaf", tabs: ["a", "b"], activeTabIndex: 0 };
    setState({ tree, focusedSessionId: "a" });

    await switchToTab("b");

    const state = get(layoutState);
    expect(state.tree).toEqual({ type: "leaf", tabs: ["a", "b"], activeTabIndex: 1 });
    expect(state.focusedSessionId).toBe("b");
    expect(backend.setLayout).toHaveBeenCalledWith(state.tree);
  });
});

describe("focusPane", () => {
  it("updates focus without touching the tree or persisting", () => {
    const tree: LayoutNode = { type: "leaf", tabs: ["a"], activeTabIndex: 0 };
    setState({ tree, focusedSessionId: null });

    focusPane("a");

    const state = get(layoutState);
    expect(state.focusedSessionId).toBe("a");
    expect(state.tree).toEqual(tree);
    expect(backend.setLayout).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd app && npm test`
Expected: FAIL — `layoutState.ts` does not exist yet.

- [ ] **Step 4: Implement `layoutState.ts`**

Create `app/src/lib/layoutState.ts`:

```typescript
import { writable, get } from "svelte/store";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { LayoutNode } from "./layout";
import * as layout from "./layout";
import * as backend from "./backend";

export interface LayoutState {
  status: "connecting" | "ready" | "error";
  errorMessage: string;
  tree: LayoutNode | null;
  focusedSessionId: string | null;
}

const initialState: LayoutState = {
  status: "connecting",
  errorMessage: "",
  tree: null,
  focusedSessionId: null,
};

export const layoutState = writable<LayoutState>(initialState);

function setError(message: string): void {
  layoutState.update((s) => ({ ...s, status: "error", errorMessage: message }));
}

// Shared by every action below that ends in "mutate the tree, then
// persist it" -- extracted so that pattern exists exactly once instead of
// once per action.
async function persistLayout(tree: LayoutNode): Promise<void> {
  try {
    await backend.setLayout(tree);
  } catch (e) {
    setError(String(e));
  }
}

// Shared by every action that creates exactly one fresh session before
// mutating the tree (splitPane, addTab, newSessionFromEmpty). Returns null
// -- having already called setError -- on failure, so callers just check
// for null rather than duplicating their own try/catch.
async function createFreshSession(): Promise<string | null> {
  try {
    return await backend.createSession();
  } catch (e) {
    setError(String(e));
    return null;
  }
}

const unlisteners: UnlistenFn[] = [];

export async function bootstrap(): Promise<void> {
  unlisteners.push(
    await listen<LayoutNode>("layout-ready", (event) => {
      layoutState.update((s) => {
        if (s.status !== "connecting") return s;
        return {
          ...s,
          status: "ready",
          tree: event.payload,
          focusedSessionId: layout.allSessionIds(event.payload)[0] ?? null,
        };
      });
    })
  );
  unlisteners.push(
    await listen<[string, number]>("session-exited", (event) => {
      handleSessionExited(event.payload[0]);
    })
  );
  unlisteners.push(
    await listen<string>("daemon-error", (event) => {
      setError(event.payload);
    })
  );

  void pollForStartupState();
}

export function teardown(): void {
  unlisteners.forEach((unlisten) => unlisten());
  unlisteners.length = 0;
}

async function pollForStartupState(): Promise<void> {
  const maxAttempts = 15;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (get(layoutState).status !== "connecting") return;
    const [tree, bootstrapError] = await Promise.all([
      backend.getCurrentLayout().catch(() => null),
      backend.getBootstrapError().catch(() => null),
    ]);
    if (bootstrapError) {
      setError(bootstrapError);
      return;
    }
    if (tree) {
      layoutState.update((s) => {
        if (s.status !== "connecting") return s;
        return { ...s, status: "ready", tree, focusedSessionId: layout.allSessionIds(tree)[0] ?? null };
      });
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (get(layoutState).status === "connecting") {
    setError("Timed out waiting for the daemon to become reachable.");
  }
}

export async function splitPane(targetSessionId: string, direction: "row" | "column"): Promise<void> {
  const state = get(layoutState);
  if (!state.tree) return;
  const newId = await createFreshSession();
  if (!newId) return;
  const tree = layout.splitLeaf(state.tree, targetSessionId, direction, newId);
  layoutState.update((s) => ({ ...s, tree, focusedSessionId: newId }));
  await persistLayout(tree);
}

export async function addTab(targetSessionId: string): Promise<void> {
  const state = get(layoutState);
  if (!state.tree) return;
  const newId = await createFreshSession();
  if (!newId) return;
  const tree = layout.addTab(state.tree, targetSessionId, newId);
  layoutState.update((s) => ({ ...s, tree, focusedSessionId: newId }));
  await persistLayout(tree);
}

export async function closeSession(sessionId: string): Promise<void> {
  const state = get(layoutState);
  if (!state.tree) return;
  try {
    await backend.killSession(sessionId);
  } catch (e) {
    setError(String(e));
    return;
  }
  handleSessionExited(sessionId);
}

// Shared by closeSession (after a successful daemon-side kill) and the
// session-exited event listener (the session is already dead, so no
// killSession call happens here) -- both cases mean "remove this session
// from the tree." See Global Constraints for why the empty-tree case
// deliberately skips persistence.
export function handleSessionExited(sessionId: string): void {
  const state = get(layoutState);
  if (!state.tree) return;
  const tree = layout.closeTab(state.tree, sessionId);
  const focusedSessionId =
    state.focusedSessionId === sessionId
      ? (tree ? (layout.allSessionIds(tree)[0] ?? null) : null)
      : state.focusedSessionId;
  layoutState.update((s) => ({ ...s, tree, focusedSessionId }));
  if (tree) {
    void persistLayout(tree);
  }
}

export async function switchToTab(sessionId: string): Promise<void> {
  const state = get(layoutState);
  if (!state.tree) return;
  const tree = layout.switchTab(state.tree, sessionId);
  layoutState.update((s) => ({ ...s, tree, focusedSessionId: sessionId }));
  await persistLayout(tree);
}

export function focusPane(sessionId: string): void {
  layoutState.update((s) => ({ ...s, focusedSessionId: sessionId }));
}

export async function resizePane(splitPath: number[], sizes: number[]): Promise<void> {
  const state = get(layoutState);
  if (!state.tree) return;
  const tree = layout.resizeSplit(state.tree, splitPath, sizes);
  layoutState.update((s) => ({ ...s, tree }));
  await persistLayout(tree);
}

export async function applyPreset(
  buildTree: (freshIds: string[]) => LayoutNode,
  sessionCount: number
): Promise<void> {
  const state = get(layoutState);
  const oldIds = state.tree ? layout.allSessionIds(state.tree) : [];
  let freshIds: string[];
  try {
    freshIds = await Promise.all(Array.from({ length: sessionCount }, () => backend.createSession()));
  } catch (e) {
    setError(String(e));
    return;
  }
  const tree = buildTree(freshIds);
  layoutState.update((s) => ({ ...s, tree, focusedSessionId: freshIds[0] ?? null }));
  // Old sessions are killed best-effort *after* the new tree is already
  // committed -- unlike closeSession, applying a preset is spec'd as an
  // already-deliberate action, so one stuck kill shouldn't block it.
  await Promise.all(oldIds.map((id) => backend.killSession(id).catch(() => {})));
  await persistLayout(tree);
}

export async function newSessionFromEmpty(): Promise<void> {
  const newId = await createFreshSession();
  if (!newId) return;
  const tree = layout.presetSingle(newId);
  layoutState.update((s) => ({ ...s, tree, focusedSessionId: newId }));
  await persistLayout(tree);
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd app && npm test`
Expected: PASS — all tests in `layout.test.ts` and `layoutState.test.ts` green.

- [ ] **Step 6: Commit**

```bash
git add app/src/lib/backend.ts app/src/lib/layoutState.ts app/src/lib/layoutState.test.ts
git commit -m "feat(app): add backend bindings + reactive layout state store"
```

---

### Task 3: Terminal registry + `TerminalPane.svelte`

**Files:**
- Create: `app/src/lib/terminalRegistry.ts`
- Create: `app/src/lib/TerminalPane.svelte`

**Interfaces:**
- Consumes: `backend.ts`'s `writeInput`/`resizeSession` (Task 2). Does **not** import `layoutState.ts` — this component only renders one session's terminal and knows nothing about the tree.
- Produces: `registerTerminal(sessionId, term)`, `unregisterTerminal(sessionId)`, `getTerminal(sessionId): Terminal | undefined` (from `terminalRegistry.ts`, consumed by Task 6's clipboard copy logic to read the focused pane's live xterm.js selection). `TerminalPane.svelte` component with props `{ sessionId: string; visible: boolean }` and an exposed `fit(): void` method (called via `bind:this`, consumed by Task 4's `Pane.svelte`).

- [ ] **Step 1: Implement the terminal registry**

Create `app/src/lib/terminalRegistry.ts`:

```typescript
import type { Terminal } from "@xterm/xterm";

const registry = new Map<string, Terminal>();

export function registerTerminal(sessionId: string, term: Terminal): void {
  registry.set(sessionId, term);
}

export function unregisterTerminal(sessionId: string): void {
  registry.delete(sessionId);
}

export function getTerminal(sessionId: string): Terminal | undefined {
  return registry.get(sessionId);
}
```

- [ ] **Step 2: Implement `TerminalPane.svelte`**

Create `app/src/lib/TerminalPane.svelte`:

```svelte
<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { listen, type UnlistenFn } from "@tauri-apps/api/event";
  import { Terminal } from "@xterm/xterm";
  import { FitAddon } from "@xterm/addon-fit";
  import "@xterm/xterm/css/xterm.css";
  import * as backend from "./backend";
  import { registerTerminal, unregisterTerminal } from "./terminalRegistry";

  let { sessionId, visible }: { sessionId: string; visible: boolean } = $props();

  let container: HTMLDivElement;
  let term: Terminal;
  let fitAddon: FitAddon;
  // $state, not a plain `let` -- this file uses runes ($props below), so a
  // plain `let` read inside the $effect further down would never establish
  // reactivity and the effect would never re-fire once this flips to true.
  let ready = $state(false);
  const unlisteners: UnlistenFn[] = [];

  // Called by the parent Pane via bind:this whenever this tab's shared
  // pane rectangle changes size -- every tab in a pane gets resized
  // together, not just the active one (see Global Constraints).
  export function fit(): void {
    if (!ready) return;
    fitAddon.fit();
    const { cols, rows } = term;
    backend.resizeSession(sessionId, cols, rows).catch(() => {});
  }

  onMount(async () => {
    term = new Terminal({ convertEol: false });
    fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(container);
    registerTerminal(sessionId, term);

    term.onData((data) => {
      backend.writeInput(sessionId, data).catch(() => {});
    });

    unlisteners.push(
      await listen<[string, string]>("pty-output", (event) => {
        const [id, data] = event.payload;
        if (id !== sessionId) return;
        term.write(data);
      })
    );

    ready = true;
    fit();
    if (visible) term.focus();
  });

  onDestroy(() => {
    unlisteners.forEach((unlisten) => unlisten());
    unregisterTerminal(sessionId);
    term?.dispose();
  });

  $effect(() => {
    if (visible && ready) {
      term.focus();
    }
  });
</script>

<div class="pane" class:inactive={!visible} bind:this={container}></div>

<style>
  .pane {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
  }
  .inactive {
    visibility: hidden;
    z-index: 0;
  }
  .pane:not(.inactive) {
    z-index: 1;
  }
</style>
```

- [ ] **Step 3: Verify**

Run: `cd app && npm run check`
Expected: no type errors.

Run: `cd app && npm run build`
Expected: builds cleanly.

This task has no automated GUI test (per Global Constraints). Note in your report that actual terminal rendering, input echo, and focus behavior are unverified pending a human at the keyboard — this component only becomes visible in the running app once Task 7 wires up the page that mounts it.

- [ ] **Step 4: Commit**

```bash
git add app/src/lib/terminalRegistry.ts app/src/lib/TerminalPane.svelte
git commit -m "feat(app): add per-session TerminalPane component + terminal registry"
```

---

### Task 4: `Pane.svelte` (tab bar) + `LayoutTree.svelte` (recursive split renderer)

**Files:**
- Create: `app/src/lib/Pane.svelte`
- Create: `app/src/lib/LayoutTree.svelte`

**Interfaces:**
- Consumes: `layoutState.ts`'s `layoutState` store and `switchToTab`/`addTab`/`closeSession`/`focusPane`/`resizePane` actions (Task 2); `TerminalPane.svelte` (Task 3).
- Produces: `Pane.svelte` (props: `{ leaf: Extract<LayoutNode, { type: "leaf" }> }`), `LayoutTree.svelte` (props: `{ node: LayoutNode; path: number[] }`), both consumed by Task 7's top-level page (`LayoutTree` is the entry point; it renders `Pane` internally for leaves and itself recursively for splits via `<svelte:self>`).

- [ ] **Step 1: Implement `Pane.svelte`**

Create `app/src/lib/Pane.svelte`:

```svelte
<script lang="ts">
  import { onMount } from "svelte";
  import type { LayoutNode } from "./layout";
  import TerminalPane from "./TerminalPane.svelte";
  import { layoutState, switchToTab, addTab, closeSession, focusPane } from "./layoutState";

  let { leaf }: { leaf: Extract<LayoutNode, { type: "leaf" }> } = $props();

  let paneRefs: Record<string, { fit: () => void }> = {};
  let containerEl: HTMLDivElement;

  const isFocused = $derived(
    $layoutState.focusedSessionId !== null && leaf.tabs.includes($layoutState.focusedSessionId)
  );
  const active = $derived(leaf.tabs[leaf.activeTabIndex]);

  export function fitAll(): void {
    for (const id of leaf.tabs) {
      paneRefs[id]?.fit();
    }
  }

  // onMount, not a $effect gated on containerEl -- containerEl is a plain
  // `let` (bind:this target), so reading it inside $effect would never
  // establish reactivity and the observer would never actually get set up.
  // Svelte guarantees bind:this refs are already populated by the time
  // onMount runs, and this div is never conditionally recreated, so a
  // one-time setup here is both correct and simpler than chasing reactivity.
  onMount(() => {
    const observer = new ResizeObserver(() => fitAll());
    observer.observe(containerEl);
    return () => observer.disconnect();
  });
</script>

<div class="pane-wrapper" class:focused={isFocused}>
  <div class="tab-bar">
    {#each leaf.tabs as sessionId (sessionId)}
      <button class="tab" class:active={sessionId === active} onclick={() => switchToTab(sessionId)}>
        {sessionId.slice(0, 8)}
        <span
          class="close"
          onclick={(e) => {
            e.stopPropagation();
            closeSession(sessionId);
          }}>×</span
        >
      </button>
    {/each}
    <button class="new-tab" onclick={() => addTab(active)}>+</button>
  </div>
  <div class="content" bind:this={containerEl} onmousedown={() => focusPane(active)}>
    {#each leaf.tabs as sessionId (sessionId)}
      <TerminalPane bind:this={paneRefs[sessionId]} {sessionId} visible={sessionId === active} />
    {/each}
  </div>
</div>

<style>
  .pane-wrapper {
    display: flex;
    flex-direction: column;
    width: 100%;
    height: 100%;
    border: 1px solid transparent;
    box-sizing: border-box;
  }
  .pane-wrapper.focused {
    border-color: #4a9eff;
  }
  .tab-bar {
    display: flex;
    background: #2a2a2a;
    flex: 0 0 auto;
  }
  .tab {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 8px;
    background: transparent;
    border: none;
    color: #aaa;
    font-family: monospace;
    font-size: 0.8em;
    cursor: pointer;
  }
  .tab.active {
    background: #1e1e1e;
    color: #fff;
  }
  .close {
    opacity: 0.6;
  }
  .close:hover {
    opacity: 1;
  }
  .new-tab {
    background: transparent;
    border: none;
    color: #aaa;
    cursor: pointer;
    padding: 4px 8px;
  }
  .content {
    position: relative;
    flex: 1 1 auto;
    overflow: hidden;
  }
</style>
```

- [ ] **Step 2: Implement `LayoutTree.svelte`**

Create `app/src/lib/LayoutTree.svelte`:

```svelte
<script lang="ts">
  import type { LayoutNode } from "./layout";
  import Pane from "./Pane.svelte";
  import { resizePane } from "./layoutState";

  let { node, path }: { node: LayoutNode; path: number[] } = $props();

  let container: HTMLDivElement;
  let dragIndex = $state<number | null>(null);

  function startDrag(index: number, event: PointerEvent): void {
    if (node.type !== "split") return;
    dragIndex = index;
    event.preventDefault();
    window.addEventListener("pointermove", onDrag);
    window.addEventListener("pointerup", stopDrag);
  }

  function onDrag(event: PointerEvent): void {
    if (node.type !== "split" || dragIndex === null || !container) return;
    const rect = container.getBoundingClientRect();
    const isRow = node.direction === "row";
    const total = isRow ? rect.width : rect.height;
    const offset = isRow ? event.clientX - rect.left : event.clientY - rect.top;
    const fraction = Math.min(0.9, Math.max(0.1, offset / total));

    const sizes = [...node.sizes];
    const before = sizes.slice(0, dragIndex).reduce((a, b) => a + b, 0);
    const remaining = sizes[dragIndex] + sizes[dragIndex + 1];
    const newFirst = Math.min(remaining - 0.05, Math.max(0.05, fraction - before));
    sizes[dragIndex] = newFirst;
    sizes[dragIndex + 1] = remaining - newFirst;
    void resizePane(path, sizes);
  }

  function stopDrag(): void {
    dragIndex = null;
    window.removeEventListener("pointermove", onDrag);
    window.removeEventListener("pointerup", stopDrag);
  }
</script>

{#if node.type === "leaf"}
  <Pane leaf={node} />
{:else}
  <div
    class="split"
    class:row={node.direction === "row"}
    class:column={node.direction === "column"}
    bind:this={container}
  >
    {#each node.children as child, index (index)}
      <div class="child" style="flex-grow: {node.sizes[index]}">
        <svelte:self node={child} path={[...path, index]} />
      </div>
      {#if index < node.children.length - 1}
        <div
          class="divider"
          class:row={node.direction === "row"}
          class:column={node.direction === "column"}
          onpointerdown={(e) => startDrag(index, e)}
        ></div>
      {/if}
    {/each}
  </div>
{/if}

<style>
  .split {
    display: flex;
    width: 100%;
    height: 100%;
  }
  .split.row {
    flex-direction: row;
  }
  .split.column {
    flex-direction: column;
  }
  .child {
    position: relative;
    overflow: hidden;
  }
  .divider {
    flex: 0 0 4px;
    background: #333;
  }
  .divider.row {
    cursor: col-resize;
  }
  .divider.column {
    cursor: row-resize;
  }
</style>
```

- [ ] **Step 3: Verify**

Run: `cd app && npm run check`
Expected: no type errors.

Run: `cd app && npm run build`
Expected: builds cleanly.

No automated GUI test (per Global Constraints). Note in your report that drag-to-resize, tab switching, and focus-border rendering are unverified pending a human at the keyboard — this tree only becomes reachable in the running app once Task 7 mounts it.

- [ ] **Step 4: Commit**

```bash
git add app/src/lib/Pane.svelte app/src/lib/LayoutTree.svelte
git commit -m "feat(app): add Pane tab bar and recursive LayoutTree renderer"
```

---

### Task 5: Toolbar + pane-management keyboard shortcuts

**Files:**
- Create: `app/src/lib/Toolbar.svelte`
- Create: `app/src/lib/keyboard.ts`

**Interfaces:**
- Consumes: `layoutState.ts`'s `layoutState` store and `splitPane`/`closeSession`/`applyPreset` actions (Task 2); `layout.ts`'s `presetSingle`/`presetSideBySide`/`presetGrid2x2` (Task 1, the one place outside `layoutState.ts` that imports `layout.ts` directly, since presets are pure tree shapes the toolbar hands to `applyPreset` — this does not violate the module-boundary rule, which is about *mutating* the live tree, not about referencing pure shape-builders).
- Produces: `Toolbar.svelte` component (no props), `installKeyboardShortcuts(): () => void` (installs a capture-phase `keydown` listener, returns a cleanup function). Both consumed by Task 7's top-level page. Task 6 (clipboard) extends `keyboard.ts`'s `handleKeydown` with two more branches — do not structure `handleKeydown` in a way that makes adding branches awkward (a flat `if`/`else if` chain, as below, is what Task 6 expects to extend).

- [ ] **Step 1: Implement `Toolbar.svelte`**

Create `app/src/lib/Toolbar.svelte`:

```svelte
<script lang="ts">
  import { layoutState, splitPane, closeSession, applyPreset } from "./layoutState";
  import { presetSingle, presetSideBySide, presetGrid2x2 } from "./layout";

  async function split(direction: "row" | "column"): Promise<void> {
    const id = $layoutState.focusedSessionId;
    if (id) await splitPane(id, direction);
  }

  async function closePane(): Promise<void> {
    const id = $layoutState.focusedSessionId;
    if (id) await closeSession(id);
  }

  async function applySingle(): Promise<void> {
    await applyPreset(([id]) => presetSingle(id), 1);
  }
  async function applySideBySide(): Promise<void> {
    await applyPreset(([a, b]) => presetSideBySide(a, b), 2);
  }
  async function applyGrid(): Promise<void> {
    await applyPreset(([a, b, c, d]) => presetGrid2x2(a, b, c, d), 4);
  }
</script>

<div class="toolbar">
  <button onclick={() => split("row")}>Split Right</button>
  <button onclick={() => split("column")}>Split Down</button>
  <button onclick={closePane}>Close Pane</button>
  <div class="presets">
    <span>Presets:</span>
    <button onclick={applySingle}>Single</button>
    <button onclick={applySideBySide}>Side by Side</button>
    <button onclick={applyGrid}>2×2 Grid</button>
  </div>
</div>

<style>
  .toolbar {
    display: flex;
    gap: 8px;
    align-items: center;
    padding: 4px 8px;
    background: #2a2a2a;
    color: #ccc;
    font-family: sans-serif;
    font-size: 0.8em;
    flex: 0 0 auto;
  }
  .toolbar button {
    background: #3a3a3a;
    border: none;
    color: #ccc;
    padding: 4px 8px;
    border-radius: 3px;
    cursor: pointer;
  }
  .toolbar button:hover {
    background: #4a4a4a;
  }
  .presets {
    display: flex;
    gap: 4px;
    align-items: center;
    margin-left: auto;
  }
</style>
```

- [ ] **Step 2: Implement `keyboard.ts`**

Create `app/src/lib/keyboard.ts`:

```typescript
import { get } from "svelte/store";
import { layoutState, splitPane, addTab, closeSession } from "./layoutState";

async function handleKeydown(event: KeyboardEvent): Promise<void> {
  // metaKey is Cmd on macOS -- the app is macOS-first per the project roadmap.
  if (!event.metaKey) return;
  const state = get(layoutState);
  if (!state.focusedSessionId) return;

  const key = event.key.toLowerCase();

  if (key === "d" && event.shiftKey) {
    event.preventDefault();
    event.stopPropagation();
    await splitPane(state.focusedSessionId, "column");
  } else if (key === "d") {
    event.preventDefault();
    event.stopPropagation();
    await splitPane(state.focusedSessionId, "row");
  } else if (key === "t") {
    event.preventDefault();
    event.stopPropagation();
    await addTab(state.focusedSessionId);
  } else if (key === "w") {
    event.preventDefault();
    event.stopPropagation();
    await closeSession(state.focusedSessionId);
  }
}

export function installKeyboardShortcuts(): () => void {
  // Capture phase, not bubble -- xterm.js's own keydown handler stops
  // propagation before a bubble-phase window listener would ever see it
  // (established the hard way in Milestone B).
  const listener = (event: KeyboardEvent) => {
    void handleKeydown(event);
  };
  window.addEventListener("keydown", listener, true);
  return () => window.removeEventListener("keydown", listener, true);
}
```

- [ ] **Step 3: Verify**

Run: `cd app && npm run check`
Expected: no type errors.

Run: `cd app && npm run build`
Expected: builds cleanly.

No automated GUI test (per Global Constraints). Note in your report that the toolbar buttons and keyboard shortcuts are unverified pending a human at the keyboard — neither is reachable in the running app until Task 7 mounts the toolbar and installs the shortcuts.

- [ ] **Step 4: Commit**

```bash
git add app/src/lib/Toolbar.svelte app/src/lib/keyboard.ts
git commit -m "feat(app): add toolbar and pane-management keyboard shortcuts"
```

---

### Task 6: Clipboard copy/paste

**Files:**
- Create: `app/src/lib/clipboard.ts`
- Modify: `app/src-tauri/Cargo.toml` (add `tauri-plugin-clipboard-manager` dependency)
- Modify: `app/package.json` (add `@tauri-apps/plugin-clipboard-manager` dependency)
- Modify: `app/src-tauri/src/lib.rs` (register the plugin)
- Modify: `app/src-tauri/capabilities/default.json` (grant the clipboard permission)
- Modify: `app/src/lib/keyboard.ts` (add `Cmd+C`/`Cmd+V` handling)

**Interfaces:**
- Consumes: `terminalRegistry.ts`'s `getTerminal` (Task 3); `backend.ts`'s `writeInput` (Task 2); `layoutState.ts`'s `layoutState` store (Task 2); `keyboard.ts`'s `handleKeydown` (Task 5, extended in place).
- Produces: `copySelection(): Promise<void>`, `pasteClipboard(): Promise<void>` (from `clipboard.ts`) — not consumed by any later task, wired directly into `keyboard.ts`'s own handler in this task.

- [ ] **Step 1: Add the Rust dependency**

Open `app/src-tauri/Cargo.toml`. Add one line to `[dependencies]`, alongside the existing `tauri-plugin-opener`/`tauri-plugin-dialog` entries:

```toml
[dependencies]
tauri = { version = "2", features = [] }
tauri-plugin-opener = "2"
tauri-plugin-dialog = "2"
tauri-plugin-clipboard-manager = "2"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
anyhow = "1"
protocol = { path = "../../crates/protocol" }
```

- [ ] **Step 2: Add the npm package**

```bash
cd app && npm install @tauri-apps/plugin-clipboard-manager
```

- [ ] **Step 3: Register the plugin**

Open `app/src-tauri/src/lib.rs`. Add one `.plugin(...)` call, alongside the existing `opener`/`dialog` registrations:

```rust
tauri::Builder::default()
    .plugin(tauri_plugin_opener::init())
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_clipboard_manager::init())
    .manage(session::FrontendReady(std::sync::atomic::AtomicBool::new(false)))
    .manage(session::BootstrapError(std::sync::Mutex::new(None)))
```

(Everything else in `lib.rs` is unchanged.)

- [ ] **Step 4: Build once to generate the plugin's permission schema, then grant it**

Run: `cd app/src-tauri && cargo build`
Expected: builds successfully (this generates/updates `app/src-tauri/gen/schemas/`, which lists every permission identifier the newly-registered plugin actually exposes — this directory is gitignored and regenerated on every build, so it is never committed).

Read `app/src-tauri/gen/schemas/desktop-schema.json` (or wherever the build placed the clipboard-manager plugin's generated permission identifiers) and confirm the exact default-permission identifier name — do not assume it's `"clipboard-manager:default"` without checking, the same way Milestone B once assumed `core:default` covered window close/destroy and was wrong. Once confirmed, open `app/src-tauri/capabilities/default.json` and add it:

```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "default",
  "description": "Capability for the main window",
  "windows": ["main"],
  "permissions": [
    "core:default",
    "core:window:allow-close",
    "core:window:allow-destroy",
    "opener:default",
    "dialog:default",
    "clipboard-manager:default"
  ]
}
```

(Use whatever the actual confirmed identifier is in place of `"clipboard-manager:default"` if the generated schema names it differently.)

- [ ] **Step 5: Implement `clipboard.ts`**

Create `app/src/lib/clipboard.ts`:

```typescript
import { get } from "svelte/store";
import { writeText, readText } from "@tauri-apps/plugin-clipboard-manager";
import { layoutState } from "./layoutState";
import { getTerminal } from "./terminalRegistry";
import { writeInput } from "./backend";

export async function copySelection(): Promise<void> {
  const state = get(layoutState);
  if (!state.focusedSessionId) return;
  const term = getTerminal(state.focusedSessionId);
  const selection = term?.getSelection();
  if (!selection) return;
  await writeText(selection);
}

export async function pasteClipboard(): Promise<void> {
  const state = get(layoutState);
  if (!state.focusedSessionId) return;
  const text = await readText();
  if (!text) return;
  await writeInput(state.focusedSessionId, text);
}
```

Verify the exact export names (`writeText`/`readText`) against `node_modules/@tauri-apps/plugin-clipboard-manager`'s type definitions after Step 2's install, and adjust if the installed version names them differently.

- [ ] **Step 6: Wire `Cmd+C`/`Cmd+V` into `keyboard.ts`**

Open `app/src/lib/keyboard.ts`. Add the import and two more branches to `handleKeydown`'s `if`/`else if` chain:

```typescript
import { get } from "svelte/store";
import { layoutState, splitPane, addTab, closeSession } from "./layoutState";
import { copySelection, pasteClipboard } from "./clipboard";

async function handleKeydown(event: KeyboardEvent): Promise<void> {
  if (!event.metaKey) return;
  const state = get(layoutState);
  if (!state.focusedSessionId) return;

  const key = event.key.toLowerCase();

  if (key === "d" && event.shiftKey) {
    event.preventDefault();
    event.stopPropagation();
    await splitPane(state.focusedSessionId, "column");
  } else if (key === "d") {
    event.preventDefault();
    event.stopPropagation();
    await splitPane(state.focusedSessionId, "row");
  } else if (key === "t") {
    event.preventDefault();
    event.stopPropagation();
    await addTab(state.focusedSessionId);
  } else if (key === "w") {
    event.preventDefault();
    event.stopPropagation();
    await closeSession(state.focusedSessionId);
  } else if (key === "c") {
    event.preventDefault();
    event.stopPropagation();
    await copySelection();
  } else if (key === "v") {
    event.preventDefault();
    event.stopPropagation();
    await pasteClipboard();
  }
}
```

(`installKeyboardShortcuts` at the bottom of the file is unchanged.)

- [ ] **Step 7: Verify**

Run: `cd app && npm run check`
Expected: no type errors.

Run: `cd app/src-tauri && cargo build`
Expected: builds successfully.

Run: `cd app && npm run build`
Expected: builds cleanly.

No automated GUI test (per Global Constraints). Note in your report that actual copy/paste behavior — including whether the permission grant from Step 4 is sufficient at runtime, not just at compile time — is unverified pending a human at the keyboard.

- [ ] **Step 8: Commit**

```bash
git add app/src-tauri/Cargo.toml app/src-tauri/Cargo.lock app/package.json app/package-lock.json \
  app/src-tauri/src/lib.rs app/src-tauri/capabilities/default.json app/src/lib/clipboard.ts \
  app/src/lib/keyboard.ts
git commit -m "feat(app): add Cmd+C/Cmd+V clipboard copy/paste"
```

(`app/src-tauri/gen/schemas/` is gitignored — do not add it.)

---

### Task 7: Top-level page rewrite

**Files:**
- Modify: `app/src/routes/+page.svelte` (full rewrite)
- Delete: `app/src/lib/Terminal.svelte` (superseded by `TerminalPane.svelte` + the new component tree — every piece of behavior it had now lives in `layoutState.ts`, `TerminalPane.svelte`, or this task's rewritten `+page.svelte`)

**Interfaces:**
- Consumes: `layoutState.ts`'s `layoutState` store, `bootstrap`/`teardown`/`newSessionFromEmpty` (Task 2); `backend.ts`'s `signalFrontendReady` (Task 2); `keyboard.ts`'s `installKeyboardShortcuts` (Task 5, now including clipboard from Task 6); `LayoutTree.svelte` (Task 4); `Toolbar.svelte` (Task 5).
- Produces: nothing further — this is the final integration task. The whole app is reachable end-to-end after this task.

- [ ] **Step 1: Rewrite `+page.svelte`**

Replace the full contents of `app/src/routes/+page.svelte`:

```svelte
<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { getCurrentWindow } from "@tauri-apps/api/window";
  import { confirm } from "@tauri-apps/plugin-dialog";
  import { layoutState, bootstrap, teardown, newSessionFromEmpty } from "$lib/layoutState";
  import { signalFrontendReady } from "$lib/backend";
  import { installKeyboardShortcuts } from "$lib/keyboard";
  import LayoutTree from "$lib/LayoutTree.svelte";
  import Toolbar from "$lib/Toolbar.svelte";

  let closeConfirmed = false;
  let uninstallShortcuts: (() => void) | null = null;
  let unlistenClose: (() => void) | null = null;

  async function quitApp(): Promise<void> {
    closeConfirmed = true;
    // destroy(), not close() -- close() would re-dispatch CloseRequested
    // through the very listener intercepting it below.
    await getCurrentWindow().destroy();
  }

  onMount(async () => {
    unlistenClose = await getCurrentWindow().onCloseRequested(async (event) => {
      if (closeConfirmed) return;
      event.preventDefault();
      const shouldClose = await confirm(
        "Close this window? Your terminal sessions will keep running — reopen the app to resume them.",
        { title: "gavin" }
      );
      if (shouldClose) {
        await quitApp();
      }
    });

    try {
      await bootstrap();
    } finally {
      await signalFrontendReady();
    }

    uninstallShortcuts = installKeyboardShortcuts();
  });

  onDestroy(() => {
    unlistenClose?.();
    uninstallShortcuts?.();
    teardown();
  });
</script>

<div class="app">
  {#if $layoutState.status === "connecting"}
    <div class="overlay">
      <p>Connecting…</p>
    </div>
  {:else if $layoutState.status === "error"}
    <div class="overlay">
      <p>Couldn't connect to the daemon.</p>
      <p class="detail">{$layoutState.errorMessage}</p>
    </div>
  {:else if $layoutState.tree}
    <Toolbar />
    <div class="tree">
      <LayoutTree node={$layoutState.tree} path={[]} />
    </div>
  {:else}
    <div class="overlay">
      <button onclick={newSessionFromEmpty}>New Session</button>
    </div>
  {/if}
</div>

<style>
  :global(html, body) {
    margin: 0;
    padding: 0;
    overflow: hidden;
  }
  .app {
    width: 100vw;
    height: 100vh;
    margin: 0;
    background: #1e1e1e;
    display: flex;
    flex-direction: column;
  }
  .tree {
    flex: 1 1 auto;
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

(The `:global(html, body)` reset moves here from the old `+page.svelte`, which previously imported `<Terminal />` for this — see Step 2.)

- [ ] **Step 2: Delete the superseded component**

```bash
git rm app/src/lib/Terminal.svelte
```

- [ ] **Step 3: Verify**

Run: `cd app && npm run check`
Expected: no type errors, and no dangling reference to the deleted `Terminal.svelte` anywhere.

Run: `grep -rn "lib/Terminal\"" app/src` (or equivalent) to confirm nothing still imports the deleted file.
Expected: no matches.

Run: `cd app && npm run build`
Expected: builds cleanly.

Run: `cd app && npm test`
Expected: all `layout.test.ts` and `layoutState.test.ts` tests still pass (this task doesn't touch either module, but it's the last task — confirm nothing regressed).

Run: `cd app && npm run tauri dev` (or `npm run dev` for a browser-only smoke check of the SPA shell) and confirm the app launches to either the connecting/error overlay or a rendered single-pane terminal without a JS console error, as far as can be observed without synthetic keyboard/mouse input.

No automated GUI test beyond the above (per Global Constraints). This is the final integration task — your report must clearly list everything that still needs a human at the keyboard: split (`Cmd+D`/`Cmd+Shift+D`/toolbar buttons), new tab (`Cmd+T`/pane "+"), close tab/pane (`Cmd+W`/tab "×"/toolbar "Close Pane"), drag-to-resize, layout presets, copy/paste (`Cmd+C`/`Cmd+V`), the window-close confirmation dialog, and the empty-state "New Session" button.

- [ ] **Step 4: Commit**

```bash
git add app/src/routes/+page.svelte
git commit -m "feat(app): wire up split-pane layout as the app's top-level page"
```

## Self-Review Notes

- **Spec coverage:** every item in the design spec's "Frontend (Svelte) changes" bullet and Data flow steps 2-7 maps to a task: pane-component extraction/reuse → Task 3; recursive layout renderer + resize dividers → Task 4; tab bar (click/+/×) → Task 4; toolbar + keyboard shortcuts → Task 5; layout presets → Task 2 (logic) + Task 5 (toolbar UI); `Cmd+C`/`Cmd+V` clipboard → Task 6; mouse-drag text selection → explicitly unbuilt, per the spec, since it's xterm.js's own built-in behavior needing no new code. The open question the spec's Architecture section left unresolved (frontend- vs. server-side layout persistence after `create_session`/`kill_session`) is resolved in this plan's own Architecture summary and encoded throughout Task 2.
- **Placeholder scan:** none found — every step has complete, concrete code; the two genuinely-uncertain external details (the clipboard plugin's exact permission identifier, and its exact JS export names) are called out as explicit verify-don't-assume steps with a clear reason, not glossed over as TODOs.
- **Type consistency:** `LayoutNode` (Task 1) is used identically by every later task. Action names are consistent from their first definition (Task 2) through every consumer (`splitPane`/`addTab`/`closeSession`/`switchToTab`/`focusPane`/`resizePane`/`applyPreset`/`newSessionFromEmpty`/`handleSessionExited`/`bootstrap`/`teardown` — Tasks 4, 5, 6, and 7 all call these by the exact names Task 2 exports, none renamed or redefined). `TerminalPane`'s exposed `fit()` (Task 3) is called by name from `Pane.svelte` (Task 4). `terminalRegistry.ts`'s `getTerminal` (Task 3) is called by name from `clipboard.ts` (Task 6).
