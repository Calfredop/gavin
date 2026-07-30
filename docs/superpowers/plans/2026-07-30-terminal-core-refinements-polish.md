# Terminal Core Refinements — Plan 1: Polish Pass Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add icons to the toolbar/pane action buttons and a confirmation prompt before any action that would empty a pane.

**Architecture:** A new pure query (`isLastTabInPane`) in `layout.ts` answers "would closing this tab empty its pane," consumed by a small new `confirmClose.ts` module wrapping `@tauri-apps/plugin-dialog`'s `confirm()` with the two wordings this feature needs — that module is called from the three UI-layer sites that can empty a pane (a tab's ×, `Cmd+W`, the toolbar's "Close Pane" button), leaving `layoutState.ts`'s existing `closeSession`/`closePane` actions untouched. Icons come from a new `lucide-svelte` dependency, swapped in directly at each button.

**Tech Stack:** Svelte 5, `lucide-svelte` (new dependency), `@tauri-apps/plugin-dialog` (already a dependency, already used for the window-close confirm).

## Global Constraints

- Confirm-dialog wording, exact: single-tab-empties-pane case —
  `"Close this tab? It's the last one in this pane, so the pane will close too."`;
  toolbar's always-confirm case —
  `` `Close this pane? ${count} terminal session${count === 1 ? "" : "s"} will end.` ``
  (pluralizes "session"/"sessions" correctly).
- Confirming/declining is a UI-layer decision. `layoutState.ts`'s `closeSession(sessionId)` and `closePane(anySessionId)` actions are not modified by this plan — the confirm step happens *before* calling them, at each of the three call sites, exactly mirroring where the existing window-close confirm already lives (`+page.svelte`, not the data layer).
- Closing a tab that does *not* empty its pane (siblings remain) stays completely unprompted, exactly as it behaves today — only emptying a pane gets a prompt.
- Icons replace text labels on the toolbar's Split Right / Split Down / Close Pane buttons and on `Pane.svelte`'s tab-close (×) and new-tab (+) controls — those become icon-only, with `aria-label`/`title` attributes for accessibility and a plain hover hint (this is a different, much simpler thing than the custom tooltip component a *later* plan builds for tab names — a native `title=` attribute is the right tool for a simple icon-only button hint). The toolbar's three layout-preset buttons keep their existing text labels alongside a representative icon — an icon alone for "2×2 Grid" isn't recognizable at a glance.
- `Pane.svelte`'s tab label itself (currently `{sessionId.slice(0, 8)}`) is **not** touched by this plan — tab naming by folder is a separate, later plan. Do not scope-creep into changing what text a tab shows, only its × icon.
- `lucide-svelte`'s exact import syntax and icon component names must be verified against the actually-installed package (check its README or the `node_modules/lucide-svelte` contents) rather than assumed — icon names and import patterns have changed across versions of this package, and this project has hit exactly this class of "verify the real API, don't guess" issue before (Milestone C Part 2's clipboard-permission-identifier lesson). The names used in this plan's code blocks (`Columns2`, `Rows2`, `X`, `Plus`, `Square`, `Grid2x2`) are this plan's best understanding of the current icon set; treat them as a starting point to confirm, not a guarantee.
- GUI behavior (does the confirm dialog actually appear and respond correctly to Yes/No, do the icons render) has no automated coverage in the agent environment (no synthetic-input capability) — this is a documented, standing limitation of every Svelte-component task in this project so far. `npm run check` and `npm run build` are the automated floor for every task touching a `.svelte` file; note anything beyond that as unverified pending a human at the keyboard.
- Work happens directly on `main` (no worktree) — an explicit, standing preference for every plan in this project so far.

---

### Task 1: `isLastTabInPane` pure query

**Files:**
- Modify: `app/src/lib/layout.ts`
- Modify: `app/src/lib/layout.test.ts`

**Interfaces:**
- Produces: `isLastTabInPane(tree: LayoutNode, sessionId: string): boolean`. Consumed by Task 2's `confirmClose.ts`.
- Consumes: `findLeafPath`/`getNodeAtPath`, both already exported by `layout.ts`.

