# Plan Explorer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** a `.gavin*`-scoped markdown explorer (tree + editor) that also creates plans/docs/specs/contexts and edits a plan's kanban metadata directly.

**Architecture:** the tree is a pure projection of the existing `GavinTree` (`planExplorer.ts`) rendered by a presentational `PlanTree.svelte`; `PlanExplorerHubView.svelte` owns state and every backend call; `PlanMetadataPanel.svelte` writes plan frontmatter surgically and moves the card optimistically. No new scanning, no new watcher.

**Tech Stack:** existing only — no new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-19-agent-orchestration-plan-explorer-design.md` (D27–D30).

## Global Constraints

- User works directly on `main`; inline execution is the standing fallback.
- **A parallel session is reworking the kanban board** (`KanbanBoard/KanbanColumn/kanbanDrag*`, protocol v2, `order` field). This plan touches almost none of that — mostly new files plus `workspaceViews.ts`, `backend.ts`, `gavinState.ts`, `gavin.rs`. Rebase pain is unlikely; do not "fix" its files.
- **No Svelte component tests** — vitest here cannot preprocess `.svelte`. Logic worth testing goes in `.ts`.
- `set_plan_field` stays a **fixed allow-list**; it must never become an arbitrary-line writer.
- Creation only — **no rename or delete** anywhere in this sub-project (D10/D29).
- The title field edits frontmatter, **never the filename**.
- Verification per task: `cargo test`, `npx vitest run`, `npx svelte-check` (0 errors), and `npm run build` for tasks touching components.

---

### Task 1: `title` field + app-side plan creation

The spec assumes the app can create plans; it cannot. `CreatePlan` exists in the daemon and protocol, but **no Tauri command wraps it** — only `gavin-mcp` reaches it. This task closes that and extends the allow-list.

**Files:**
- Modify: `crates/daemon/src/gavin.rs`
- Modify: `app/src-tauri/src/session.rs`, `app/src-tauri/src/lib.rs`
- Modify: `app/src/lib/backend.ts`, `app/src/lib/gavinState.ts`, `app/src/lib/gavinState.test.ts`

**Interfaces:**
- Produces (Tasks 4–5): `backend.createPlan(contextFolder, fileName, title, status?, priority?, body?) -> Promise<string>` (the created path); `setPlanFrontmatterField`/`patchPlanField` accepting `"title"`.

- [ ] **Step 1: Allow `title`** in `gavin::set_plan_field`, before the `other =>` arm:

```rust
        "title" => {
            if value.trim().is_empty() || value.contains('\n') {
                anyhow::bail!("title must be a non-empty single line");
            }
        }
```

- [ ] **Step 2: Rewrite the test that encodes the OLD contract.** `set_plan_field_rejects_disallowed_keys_and_invalid_priorities` asserts `set_plan_field(&path, "title", "x").is_err()` — that is precisely what Step 1 changes. Swap the key for one that is still disallowed, keeping the rest of the test intact:

```rust
        assert!(set_plan_field(&path, "owner", "alice").is_err());
```

Do **not** delete the test: the disallowed-key coverage it protects has to survive.

- [ ] **Step 3: Add a title test** beside it:

```rust
    #[test]
    fn set_plan_field_writes_title_surgically_and_rejects_empty_or_multiline() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("p.md");
        std::fs::write(&path, "---\ntitle: Old\nstatus: To Do\n---\n# Body\n").unwrap();

        set_plan_field(&path, "title", "New title").unwrap();
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "---\ntitle: New title\nstatus: To Do\n---\n# Body\n"
        );

        assert!(set_plan_field(&path, "title", "   ").is_err());
        assert!(set_plan_field(&path, "title", "two\nlines").is_err());
        // Neither rejection touched the file.
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "---\ntitle: New title\nstatus: To Do\n---\n# Body\n"
        );
    }
```

- [ ] **Step 4: The Tauri command** (`session.rs`, beside `set_plan_frontmatter_field`):

```rust
/// Plan authoring from the app (the explorer's "New plan"). Same daemon
/// path MCP agents use, so validation and the never-overwrite guarantee
/// are identical no matter who creates a plan. Returns the created path.
#[tauri::command]
pub fn create_plan(
    context_folder: String,
    file_name: String,
    title: String,
    status: Option<String>,
    priority: Option<String>,
    body: Option<String>,
    state: State<CommandConnection>,
) -> Result<String, String> {
    let resp = send_command(
        &state.0,
        &Request::CreatePlan { context_folder, file_name, title, status, priority, body },
    )
    .map_err(|e| e.to_string())?;
    match resp {
        Response::PlanCreated { path } => Ok(path),
        Response::Error { message } => Err(message),
        other => Err(format!("unexpected response: {other:?}")),
    }
}
```

Register `session::create_plan` in `lib.rs`'s `generate_handler![]`.

- [ ] **Step 5: TypeScript.** In `backend.ts`, widen the key union and add the creator:

```typescript
export function setPlanFrontmatterField(
  path: string,
  key: "status" | "priority" | "order" | "title",
  value: string
): Promise<void> {
  return invoke("set_plan_frontmatter_field", { path, key, value });
}

