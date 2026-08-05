# File Viewer — Viewer UI (Part 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the file viewer's user-facing half — the pane component that renders a file, the cmd+click link layer in terminal output that opens one, and the tab-lifecycle changes that stop treating file tabs as terminal sessions.

**Architecture:** A new `FileViewerPane.svelte` renders markdown (via `marked` + `DOMPurify`) or syntax-highlighted text (via `highlight.js`), reading through the already-shipped `readFileForViewer` and live-reloading on the already-shipped `file-changed` event. `Pane.svelte` gains one dispatch branch keyed off the already-shipped `fileTabsById` map. `terminalRegistry.ts` gains the xterm link layer (`@xterm/addon-web-links` for URLs, a custom `registerLinkProvider` for paths). `layoutState.ts` gains `openFileInSplit`, and every close path learns to skip file-tab ids rather than trying to kill sessions that never existed.

**Tech Stack:** Svelte 5 (runes), TypeScript, xterm.js, `marked`, `DOMPurify`, `highlight.js`, `@xterm/addon-web-links`, Vitest.

## Global Constraints

- **Part 1 already shipped** (commits `6e1602c`..`c1c9f8f` on `main`). Do NOT re-add any of it. Already exists and is tested: `AppConfig.file_tabs` persistence, `get_file_tabs`/`set_file_tabs`, `LayoutState.fileTabsById: Record<string, FileTab>` with `export interface FileTab { path: string }` in `layoutState.ts` (hydrated on bootstrap), all 7 `backend.ts` wrappers (`getFileTabs`, `setFileTabs`, `readFileForViewer`, `resolvePathUnderCursor`, `viewableExtensions`, `watchFileForViewer`, `unwatchFileForViewer`), the `file-changed` Tauri event (payload: the watched path as a bare string), and session-reconciliation skipping of file-tab ids.
- **`folderName(path)` in `app/src/lib/paths.ts` already does basename semantics** (last `/`-separated segment). Use it for file-tab labels — do NOT write a new basename helper.
- A file tab's label is always the filename and is **never renameable** — `Pane.svelte`'s double-click-to-rename affordance must be suppressed for file tabs.
- File tabs never count toward the "N terminal sessions will end" counts in any `confirmClose.ts` prompt, and closing a file tab alone never prompts (spec §5).
- New npm dependencies, none currently installed (verified): `marked`, `dompurify`, `highlight.js`, `@xterm/addon-web-links`.
- Markdown HTML **must** be sanitized through `DOMPurify` before insertion — never `{@html}` raw `marked` output.
- Cmd+click gating: the link `activate` handlers fire only when `event.metaKey` is true. A plain click in a terminal must keep behaving exactly as it does today.
- User works directly on `main` (no worktree) — standing preference for this project.
- This session has hit the 200-subagent spawn cap seven times, always on a fresh plan's first dispatch, each time resolved by the user choosing direct controller implementation. Expect it may happen again; it is not a sign anything is wrong with this plan.
- Every commit stages only the files that specific task actually needs — never `git add -A` / `git add .`.

## Testing Scope

Automated (Vitest, existing mocked-`backend` pattern): `layoutState.ts`'s `openFileInSplit` and the close-path file-tab skipping, `confirmClose.ts`'s counting, and the `fileTypes.ts` pure helpers (`fileExtension`, `isMarkdown`, `fileLanguage`).

**No Svelte component rendering tests.** This codebase has never had them and this plan does not introduce them. `FileViewerPane.svelte`, `Pane.svelte`'s dispatch branch, and the xterm link provider are verified by the manual GUI smoke test in Task 6 — which is a required step, not an optional one.

---

### Task 1: Install dependencies + `fileTypes.ts` helpers

**Files:**
- Modify: `app/package.json`
- Create: `app/src/lib/fileTypes.ts`
- Create: `app/src/lib/fileTypes.test.ts`

**Interfaces:**
- Produces: `fileLanguage(path: string): string | null` (highlight.js language id, or `null` for "render as plain text"); `isMarkdown(path: string): boolean`; `fileExtension(path: string): string`.

- [ ] **Step 1: Install the dependencies**

```bash
cd app && npm install marked dompurify highlight.js @xterm/addon-web-links
```

- [ ] **Step 2: Write the failing tests**

