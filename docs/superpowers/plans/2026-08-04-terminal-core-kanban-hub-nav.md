# Kanban Hub Navigation Correction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the hub (Kanban now, PRD/Settings later) from a tab bar shown above every page to a pinned, icon-only entry point in the sidebar — regular pages go back to showing a bare pane-tree with no tab bar at all, exactly as before the kanban milestone started.

**Architecture:** `workspaceViews.ts` becomes a hub-only registry (drops the `"terminal"` entry). `+page.svelte`'s content area becomes a three-way split: no workspace → unchanged; `activeView === "terminal"` → `TerminalView` directly, no tab bar; anything else → the hub's own tab bar + active hub component. `Sidebar.svelte` gains one pinned, icon-only row per real workspace (skipping Unfiled) that enters the hub, and its page-row active-highlighting now also checks `activeView === "terminal"`.

**Tech Stack:** Svelte 5 (runes), TypeScript, `@lucide/svelte` (the `House` icon — verified present via `app/node_modules/@lucide/svelte/dist/icons/house.svelte`; **not** `Home`, which is only a legacy alias file not re-exported from the package's public barrel — importing `Home` from `@lucide/svelte` would fail to compile).

## Global Constraints

- This is a corrective follow-up to the already-shipped kanban board Part 2 plan (`docs/superpowers/plans/2026-08-04-terminal-core-kanban-frontend.md`, commits `7d3d556..e673271`, on `main`), not a new milestone. The Kanban board itself — `kanban.ts`, `kanbanState.ts`, `KanbanBoard`/`KanbanColumn`/`KanbanCard.svelte`, `Modal`/`CardDetailModal`/`DeleteColumnPrompt.svelte` — needs **zero** changes. This plan touches exactly three files: `app/src/lib/workspaceViews.ts`, `app/src/routes/+page.svelte`, `app/src/lib/Sidebar.svelte`.
- No backend/Rust changes. No new files (`TerminalView.svelte` already exists and needs no changes — it's imported directly now instead of via the registry).
- No dedicated automated test for this plan's changes — a static registry array and template/routing conditionals have no meaningful pure logic to unit-test, matching this project's own consistent, already-stated limitation (no Svelte component rendering/interaction tests exist anywhere in this codebase). Verification is `npm run check` (0 errors) + `npm test` (no regressions) + a manual smoke test.
- The user works directly on `main`, no git worktree — standing preference.
- Execute via `superpowers:subagent-driven-development`, this project's established process. Note for whoever executes: this session has hit the 200-subagent spawn cap five times already (each time resolved by the user choosing direct controller implementation) — don't be surprised if it happens again.
- Every commit stages only the files that specific task actually needs — never `git add -A` / `git add .`.

---

### Task 1: Hub-only registry + `+page.svelte`'s three-way routing

**Files:**
- Modify: `app/src/lib/workspaceViews.ts`
- Modify: `app/src/routes/+page.svelte`

**Interfaces:**
- Produces: `HubView` interface (`{ id, label, icon, component }`), `HUB_VIEWS: HubView[]` array (one entry: `kanban`) — replacing the old `WorkspaceView`/`WORKSPACE_VIEWS` names entirely, not adding alongside them.

- [ ] **Step 1: Rewrite `workspaceViews.ts` as a hub-only registry**

Replace the entire file with:

```ts
import type { Component } from "svelte";
import { Kanban } from "@lucide/svelte";
import KanbanBoard from "./KanbanBoard.svelte";

export interface HubView {
  id: string;
  label: string;
  icon: Component;
  component: Component<{ workspaceId: string }>;
}

export const HUB_VIEWS: HubView[] = [
  { id: "kanban", label: "Kanban", icon: Kanban, component: KanbanBoard },
];
```

This drops the `Terminal` icon import and the `TerminalView` import entirely — `+page.svelte` will import `TerminalView` directly in the next step, not through this registry.

- [ ] **Step 2: Rewrite `+page.svelte`'s imports and derived values**

Change the import line:

```ts
import { WORKSPACE_VIEWS } from "$lib/workspaceViews";
```

to:

```ts
import { HUB_VIEWS } from "$lib/workspaceViews";
import TerminalView from "$lib/TerminalView.svelte";
```

Change the `activeViewDef` derived value:

```ts
const activeViewDef = $derived(WORKSPACE_VIEWS.find((v) => v.id === activeView) ?? WORKSPACE_VIEWS[0]);
```

to:

```ts
const activeViewDef = $derived(HUB_VIEWS.find((v) => v.id === activeView) ?? HUB_VIEWS[0]);
```

(`activeView` itself, and the `getActiveWorkspace`/`getActiveView` imports it depends on, are unchanged — leave those exactly as they are.)

- [ ] **Step 3: Rewrite the content-area markup as a three-way split**

Replace this block:

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
            <activeViewDef.component workspaceId={activeWorkspace.id} />
          </div>
        </div>
      {/if}
```

with:

```svelte
      {#if !activeWorkspace}
        <div class="overlay">
          <button onclick={createFirstWorkspace}>New Workspace</button>
        </div>
      {:else if activeView === "terminal"}
        <div class="view">
          <TerminalView workspaceId={activeWorkspace.id} />
        </div>
      {:else}
        <div class="content">
          <div class="tabs">
            {#each HUB_VIEWS as view (view.id)}
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
            <activeViewDef.component workspaceId={activeWorkspace.id} />
          </div>
        </div>
      {/if}
```

The terminal branch reuses the existing `.view` CSS class directly (as a plain wrapper, no tab bar) — the exact same class already used inside `.content` for the hub case, which already correctly sizes as a flex child (`flex: 1 1 auto; min-height: 0; position: relative;`) of `.body`'s flex-row layout. No CSS changes are needed in this task — `.view`'s existing rule already covers both places it's now used.

- [ ] **Step 4: Run the frontend type checker**

Run: `npm run check` (from `app/`)
Expected: 0 errors. `WORKSPACE_VIEWS` no longer exists anywhere in this file — if you see an error referencing it, you missed an occurrence in Step 2 or 3.

- [ ] **Step 5: Run the full frontend test suite**

Run: `npm test` (from `app/`)
Expected: PASS, no regressions (this task has no new automated tests — see Global Constraints).

- [ ] **Step 6: Commit**

```bash
git add app/src/lib/workspaceViews.ts app/src/routes/+page.svelte
git commit -m "fix(app): move the hub out of a tab bar shown above every page"
```

---

### Task 2: Sidebar's pinned hub-entry row

**Files:**
- Modify: `app/src/lib/Sidebar.svelte`

**Interfaces:**
- Consumes: `HUB_VIEWS` (Task 1), `getActiveView` (already exported by `workspace.ts`, not yet imported in this file), `switchWorkspaceView` (already exported by `layoutState.ts`, already imported in this file from prior work).

- [ ] **Step 1: Add the new imports**

Add `HUB_VIEWS` and `House`:

```ts
import { HUB_VIEWS } from "./workspaceViews";
```

Add `House` to the existing `@lucide/svelte` import line:

```ts
import { ChevronRight, ChevronDown, Plus, X } from "@lucide/svelte";
```

becomes:

```ts
import { ChevronRight, ChevronDown, Plus, X, House } from "@lucide/svelte";
```

Add `getActiveView` to the existing `./workspace` import line:

```ts
import { UNFILED_WORKSPACE_ID, summarizePageGitStatus, type Workspace, type Page, type GitStatus } from "./workspace";
```

becomes:

```ts
import { UNFILED_WORKSPACE_ID, summarizePageGitStatus, getActiveView, type Workspace, type Page, type GitStatus } from "./workspace";
```

- [ ] **Step 2: Add a `showHomeRow` parameter to the `pageList` snippet, and render the pinned row**

Change the snippet's own signature and opening:

```svelte
{#snippet pageList(ws: Workspace)}
  <div class="page-list">
    {#each ws.pages as page, pageIndex (page.id)}
```

to:

```svelte
{#snippet pageList(ws: Workspace, showHomeRow: boolean)}
  <div class="page-list">
    {#if showHomeRow}
      <div
        class="page-row home"
        class:active={ws.id === $layoutState.activeWorkspaceId && getActiveView(ws) !== "terminal"}
        onclick={() => switchWorkspaceView(ws.id, HUB_VIEWS[0].id)}
        role="button"
        tabindex="0"
        title="Hub"
      >
        <House size={14} />
      </div>
    {/if}
    {#each ws.pages as page, pageIndex (page.id)}
```

- [ ] **Step 3: Update the page-row active-highlighting condition**

Find:

```svelte
          class:active={ws.id === $layoutState.activeWorkspaceId && page.id === ws.activePageId}
```

(this is inside the `pageList` snippet's own `{#each ws.pages...}` loop, on the `.page-row` div — there is exactly one occurrence, since `pageList` is a single shared snippet used by both call sites). Change it to:

```svelte
          class:active={ws.id === $layoutState.activeWorkspaceId && page.id === ws.activePageId && getActiveView(ws) === "terminal"}
```

- [ ] **Step 4: Update both call sites of `pageList`**

There are two call sites, both `{@render pageList(ws)}` — one inside the Unfiled workspace's rendering block, one inside the `{#each regularWorkspaces as ws}` block. Change the Unfiled one (it must never get the home row) to:

```svelte
{@render pageList(ws, false)}
```

and the regular-workspaces one to:

```svelte
{@render pageList(ws, true)}
```

- [ ] **Step 5: Add the `.page-row.home` CSS rule**

The pinned row reuses `.page-row`'s existing base styling (padding, cursor, hover) and `.page-row.active`'s existing active-state styling automatically, since it uses the same `page-row` class. Add one rule to center the icon (it has no text, unlike every other `.page-row`), right after the existing `.page-row.active` rule:

```css
  .page-row.active {
    background: #1e1e1e;
    color: #fff;
  }
  .page-row.home {
    justify-content: center;
    color: #999;
  }
  .page-row.home.active {
    color: #eee;
  }
```

- [ ] **Step 6: Run the frontend type checker**

Run: `npm run check` (from `app/`)
Expected: 0 errors.

- [ ] **Step 7: Run the full frontend test suite**

Run: `npm test` (from `app/`)
Expected: PASS, no regressions.

- [ ] **Step 8: Commit**

```bash
git add app/src/lib/Sidebar.svelte
git commit -m "feat(app): add the pinned sidebar row that enters the hub"
```

---

## Manual smoke test (not automated — flag explicitly when this plan is done)

Launch the app: confirm every real workspace (not Unfiled) shows a pinned, icon-only, unnamed row above its page list. Confirm Unfiled has no such row. Click the pinned row: confirm the Kanban hub appears, with a small tab bar showing only "Kanban" (no "Terminal" entry anywhere). Click a regular page afterward: confirm it shows a bare pane-tree immediately, with no tab bar visible at all — exactly like before this whole kanban milestone. Click the pinned row again while a different page was active: confirm it correctly re-enters the hub. Confirm the pinned row highlights as active while the hub is showing, and a page row highlights as active only while that page's plain terminal view is showing (never both at once).