export function createPlan(
  contextFolder: string,
  fileName: string,
  title: string,
  status?: string,
  priority?: string,
  body?: string
): Promise<string> {
  return invoke("create_plan", { contextFolder, fileName, title, status, priority, body });
}
```

In `gavinState.ts`, widen `patchPlanField`'s key union the same way and add its branch after the `status` line:

```typescript
        if (key === "title") return { ...p, title: value };
```

- [ ] **Step 6: Test the branch** (`gavinState.test.ts`, in the existing patch describe):

```typescript
  it("patchPlanField updates title", async () => {
    await initGavinListeners();
    const handler = vi.mocked(listen).mock.calls[0][1] as (e: { payload: [string, GavinTree] }) => void;
    handler({
      payload: [
        "ws-1",
        {
          rootPath: "/ws",
          rootMissing: false,
          contexts: [
            {
              folderPath: "/ws",
              kind: "root",
              name: "root",
              plans: [
                { path: "/ws/a.md", fileName: "a.md", title: "Old", status: "To Do", priority: null, order: null, parseWarning: false },
              ],
              docs: [],
              specs: [],
              hasPrd: true,
              configWarning: false,
            },
          ],
        },
      ],
    });
    patchPlanField("ws-1", "/ws/a.md", "title", "New");
    expect(get(gavinTrees)["ws-1"].contexts[0].plans[0].title).toBe("New");
  });
```

- [ ] **Step 7: Verify** — `cargo test -p gavin-daemon -p app`, `npx vitest run`, `npx svelte-check`.

- [ ] **Step 8: Commit** — `git add app crates && git commit -m "feat(explorer): allow title in set_plan_field, add app-side create_plan"`

---

### Task 2: `planExplorer.ts` — the pure projection

**Files:**
- Create: `app/src/lib/planExplorer.ts`
- Test: `app/src/lib/planExplorer.test.ts`

**Interfaces:**
- Produces (Tasks 3–5): `ExplorerGroup`, `ExplorerFile`, `ExplorerGroupNode`, `ExplorerContextNode`, `buildExplorerTree`, `slugFileName`, `isUnderRoot`, `statusOptions`, `gavinDirFor`, `newFilePath`.

- [ ] **Step 1: Write the failing tests** (`planExplorer.test.ts`):

```typescript
import { describe, it, expect } from "vitest";
import {
  buildExplorerTree,
  slugFileName,
  isUnderRoot,
  statusOptions,
  newFilePath,
} from "./planExplorer";
import type { GavinContext, GavinTree, PlanFileInfo } from "./gavin";

function plan(fileName: string, overrides: Partial<PlanFileInfo> = {}): PlanFileInfo {
  return {
    path: `/ws/.gavin-root/plans/${fileName}`,
    fileName,
    title: fileName.replace(/\.md$/, ""),
    status: "To Do",
    priority: null,
    order: null,
    parseWarning: false,
    ...overrides,
  };
}

function ctx(folderPath: string, name: string, over: Partial<GavinContext> = {}): GavinContext {
  return {
    folderPath,
    kind: "context",
    name,
    plans: [],
    docs: [],
    specs: [],
    hasPrd: false,
    configWarning: false,
    ...over,
  };
}

function tree(contexts: GavinContext[]): GavinTree {
  return { rootPath: "/ws", rootMissing: false, contexts };
}

describe("buildExplorerTree", () => {
  it("puts the root context first, then contexts by folder path", () => {
    const t = tree([
      ctx("/ws/zeta", "zeta", { plans: [plan("z.md")] }),
      ctx("/ws", "root", { kind: "root", plans: [plan("r.md")] }),
      ctx("/ws/alpha", "alpha", { plans: [plan("a.md")] }),
    ]);
    expect(buildExplorerTree(t).map((c) => c.name)).toEqual(["root", "alpha", "zeta"]);
  });

  it("omits empty groups and labels files per group", () => {
    const t = tree([
      ctx("/ws/auth", "auth", {
        plans: [plan("login.md", { title: "Login flow" })],
        docs: [{ path: "/ws/auth/.gavin/docs/guides/setup.md", relPath: "guides/setup.md" }],
      }),
    ]);
    const [node] = buildExplorerTree(t);
    expect(node.groups.map((g) => g.group)).toEqual(["plans", "docs"]);
    expect(node.groups[0].files[0].label).toBe("Login flow");
    // Docs keep their relative path, so nesting stays readable.
    expect(node.groups[1].files[0].label).toBe("guides/setup.md");
  });

  it("carries plan metadata onto file rows", () => {
    const t = tree([
      ctx("/ws", "root", {
        kind: "root",
        plans: [plan("a.md", { status: "In Progress", priority: "high", parseWarning: true })],
      }),
    ]);
    const file = buildExplorerTree(t)[0].groups[0].files[0];
    expect(file.status).toBe("In Progress");
    expect(file.priority).toBe("high");
    expect(file.parseWarning).toBe(true);
  });

  it("computes each context's gavin directory from its kind", () => {
    const t = tree([ctx("/ws", "root", { kind: "root", plans: [plan("a.md")] }), ctx("/ws/auth", "auth", { plans: [plan("b.md")] })]);
    const [root, auth] = buildExplorerTree(t);
    expect(root.gavinDir).toBe("/ws/.gavin-root");
    expect(auth.gavinDir).toBe("/ws/auth/.gavin");
  });

  it("is empty for an absent or root_missing tree", () => {
    expect(buildExplorerTree(undefined)).toEqual([]);
    expect(buildExplorerTree({ rootPath: "/ws", rootMissing: true, contexts: [] })).toEqual([]);
  });
});