Create `app/src/lib/fileTypes.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { fileExtension, fileLanguage, isMarkdown } from "./fileTypes";

describe("fileExtension", () => {
  it("returns the lowercased extension", () => {
    expect(fileExtension("/tmp/README.MD")).toBe("md");
  });

  it("returns an empty string for a file with no extension", () => {
    expect(fileExtension("/tmp/Makefile")).toBe("");
  });

  it("ignores dots in parent directories", () => {
    expect(fileExtension("/tmp/my.dir/plainfile")).toBe("");
  });
});

describe("isMarkdown", () => {
  it("is true for .md and .markdown", () => {
    expect(isMarkdown("/tmp/a.md")).toBe(true);
    expect(isMarkdown("/tmp/a.markdown")).toBe(true);
  });

  it("is false for other extensions", () => {
    expect(isMarkdown("/tmp/a.ts")).toBe(false);
  });
});

describe("fileLanguage", () => {
  it("maps a known extension to its highlight.js language id", () => {
    expect(fileLanguage("/tmp/a.ts")).toBe("typescript");
    expect(fileLanguage("/tmp/a.rs")).toBe("rust");
  });

  it("returns null for an extension with no known language, so it renders as plain text", () => {
    expect(fileLanguage("/tmp/a.log")).toBeNull();
    expect(fileLanguage("/tmp/Makefile")).toBeNull();
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run (from `app/`): `npm test -- src/lib/fileTypes.test.ts`
Expected: FAIL — `./fileTypes` does not exist.

- [ ] **Step 4: Create `fileTypes.ts`**

```ts
// Maps file extensions to highlight.js language ids. Only extensions
// whose language highlight.js actually ships in its common bundle are
// listed -- an extension absent from here still renders, just as plain
// unhighlighted text (fileLanguage returns null), which is the correct
// fallback for a .log or an extensionless Makefile.
const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  svelte: "xml",
  rs: "rust",
  py: "python",
  go: "go",
  rb: "ruby",
  java: "java",
  c: "c",
  h: "c",
  cpp: "cpp",
  hpp: "cpp",
  cs: "csharp",
  swift: "swift",
  kt: "kotlin",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  fish: "bash",
  toml: "ini",
  ini: "ini",
  conf: "ini",
  cfg: "ini",
  yaml: "yaml",
  yml: "yaml",
  json: "json",
  xml: "xml",
  html: "xml",
  css: "css",
  scss: "scss",
  sql: "sql",
  graphql: "graphql",
  lua: "lua",
  php: "php",
  pl: "perl",
  r: "r",
  csv: "plaintext",
};

/// Lowercased extension of a path, or "" when there is none. Only looks
/// at the final path segment, so a dot in a parent directory
/// (/tmp/my.dir/plainfile) is never mistaken for an extension.
export function fileExtension(path: string): string {
  const base = path.split("/").filter(Boolean).pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "";
  return base.slice(dot + 1).toLowerCase();
}

export function isMarkdown(path: string): boolean {
  const ext = fileExtension(path);
  return ext === "md" || ext === "markdown";
}