- [ ] **Step 1: Write the failing tests**

Open `app/src/lib/layout.test.ts`. Add `isLastTabInPane` to the existing
named-import list at the top of the file (alongside `findLeafPath`,
`getNodeAtPath`, and the rest — it's one existing `import { ... } from
"./layout";` statement, just add the one new name to it).

Add this `describe` block anywhere among the file's other `describe`
blocks (order doesn't matter to vitest):

```typescript
describe("isLastTabInPane", () => {
  it("returns true when the session is the only tab in its leaf", () => {
    const tree: LayoutNode = { type: "leaf", tabs: ["a"], activeTabIndex: 0 };
    expect(isLastTabInPane(tree, "a")).toBe(true);
  });

  it("returns false when the session shares its leaf with other tabs", () => {
    const tree: LayoutNode = { type: "leaf", tabs: ["a", "b"], activeTabIndex: 0 };
    expect(isLastTabInPane(tree, "a")).toBe(false);
  });

  it("returns false for a session id not present in the tree", () => {
    const tree: LayoutNode = { type: "leaf", tabs: ["a"], activeTabIndex: 0 };
    expect(isLastTabInPane(tree, "missing")).toBe(false);
  });

  it("checks the correct leaf when nested inside a split", () => {
    const tree: LayoutNode = {
      type: "split",
      direction: "row",
      sizes: [0.5, 0.5],
      children: [
        { type: "leaf", tabs: ["a"], activeTabIndex: 0 },
        { type: "leaf", tabs: ["b", "c"], activeTabIndex: 0 },
      ],
    };
    expect(isLastTabInPane(tree, "a")).toBe(true);
    expect(isLastTabInPane(tree, "b")).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd app && npm test`
Expected: FAIL — `isLastTabInPane` is not exported by `layout.ts` yet.

- [ ] **Step 3: Implement `isLastTabInPane`**

Open `app/src/lib/layout.ts`. Add this function — a sensible place is right
after `getNodeAtPath`, since it's built directly on top of it:

```typescript
export function isLastTabInPane(tree: LayoutNode, sessionId: string): boolean {
  const path = findLeafPath(tree, sessionId);
  if (!path) return false;
  const leaf = getNodeAtPath(tree, path);
  return leaf.type === "leaf" && leaf.tabs.length === 1;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd app && npm test`
Expected: PASS — all tests in `layout.test.ts` green, including the 4 new ones.

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/layout.ts app/src/lib/layout.test.ts
git commit -m "feat(app): add isLastTabInPane pure query"
```

---

### Task 2: Confirm-prompt module, wired into all three pane-emptying call sites

**Files:**
- Create: `app/src/lib/confirmClose.ts`
- Create: `app/src/lib/confirmClose.test.ts`
- Modify: `app/src/lib/Pane.svelte`
- Modify: `app/src/lib/keyboard.ts`
- Modify: `app/src/lib/Toolbar.svelte`

**Interfaces:**
- Consumes: Task 1's `isLastTabInPane`; `layout.ts`'s existing `findLeafPath`/`getNodeAtPath`; `layoutState.ts`'s existing `layoutState` store (read-only) and `closeSession`/`closePane` actions (called unchanged, from the UI layer, after a confirm).
- Produces: `confirmTabClose(sessionId: string): Promise<boolean>`, `confirmPaneClose(anySessionId: string): Promise<boolean>`. Not consumed by any later task in this plan (both call sites needing them are wired up in this same task) — Task 3 doesn't touch this file.

- [ ] **Step 1: Write the failing tests**

Create `app/src/lib/confirmClose.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { LayoutNode } from "./layout";

vi.mock("@tauri-apps/plugin-dialog", () => ({
  confirm: vi.fn(),
}));

import { confirm } from "@tauri-apps/plugin-dialog";
import { layoutState } from "./layoutState";
import { confirmTabClose, confirmPaneClose } from "./confirmClose";

beforeEach(() => {
  vi.clearAllMocks();
});

function setTree(tree: LayoutNode): void {
  layoutState.set({ status: "ready", errorMessage: "", tree, focusedSessionId: null });
}

describe("confirmTabClose", () => {
  it("skips the prompt and resolves true when the tab isn't the last one in its pane", async () => {
    setTree({ type: "leaf", tabs: ["a", "b"], activeTabIndex: 0 });
    const result = await confirmTabClose("a");
    expect(result).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
  });

  it("prompts and returns the dialog's answer when the tab is the last one in its pane", async () => {
    setTree({ type: "leaf", tabs: ["a"], activeTabIndex: 0 });
    vi.mocked(confirm).mockResolvedValue(true);
    const result = await confirmTabClose("a");
    expect(result).toBe(true);
    expect(confirm).toHaveBeenCalledOnce();
    expect(vi.mocked(confirm).mock.calls[0][0]).toContain("last one in this pane");
  });

  it("propagates a decline", async () => {
    setTree({ type: "leaf", tabs: ["a"], activeTabIndex: 0 });
    vi.mocked(confirm).mockResolvedValue(false);
    expect(await confirmTabClose("a")).toBe(false);
  });
});

describe("confirmPaneClose", () => {
  it("always prompts, even for a single-tab pane, and reports the session count", async () => {
    setTree({ type: "leaf", tabs: ["a", "b", "c"], activeTabIndex: 0 });
    vi.mocked(confirm).mockResolvedValue(true);
    const result = await confirmPaneClose("b");
    expect(result).toBe(true);
    expect(vi.mocked(confirm).mock.calls[0][0]).toContain("3 terminal sessions");
  });

  it("pluralizes correctly for a single session", async () => {
    setTree({ type: "leaf", tabs: ["a"], activeTabIndex: 0 });
    vi.mocked(confirm).mockResolvedValue(true);
    await confirmPaneClose("a");
    expect(vi.mocked(confirm).mock.calls[0][0]).toContain("1 terminal session ");
  });

  it("propagates a decline", async () => {
    setTree({ type: "leaf", tabs: ["a"], activeTabIndex: 0 });
    vi.mocked(confirm).mockResolvedValue(false);
    expect(await confirmPaneClose("a")).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd app && npm test`
Expected: FAIL — `confirmClose.ts` does not exist yet.

- [ ] **Step 3: Implement `confirmClose.ts`**

Create `app/src/lib/confirmClose.ts`:

```typescript
import { confirm } from "@tauri-apps/plugin-dialog";
import { get } from "svelte/store";
import { layoutState } from "./layoutState";
import { findLeafPath, getNodeAtPath, isLastTabInPane } from "./layout";

// Prompts before closing a single tab, but only when doing so would empty
// its pane -- closing a tab that leaves siblings behind needs no prompt,
// exactly as it behaves today. Returns whether the caller should proceed
// with closeSession(sessionId).
export async function confirmTabClose(sessionId: string): Promise<boolean> {
  const state = get(layoutState);
  if (!state.tree || !isLastTabInPane(state.tree, sessionId)) return true;
  return confirm("Close this tab? It's the last one in this pane, so the pane will close too.", {
    title: "gavin",
  });
}

// Prompts before closing an entire pane -- always, since the toolbar's
// "Close Pane" button is by definition emptying a pane, regardless of how
// many tabs it holds. Returns whether the caller should proceed with
// closePane(anySessionId).
export async function confirmPaneClose(anySessionId: string): Promise<boolean> {
  const state = get(layoutState);
  if (!state.tree) return true;
  const path = findLeafPath(state.tree, anySessionId);
  if (!path) return true;
  const leaf = getNodeAtPath(state.tree, path);
  const count = leaf.type === "leaf" ? leaf.tabs.length : 0;
  return confirm(`Close this pane? ${count} terminal session${count === 1 ? "" : "s"} will end.`, {
    title: "gavin",
  });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd app && npm test`
Expected: PASS — all tests in `confirmClose.test.ts` green, plus the full
existing suite still passing.

- [ ] **Step 5: Wire `confirmTabClose` into `Pane.svelte`'s tab-close ×**

Open `app/src/lib/Pane.svelte`. Add to the imports:

```typescript
import { confirmTabClose } from "./confirmClose";
```

Replace the `<span class="close" ...>` block's `onclick` handler:

```svelte
        <span
          class="close"
          onclick={async (e) => {
            e.stopPropagation();
            if (await confirmTabClose(sessionId)) {
              closeSession(sessionId);
            }
          }}>×</span
        >
```

(The visible `×` character and everything else in the file is unchanged —
Task 3 swaps this to an icon later; this step only changes the click
behavior.)

- [ ] **Step 6: Wire `confirmTabClose` into `keyboard.ts`'s `Cmd+W`**

Open `app/src/lib/keyboard.ts`. Add to the imports:

```typescript
import { confirmTabClose } from "./confirmClose";
```

Replace the `key === "w"` branch:

```typescript
  } else if (key === "w") {
    event.preventDefault();
    event.stopPropagation();
    if (await confirmTabClose(state.focusedSessionId)) {
      await closeSession(state.focusedSessionId);
    }
  }
```

- [ ] **Step 7: Wire `confirmPaneClose` into `Toolbar.svelte`'s "Close Pane"**

Open `app/src/lib/Toolbar.svelte`. Add to the imports:

```typescript
import { confirmPaneClose } from "./confirmClose";
```

Replace `handleClosePane`:

```typescript
  async function handleClosePane(): Promise<void> {
    const id = $layoutState.focusedSessionId;
    if (!id) return;
    if (await confirmPaneClose(id)) {
      await closePane(id);
    }
  }
```

- [ ] **Step 8: Verify**

Run: `cd app && npm run check`
Expected: no type errors.

Run: `cd app && npm run build`
Expected: builds cleanly.

Run: `cd app && npm test`
Expected: full suite green (this task's new tests plus every pre-existing
test).

No automated GUI test exists for this task (per Global Constraints). Note
in your report that the dialogs actually appearing, their Yes/No behavior,
and the correct-tab-vs-correct-pane targeting are unverified pending a
human at the keyboard.

- [ ] **Step 9: Commit**

```bash
git add app/src/lib/confirmClose.ts app/src/lib/confirmClose.test.ts \
  app/src/lib/Pane.svelte app/src/lib/keyboard.ts app/src/lib/Toolbar.svelte
git commit -m "feat(app): confirm before any action that would empty a pane"
```

---

### Task 3: Icons

**Files:**
- Modify: `app/package.json` (add `lucide-svelte`)
- Modify: `app/src/lib/Toolbar.svelte`
- Modify: `app/src/lib/Pane.svelte`

**Interfaces:**
- Consumes: nothing new — this task only changes what these two already-complete components render, not their behavior (Task 2 already finished the behavior changes).
- Produces: nothing consumed by any later task in this plan — this is the last task.

- [ ] **Step 1: Add the dependency**

```bash
cd app && npm install lucide-svelte
```

- [ ] **Step 2: Confirm the exact icon import pattern and names**

Before writing any component code, check `lucide-svelte`'s actual usage
pattern for the version that just got installed — its README (in
`node_modules/lucide-svelte`) or its type definitions. This plan's code
below uses per-icon named imports (`import { Columns2 } from
"lucide-svelte";`) as its best understanding of the package, but confirm
this is correct — and confirm the exact names `Columns2`, `Rows2`, `X`,
`Plus`, `Square`, `Grid2x2` all exist with that exact casing — before
proceeding. If the installed version uses a different import style (e.g.
per-icon subpath imports) or slightly different names, use what's actually
there; this is the same "verify the real API, don't guess" discipline this
project applied to the clipboard-manager permission identifier in
Milestone C Part 2.

- [ ] **Step 3: Icons in `Toolbar.svelte`**

Open `app/src/lib/Toolbar.svelte`. Add the icon imports (adjusting per
Step 2's findings) alongside the existing imports:

```typescript
import { Columns2, Rows2, X, Square, Grid2x2 } from "lucide-svelte";
```

Replace the template's button markup (the `<script>` block is unchanged
from Task 2 — only the template and the button styles below change):

```svelte
<div class="toolbar">
  <button aria-label="Split Right" title="Split Right" onclick={() => split("row")}>
    <Columns2 size={16} />
  </button>
  <button aria-label="Split Down" title="Split Down" onclick={() => split("column")}>
    <Rows2 size={16} />
  </button>
  <button aria-label="Close Pane" title="Close Pane" onclick={handleClosePane}>
    <X size={16} />
  </button>
  <div class="presets">
    <span>Presets:</span>
    <button onclick={applySingle}><Square size={14} /> Single</button>
    <button onclick={applySideBySide}><Columns2 size={14} /> Side by Side</button>
    <button onclick={applyGrid}><Grid2x2 size={14} /> 2×2 Grid</button>
  </div>
</div>
```

Update the `.toolbar button` style rule to lay out icon+text buttons
correctly (add two properties to the existing rule, everything else in
`<style>` stays as-is):

```css
  .toolbar button {
    display: flex;
    align-items: center;
    gap: 4px;
    background: #3a3a3a;
    border: none;
    color: #ccc;
    padding: 4px 8px;
    border-radius: 3px;
    cursor: pointer;
  }
```

- [ ] **Step 4: Icons in `Pane.svelte`**

Open `app/src/lib/Pane.svelte`. Add the icon imports:

```typescript
import { X, Plus } from "lucide-svelte";
```

Replace the tab's close `<span>` and the new-tab `<button>` (everything
else in the template — the tab's own `{sessionId.slice(0, 8)}` label, the
`switchToTab`/`addTab` click handlers, the surrounding structure — is
unchanged):

```svelte
        <span
          class="close"
          onclick={async (e) => {
            e.stopPropagation();
            if (await confirmTabClose(sessionId)) {
              closeSession(sessionId);
            }
          }}
        >
          <X size={12} />
        </span>
      </button>
    {/each}
    <button class="new-tab" aria-label="New Tab" title="New Tab" onclick={() => addTab(active)}>
      <Plus size={14} />
    </button>
```

- [ ] **Step 5: Verify**

Run: `cd app && npm run check`
Expected: no new type errors (the file's existing a11y/deprecation
warnings from prior tasks are fine to leave, per this project's
established precedent — don't try to eliminate warnings unrelated to this
task).

Run: `cd app && npm run build`
Expected: builds cleanly.

Run: `cd app && npm test`
Expected: full suite still green (this task touches no tested logic).

No automated GUI test exists for this task. Note in your report that
actual icon rendering (correct icons, correct sizing, hover-title
tooltips showing) is unverified pending a human at the keyboard.

- [ ] **Step 6: Commit**

```bash
git add app/package.json app/package-lock.json app/src/lib/Toolbar.svelte app/src/lib/Pane.svelte
git commit -m "feat(app): use lucide-svelte icons on toolbar and pane action buttons"
```

## Self-Review Notes

- **Spec coverage:** every requirement in spec section 1 maps to a task —
  `isLastTabInPane` (Task 1), confirm prompts at all three pane-emptying
  call sites with the spec's exact wording (Task 2), icon swaps per the
  spec's exact icon-to-action mapping including the presets' kept text
  labels (Task 3).
- **Placeholder scan:** none — every step has complete, concrete code; the
  one genuinely uncertain detail (lucide-svelte's exact import
  syntax/names) is called out as an explicit verify-don't-assume step with
  a clear reason, not glossed over.
- **Type consistency:** `isLastTabInPane(tree, sessionId)` (Task 1) is
  called with that exact signature from `confirmClose.ts` (Task 2).
  `confirmTabClose`/`confirmPaneClose` (Task 2) are called by those exact
  names, unchanged, from all three UI call sites, and Task 3 doesn't
  rename or touch either.