describe("slugFileName", () => {
  it("slugifies a title into a daemon-legal filename", () => {
    expect(slugFileName("Auth flow rework")).toBe("auth-flow-rework.md");
    expect(slugFileName("  Spaces  &  Symbols!! ")).toBe("spaces-symbols.md");
    expect(slugFileName("Already-kebab")).toBe("already-kebab.md");
  });

  it("returns null when nothing usable survives", () => {
    expect(slugFileName("   ")).toBeNull();
    expect(slugFileName("!!!")).toBeNull();
  });
});

describe("isUnderRoot", () => {
  it("accepts a folder strictly inside the root", () => {
    expect(isUnderRoot("/ws", "/ws/src/auth")).toBe(true);
  });

  it("rejects the root itself", () => {
    // A .gavin beside .gavin-root is ignored by the scanner, so creating
    // one there would make an invisible context.
    expect(isUnderRoot("/ws", "/ws")).toBe(false);
  });

  it("rejects outside paths and segment-prefix lookalikes", () => {
    expect(isUnderRoot("/ws", "/elsewhere")).toBe(false);
    expect(isUnderRoot("/ws", "/ws2/src")).toBe(false);
  });
});

describe("statusOptions", () => {
  it("offers the board's columns", () => {
    expect(statusOptions(["To Do", "In Progress", "Done"], "To Do")).toEqual([
      "To Do",
      "In Progress",
      "Done",
    ]);
  });

  it("appends the current value when no column matches it", () => {
    expect(statusOptions(["To Do", "Done"], "Shipped")).toEqual(["To Do", "Done", "Shipped"]);
  });

  it("matches columns slug-insensitively before appending", () => {
    expect(statusOptions(["In Progress"], "in-progress")).toEqual(["In Progress"]);
  });

  it("handles a null current value and an empty board", () => {
    expect(statusOptions(["To Do"], null)).toEqual(["To Do"]);
    expect(statusOptions([], "Blocked")).toEqual(["Blocked"]);
  });
});

describe("newFilePath", () => {
  it("builds paths under the context's gavin directory", () => {
    expect(newFilePath("/ws/.gavin-root", "docs", "notes.md")).toBe("/ws/.gavin-root/docs/notes.md");
    expect(newFilePath("/ws/auth/.gavin", "specs", "api.md")).toBe("/ws/auth/.gavin/specs/api.md");
  });
});
```

- [ ] **Step 2: Run them, expect failure** (module not found).

- [ ] **Step 3: Implement `planExplorer.ts`:**

```typescript
import type { GavinContext, GavinTree, PlanFileInfo } from "./gavin";
import { slugStatus } from "./planBoard";

export type ExplorerGroup = "plans" | "docs" | "specs";

export interface ExplorerFile {
  path: string;
  // Plan title, or the doc/spec's path relative to its group folder --
  // so a nested guides/setup.md reads correctly instead of collapsing to
  // a bare filename.
  label: string;
  group: ExplorerGroup;
  // Plans only; null for docs and specs.
  status: string | null;
  priority: PlanFileInfo["priority"];
  parseWarning: boolean;
}

export interface ExplorerGroupNode {
  group: ExplorerGroup;
  label: string;
  files: ExplorerFile[];
}

export interface ExplorerContextNode {
  folderPath: string;
  name: string;
  kind: GavinContext["kind"];
  configWarning: boolean;
  // Absolute path of this context's .gavin-root/ or .gavin/ -- creation
  // targets are built from it.
  gavinDir: string;
  groups: ExplorerGroupNode[];
}

const GROUP_LABELS: Record<ExplorerGroup, string> = {
  plans: "Plans",
  docs: "Docs",
  specs: "Specs",
};

export function gavinDirFor(context: { folderPath: string; kind: GavinContext["kind"] }): string {
  return `${context.folderPath}/${context.kind === "root" ? ".gavin-root" : ".gavin"}`;
}

export function newFilePath(gavinDir: string, group: ExplorerGroup, fileName: string): string {
  return `${gavinDir}/${group}/${fileName}`;
}