/// The highlight.js language id for a path, or null to render it as plain
/// unhighlighted text.
export function fileLanguage(path: string): string | null {
  return LANGUAGE_BY_EXTENSION[fileExtension(path)] ?? null;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test -- src/lib/fileTypes.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 6: Commit**

```bash
git add app/package.json app/package-lock.json app/src/lib/fileTypes.ts app/src/lib/fileTypes.test.ts
git commit -m "feat(fileviewer): add rendering deps and file-type helpers"
```

---

### Task 2: `openFileInSplit` + file-tab-aware close paths

**Files:**
- Modify: `app/src/lib/layoutState.ts`
- Modify: `app/src/lib/layoutState.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `openFileInSplit(anchorSessionId: string, path: string): Promise<void>`; `closeSession`/`closePane`/`closeWorkspace`/`closePage` all skip `killSession` for file-tab ids and call `backend.unwatchFileForViewer` instead.

- [ ] **Step 1: Write the failing tests**

Add to `app/src/lib/layoutState.test.ts`. First add these to the `vi.mock("./backend", ...)` factory: `setFileTabs: vi.fn(),` and `unwatchFileForViewer: vi.fn(),`. Add `openFileInSplit` to the import list from `./layoutState`.

Then add these describe blocks:

```ts
describe("openFileInSplit", () => {
  it("splits the anchor's pane with a new file tab and persists both the tree and the file-tab map", async () => {
    setState([ws("ws-1", [page("page-1", leaf(["a"]))])], "ws-1", "a");

    await openFileInSplit("a", "/tmp/README.md");

    const state = get(layoutState);
    const tree = state.workspaces[0].pages[0].layout;
    expect(tree.type).toBe("split");
    if (tree.type !== "split") throw new Error("expected a split");
    // The anchor keeps its own leaf; the new file tab gets the sibling leaf.
    expect(tree.children[0]).toEqual(leaf(["a"]));
    const newLeaf = tree.children[1];
    if (newLeaf.type !== "leaf") throw new Error("expected a leaf");
    const newTabId = newLeaf.tabs[0];
    expect(state.fileTabsById[newTabId]).toEqual({ path: "/tmp/README.md" });
    expect(backend.setFileTabs).toHaveBeenCalledWith({ [newTabId]: "/tmp/README.md" });
    expect(backend.setWorkspacesState).toHaveBeenCalled();
    // A file tab is never a terminal session.
    expect(backend.createSession).not.toHaveBeenCalled();
  });

  it("is a no-op when there is no active page", async () => {
    setState([ws("ws-1", [])], "ws-1", null);

    await openFileInSplit("a", "/tmp/README.md");

    expect(backend.setFileTabs).not.toHaveBeenCalled();
  });
});

describe("closing file tabs", () => {
  it("closeSession unwatches a file tab instead of killing a session", async () => {
    setState([ws("ws-1", [page("page-1", leaf(["a", "file-1"]))])], "ws-1", "a");
    layoutState.update((s) => ({ ...s, fileTabsById: { "file-1": { path: "/tmp/a.md" } } }));

    await closeSession("file-1");

    expect(backend.killSession).not.toHaveBeenCalled();
    expect(backend.unwatchFileForViewer).toHaveBeenCalledWith("/tmp/a.md");
    expect(get(layoutState).workspaces[0].pages[0].layout).toEqual(leaf(["a"]));
  });

  it("closePane kills only the session tabs and unwatches only the file tabs", async () => {
    setState([ws("ws-1", [page("page-1", leaf(["a", "file-1"]))])], "ws-1", "a");
    layoutState.update((s) => ({ ...s, fileTabsById: { "file-1": { path: "/tmp/a.md" } } }));
    vi.mocked(backend.killSession).mockResolvedValue(undefined);

    await closePane("a");

    expect(backend.killSession).toHaveBeenCalledTimes(1);
    expect(backend.killSession).toHaveBeenCalledWith("a");
    expect(backend.unwatchFileForViewer).toHaveBeenCalledWith("/tmp/a.md");
  });

  it("closeWorkspace kills only the session tabs and unwatches only the file tabs", async () => {
    setState([ws("ws-1", [page("page-1", leaf(["a", "file-1"]))])], "ws-1", "a");
    layoutState.update((s) => ({ ...s, fileTabsById: { "file-1": { path: "/tmp/a.md" } } }));
    vi.mocked(backend.killSession).mockResolvedValue(undefined);
    vi.mocked(backend.deleteBoard).mockResolvedValue(undefined);

    await closeWorkspace("ws-1");

    expect(backend.killSession).toHaveBeenCalledTimes(1);
    expect(backend.killSession).toHaveBeenCalledWith("a");
    expect(backend.unwatchFileForViewer).toHaveBeenCalledWith("/tmp/a.md");
  });

  it("closePage kills only the session tabs and unwatches only the file tabs", async () => {
    setState([ws("ws-1", [page("page-1", leaf(["a", "file-1"]))])], "ws-1", "a");
    layoutState.update((s) => ({ ...s, fileTabsById: { "file-1": { path: "/tmp/a.md" } } }));
    vi.mocked(backend.killSession).mockResolvedValue(undefined);

    await closePage("ws-1", "page-1");

    expect(backend.killSession).toHaveBeenCalledTimes(1);
    expect(backend.killSession).toHaveBeenCalledWith("a");
    expect(backend.unwatchFileForViewer).toHaveBeenCalledWith("/tmp/a.md");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- src/lib/layoutState.test.ts`
Expected: FAIL — `openFileInSplit` is not exported, and the close paths still call `killSession` for file tabs.

- [ ] **Step 3: Add a shared close helper and `openFileInSplit`**

In `app/src/lib/layoutState.ts`, add this helper next to the other private helpers near the top (after `createFreshSession`):

```ts
// Every close path (tab, pane, page, workspace) ends the tabs it owns.
// A file tab is not a session -- killing it would ask the daemon to kill
// an id it has never heard of -- so it gets its watcher torn down instead.
// Returns false (having already called setError) if a real session kill
// failed, so callers can bail exactly as they do today.
async function endTabs(tabIds: string[], fileTabsById: Record<string, FileTab>): Promise<boolean> {
  for (const id of tabIds) {
    const fileTab = fileTabsById[id];
    if (fileTab) {
      // Best-effort: a watcher that's already gone (or was never
      // started because the file read failed) must not block the close.
      await backend.unwatchFileForViewer(fileTab.path).catch(() => {});
      continue;
    }
    try {
      await backend.killSession(id);
    } catch (e) {
      setError(String(e));
      return false;
    }
  }
  return true;
}
```

Add `openFileInSplit` after `splitPane`:

```ts
// Opens `path` as a new file tab, split beside the pane holding
// `anchorSessionId` -- the cmd+click-a-path flow's entry point. Mirrors
// splitPane exactly, except the new tab is a file tab (a fresh opaque id
// recorded in fileTabsById) rather than a freshly spawned session, so no
// create_session call happens at all.
export async function openFileInSplit(anchorSessionId: string, path: string): Promise<void> {
  const state = get(layoutState);
  const location = activePageLocation(state);
  if (!location) return;
  const tabId = crypto.randomUUID();
  const newTree = layout.splitLeaf(location.tree, anchorSessionId, "row", tabId);
  const withTree = workspace.updatePageLayout(state, location.workspaceId, location.pageId, newTree);
  const data = workspace.setPageFocus(withTree, location.workspaceId, location.pageId, tabId);
  const fileTabsById = { ...state.fileTabsById, [tabId]: { path } };
  layoutState.update((s) => ({ ...s, workspaces: data.workspaces, focusedSessionId: tabId, fileTabsById }));

  const asPathMap: Record<string, string> = {};
  for (const [id, tab] of Object.entries(fileTabsById)) {
    asPathMap[id] = tab.path;
  }
  try {
    await backend.setFileTabs(asPathMap);
  } catch (e) {
    setError(String(e));
    return;
  }
  await persistWorkspaces(data.workspaces, state.activeWorkspaceId);
}
```

- [ ] **Step 4: Route every close path through `endTabs`**

In `closeSession`, replace its whole body:

```ts
export async function closeSession(sessionId: string): Promise<void> {
  const state = get(layoutState);
  if (!(await endTabs([sessionId], state.fileTabsById))) return;
  handleSessionExited(sessionId);
}
```

In `closePane`, replace the `for (const id of sessionIds) { try { await backend.killSession(id); } ... }` loop with:

```ts
  if (!(await endTabs(sessionIds, state.fileTabsById))) return;
```

In `closeWorkspace`, replace its equivalent kill loop with the same single line:

```ts
  if (!(await endTabs(sessionIds, state.fileTabsById))) return;
```

In `closePage`, replace its equivalent kill loop with the same single line:

```ts
  if (!(await endTabs(sessionIds, state.fileTabsById))) return;
```

(Each of these four already has a `state` — or equivalently-named — local in scope holding `get(layoutState)`; use it. Do not add a second `get(layoutState)` call.)

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test -- src/lib/layoutState.test.ts`
Expected: PASS, all tests (78 total: 72 existing + 6 new).

- [ ] **Step 6: Commit**

```bash
git add app/src/lib/layoutState.ts app/src/lib/layoutState.test.ts
git commit -m "feat(fileviewer): add openFileInSplit and file-tab-aware close paths"
```

---

### Task 3: `confirmClose.ts` stops counting file tabs

**Files:**
- Modify: `app/src/lib/confirmClose.ts`
- Modify: `app/src/lib/confirmClose.test.ts`

**Interfaces:**
- Consumes: `LayoutState.fileTabsById` (Part 1).
- Produces: no new exports — the four existing `confirm*Close` functions change behavior only.

- [ ] **Step 1: Write the failing tests**

Add to `app/src/lib/confirmClose.test.ts`:

```ts
describe("file tabs are not counted as terminal sessions", () => {
  it("confirmTabClose does not prompt when closing a file tab that is alone in its pane", async () => {
    setActivePage([ws("ws-1", [page("page-1", leaf(["file-1"]))])], "ws-1");
    layoutState.update((s) => ({ ...s, fileTabsById: { "file-1": { path: "/tmp/a.md" } } }));

    const proceed = await confirmTabClose("file-1");

    expect(proceed).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
  });

  it("confirmPaneClose counts only real sessions", async () => {
    setActivePage([ws("ws-1", [page("page-1", leaf(["a", "file-1"]))])], "ws-1");
    layoutState.update((s) => ({ ...s, fileTabsById: { "file-1": { path: "/tmp/a.md" } } }));
    vi.mocked(confirm).mockResolvedValue(true);

    await confirmPaneClose("a");

    expect(confirm).toHaveBeenCalledWith(
      "Close this pane? 1 terminal session will end.",
      { title: "gavin" }
    );
  });

  it("confirmPageClose counts only real sessions", async () => {
    setActivePage([ws("ws-1", [page("page-1", leaf(["a", "file-1"]))])], "ws-1");
    layoutState.update((s) => ({ ...s, fileTabsById: { "file-1": { path: "/tmp/a.md" } } }));
    vi.mocked(confirm).mockResolvedValue(true);

    await confirmPageClose("ws-1", "page-1");

    expect(confirm).toHaveBeenCalledWith(
      "Close this page? 1 terminal session will end.",
      { title: "gavin" }
    );
  });

  it("confirmWorkspaceClose counts only real sessions", async () => {
    setActivePage([ws("ws-1", [page("page-1", leaf(["a", "file-1"]))])], "ws-1");
    layoutState.update((s) => ({ ...s, fileTabsById: { "file-1": { path: "/tmp/a.md" } } }));
    vi.mocked(confirm).mockResolvedValue(true);

    await confirmWorkspaceClose("ws-1");

    expect(confirm).toHaveBeenCalledWith(
      "Close this workspace? 1 terminal session will end.",
      { title: "gavin" }
    );
  });
});
```

If `confirmClose.test.ts`'s existing helpers are named differently from `setState`/`ws`/`page`/`leaf`, use whatever that file already defines — read its top before writing these, and adapt the four blocks to its own helper names rather than adding duplicates.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- src/lib/confirmClose.test.ts`
Expected: FAIL — counts include the file tab (e.g. "2 terminal sessions will end"), and `confirmTabClose` prompts for a lone file tab.

- [ ] **Step 3: Make the four functions file-tab-aware**

In `app/src/lib/confirmClose.ts`, add this helper after the imports:

```ts
// A file tab is not a terminal session: closing one ends no process, so
// it must never appear in a "N terminal sessions will end" count, and a
// pane/page/workspace holding only file tabs needs no prompt at all.
function sessionTabsOnly(ids: string[], fileTabsById: Record<string, { path: string }>): string[] {
  return ids.filter((id) => !fileTabsById[id]);
}
```

Rewrite `confirmTabClose` — a lone file tab closes silently:

```ts
export async function confirmTabClose(sessionId: string): Promise<boolean> {
  const state = get(layoutState);
  if (state.fileTabsById[sessionId]) return true;
  const tree = getActiveTree(state);
  if (!tree || !isLastTabInPane(tree, sessionId)) return true;
  return confirm("Close this tab? It's the last one in this pane, so the pane will close too.", {
    title: "gavin",
  });
}
```

In `confirmPaneClose`, replace the `count` line:

```ts
  const count = leaf.type === "leaf" ? sessionTabsOnly(leaf.tabs, state.fileTabsById).length : 0;
```

In `confirmPageClose`, replace the `count` line:

```ts
  const count = sessionTabsOnly(allSessionIds(page.layout), state.fileTabsById).length;
```

In `confirmWorkspaceClose`, replace the `count` line:

```ts
  const count = sessionTabsOnly(allSessionIdsInWorkspace(ws), state.fileTabsById).length;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- src/lib/confirmClose.test.ts`
Expected: PASS, all tests (13 total: 9 existing + 4 new).

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/confirmClose.ts app/src/lib/confirmClose.test.ts
git commit -m "feat(fileviewer): stop counting file tabs as terminal sessions in close prompts"
```

---

### Task 4: `FileViewerPane.svelte`

**Files:**
- Create: `app/src/lib/FileViewerPane.svelte`

**Interfaces:**
- Consumes: Task 1's `fileLanguage`/`isMarkdown`; Part 1's `backend.readFileForViewer`/`watchFileForViewer`/`unwatchFileForViewer` and the `file-changed` event.
- Produces: a component taking `{ path: string; visible: boolean }` and exporting a no-op `fit(): void` (so `Pane.svelte`'s existing `fitAll()` loop, which calls `paneRefs[id]?.fit()` over every tab, works unchanged for file tabs — see Task 5).

- [ ] **Step 1: Create the component**

```svelte
<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { listen, type UnlistenFn } from "@tauri-apps/api/event";
  import { openPath } from "@tauri-apps/plugin-opener";
  import { marked } from "marked";
  import DOMPurify from "dompurify";
  import hljs from "highlight.js";
  import "highlight.js/styles/github-dark.css";
  import { fileLanguage, isMarkdown } from "./fileTypes";
  import * as backend from "./backend";

  let { path, visible }: { path: string; visible: boolean } = $props();

  let content = $state("");
  let truncated = $state(false);
  let error = $state<string | null>(null);
  let unlisten: UnlistenFn | null = null;

  // Pane.svelte's fitAll() calls fit() on every tab in a pane, terminal or
  // not. A file viewer has nothing to resize -- it reflows with CSS -- so
  // this exists purely so that shared loop needs no per-tab-kind branch.
  export function fit(): void {}

  async function load(): Promise<void> {
    try {
      const result = await backend.readFileForViewer(path);
      content = result.content;
      truncated = result.truncated;
      error = null;
    } catch (e) {
      error = String(e instanceof Error ? e.message : e);
    }
  }

  const rendered = $derived.by(() => {
    if (error !== null) return "";
    if (isMarkdown(path)) {
      return DOMPurify.sanitize(marked.parse(content, { async: false }) as string);
    }
    const language = fileLanguage(path);
    if (language && hljs.getLanguage(language)) {
      return hljs.highlight(content, { language }).value;
    }
    // No known language: still viewable, just not colorized. Escaped via
    // highlightAuto's own escaping path would guess wrongly on short
    // files, so escape manually instead of guessing.
    return escapeHtml(content);
  });

  function escapeHtml(text: string): string {
    return text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  async function openExternally(): Promise<void> {
    await openPath(path).catch(() => {});
  }

  onMount(async () => {
    await load();
    await backend.watchFileForViewer(path).catch(() => {});
    unlisten = await listen<string>("file-changed", (event) => {
      if (event.payload === path) void load();
    });
  });

  onDestroy(() => {
    unlisten?.();
    // Best-effort: the tab is going away regardless of whether the
    // watcher teardown succeeds. layoutState's close paths also unwatch
    // (see Task 2's endTabs) -- unwatching twice is a documented no-op.
    void backend.unwatchFileForViewer(path).catch(() => {});
  });
</script>

<div class="pane" class:inactive={!visible}>
  {#if error !== null}
    <div class="overlay">
      <p>Couldn't open this file.</p>
      <p class="detail">{error}</p>
      <button onclick={openExternally}>Open externally</button>
    </div>
  {:else}
    {#if truncated}
      <div class="notice">
        This file is too large to preview in full — showing the first part only.
        <button onclick={openExternally}>Open externally</button>
      </div>
    {/if}
    {#if isMarkdown(path)}
      <div class="markdown">{@html rendered}</div>
    {:else}
      <pre class="code"><code>{@html rendered}</code></pre>
    {/if}
  {/if}
</div>

<style>
  .pane {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    overflow: auto;
    background: #1e1e1e;
    color: #eee;
  }
  .inactive {
    visibility: hidden;
    z-index: 0;
  }
  .pane:not(.inactive) {
    z-index: 1;
  }
  .overlay {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 100%;
    font-family: monospace;
  }
  .detail {
    opacity: 0.7;
    font-size: 0.85em;
  }
  .overlay button,
  .notice button {
    margin-top: 12px;
    padding: 8px 16px;
    background: #3a3a3a;
    border: none;
    color: #eee;
    border-radius: 4px;
    cursor: pointer;
    font-family: monospace;
  }
  .notice {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 8px 12px;
    background: #3a3320;
    color: #e0d0a0;
    font-family: monospace;
    font-size: 0.85em;
  }
  .notice button {
    margin-top: 0;
    padding: 4px 10px;
  }
  .code {
    margin: 0;
    padding: 12px;
    font-family: monospace;
    font-size: 0.85em;
    white-space: pre;
    user-select: text;
  }
  .markdown {
    padding: 16px 20px;
    max-width: 900px;
    line-height: 1.6;
    user-select: text;
  }
  .markdown :global(pre) {
    background: #2a2a2a;
    padding: 10px;
    border-radius: 4px;
    overflow-x: auto;
  }
  .markdown :global(code) {
    font-family: monospace;
    font-size: 0.9em;
  }
  .markdown :global(a) {
    color: #4a9eff;
  }
  .markdown :global(table) {
    border-collapse: collapse;
  }
  .markdown :global(th),
  .markdown :global(td) {
    border: 1px solid #444;
    padding: 4px 8px;
  }
</style>
```

- [ ] **Step 2: Type-check**

Run (from `app/`): `npm run check`
Expected: 0 errors. (34 warnings is this project's established baseline; a new a11y warning on this file is acceptable only if it matches a class already present elsewhere — if a genuinely new *error* appears, fix it before committing.)

- [ ] **Step 3: Commit**

```bash
git add app/src/lib/FileViewerPane.svelte
git commit -m "feat(fileviewer): add FileViewerPane with markdown and syntax highlighting"
```

---

### Task 5: `Pane.svelte` dispatch, labels, and rename suppression

**Files:**
- Modify: `app/src/lib/Pane.svelte`

**Interfaces:**
- Consumes: Task 4's `FileViewerPane` (props `{ path, visible }`, exports `fit()`); Part 1's `fileTabsById`; `folderName` from `paths.ts`.

- [ ] **Step 1: Add the import and a file-tab helper**

In `Pane.svelte`'s `<script>`, add to the imports:

```ts
  import FileViewerPane from "./FileViewerPane.svelte";
  import { folderName } from "./paths";
```

(`sessionLabel` is already imported from `./paths` — extend that existing import rather than adding a second one.)

Add this helper next to `tabLabel`:

```ts
  function fileTabPath(tabId: string): string | null {
    return $layoutState.fileTabsById[tabId]?.path ?? null;
  }
```

- [ ] **Step 2: Make labels and tooltips file-tab-aware**

Replace `tabLabel` and `tabTooltip`:

```ts
  function tabLabel(sessionId: string): string {
    const path = fileTabPath(sessionId);
    // A file tab's label is always its filename -- exact, known
    // information, unlike a terminal's cwd-derived guess, which is why it
    // is also not renameable (see the dblclick guard below).
    if (path) return folderName(path);
    return sessionLabel($layoutState.sessionNames, $layoutState.cwdBySessionId, sessionId);
  }

  function tabTooltip(sessionId: string): string {
    const path = fileTabPath(sessionId);
    if (path) return path;
    return $layoutState.sessionNames[sessionId] ?? $layoutState.cwdBySessionId[sessionId] ?? sessionId;
  }
```

- [ ] **Step 3: Suppress the status/git dots and the rename affordance for file tabs**

`tabStatusDot` and `tabGitDot` both index maps keyed by session id; a file tab is never in either, so they already return `null` for one — no change needed there.

Guard `startEditing` so a double-click on a file tab does nothing:

```ts
  function startEditing(sessionId: string): void {
    // File tabs are never renameable -- their label is the filename.
    if (fileTabPath(sessionId)) return;
    editingSessionId = sessionId;
    editValue = tabLabel(sessionId);
  }
```

- [ ] **Step 4: Add the content-area dispatch branch**

Replace the content area's `{#each}` block:

```svelte
    {#each leaf.tabs as sessionId (sessionId)}
      {#if fileTabPath(sessionId)}
        <FileViewerPane
          bind:this={paneRefs[sessionId]}
          path={fileTabPath(sessionId) ?? ""}
          visible={sessionId === active}
        />
      {:else}
        <TerminalPane
          bind:this={paneRefs[sessionId]}
          {sessionId}
          visible={sessionId === active}
          focused={sessionId === $layoutState.focusedSessionId}
        />
      {/if}
    {/each}
```

- [ ] **Step 5: Type-check and run the full suite**

Run (from `app/`): `npm run check`
Expected: 0 errors.

Run: `npm test`
Expected: PASS, all tests — no regressions. (This task adds no automated tests; see this plan's Testing Scope.)

- [ ] **Step 6: Commit**

```bash
git add app/src/lib/Pane.svelte
git commit -m "feat(fileviewer): render file tabs in Pane and label them by filename"
```

---

### Task 6: The xterm link layer (cmd+click paths and URLs)

**Files:**
- Modify: `app/src/lib/terminalRegistry.ts`

**Interfaces:**
- Consumes: Task 2's `openFileInSplit`; Part 1's `backend.resolvePathUnderCursor`/`viewableExtensions`.

**Note on the circular import:** `layoutState.ts` already imports `terminalRegistry.ts`, so `terminalRegistry.ts` must NOT statically import `layoutState.ts` back. Use a dynamic `await import("./layoutState")` inside the click handler — the same shape `FileViewerPane.svelte` uses for `backend`, and the same circular-import concern `backend.ts`'s `setOnWriteInputHook` comment already documents for a different pair of modules.

- [ ] **Step 1: Add the imports and the supported-extension cache**

In `terminalRegistry.ts`, add to the imports:

```ts
import { WebLinksAddon } from "@xterm/addon-web-links";
import { openPath, openUrl } from "@tauri-apps/plugin-opener";
import { fileExtension } from "./fileTypes";
```

Add near the top, after the existing `registry`/`pendingUnlisten` maps:

```ts
// Fetched once, lazily, and reused for every link hover/click -- the list
// is a compile-time constant on the Rust side, so re-fetching per hover
// would be pure overhead.
let viewableExtensionsCache: string[] | null = null;

async function isViewableInApp(path: string): Promise<boolean> {
  if (viewableExtensionsCache === null) {
    viewableExtensionsCache = await backend.viewableExtensions().catch(() => []);
  }
  return viewableExtensionsCache.includes(fileExtension(path));
}
```

- [ ] **Step 2: Add the path link provider**

Add this function to `terminalRegistry.ts`:

```ts
// Matches path-shaped runs of text in a rendered line: absolute (/...),
// home-relative (~/...), or relative containing a slash. Deliberately
// stricter than "any word" -- every candidate costs a resolve round-trip
// on hover, and a false positive that resolves to nothing just never
// becomes clickable anyway.
const PATH_CANDIDATE = /(~\/|\.{0,2}\/)[^\s'"()[\]{}:,]+/g;

function registerPathLinks(term: Terminal, sessionId: string): void {
  term.registerLinkProvider({
    provideLinks(lineNumber, callback) {
      const line = term.buffer.active.getLine(lineNumber - 1);
      if (!line) {
        callback(undefined);
        return;
      }
      const text = line.translateToString(true);
      const cwd = cwdForSession(sessionId);
      const matches = [...text.matchAll(PATH_CANDIDATE)];
      if (matches.length === 0) {
        callback(undefined);
        return;
      }
      void Promise.all(
        matches.map(async (m) => {
          const candidate = m[0];
          const resolved = await backend.resolvePathUnderCursor(candidate, cwd).catch(() => null);
          if (!resolved) return null;
          const start = (m.index ?? 0) + 1;
          return {
            range: {
              start: { x: start, y: lineNumber },
              end: { x: start + candidate.length - 1, y: lineNumber },
            },
            text: candidate,
            activate: (event: MouseEvent) => {
              // Cmd+click only -- a plain click must keep doing exactly
              // what it does today (nothing special).
              if (!event.metaKey) return;
              void activatePath(resolved, sessionId);
            },
          };
        })
      ).then((links) => {
        const real = links.filter((l): l is NonNullable<typeof l> => l !== null);
        callback(real.length > 0 ? real : undefined);
      });
    },
  });
}

async function activatePath(resolvedPath: string, sessionId: string): Promise<void> {
  if (await isViewableInApp(resolvedPath)) {
    const { openFileInSplit } = await import("./layoutState");
    await openFileInSplit(sessionId, resolvedPath);
    return;
  }
  await openPath(resolvedPath).catch(() => {});
}

// The session's own live cwd, mirrored here from layoutState's
// cwdBySessionId (kept current by the existing OSC 7 plumbing) via
// setCwdForLinks below. A local mirror rather than reading the store
// directly for two reasons: provideLinks is called synchronously per
// rendered line and cannot await, and this module must never statically
// import layoutState.ts, which already imports THIS module (a static
// import back would be circular).
const cwdBySessionId = new Map<string, string>();

function cwdForSession(sessionId: string): string {
  return cwdBySessionId.get(sessionId) ?? "";
}

export function setCwdForLinks(sessionId: string, cwd: string): void {
  cwdBySessionId.set(sessionId, cwd);
}
```

- [ ] **Step 3: Wire the addon, the provider, and the cwd mirror**

In `getOrCreateTerminal`, after `term.loadAddon(fitAddon);`, add:

```ts
  term.loadAddon(
    new WebLinksAddon((event, uri) => {
      // Cmd+click only, matching the path links -- a plain click on a URL
      // keeps doing nothing, as it does today.
      if (!event.metaKey) return;
      void openUrl(uri).catch(() => {});
    })
  );
  registerPathLinks(term, sessionId);
```

In `layoutState.ts`'s `handleCwdChanged`, add a call so the link provider's cwd mirror stays current (this is the one line this task adds outside `terminalRegistry.ts`):

```ts
export function handleCwdChanged(sessionId: string, cwd: string): void {
  terminalRegistry.setCwdForLinks(sessionId, cwd);
  layoutState.update((s) => ({ ...s, cwdBySessionId: { ...s.cwdBySessionId, [sessionId]: cwd } }));
}
```

Add `setCwdForLinks: vi.fn(),` to `layoutState.test.ts`'s `vi.mock("./terminalRegistry", ...)` factory so the existing `handleCwdChanged` tests keep passing.

In `destroyTerminal`, add cleanup alongside the existing entries:

```ts
  cwdBySessionId.delete(sessionId);
```

- [ ] **Step 4: Type-check and run the full suite**

Run (from `app/`): `npm run check`
Expected: 0 errors.

Run: `npm test`
Expected: PASS, all tests — no regressions.

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/terminalRegistry.ts app/src/lib/layoutState.ts app/src/lib/layoutState.test.ts
git commit -m "feat(fileviewer): cmd+click paths and URLs in terminal output"
```

- [ ] **Step 6: Manual GUI smoke test (required — none of this is automated)**

Build and run the app (`npm run tauri dev` from `app/`), then verify each:

1. **URL**: `echo https://example.com` in a terminal. Hover — it underlines. Plain click — nothing happens. Cmd+click — opens in the default browser.
2. **Viewable path**: `ls` in a directory with a `.md` or `.ts` file, then cmd+click that filename. It opens as a **new split beside** the terminal, showing rendered markdown (or highlighted code), with the tab labeled the filename.
3. **Non-existent path**: `echo /definitely/not/real.txt`. Hover — it does NOT underline (no dead-end click).
4. **Non-viewable path**: cmd+click a `.png` (or any non-listed extension). It opens in the OS default app, not in a pane.
5. **Live reload**: with a file open in the viewer, edit and save it from another editor (or `echo "new line" >> thatfile`). The pane content updates within ~1s without any interaction.
6. **Rename suppression**: double-click a file tab's label. It does NOT become an editable input (a terminal tab's label still does).
7. **Close prompts**: a pane containing one terminal + one file tab — the "Close Pane" prompt says "**1** terminal session will end", not 2. Closing a lone file tab prompts nothing at all.
8. **Persistence**: with a file tab open, fully quit and relaunch the app. The file tab is still there, showing the file's current content, and no phantom shell was spawned in its place.
9. **Too-large file**: `head -c 2000000 /dev/urandom | base64 > /tmp/big.txt`, then cmd+click `/tmp/big.txt`. It shows the "too large to preview in full" notice with a working "Open externally" button.
