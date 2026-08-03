# Git Status Detection — Frontend (Part 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface the git status data the daemon already emits (`Response::GitStatusChanged`, relayed as the `"git-status-changed"` Tauri event — both shipped in Part 1) in the frontend: a compact per-tab dirty/clean dot, and a sidebar page row that shows one repo's status directly or expands into per-session rows when a page spans multiple repos.

**Architecture:** A new `gitStatusById: Record<string, GitStatus | null>` map in `layoutState.ts`, populated by a `"git-status-changed"` listener exactly mirroring the existing `"session-status-changed"`/`sessionStatusById` pattern. A new pure `summarizePageGitStatus` function in `workspace.ts` (alongside the other `Page`-consuming pure functions already there) implements the spec's zero/one/multiple-distinct-repos branching rule, independently tested rather than living inline in a component. `Pane.svelte` renders a small dot per tab; `Sidebar.svelte` renders the page-row summary and, when a page spans multiple repos, a new expandable per-session detail list — a genuine third level of sidebar hierarchy (workspace → page → session) that only appears when it's actually needed.

**Tech Stack:** Svelte 5 (runes), TypeScript, Vitest. No new dependencies — this plan adds zero Rust/Tauri code; the daemon protocol event and its Tauri relay already shipped in Part 1 (`docs/superpowers/plans/2026-08-03-terminal-core-git-status-backend.md`).

## Global Constraints

- `GitStatus`'s wire shape (already shipped, Rust side) is camelCase: `repoRoot`, `branch`, `dirty`, `ahead`, `behind`, `hasUpstream`. The TypeScript type in this plan must match those field names exactly — no translation layer.
- `repoRoot` is what identifies a repo for grouping purposes, never `branch` — two unrelated repos can coincidentally share a branch name like `main`.
- `ahead`/`behind` are only meaningful, and must only be displayed, when `hasUpstream` is `true`.
- `Pane.svelte`'s tab dot: filled when `dirty`, hollow (outlined, not filled) when clean, absent entirely when the session has no git repo (`gitStatusById[id]` is `null` or not yet present). No branch name, no ahead/behind numbers, no tooltip elaboration on the tab itself — that detail lives entirely in the sidebar.
- `Sidebar.svelte` page row: zero distinct repos among the page's sessions → no git indicator on the row at all. Exactly one distinct repo → that repo's branch, dirty indicator, and ahead/behind shown directly on the row, no expansion. Two or more distinct repos → an expand toggle appears; expanding reveals one row per **session** in the page (not one row per repo), each showing that session's own label plus its own branch/dirty/ahead-behind, clickable to switch to that specific session.
- Workspace row: no git indicator at any level above the page row, ever — richer per-repo detail doesn't aggregate meaningfully into a single "this workspace" signal.
- The repo-root grouping logic (zero/one/multiple distinct repos per page) is real business logic and must be a pure, independently-tested function — not inline template logic, unlike this project's earlier UI-only milestones that had no branching logic of their own.
- `gitStatusById` entries are never cleaned up on session exit, matching `cwdBySessionId`/`sessionStatusById`'s existing convention — a stale in-memory entry for a session that closed is harmless.
- Git status changes never trigger OS notifications (unlike session status) — this plan adds no `notifications.ts` changes and no new notification call sites.
- GUI-only caveat, same as every prior milestone: actual dot rendering, sidebar expand/collapse interaction, and real git output display need manual verification in the running app — there is no synthetic input/rendering observation available in the automated verification environment.

---

### Task 1: `GitStatus` type + `summarizePageGitStatus` pure function

**Files:**
- Modify: `app/src/lib/workspace.ts`
- Test: `app/src/lib/workspace.test.ts`