// The tree the explorer renders. A pure projection: the daemon already
// sorts plans and md listings by name, so ordering within a group is
// inherited rather than re-derived.
export function buildExplorerTree(tree: GavinTree | undefined): ExplorerContextNode[] {
  if (!tree || tree.rootMissing) return [];

  const contexts = [...tree.contexts].sort((a, b) => {
    const aRoot = a.kind === "root";
    const bRoot = b.kind === "root";
    if (aRoot !== bRoot) return aRoot ? -1 : 1;
    return a.folderPath.localeCompare(b.folderPath);
  });

  return contexts.map((ctx) => {
    const groups: ExplorerGroupNode[] = [];

    if (ctx.plans.length > 0) {
      groups.push({
        group: "plans",
        label: GROUP_LABELS.plans,
        files: ctx.plans.map((p) => ({
          path: p.path,
          label: p.title,
          group: "plans" as const,
          status: p.status,
          priority: p.priority,
          parseWarning: p.parseWarning,
        })),
      });
    }
    for (const group of ["docs", "specs"] as const) {
      const list = ctx[group];
      if (list.length === 0) continue;
      groups.push({
        group,
        label: GROUP_LABELS[group],
        files: list.map((f) => ({
          path: f.path,
          label: f.relPath,
          group,
          status: null,
          priority: null,
          parseWarning: false,
        })),
      });
    }

    return {
      folderPath: ctx.folderPath,
      name: ctx.name,
      kind: ctx.kind,
      configWarning: ctx.configWarning,
      gavinDir: gavinDirFor(ctx),
      groups,
    };
  });
}

// Must satisfy the daemon's own [A-Za-z0-9._-]+\.md rule, so anything
// else is stripped rather than escaped. Null when nothing usable
// survives -- the caller shows an inline error instead of writing a file
// named ".md".
export function slugFileName(title: string): string | null {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug ? `${slug}.md` : null;
}

// Strictly inside: the root itself is rejected because a .gavin beside
// .gavin-root is deliberately ignored by the scanner (spec §1 edge
// rules), so creating one there would make an invisible context.
export function isUnderRoot(root: string, folder: string): boolean {
  const base = root.endsWith("/") ? root : `${root}/`;
  return folder !== root && folder.startsWith(base);
}

// The board's column names are the status vocabulary (D6). A plan whose
// status matches no column keeps its own value as an extra option, so
// opening the dropdown can never silently retitle it.
export function statusOptions(columnNames: string[], current: string | null): string[] {
  if (!current) return [...columnNames];
  const matched = columnNames.some((name) => slugStatus(name) === slugStatus(current));
  return matched ? [...columnNames] : [...columnNames, current];
}
```

- [ ] **Step 4: Run** — green.

- [ ] **Step 5: Commit** — `git add app/src/lib/planExplorer.ts app/src/lib/planExplorer.test.ts && git commit -m "feat(explorer): pure tree projection, slug, root check, status options"`

---

### Task 3: `PlanTree.svelte` — presentational tree

**Files:**
- Create: `app/src/lib/PlanTree.svelte`

**Interfaces:**
- Consumes: Task 2's types.
- Produces (Task 4): `<PlanTree contexts selectedPath onSelect onCreateFile onOpenInSplit />`. Expand/collapse and composer state are **internal** — nothing outside needs them.

- [ ] **Step 1: Write the component:**

```svelte
<script lang="ts">
  import type { ExplorerContextNode, ExplorerGroup } from "./planExplorer";
  // Icon names are a COMPILE error when wrong: verify each against the
  // installed @lucide/svelte before assuming. Columns2 is the current
  // name for the old SplitSquareHorizontal; if it is absent, PanelRight
  // is a fine stand-in.
  import { FileText, TriangleAlert, ChevronRight, ChevronDown, Plus, Columns2 } from "@lucide/svelte";

  interface Props {
    contexts: ExplorerContextNode[];
    selectedPath: string | null;
    onSelect: (path: string) => void;
    onCreateFile: (context: ExplorerContextNode, group: ExplorerGroup, title: string) => void;
    // Null when there is no terminal session to anchor a split to.
    onOpenInSplit: ((path: string) => void) | null;
  }
  let { contexts, selectedPath, onSelect, onCreateFile, onOpenInSplit }: Props = $props();

  // Collapsed rather than expanded ids: .gavin folders are few, so
  // everything starts open and this stays empty in the common case.
  let collapsed = $state<Set<string>>(new Set());
  let composer = $state<{ folderPath: string; group: ExplorerGroup } | null>(null);
  let composerTitle = $state("");

  // Hoisted: `{#each [...] as const as g}` does not parse -- the `as
  // const` collides with each's own `as` binding.
  const GROUPS = ["plans", "docs", "specs"] as const;

  function toggle(id: string): void {
    const next = new Set(collapsed);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    collapsed = next;
  }

  function openComposer(folderPath: string): void {
    composer = { folderPath, group: "plans" };
    composerTitle = "";
  }

  function submitComposer(context: ExplorerContextNode): void {
    const title = composerTitle.trim();
    if (!title || !composer) return;
    onCreateFile(context, composer.group, title);
    composer = null;
    composerTitle = "";
  }
</script>

<div class="tree">
  {#each contexts as context (context.folderPath)}
    {@const contextCollapsed = collapsed.has(context.folderPath)}
    <div class="context">
      <div class="row context-row">
        <button type="button" class="twisty" onclick={() => toggle(context.folderPath)}>
          {#if contextCollapsed}<ChevronRight size={12} />{:else}<ChevronDown size={12} />{/if}
        </button>
        <span class="name" title={context.folderPath}>{context.name}</span>
        {#if context.configWarning}
          <span class="warn" title="config.toml could not be parsed"><TriangleAlert size={11} /></span>
        {/if}
        <button type="button" class="add" title="New file in this context" onclick={() => openComposer(context.folderPath)}>
          <Plus size={12} />
        </button>
      </div>

      {#if composer && composer.folderPath === context.folderPath}
        <div class="composer">
          <div class="group-picker">
            {#each GROUPS as g (g)}
              <button
                type="button"
                class:active={composer?.group === g}
                onclick={() => (composer = { folderPath: context.folderPath, group: g })}
              >
                {g}
              </button>
            {/each}
          </div>
          <!-- svelte-ignore a11y_autofocus -->
          <input
            autofocus
            placeholder="Title…"
            bind:value={composerTitle}
            onkeydown={(e) => {
              if (e.key === "Enter") submitComposer(context);
              else if (e.key === "Escape") composer = null;
            }}
          />
        </div>
      {/if}

      {#if !contextCollapsed}
        {#each context.groups as group (group.group)}
          {@const groupId = `${context.folderPath}#${group.group}`}
          {@const groupCollapsed = collapsed.has(groupId)}
          <div class="row group-row">
            <button type="button" class="twisty" onclick={() => toggle(groupId)}>
              {#if groupCollapsed}<ChevronRight size={12} />{:else}<ChevronDown size={12} />{/if}
            </button>
            <span class="group-label">{group.label}</span>
            <span class="count">{group.files.length}</span>
          </div>
          {#if !groupCollapsed}
            {#each group.files as file (file.path)}
              <div class="row file-row" class:selected={file.path === selectedPath}>
                <button type="button" class="file" title={file.path} onclick={() => onSelect(file.path)}>
                  <span class="glyph"><FileText size={11} /></span>
                  <span class="label">{file.label}</span>
                  {#if file.priority && file.priority !== "none"}
                    <span class="priority priority-{file.priority}" title="Priority: {file.priority}"></span>
                  {/if}
                  {#if file.status}
                    <span class="status">{file.status}</span>
                  {/if}
                  {#if file.parseWarning}
                    <span class="warn" title="Frontmatter has issues"><TriangleAlert size={11} /></span>
                  {/if}
                </button>
                {#if onOpenInSplit}
                  <button
                    type="button"
                    class="split"
                    title="Open beside a terminal"
                    onclick={() => onOpenInSplit?.(file.path)}
                  >
                    <Columns2 size={11} />
                  </button>
                {/if}
              </div>
            {/each}
          {/if}
        {/each}
      {/if}
    </div>
  {/each}
</div>

<style>
  .tree {
    height: 100%;
    overflow: auto;
    padding: 8px 4px;
    font-family: monospace;
    font-size: 0.8em;
    color: #ccc;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 1px 4px;
    border-radius: 4px;
  }
  .file-row.selected {
    background: #2f3a2f;
  }
  .file-row:hover,
  .context-row:hover,
  .group-row:hover {
    background: #2a2a2a;
  }
  .twisty,
  .add,
  .split {
    background: transparent;
    border: none;
    color: #888;
    cursor: pointer;
    display: flex;
    align-items: center;
    padding: 0 2px;
  }
  .add,
  .split {
    margin-left: auto;
    opacity: 0;
  }
  .context-row:hover .add,
  .file-row:hover .split {
    opacity: 1;
  }
  .name {
    color: #8bc98b;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .group-label {
    color: #999;
    text-transform: uppercase;
    font-size: 0.85em;
    letter-spacing: 0.05em;
  }
  .count {
    color: #666;
    font-size: 0.85em;
  }
  .file {
    display: flex;
    align-items: center;
    gap: 5px;
    background: transparent;
    border: none;
    color: inherit;
    font-family: inherit;
    font-size: inherit;
    cursor: pointer;
    padding: 1px 2px;
    flex: 1 1 auto;
    min-width: 0;
    text-align: left;
  }
  .label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .glyph {
    display: flex;
    color: #7a8a7a;
    flex: 0 0 auto;
  }
  .status {
    color: #777;
    font-size: 0.85em;
    flex: 0 0 auto;
  }
  .priority {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    flex: 0 0 auto;
  }
  .priority-low { background: #6b8e6b; }
  .priority-medium { background: #d9a648; }
  .priority-high { background: #d97748; }
  .priority-urgent { background: #d94848; }
  .warn {
    display: flex;
    color: #d9a648;
    flex: 0 0 auto;
  }
  .composer {
    padding: 4px 6px 6px 20px;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .group-picker {
    display: flex;
    gap: 4px;
  }
  .group-picker button {
    background: transparent;
    border: 1px solid #3a3a3a;
    border-radius: 4px;
    color: #999;
    font-family: inherit;
    font-size: 0.85em;
    padding: 1px 6px;
    cursor: pointer;
  }
  .group-picker button.active {
    background: #333;
    color: #eee;
  }
  .composer input {
    background: #1e1e1e;
    border: 1px solid #444;
    border-radius: 4px;
    color: #eee;
    font-family: inherit;
    font-size: inherit;
    padding: 2px 6px;
  }
</style>
```

- [ ] **Step 2: Verify** — `npx svelte-check` 0 errors (the component is unused for now, which is fine).

- [ ] **Step 3: Commit** — `git add app/src/lib/PlanTree.svelte && git commit -m "feat(explorer): plan tree component"`

---

### Task 4: `PlanExplorerHubView.svelte` + hub registration

**Files:**
- Create: `app/src/lib/PlanExplorerHubView.svelte`
- Modify: `app/src/lib/workspaceViews.ts`

**Interfaces:**
- Consumes: Tasks 1–3, `gavinTrees`, `fetchBoard`/`kanbanState`, `openFileInSplit`, `switchWorkspaceView`, `plugin-dialog`.
- Produces (Task 5): the detail-pane slot the metadata panel plugs into; a `Plans` hub tab.

- [ ] **Step 1: The hub view** (metadata panel arrives in Task 5 — this task ends with tree + editor working):

```svelte
<script lang="ts">
  import { open } from "@tauri-apps/plugin-dialog";
  import { layoutState, openFileInSplit, switchWorkspaceView } from "./layoutState";
  import { gavinTrees } from "./gavinState";
  import { fetchBoard } from "./kanbanState";
  import { buildExplorerTree, isUnderRoot, newFilePath, slugFileName, type ExplorerContextNode, type ExplorerGroup } from "./planExplorer";
  import PlanTree from "./PlanTree.svelte";
  import FileEditor from "./FileEditor.svelte";
  import * as backend from "./backend";

  interface Props {
    workspaceId: string;
  }
  let { workspaceId }: Props = $props();

  let selectedPath = $state<string | null>(null);
  let error = $state<string | null>(null);

  const root = $derived($layoutState.workspaces.find((w) => w.id === workspaceId)?.rootPath ?? null);
  const contexts = $derived(buildExplorerTree($gavinTrees[workspaceId]));
  const allPaths = $derived(new Set(contexts.flatMap((c) => c.groups.flatMap((g) => g.files.map((f) => f.path)))));
  // Selection is held by PATH because the tree rebuilds on every watcher
  // push; a file deleted in a terminal must say so rather than leave a
  // stale buffer on screen.
  const selectionVanished = $derived(selectedPath !== null && !allPaths.has(selectedPath));

  // The board is only needed for Task 5's status dropdown, but fetching
  // here (idempotent) means the panel never renders an empty list.
  $effect(() => {
    void fetchBoard(workspaceId);
  });

  // A split needs a terminal session to anchor to; file and board tabs
  // are not sessions.
  const anchorSessionId = $derived.by(() => {
    const focused = $layoutState.focusedSessionId;
    if (!focused) return null;
    if ($layoutState.fileTabsById[focused] || $layoutState.boardTabsById[focused]) return null;
    return focused;
  });

  async function createFile(context: ExplorerContextNode, group: ExplorerGroup, title: string): Promise<void> {
    error = null;
    const fileName = slugFileName(title);
    if (!fileName) {
      error = "That title has no usable filename characters.";
      return;
    }
    try {
      if (group === "plans") {
        // Same daemon path agents use: validated, never overwrites.
        selectedPath = await backend.createPlan(context.folderPath, fileName, title);
      } else {
        const path = newFilePath(context.gavinDir, group, fileName);
        await backend.writeFileForEditor(path, `# ${title}\n`);
        selectedPath = path;
      }
    } catch (e) {
      error = String(e instanceof Error ? e.message : e);
    }
  }

  async function createContext(): Promise<void> {
    error = null;
    if (!root) return;
    const picked = await open({ directory: true, multiple: false, title: "Folder for the new gavin context" });
    if (typeof picked !== "string") return;
    if (!isUnderRoot(root, picked)) {
      error = "Pick a folder inside the workspace root — a context outside it is never scanned.";
      return;
    }
    try {
      await backend.createGavinContext(picked);
    } catch (e) {
      error = String(e instanceof Error ? e.message : e);
    }
  }

  async function openInSplit(path: string): Promise<void> {
    if (!anchorSessionId) return;
    await switchWorkspaceView(workspaceId, "terminal");
    await openFileInSplit(anchorSessionId, path);
  }
</script>

{#if !root}
  <div class="empty">No root folder set for this workspace.</div>
{:else}
  <div class="explorer">
    <div class="sidebar">
      <div class="sidebar-head">
        <span>Contexts</span>
        <button type="button" onclick={createContext} title="Create a .gavin context in a folder">+ context</button>
      </div>
      {#if contexts.length === 0}
        <div class="empty small">No .gavin folders yet — create one to start planning.</div>
      {:else}
        <PlanTree
          {contexts}
          {selectedPath}
          onSelect={(p) => (selectedPath = p)}
          onCreateFile={createFile}
          onOpenInSplit={anchorSessionId ? openInSplit : null}
        />
      {/if}
    </div>
    <div class="detail">
      {#if error}
        <div class="error-strip">
          <span>{error}</span>
          <button type="button" onclick={() => (error = null)}>✕</button>
        </div>
      {/if}
      {#if selectedPath === null}
        <div class="empty">Select a file.</div>
      {:else if selectionVanished}
        <div class="empty">This file no longer exists.</div>
      {:else}
        {#key selectedPath}
          <FileEditor path={selectedPath} />
        {/key}
      {/if}
    </div>
  </div>
{/if}

<style>
  .explorer {
    display: flex;
    height: 100%;
    min-height: 0;
  }
  .sidebar {
    width: 260px;
    flex: 0 0 auto;
    border-right: 1px solid #2f2f2f;
    display: flex;
    flex-direction: column;
    min-height: 0;
  }
  .sidebar-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 6px 8px;
    border-bottom: 1px solid #2f2f2f;
    color: #999;
    font-family: monospace;
    font-size: 0.75em;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    flex: 0 0 auto;
  }
  .sidebar-head button {
    background: transparent;
    border: 1px solid #3a3a3a;
    border-radius: 4px;
    color: #999;
    font-family: monospace;
    font-size: 1em;
    padding: 1px 6px;
    cursor: pointer;
    text-transform: none;
  }
  .detail {
    flex: 1 1 auto;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }
  .empty {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100%;
    color: #888;
    font-family: monospace;
    font-size: 0.85em;
    padding: 8px;
    text-align: center;
  }
  .empty.small {
    height: auto;
    padding: 16px 8px;
  }
  .error-strip {
    display: flex;
    align-items: center;
    gap: 10px;
    margin: 8px;
    padding: 6px 10px;
    border: 1px solid #a15c2f;
    border-radius: 6px;
    color: #e0b08a;
    font-family: monospace;
    font-size: 0.8em;
    flex: 0 0 auto;
  }
  .error-strip button {
    background: transparent;
    border: none;
    color: inherit;
    cursor: pointer;
    margin-left: auto;
  }
</style>
```

- [ ] **Step 2: Register the tab** (`workspaceViews.ts`): import `FolderTree` from `@lucide/svelte` (verify the name exists in the installed version — a wrong icon name fails the build) and `PlanExplorerHubView`, then add after the `agent-file` entry:

```typescript
  { id: "plans", label: "Plans", icon: FolderTree, component: PlanExplorerHubView, requiresRoot: true },
```

- [ ] **Step 3: Verify** — `npx svelte-check` 0 errors, `npx vitest run` green, `npm run build` succeeds.

- [ ] **Step 4: Commit** — `git add app/src && git commit -m "feat(explorer): Plans hub tab with tree, editor, and creation flows"`

---

### Task 5: `PlanMetadataPanel.svelte` + `FileEditor.flush()`

**Files:**
- Create: `app/src/lib/PlanMetadataPanel.svelte`
- Modify: `app/src/lib/FileEditor.svelte`, `app/src/lib/PlanExplorerHubView.svelte`

- [ ] **Step 1: Expose `flush()`** in `FileEditor.svelte`, beside `measure()`:

```typescript
  // Lets an outside writer (the plan metadata panel) land the buffer
  // before it rewrites one frontmatter line of the same file -- without
  // this, the panel's write trips the external-change conflict banner
  // against the user's own unsaved edits.
  export async function flush(): Promise<void> {
    await save();
  }
```

- [ ] **Step 2: The panel:**

```svelte
<script lang="ts">
  import type { PlanFileInfo } from "./gavin";
  import { statusOptions } from "./planExplorer";
  import { patchPlanField } from "./gavinState";
  import * as backend from "./backend";

  interface Props {
    plan: PlanFileInfo;
    workspaceId: string;
    columnNames: string[];
    // Lands any unsaved editor buffer before we rewrite a line of the
    // same file (see FileEditor.flush).
    onBeforeWrite: () => Promise<void>;
  }
  let { plan, workspaceId, columnNames, onBeforeWrite }: Props = $props();

  const PRIORITIES = ["none", "low", "medium", "high", "urgent"] as const;

  let titleDraft = $state(plan.title);
  let error = $state<string | null>(null);
  // Reset the draft when a different plan is selected.
  let draftFor = $state(plan.path);
  $effect(() => {
    if (draftFor !== plan.path) {
      titleDraft = plan.title;
      draftFor = plan.path;
    }
  });

  const options = $derived(statusOptions(columnNames, plan.status));

  async function commit(key: "title" | "status" | "priority", value: string): Promise<void> {
    error = null;
    try {
      await onBeforeWrite();
      await backend.setPlanFrontmatterField(plan.path, key, value);
      // Optimistic: the confirming watcher push is ~3s away.
      patchPlanField(workspaceId, plan.path, key, value);
    } catch (e) {
      error = String(e instanceof Error ? e.message : e);
    }
  }

  function commitTitle(): void {
    const next = titleDraft.trim();
    if (!next || next === plan.title) {
      titleDraft = plan.title;
      return;
    }
    void commit("title", next);
  }
</script>

<div class="panel">
  <input
    class="title"
    bind:value={titleDraft}
    onblur={commitTitle}
    onkeydown={(e) => {
      if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur();
      else if (e.key === "Escape") titleDraft = plan.title;
    }}
  />
  <label>
    Status
    <select value={plan.status ?? ""} onchange={(e) => void commit("status", (e.currentTarget as HTMLSelectElement).value)}>
      {#each options as option (option)}
        <option value={option}>{option}</option>
      {/each}
    </select>
  </label>
  <label>
    Priority
    <select
      value={plan.priority ?? "none"}
      onchange={(e) => void commit("priority", (e.currentTarget as HTMLSelectElement).value)}
    >
      {#each PRIORITIES as p (p)}
        <option value={p}>{p}</option>
      {/each}
    </select>
  </label>
  {#if plan.parseWarning}
    <span class="warn">frontmatter issues</span>
  {/if}
  {#if error}
    <span class="error">{error}</span>
  {/if}
</div>

<style>
  .panel {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px 10px;
    border-bottom: 1px solid #2f2f2f;
    font-family: monospace;
    font-size: 0.8em;
    color: #999;
    flex: 0 0 auto;
    flex-wrap: wrap;
  }
  .title {
    background: transparent;
    border: 1px solid transparent;
    border-radius: 4px;
    color: #eee;
    font-family: inherit;
    font-size: 1.1em;
    padding: 2px 6px;
    flex: 1 1 200px;
    min-width: 120px;
  }
  .title:hover,
  .title:focus {
    border-color: #444;
    background: #1e1e1e;
  }
  label {
    display: flex;
    align-items: center;
    gap: 4px;
  }
  select {
    background: #1e1e1e;
    color: #eee;
    border: 1px solid #444;
    border-radius: 4px;
    font-family: inherit;
    padding: 1px 4px;
  }
  .warn {
    color: #d9a648;
  }
  .error {
    color: #e0a0a0;
  }
</style>
```

- [ ] **Step 3: Wire it into the hub view.** In `PlanExplorerHubView.svelte`: import `PlanMetadataPanel` and `kanbanState`; add

```typescript
  let editor = $state<{ flush: () => Promise<void> } | null>(null);

  const columnNames = $derived(($kanbanState[workspaceId]?.columns ?? []).map((c) => c.name));
  // The selected file's PlanFileInfo, when it is a plan (docs and specs
  // have no frontmatter contract, so they get no panel).
  const selectedPlan = $derived.by(() => {
    const tree = $gavinTrees[workspaceId];
    if (!tree || !selectedPath) return null;
    for (const ctx of tree.contexts) {
      const found = ctx.plans.find((p) => p.path === selectedPath);
      if (found) return found;
    }
    return null;
  });
```

and replace the `{#key selectedPath}` block with:

```svelte
        {#key selectedPath}
          {#if selectedPlan}
            <PlanMetadataPanel
              plan={selectedPlan}
              {workspaceId}
              {columnNames}
              onBeforeWrite={async () => {
                await editor?.flush();
              }}
            />
          {/if}
          <FileEditor bind:this={editor} path={selectedPath} />
        {/key}
```

- [ ] **Step 4: Verify** — `npx svelte-check` 0 errors, `npx vitest run` green, `npm run build`, `cargo build`.

- [ ] **Step 5: Commit** — `git add app/src && git commit -m "feat(explorer): plan metadata panel with flush-before-write"`

---

### Task 6: Checklist, full gates, manual smoke

**Files:**
- Modify: `app/src/lib/smokeChecklist.ts`

- [ ] **Step 1: Add the section** to `SMOKE_SECTIONS`, after "Markdown editing":

```typescript
  {
    title: "Plan explorer",
    items: [
      { id: "exp-tab", text: "A Plans tab appears once a root is bound; tree shows contexts → Plans/Docs/Specs" },
      { id: "exp-meta", text: "Plan rows show status, priority dot, and ⚠ for broken frontmatter" },
      { id: "exp-select", text: "Clicking a file opens it in the editor on the right" },
      { id: "exp-new-plan", text: "+ → Plans → title → Enter creates the file, selects it, and it appears on the board (~3s)" },
      { id: "exp-new-doc", text: "+ → Docs creates a doc; a title with no usable characters shows an inline error instead" },
      { id: "exp-new-context", text: "“+ context” picker: a folder inside the root scaffolds .gavin; one outside is refused with a reason" },
      { id: "exp-status", text: "Changing Status in the metadata panel moves the card on the board" },
      { id: "exp-title", text: "Changing the title updates the card and the tree row — the filename does NOT change" },
      {
        id: "exp-no-conflict",
        text: "Type in the editor, then immediately change Status — NO conflict banner appears",
        hint: "The panel flushes the editor before writing; a banner here means that flush regressed.",
      },
      { id: "exp-vanished", text: "Delete the selected file in a terminal → detail pane says it no longer exists" },
      { id: "exp-split", text: "The split icon on a file row opens it beside a terminal (hidden with no terminal session)" },
    ],
  },
```

- [ ] **Step 2: Full gates** — `cargo test` (all crates), `npx vitest run`, `npx svelte-check` (0 errors), `npm run build`.

- [ ] **Step 3: Manual smoke** — run the new checklist section in the dev Smoke Test workspace. Present results honestly; do not claim a pass you did not observe.

- [ ] **Step 4: Commit** — `git add app/src && git commit -m "test(explorer): plan explorer smoke checklist section"`

---

## Testing summary

- Rust: 1 rewritten allow-list test, 1 new title test.
- Frontend: ~18 `planExplorer.ts` cases, 1 `patchPlanField` title case.
- Components (PlanTree, PlanExplorerHubView, PlanMetadataPanel): manual, via the new checklist section.

## Out of scope

Rename/delete (D29), non-markdown files, the Mission Control home (sub-6), drag-to-reorder within the tree.