**Interfaces:**
- Produces: `GitStatus` interface, `PageGitSummary` type, `summarizePageGitStatus(page: Page, gitStatusById: Record<string, GitStatus | null>): PageGitSummary` — consumed by Task 2 (`layoutState.ts`'s `gitStatusById` map is typed `Record<string, GitStatus | null>`) and Tasks 4-5 (`Sidebar.svelte` calls `summarizePageGitStatus` per page).

- [ ] **Step 1: Write the failing tests**

Add to `app/src/lib/workspace.test.ts`, importing the new names alongside the existing ones (extend the existing `import { ... } from "./workspace";` block with `summarizePageGitStatus`, `type GitStatus`, `type PageGitSummary`), and add this helper near the existing `leaf`/`empty` helpers at the top of the file:

```ts
function page(id: string, layout: LayoutNode): Page {
  return { id, name: id, layout, focusedSessionId: null };
}

function gitStatus(repoRoot: string, overrides: Partial<GitStatus> = {}): GitStatus {
  return { repoRoot, branch: "main", dirty: false, ahead: 0, behind: 0, hasUpstream: false, ...overrides };
}
```

Then add this test block (anywhere after the existing `describe` blocks):

```ts
describe("summarizePageGitStatus", () => {
  it("returns none when no session in the page has a git repo (empty map)", () => {
    const p = page("p1", leaf(["a", "b"]));
    expect(summarizePageGitStatus(p, {})).toEqual({ kind: "none" });
  });

  it("returns none when every session's status is explicitly null", () => {
    const p = page("p1", leaf(["a", "b"]));
    expect(summarizePageGitStatus(p, { a: null, b: null })).toEqual({ kind: "none" });
  });

  it("returns single when every session with a repo shares the same repoRoot", () => {
    const p = page("p1", leaf(["a", "b"]));
    const status = gitStatus("/repo");
    expect(summarizePageGitStatus(p, { a: status, b: status })).toEqual({ kind: "single", status });
  });

  it("returns single when only some sessions have a repo, and the rest are null or missing", () => {
    const p = page("p1", leaf(["a", "b", "c"]));
    const status = gitStatus("/repo");
    expect(summarizePageGitStatus(p, { a: status, b: null })).toEqual({ kind: "single", status });
  });

  it("returns multiple with the correct distinct repo count when sessions span different repos", () => {
    const p = page("p1", leaf(["a", "b", "c"]));
    const result = summarizePageGitStatus(p, {
      a: gitStatus("/repo-a"),
      b: gitStatus("/repo-b"),
      c: gitStatus("/repo-a"),
    });
    expect(result).toEqual({ kind: "multiple", repoCount: 2 });
  });

  it("ignores sessions not present in the page's own layout", () => {
    const p = page("p1", leaf(["a"]));
    const result = summarizePageGitStatus(p, { a: gitStatus("/repo-a"), stranger: gitStatus("/repo-b") });
    expect(result).toEqual({ kind: "single", status: gitStatus("/repo-a") });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/coalpila/CloudStation/Coding/gavin/app && npm test -- workspace.test.ts`
Expected: FAIL — `summarizePageGitStatus`/`GitStatus`/`PageGitSummary` are not exported from `./workspace`.

- [ ] **Step 3: Implement in `workspace.ts`**

Add this at the end of `app/src/lib/workspace.ts`, after the existing `allSessionIdsInWorkspace` function:

```ts
// A single session's git status, mirroring crates/protocol's GitStatus
// wire shape exactly (camelCase, per its own #[serde(rename_all =
// "camelCase")]). repoRoot identifies the repo by canonical filesystem
// path, not by branch name -- two unrelated repos could coincidentally
// both be on a branch called "main".
export interface GitStatus {
  repoRoot: string;
  branch: string;
  dirty: boolean;
  ahead: number;
  behind: number;
  hasUpstream: boolean;
}

// The sidebar's own three-way branching rule for a page's git status, per
// the design spec: zero distinct repos among the page's sessions means no
// indicator at all; exactly one means that repo's status is shown
// directly on the page row; two or more means an expand toggle instead of
// picking one arbitrary repo to show. Sidebar.svelte renders one row per
// SESSION when expanded (not one row per repo), so this type only needs
// to carry the repo count for that branch, not a full per-repo breakdown.
export type PageGitSummary =
  | { kind: "none" }
  | { kind: "single"; status: GitStatus }
  | { kind: "multiple"; repoCount: number };

// Groups a page's sessions' git statuses by repoRoot. Sessions with no
// git repo (a null or entirely missing gitStatusById entry) are ignored,
// not counted as a distinct "no repo" group of their own. Real business
// logic, not template rendering -- extracted here so it's independently
// testable rather than living inline in Sidebar.svelte, per this
// milestone's own testing note (unlike the previous milestone's UI-only
// tasks, which had no branching logic of their own to test).
export function summarizePageGitStatus(
  page: Page,
  gitStatusById: Record<string, GitStatus | null>
): PageGitSummary {
  const byRepoRoot = new Map<string, GitStatus>();
  for (const id of allSessionIds(page.layout)) {
    const status = gitStatusById[id];
    if (status) byRepoRoot.set(status.repoRoot, status);
  }
  if (byRepoRoot.size === 0) return { kind: "none" };
  if (byRepoRoot.size === 1) return { kind: "single", status: [...byRepoRoot.values()][0] };
  return { kind: "multiple", repoCount: byRepoRoot.size };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/coalpila/CloudStation/Coding/gavin/app && npm test -- workspace.test.ts`
Expected: PASS — all existing `workspace.test.ts` tests plus the 6 new ones.

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/workspace.ts app/src/lib/workspace.test.ts
git commit -m "feat(app): add GitStatus type and the page-level repo-grouping pure function"
```

---

### Task 2: `gitStatusById` map + event wiring in `layoutState.ts`

**Files:**
- Modify: `app/src/lib/layoutState.ts`
- Test: `app/src/lib/layoutState.test.ts`

**Interfaces:**
- Consumes: `GitStatus` (Task 1, imported from `./workspace`).
- Produces: `LayoutState.gitStatusById: Record<string, GitStatus | null>`, `handleGitStatusChanged(sessionId: string, status: GitStatus | null): void` — consumed by Task 3 (`Pane.svelte` reads `$layoutState.gitStatusById`) and Tasks 4-5 (`Sidebar.svelte` reads it, passes it to `summarizePageGitStatus`).

- [ ] **Step 1: Write the failing tests**

In `app/src/lib/layoutState.test.ts`, add `handleGitStatusChanged` to the existing `import { ... } from "./layoutState";` block, add `gitStatusById: {},` to both existing `layoutState.set({...})` object literals in `beforeEach` and in the `setState` helper (mirroring the existing `sessionStatusById: {},` line right above the closing brace in each), and add this test block after the existing `describe("handleSessionStatusChanged", ...)` block:

```ts
describe("handleGitStatusChanged", () => {
  it("sets a session's git status", () => {
    const status = { repoRoot: "/repo", branch: "main", dirty: true, ahead: 0, behind: 0, hasUpstream: false };
    handleGitStatusChanged("a", status);
    expect(get(layoutState).gitStatusById["a"]).toEqual(status);
  });

  it("overwrites a session's previous git status", () => {
    const dirty = { repoRoot: "/repo", branch: "main", dirty: true, ahead: 0, behind: 0, hasUpstream: false };
    const clean = { ...dirty, dirty: false };
    handleGitStatusChanged("a", dirty);
    handleGitStatusChanged("a", clean);
    expect(get(layoutState).gitStatusById["a"]).toEqual(clean);
  });

  it("can be set to null (the session left its repo, or never had one)", () => {
    const status = { repoRoot: "/repo", branch: "main", dirty: true, ahead: 0, behind: 0, hasUpstream: false };
    handleGitStatusChanged("a", status);
    handleGitStatusChanged("a", null);
    expect(get(layoutState).gitStatusById["a"]).toBeNull();
  });

  it("tracks independent sessions independently", () => {
    const statusA = { repoRoot: "/repo-a", branch: "main", dirty: false, ahead: 0, behind: 0, hasUpstream: false };
    const statusB = { repoRoot: "/repo-b", branch: "dev", dirty: true, ahead: 1, behind: 0, hasUpstream: true };
    handleGitStatusChanged("a", statusA);
    handleGitStatusChanged("b", statusB);
    expect(get(layoutState).gitStatusById).toEqual({ a: statusA, b: statusB });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/coalpila/CloudStation/Coding/gavin/app && npm test -- layoutState.test.ts`
Expected: FAIL — `handleGitStatusChanged` is not exported from `./layoutState`, and/or `gitStatusById` is missing from the state object literals (a TypeScript error on the test file itself, surfaced as a test run failure).

- [ ] **Step 3: Implement in `layoutState.ts`**

Add the import (extend the existing `import { sessionLabel } from "./paths";` line's neighborhood — add a new line right after it):

```ts
import type { GitStatus } from "./workspace";
```

Add `gitStatusById` to the `LayoutState` interface, right after `sessionStatusById: Record<string, SessionStatus>;`:

```ts
  gitStatusById: Record<string, GitStatus | null>;
```

Add `gitStatusById: {},` to `initialState`, right after `sessionStatusById: {},`:

```ts
  gitStatusById: {},
```

Add the listener registration inside `bootstrap()`, right after the existing `"session-status-changed"` listener block:

```ts
  unlisteners.push(
    await listen<[string, GitStatus | null]>("git-status-changed", (event) => {
      handleGitStatusChanged(event.payload[0], event.payload[1]);
    })
  );
```

Add the handler function itself, right after `handleSessionStatusChanged`:

```ts
// Shared by the "git-status-changed" event listener in bootstrap() and
// this file's own tests. Unlike handleSessionStatusChanged, there is no
// previous-value read and no notification side effect -- git status
// changes are frequent (every fs-watch trigger, every OSC-133 idle
// prompt) and were never in scope for OS notifications, only the in-app
// dot/sidebar display. Like handleCwdChanged/handleSessionStatusChanged,
// entries are never removed on session exit.
export function handleGitStatusChanged(sessionId: string, status: GitStatus | null): void {
  layoutState.update((s) => ({ ...s, gitStatusById: { ...s.gitStatusById, [sessionId]: status } }));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/coalpila/CloudStation/Coding/gavin/app && npm test -- layoutState.test.ts`
Expected: PASS — all existing `layoutState.test.ts` tests plus the 4 new ones.

- [ ] **Step 5: Run the full frontend test suite and type-check**

Run: `cd /Users/coalpila/CloudStation/Coding/gavin/app && npm test && npm run check`
Expected: PASS — no regressions in any other test file, no new TypeScript errors.

- [ ] **Step 6: Commit**

```bash
git add app/src/lib/layoutState.ts app/src/lib/layoutState.test.ts
git commit -m "feat(app): wire gitStatusById and the git-status-changed listener into layoutState"
```

---

### Task 3: `Pane.svelte` tab git-status dot

**Files:**
- Modify: `app/src/lib/Pane.svelte`

**Interfaces:**
- Consumes: `$layoutState.gitStatusById` (Task 2).

- [ ] **Step 1: Add the `tabGitDot` helper**

In `app/src/lib/Pane.svelte`'s `<script>` block, add this function right after the existing `tabStatusDot`:

```ts
  // Filled when dirty, hollow (outlined) when clean, absent entirely when
  // this session has no git repo -- no branch name, no ahead/behind, and
  // no tooltip here; that detail lives entirely in the sidebar (see this
  // plan's Global Constraints).
  function tabGitDot(sessionId: string): { dirty: boolean } | null {
    const status = $layoutState.gitStatusById[sessionId];
    if (!status) return null;
    return { dirty: status.dirty };
  }
```

- [ ] **Step 2: Render it in the tab markup**

Find this block inside the `{#each leaf.tabs as sessionId, tabIndex (sessionId)}` loop:

```svelte
        {#if tabStatusDot(sessionId)}
          {@const dot = tabStatusDot(sessionId)}
          <span class="status-dot {dot?.class}" title={dot?.title}></span>
        {/if}
```

Replace with (adding the git dot immediately after, inside the same conditional structure):

```svelte
        {#if tabStatusDot(sessionId)}
          {@const dot = tabStatusDot(sessionId)}
          <span class="status-dot {dot?.class}" title={dot?.title}></span>
        {/if}
        {#if tabGitDot(sessionId)}
          {@const gitDot = tabGitDot(sessionId)}
          <span
            class="git-dot"
            class:dirty={gitDot?.dirty}
            class:clean={!gitDot?.dirty}
            title={gitDot?.dirty ? "Uncommitted changes" : "Clean"}
          ></span>
        {/if}
```

- [ ] **Step 3: Add the CSS**

Add this to the `<style>` block, right after the existing `.status-dot.status-waiting` rule:

```css
  .git-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    flex: 0 0 auto;
    box-sizing: border-box;
  }
  .git-dot.dirty {
    background: #d9a648;
  }
  .git-dot.clean {
    background: transparent;
    border: 1px solid #d9a648;
  }
```

- [ ] **Step 4: Type-check and run the full frontend test suite**

Run: `cd /Users/coalpila/CloudStation/Coding/gavin/app && npm run check && npm test`
Expected: PASS — `Pane.svelte` has no dedicated test file (pure rendering, mirroring this project's established precedent that UI-only tasks with no branching logic of their own have no dedicated tests), so this step just confirms no regressions and no type errors.

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/Pane.svelte
git commit -m "feat(app): render a per-tab git dirty/clean dot in Pane.svelte"
```

---

### Task 4: `Sidebar.svelte` page-row single/none git status display

**Files:**
- Modify: `app/src/lib/Sidebar.svelte`

**Interfaces:**
- Consumes: `summarizePageGitStatus` (Task 1), `$layoutState.gitStatusById` (Task 2).

- [ ] **Step 1: Import `summarizePageGitStatus` and add the display helpers**

In `app/src/lib/Sidebar.svelte`'s `<script>` block, extend the existing `import { UNFILED_WORKSPACE_ID, type Workspace, type Page } from "./workspace";` line to also import `summarizePageGitStatus` and `type GitStatus`:

```ts
  import { UNFILED_WORKSPACE_ID, summarizePageGitStatus, type Workspace, type Page, type GitStatus } from "./workspace";
```

Add this function right after the existing `workspaceWaitingForInputCount`:

```ts
  function pageGitSummary(page: Page) {
    return summarizePageGitStatus(page, $layoutState.gitStatusById);
  }

  // ahead/behind are only meaningful (and only shown) when hasUpstream is
  // true, and only the non-zero side(s) are shown -- "main" alone when
  // fully up to date with its upstream, "main ↑2" when only ahead,
  // "main ↑2 ↓1" when diverged. Not extracted to workspace.ts: this is
  // presentational string formatting, not branching business logic (see
  // this plan's Global Constraints on what needed its own pure-function
  // test), matching this file's existing local-helper precedent
  // (waitingForInputCount and friends are template-local too).
  function formatAheadBehind(status: GitStatus): string {
    if (!status.hasUpstream) return "";
    const parts: string[] = [];
    if (status.ahead > 0) parts.push(`↑${status.ahead}`);
    if (status.behind > 0) parts.push(`↓${status.behind}`);
    return parts.join(" ");
  }
```

- [ ] **Step 2: Render the single/none cases in the page row**

In `app/src/lib/Sidebar.svelte`, inside the `{#snippet pageList(ws: Workspace)}` snippet, find this complete block (the `{#each ws.pages as page, pageIndex (page.id)}` loop body):

```svelte
    {#each ws.pages as page, pageIndex (page.id)}
      <div
        class="page-row"
        class:active={ws.id === $layoutState.activeWorkspaceId && page.id === ws.activePageId}
        class:drop-before={hoverState?.targetId === page.id &&
          hoverState.kind === "reorder" &&
          hoverState.position === "before"}
        class:drop-after={hoverState?.targetId === page.id &&
          hoverState.kind === "reorder" &&
          hoverState.position === "after"}
        class:drop-zone-left={hoverState?.targetId === page.id && hoverState.kind === "zone" && hoverState.zone === "left"}
        class:drop-zone-right={hoverState?.targetId === page.id && hoverState.kind === "zone" && hoverState.zone === "right"}
        class:drop-zone-top={hoverState?.targetId === page.id && hoverState.kind === "zone" && hoverState.zone === "top"}
        class:drop-zone-bottom={hoverState?.targetId === page.id && hoverState.kind === "zone" && hoverState.zone === "bottom"}
        class:drop-zone-center={hoverState?.targetId === page.id && hoverState.kind === "zone" && hoverState.zone === "center"}
        draggable={editingPageId !== page.id}
        ondragstart={(e) => handlePageDragStart(e, ws.id, page.id)}
        ondragover={(e) => handlePageDragOver(e, page.id)}
        ondragleave={clearHover}
        ondragend={clearHover}
        ondrop={(e) => handlePageDrop(e, ws, page, pageIndex)}
      >
        {#if editingPageId === page.id}
          <input
            class="page-name-input"
            bind:this={pageEditInput}
            bind:value={pageEditValue}
            onclick={(e) => e.stopPropagation()}
            onblur={commitPageEdit}
            onkeydown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commitPageEdit();
              } else if (e.key === "Escape") {
                e.preventDefault();
                cancelPageEdit();
              }
            }}
          />
        {:else}
          <span
            class="page-name"
            ondblclick={() => startEditingPage(page.id, page.name)}
            onclick={() => switchPage(ws.id, page.id)}
          >{page.name}</span>
        {/if}
        {#if waitingForInputCount(page) > 0}
          <span class="waiting-badge">{waitingForInputCount(page)}</span>
        {/if}
        <button
          class="close-page"
          aria-label="Close Page"
          title="Close Page"
          onclick={async () => {
            if (await confirmPageClose(ws.id, page.id)) {
              void closePage(ws.id, page.id);
            }
          }}
        >
          <X size={10} />
        </button>
      </div>
    {/each}
  </div>
{/snippet}
```

Replace it with (adding a `{@const gitSummary = pageGitSummary(page)}` line and the single-repo display block; everything else in this block is byte-for-byte unchanged):

```svelte
    {#each ws.pages as page, pageIndex (page.id)}
      {@const gitSummary = pageGitSummary(page)}
      <div
        class="page-row"
        class:active={ws.id === $layoutState.activeWorkspaceId && page.id === ws.activePageId}
        class:drop-before={hoverState?.targetId === page.id &&
          hoverState.kind === "reorder" &&
          hoverState.position === "before"}
        class:drop-after={hoverState?.targetId === page.id &&
          hoverState.kind === "reorder" &&
          hoverState.position === "after"}
        class:drop-zone-left={hoverState?.targetId === page.id && hoverState.kind === "zone" && hoverState.zone === "left"}
        class:drop-zone-right={hoverState?.targetId === page.id && hoverState.kind === "zone" && hoverState.zone === "right"}
        class:drop-zone-top={hoverState?.targetId === page.id && hoverState.kind === "zone" && hoverState.zone === "top"}
        class:drop-zone-bottom={hoverState?.targetId === page.id && hoverState.kind === "zone" && hoverState.zone === "bottom"}
        class:drop-zone-center={hoverState?.targetId === page.id && hoverState.kind === "zone" && hoverState.zone === "center"}
        draggable={editingPageId !== page.id}
        ondragstart={(e) => handlePageDragStart(e, ws.id, page.id)}
        ondragover={(e) => handlePageDragOver(e, page.id)}
        ondragleave={clearHover}
        ondragend={clearHover}
        ondrop={(e) => handlePageDrop(e, ws, page, pageIndex)}
      >
        {#if editingPageId === page.id}
          <input
            class="page-name-input"
            bind:this={pageEditInput}
            bind:value={pageEditValue}
            onclick={(e) => e.stopPropagation()}
            onblur={commitPageEdit}
            onkeydown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commitPageEdit();
              } else if (e.key === "Escape") {
                e.preventDefault();
                cancelPageEdit();
              }
            }}
          />
        {:else}
          <span
            class="page-name"
            ondblclick={() => startEditingPage(page.id, page.name)}
            onclick={() => switchPage(ws.id, page.id)}
          >{page.name}</span>
        {/if}
        {#if gitSummary.kind === "single"}
          <span class="git-branch">{gitSummary.status.branch}</span>
          <span
            class="git-dot"
            class:dirty={gitSummary.status.dirty}
            class:clean={!gitSummary.status.dirty}
          ></span>
          {#if formatAheadBehind(gitSummary.status)}
            <span class="git-ahead-behind">{formatAheadBehind(gitSummary.status)}</span>
          {/if}
        {/if}
        {#if waitingForInputCount(page) > 0}
          <span class="waiting-badge">{waitingForInputCount(page)}</span>
        {/if}
        <button
          class="close-page"
          aria-label="Close Page"
          title="Close Page"
          onclick={async () => {
            if (await confirmPageClose(ws.id, page.id)) {
              void closePage(ws.id, page.id);
            }
          }}
        >
          <X size={10} />
        </button>
      </div>
    {/each}
  </div>
{/snippet}
```

(`{kind: "none"}` and `{kind: "multiple"}` intentionally render nothing from this block — `"none"` per the spec's own rule, `"multiple"` is Task 5's job.)

- [ ] **Step 3: Add the CSS**

Add this to the `<style>` block, right after the existing `.waiting-badge` rule:

```css
  .git-branch {
    flex: 0 0 auto;
    max-width: 80px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: #999;
  }
  .git-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    flex: 0 0 auto;
    box-sizing: border-box;
  }
  .git-dot.dirty {
    background: #d9a648;
  }
  .git-dot.clean {
    background: transparent;
    border: 1px solid #d9a648;
  }
  .git-ahead-behind {
    flex: 0 0 auto;
    color: #999;
    font-size: 0.9em;
  }
```

- [ ] **Step 4: Type-check and run the full frontend test suite**

Run: `cd /Users/coalpila/CloudStation/Coding/gavin/app && npm run check && npm test`
Expected: PASS — no dedicated test for this step (pure rendering wired to Task 1's already-tested pure function), no regressions, no type errors.

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/Sidebar.svelte
git commit -m "feat(app): show a page's single-repo git status on its sidebar row"
```

---

### Task 5: `Sidebar.svelte` multi-repo expand-to-session-rows

**Files:**
- Modify: `app/src/lib/Sidebar.svelte`
- Modify: `app/src/lib/layoutState.ts`
- Test: `app/src/lib/layoutState.test.ts`

**Interfaces:**
- Consumes: `pageGitSummary`/`formatAheadBehind` (Task 4), `summarizePageGitStatus`'s `{kind: "multiple"}` variant (Task 1), `sessionLabel` (existing, `./paths`).
- Produces: `switchToSessionInPage(workspaceId: string, pageId: string, sessionId: string): Promise<void>` in `layoutState.ts`.

This is the genuine new third level of sidebar hierarchy (workspace → page → session) the design spec calls for — it only appears when a page's sessions actually span 2+ distinct repos, so the common single-repo (or no-repo) case, already handled by Task 4, never grows this affordance.

- [ ] **Step 1: Write the failing test for `switchToSessionInPage`**

In `app/src/lib/layoutState.test.ts`, add `switchToSessionInPage` to the existing `import { ... } from "./layoutState";` block, and add this test block immediately after the existing `describe("switchToTab", () => { ... });` block:

```ts
describe("switchToSessionInPage", () => {
  it("switches workspace and page, and makes the target session the active tab and focus", async () => {
    const treeA = leaf(["a1", "a2"]);
    const treeB = leaf(["b1"]);
    setState(
      [ws("ws-1", [page("page-a", treeA), page("page-b", treeB)], "page-a")],
      "ws-1",
      "a1"
    );
    await switchToSessionInPage("ws-1", "page-a", "a2");
    const state = get(layoutState);
    expect(state.activeWorkspaceId).toBe("ws-1");
    expect(state.focusedSessionId).toBe("a2");
    const pageA = state.workspaces[0].pages.find((p) => p.id === "page-a");
    expect(pageA?.layout).toEqual(leaf(["a1", "a2"], 1));
    expect(pageA?.focusedSessionId).toBe("a2");
  });

  it("switches to a different page's own tab when the target session lives there", async () => {
    const treeA = leaf(["a1"]);
    const treeB = leaf(["b1", "b2"]);
    setState(
      [ws("ws-1", [page("page-a", treeA), page("page-b", treeB)], "page-a")],
      "ws-1",
      "a1"
    );
    await switchToSessionInPage("ws-1", "page-b", "b2");
    const state = get(layoutState);
    const wsAfter = state.workspaces[0];
    expect(wsAfter.activePageId).toBe("page-b");
    expect(state.focusedSessionId).toBe("b2");
  });

  it("does nothing when the page doesn't exist", async () => {
    setState([ws("ws-1", [page("page-a", leaf(["a1"]))], "page-a")], "ws-1", "a1");
    await switchToSessionInPage("ws-1", "no-such-page", "a1");
    expect(get(layoutState).focusedSessionId).toBe("a1");
  });

  it("persists the updated workspaces state", async () => {
    setState([ws("ws-1", [page("page-a", leaf(["a1", "a2"]))], "page-a")], "ws-1", "a1");
    await switchToSessionInPage("ws-1", "page-a", "a2");
    expect(backend.setWorkspacesState).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/coalpila/CloudStation/Coding/gavin/app && npm test -- layoutState.test.ts`
Expected: FAIL — `switchToSessionInPage` is not exported from `./layoutState`.

- [ ] **Step 3: Implement `switchToSessionInPage` in `layoutState.ts`**

Add this function after `switchToTab`:

```ts
// Makes sessionId's own page (and workspace) active, and that session
// itself the active tab within its pane AND the page's remembered focus
// -- unlike switchPage alone (which falls back to the page's own
// last-remembered focus, or its first session, not necessarily the one
// that was actually clicked). Used by the sidebar's expanded multi-repo
// session rows (Sidebar.svelte), where each row targets one specific
// session that may not already be its page's active tab, and that page
// may not even be the currently active one.
export async function switchToSessionInPage(workspaceId: string, pageId: string, sessionId: string): Promise<void> {
  const state = get(layoutState);
  const page = state.workspaces.find((w) => w.id === workspaceId)?.pages.find((p) => p.id === pageId);
  if (!page) return;
  const newTree = layout.switchTab(page.layout, sessionId);
  const withTree = workspace.updatePageLayout(state, workspaceId, pageId, newTree);
  const withFocus = workspace.setPageFocus(withTree, workspaceId, pageId, sessionId);
  const switchedPage = workspace.switchPage(withFocus, workspaceId, pageId);
  const switched = workspace.switchWorkspace(switchedPage, workspaceId);
  const resolved = workspace.resolveActiveFocus(switched);
  layoutState.update((s) => ({
    ...s,
    workspaces: resolved.state.workspaces,
    activeWorkspaceId: resolved.state.activeWorkspaceId,
    focusedSessionId: resolved.focusedSessionId,
  }));
  await persistWorkspaces(resolved.state.workspaces, resolved.state.activeWorkspaceId);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/coalpila/CloudStation/Coding/gavin/app && npm test -- layoutState.test.ts`
Expected: PASS — all existing tests plus the 4 new ones.

- [ ] **Step 5: Add page-level expand state and imports to `Sidebar.svelte`**

In `app/src/lib/Sidebar.svelte`'s `<script>` block, add this right after the existing `let expanded: Set<string> = $state(new Set());` line (a separate Set, deliberately — workspace-row expand state and page-level git-detail expand state are unrelated concepts that happen to both key on string ids, and keeping them in separate Sets avoids any confusion about what a given id in a given Set actually means):

```ts
  // Tracks which pages currently have their multi-repo git detail
  // expanded -- unrelated to `expanded` above (that Set tracks which
  // WORKSPACES show their page list; this one tracks which PAGES show
  // their per-session git detail). Kept separate rather than reusing one
  // Set, since workspace ids and page ids are different concepts that
  // happen to both be strings.
  let expandedPagesGit: Set<string> = $state(new Set());

  function isPageGitExpanded(pageId: string): boolean {
    return expandedPagesGit.has(pageId);
  }

  function togglePageGitExpand(pageId: string): void {
    const next = new Set(expandedPagesGit);
    if (next.has(pageId)) {
      next.delete(pageId);
    } else {
      next.add(pageId);
    }
    expandedPagesGit = next;
  }
```

Then update the imports at the top of the `<script>` block. Find this complete block (as it stands after Task 4's own import change):

```ts
  import {
    layoutState,
    switchWorkspace,
    switchPage,
    createWorkspace,
    renameWorkspace,
    createPage,
    renamePage,
    closeWorkspace,
    closePage,
  } from "./layoutState";
  import { confirmWorkspaceClose, confirmPageClose } from "./confirmClose";
  import { presetSingle, allSessionIds } from "./layout";
  import { ChevronRight, ChevronDown, Plus, X } from "@lucide/svelte";
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
  import { UNFILED_WORKSPACE_ID, summarizePageGitStatus, type Workspace, type Page, type GitStatus } from "./workspace";
```

Replace it with (adding a new `sessionLabel` import line, and adding `switchToSessionInPage` to the existing `movePaneOrTab`/`reorderWorkspaceAction`/`movePageAction` import — everything else is unchanged):

```ts
  import {
    layoutState,
    switchWorkspace,
    switchPage,
    createWorkspace,
    renameWorkspace,
    createPage,
    renamePage,
    closeWorkspace,
    closePage,
  } from "./layoutState";
  import { confirmWorkspaceClose, confirmPageClose } from "./confirmClose";
  import { presetSingle, allSessionIds } from "./layout";
  import { ChevronRight, ChevronDown, Plus, X } from "@lucide/svelte";
  import { sessionLabel } from "./paths";
  import {
    setDragPayload,
    getDragKind,
    getDragPayload,
    computeDropZone,
    computeReorderPosition,
    type DropZone,
    type ReorderPosition,
  } from "./dragDrop";
  import { movePaneOrTab, reorderWorkspaceAction, movePageAction, switchToSessionInPage } from "./layoutState";
  import { UNFILED_WORKSPACE_ID, summarizePageGitStatus, type Workspace, type Page, type GitStatus } from "./workspace";
```

- [ ] **Step 6: Render the expand toggle and the per-session detail rows**

In the `{#snippet pageList(ws: Workspace)}` snippet, find this complete block (the `{#each ws.pages as page, pageIndex (page.id)}` loop body, exactly as Task 4 left it):

```svelte
    {#each ws.pages as page, pageIndex (page.id)}
      {@const gitSummary = pageGitSummary(page)}
      <div
        class="page-row"
        class:active={ws.id === $layoutState.activeWorkspaceId && page.id === ws.activePageId}
        class:drop-before={hoverState?.targetId === page.id &&
          hoverState.kind === "reorder" &&
          hoverState.position === "before"}
        class:drop-after={hoverState?.targetId === page.id &&
          hoverState.kind === "reorder" &&
          hoverState.position === "after"}
        class:drop-zone-left={hoverState?.targetId === page.id && hoverState.kind === "zone" && hoverState.zone === "left"}
        class:drop-zone-right={hoverState?.targetId === page.id && hoverState.kind === "zone" && hoverState.zone === "right"}
        class:drop-zone-top={hoverState?.targetId === page.id && hoverState.kind === "zone" && hoverState.zone === "top"}
        class:drop-zone-bottom={hoverState?.targetId === page.id && hoverState.kind === "zone" && hoverState.zone === "bottom"}
        class:drop-zone-center={hoverState?.targetId === page.id && hoverState.kind === "zone" && hoverState.zone === "center"}
        draggable={editingPageId !== page.id}
        ondragstart={(e) => handlePageDragStart(e, ws.id, page.id)}
        ondragover={(e) => handlePageDragOver(e, page.id)}
        ondragleave={clearHover}
        ondragend={clearHover}
        ondrop={(e) => handlePageDrop(e, ws, page, pageIndex)}
      >
        {#if editingPageId === page.id}
          <input
            class="page-name-input"
            bind:this={pageEditInput}
            bind:value={pageEditValue}
            onclick={(e) => e.stopPropagation()}
            onblur={commitPageEdit}
            onkeydown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commitPageEdit();
              } else if (e.key === "Escape") {
                e.preventDefault();
                cancelPageEdit();
              }
            }}
          />
        {:else}
          <span
            class="page-name"
            ondblclick={() => startEditingPage(page.id, page.name)}
            onclick={() => switchPage(ws.id, page.id)}
          >{page.name}</span>
        {/if}
        {#if gitSummary.kind === "single"}
          <span class="git-branch">{gitSummary.status.branch}</span>
          <span
            class="git-dot"
            class:dirty={gitSummary.status.dirty}
            class:clean={!gitSummary.status.dirty}
          ></span>
          {#if formatAheadBehind(gitSummary.status)}
            <span class="git-ahead-behind">{formatAheadBehind(gitSummary.status)}</span>
          {/if}
        {/if}
        {#if waitingForInputCount(page) > 0}
          <span class="waiting-badge">{waitingForInputCount(page)}</span>
        {/if}
        <button
          class="close-page"
          aria-label="Close Page"
          title="Close Page"
          onclick={async () => {
            if (await confirmPageClose(ws.id, page.id)) {
              void closePage(ws.id, page.id);
            }
          }}
        >
          <X size={10} />
        </button>
      </div>
    {/each}
  </div>
{/snippet}
```

Replace it with (wrapping the row in a new `.page-row-group` div, adding the git-expand-toggle as the row's first child when there are multiple repos, and adding the expanded per-session detail list as a sibling after the row; the row's own attributes and its existing children are otherwise byte-for-byte unchanged, just re-indented one level deeper):

```svelte
    {#each ws.pages as page, pageIndex (page.id)}
      {@const gitSummary = pageGitSummary(page)}
      <div class="page-row-group">
        <div
          class="page-row"
          class:active={ws.id === $layoutState.activeWorkspaceId && page.id === ws.activePageId}
          class:drop-before={hoverState?.targetId === page.id &&
            hoverState.kind === "reorder" &&
            hoverState.position === "before"}
          class:drop-after={hoverState?.targetId === page.id &&
            hoverState.kind === "reorder" &&
            hoverState.position === "after"}
          class:drop-zone-left={hoverState?.targetId === page.id && hoverState.kind === "zone" && hoverState.zone === "left"}
          class:drop-zone-right={hoverState?.targetId === page.id && hoverState.kind === "zone" && hoverState.zone === "right"}
          class:drop-zone-top={hoverState?.targetId === page.id && hoverState.kind === "zone" && hoverState.zone === "top"}
          class:drop-zone-bottom={hoverState?.targetId === page.id && hoverState.kind === "zone" && hoverState.zone === "bottom"}
          class:drop-zone-center={hoverState?.targetId === page.id && hoverState.kind === "zone" && hoverState.zone === "center"}
          draggable={editingPageId !== page.id}
          ondragstart={(e) => handlePageDragStart(e, ws.id, page.id)}
          ondragover={(e) => handlePageDragOver(e, page.id)}
          ondragleave={clearHover}
          ondragend={clearHover}
          ondrop={(e) => handlePageDrop(e, ws, page, pageIndex)}
        >
          {#if gitSummary.kind === "multiple"}
            <button
              class="git-expand-toggle"
              aria-label={isPageGitExpanded(page.id) ? "Collapse git detail" : "Expand git detail"}
              onclick={() => togglePageGitExpand(page.id)}
            >
              {#if isPageGitExpanded(page.id)}
                <ChevronDown size={10} />
              {:else}
                <ChevronRight size={10} />
              {/if}
            </button>
          {/if}
          {#if editingPageId === page.id}
            <input
              class="page-name-input"
              bind:this={pageEditInput}
              bind:value={pageEditValue}
              onclick={(e) => e.stopPropagation()}
              onblur={commitPageEdit}
              onkeydown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  commitPageEdit();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  cancelPageEdit();
                }
              }}
            />
          {:else}
            <span
              class="page-name"
              ondblclick={() => startEditingPage(page.id, page.name)}
              onclick={() => switchPage(ws.id, page.id)}
            >{page.name}</span>
          {/if}
          {#if gitSummary.kind === "single"}
            <span class="git-branch">{gitSummary.status.branch}</span>
            <span
              class="git-dot"
              class:dirty={gitSummary.status.dirty}
              class:clean={!gitSummary.status.dirty}
            ></span>
            {#if formatAheadBehind(gitSummary.status)}
              <span class="git-ahead-behind">{formatAheadBehind(gitSummary.status)}</span>
            {/if}
          {/if}
          {#if waitingForInputCount(page) > 0}
            <span class="waiting-badge">{waitingForInputCount(page)}</span>
          {/if}
          <button
            class="close-page"
            aria-label="Close Page"
            title="Close Page"
            onclick={async () => {
              if (await confirmPageClose(ws.id, page.id)) {
                void closePage(ws.id, page.id);
              }
            }}
          >
            <X size={10} />
          </button>
        </div>
        {#if gitSummary.kind === "multiple" && isPageGitExpanded(page.id)}
          <div class="page-git-detail">
            {#each allSessionIds(page.layout) as sessionId (sessionId)}
              {@const sessionStatus = $layoutState.gitStatusById[sessionId]}
              <div
                class="git-session-row"
                onclick={() => switchToSessionInPage(ws.id, page.id, sessionId)}
              >
                <span class="git-session-label">
                  {sessionLabel($layoutState.sessionNames, $layoutState.cwdBySessionId, sessionId)}
                </span>
                {#if sessionStatus}
                  <span class="git-branch">{sessionStatus.branch}</span>
                  <span
                    class="git-dot"
                    class:dirty={sessionStatus.dirty}
                    class:clean={!sessionStatus.dirty}
                  ></span>
                  {#if formatAheadBehind(sessionStatus)}
                    <span class="git-ahead-behind">{formatAheadBehind(sessionStatus)}</span>
                  {/if}
                {/if}
              </div>
            {/each}
          </div>
        {/if}
      </div>
    {/each}
  </div>
{/snippet}
```

- [ ] **Step 7: Add the CSS**

Add this to the `<style>` block, right after the existing `.page-name` rule:

```css
  .git-expand-toggle {
    background: transparent;
    border: none;
    color: #999;
    cursor: pointer;
    padding: 0;
    display: flex;
    flex: 0 0 auto;
  }
  .page-git-detail {
    display: flex;
    flex-direction: column;
  }
  .git-session-row {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 2px 8px 2px 44px;
    cursor: pointer;
    font-size: 0.9em;
  }
  .git-session-row:hover {
    background: #1e1e1e;
  }
  .git-session-label {
    flex: 1 1 auto;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: #999;
  }
```

- [ ] **Step 8: Type-check and run the full frontend test suite**

Run: `cd /Users/coalpila/CloudStation/Coding/gavin/app && npm run check && npm test`
Expected: PASS — no dedicated rendering test for the expand/collapse interaction itself (pure Svelte template logic, matching this project's established GUI-only-verified precedent for expand/collapse UI), but `switchToSessionInPage`'s own logic is fully covered by Step 4's tests, and the full suite must show zero regressions.

- [ ] **Step 9: Commit**

```bash
git add app/src/lib/Sidebar.svelte app/src/lib/layoutState.ts app/src/lib/layoutState.test.ts
git commit -m "feat(app): expand a page's sidebar row into per-session git status when it spans multiple repos"
```

---

## Not covered by this plan (deliberately, per the design spec)

- Any Rust/Tauri changes — the daemon event and its Tauri relay already shipped in Part 1.
- OS notifications for git status changes — never in scope, unlike session status.
- Any git *write* operation from within the app.
- A workspace-row-level git indicator — explicitly excluded per the design spec ("no git indicator at any level above the page row").
