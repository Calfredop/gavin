# Plans ⇄ Kanban Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Plan files render as cards on the workspace board and per-session context boards; dragging writes the file's `status:` line; agent edits update boards live.

**Architecture:** Frontend projection (D14): a pure `planBoard.ts` merges `gavinTrees` into display columns at render time; one new daemon request (`SetPlanFrontmatterField`, allow-listed) writes frontmatter via the generalized surgical writer; an optimistic `gavinTrees` patch bridges the watcher's ~2.5 s confirmation latency. Board tabs are a third tab kind persisted exactly like file tabs (D17).

**Tech Stack:** Existing only — no new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-06-agent-orchestration-plans-kanban-design.md` — the requirements authority. Phase log: `docs/superpowers/brainstorms/2026-08-06-agent-orchestration-brainstorm.md` (D14–D17).

## Global Constraints

- User works **directly on `main`** — no worktree (standing preference).
- Subagent-cap history: seven collisions; inline execution is the standing fallback.
- The daemon-side field writer must stay allow-listed (`status`, `priority`) at the request-handling layer — it must never become an arbitrary-line writer; `priority` values are validated against the vocabulary, `status` is free text.
- Optimistic `gavinTrees` patches happen **only after** the write request resolves successfully — never before, never on failure.
- `LayoutState` gains a required `boardTabsById` field: every literal constructor breaks. Known sites: `layoutState.ts` `initialState`, `layoutState.test.ts` (the `setState` helper and the `beforeEach` literal), `confirmClose.test.ts` — plus grep `restoredSessionIds: new Set` to catch any others.
- Frontend-crossing Rust types are camelCase with a `json!` shape test (`BoardTabRecord`).
- Vitest lessons: mocked backend fns that get `.catch()`ed need `.mockResolvedValue(undefined)`; new module-level mutable state needs `__resetForTesting`.
- Board-tab close paths never call `killSession` and have nothing to unwatch.

---

### Task 1: Daemon — generalized field writer + SetPlanFrontmatterField

**Files:**
- Modify: `crates/protocol/src/lib.rs` (one request variant + roundtrip test)
- Modify: `crates/daemon/src/gavin.rs` (generalize `write_plan_status` → `write_plan_field`, add `set_plan_field` validator, update + extend tests)
- Modify: `crates/daemon/src/server.rs` (handle_request arm + one socket test)

**Interfaces:**
- Consumes: the shipped `write_plan_status` three-case semantics and its tests.
- Produces (for Task 2): `Request::SetPlanFrontmatterField { path, key, value }` handled end-to-end; `gavin::set_plan_field(path, key, value) -> anyhow::Result<()>` (also the future MCP tool body, spec §6).

- [ ] **Step 1: Protocol.** Add to `Request` (after `CreateGavinContext`):

```rust
    SetPlanFrontmatterField {
        path: String,
        key: String,
        value: String,
    },
```

and a roundtrip test beside the other gavin request tests:

```rust
    #[test]
    fn set_plan_frontmatter_field_request_roundtrips_through_json_line() {
        let mut buf = Vec::new();
        let req = Request::SetPlanFrontmatterField {
            path: "/tmp/ws/.gavin-root/plans/a.md".to_string(),
            key: "status".to_string(),
            value: "In Progress".to_string(),
        };
        write_message(&mut buf, &req).unwrap();
        let mut cursor = Cursor::new(buf);
        let decoded: Request = read_message(&mut cursor).unwrap().unwrap();
        match decoded {
            Request::SetPlanFrontmatterField { path, key, value } => {
                assert_eq!(path, "/tmp/ws/.gavin-root/plans/a.md");
                assert_eq!(key, "status");
                assert_eq!(value, "In Progress");
            }
            other => panic!("wrong variant: {other:?}"),
        }
    }
```

- [ ] **Step 2: Generalize the writer** in `gavin.rs`. Rename `write_plan_status(path, new_status)` to `write_plan_field(path: &Path, key: &str, value: &str)` — same three cases, parameterized key (make it private; `set_plan_field` below is the public surface):

```rust
/// Rewrites ONLY the `{key}:` line (spec §2): replace in place if present,
/// insert as the block's first line when the block lacks it, prepend a new
/// block when the file has none. Every other byte is preserved --
/// including the presence/absence of a trailing newline.
fn write_plan_field(path: &Path, key: &str, value: &str) -> anyhow::Result<()> {
    let content = std::fs::read_to_string(path)?;
    let had_trailing_newline = content.ends_with('\n');
    let lines: Vec<&str> = content.lines().collect();
    let mut out: Vec<String>;

    let fm = parse_frontmatter(&content);
    if fm.present {
        let close = lines.iter().skip(1).position(|l| *l == "---").map(|i| i + 1).unwrap();
        let field_line = lines[1..close]
            .iter()
            .position(|l| l.split_once(':').map(|(k, _)| k.trim() == key).unwrap_or(false))
            .map(|i| i + 1);
        out = lines.iter().map(|l| l.to_string()).collect();
        match field_line {
            Some(i) => out[i] = format!("{key}: {value}"),
            None => out.insert(1, format!("{key}: {value}")),
        }
    } else {
        out = vec!["---".to_string(), format!("{key}: {value}"), "---".to_string()];
        out.extend(lines.iter().map(|l| l.to_string()));
    }

    let mut rebuilt = out.join("\n");
    if had_trailing_newline || content.is_empty() {
        rebuilt.push('\n');
    }
    std::fs::write(path, rebuilt)?;
    Ok(())
}

/// The public, validated entry point (and the future MCP tool body). The
/// allow-list is enforced HERE, not trusted to callers -- this must never
/// become an arbitrary-line writer.
pub fn set_plan_field(path: &Path, key: &str, value: &str) -> anyhow::Result<()> {
    match key {
        "status" => {} // free text
        "priority" => {
            if parse_priority(value).is_none() {
                anyhow::bail!("invalid priority value: {value}");
            }
        }
        other => anyhow::bail!("field not allowed: {other}"),
    }
    write_plan_field(path, key, value)
}
```

Update the three existing `write_plan_status` tests to call `write_plan_field(&path, "status", …)` (assertions unchanged), and add:

```rust
    #[test]
    fn write_plan_field_replaces_a_priority_line() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("p.md");
        std::fs::write(&path, "---\nstatus: To Do\npriority: low\n---\nbody\n").unwrap();
        set_plan_field(&path, "priority", "urgent").unwrap();
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "---\nstatus: To Do\npriority: urgent\n---\nbody\n"
        );
    }

    #[test]
    fn set_plan_field_rejects_disallowed_keys_and_invalid_priorities() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("p.md");
        std::fs::write(&path, "---\nstatus: To Do\n---\n").unwrap();
        assert!(set_plan_field(&path, "title", "x").is_err());
        assert!(set_plan_field(&path, "priority", "banana").is_err());
        // Neither failed call may touch the file:
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "---\nstatus: To Do\n---\n");
        // Case-insensitive priority is accepted:
        set_plan_field(&path, "priority", "HIGH").unwrap();
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "---\npriority: HIGH\nstatus: To Do\n---\n"
        );
    }
```

- [ ] **Step 3: Server arm** (after `CreateGavinContext`'s arm):

```rust
        Request::SetPlanFrontmatterField { path, key, value } => {
            crate::gavin::set_plan_field(std::path::Path::new(&path), &key, &value)
                .map(|_| Response::Ok)
        }
```

and one socket-level test beside the gavin integration tests:

```rust
    #[test]
    fn set_plan_frontmatter_field_over_socket_writes_and_rejects() {
        let (socket_path, _dir) = start_test_server();
        let ws_dir = tempfile::tempdir().unwrap();
        let plan = ws_dir.path().join("p.md");
        std::fs::write(&plan, "---\nstatus: To Do\n---\n# P\n").unwrap();
        let mut cmd = UnixStream::connect(&socket_path).unwrap();

        let resp = request(
            &mut cmd,
            &Request::SetPlanFrontmatterField {
                path: plan.to_string_lossy().to_string(),
                key: "status".to_string(),
                value: "Done".to_string(),
            },
        );
        assert!(matches!(resp, Response::Ok));
        assert_eq!(std::fs::read_to_string(&plan).unwrap(), "---\nstatus: Done\n---\n# P\n");

        let resp = request(
            &mut cmd,
            &Request::SetPlanFrontmatterField {
                path: plan.to_string_lossy().to_string(),
                key: "owner".to_string(),
                value: "alice".to_string(),
            },
        );
        assert!(matches!(resp, Response::Error { .. }));
    }
```

- [ ] **Step 4: Verify** — `cargo test -p protocol -p gavin-daemon` all green.

- [ ] **Step 5: Commit** — `git add crates && git commit -m "feat(daemon): allow-listed plan frontmatter field writer"`

---

### Task 2: Rust app layer — board_tabs config + commands + wrappers

**Files:**
- Modify: `app/src-tauri/src/config.rs` (BoardTabRecord + field + tests)
- Modify: `app/src-tauri/src/session.rs` (persist 5th param + all call sites, BoardTabs state, get/set commands, `set_plan_frontmatter_field` command, bootstrap hydration + union skip)
- Modify: `app/src-tauri/src/lib.rs` (register 3 commands)
- Modify: `app/src/lib/gavin.ts` (BoardTab interface)
- Modify: `app/src/lib/backend.ts` (3 wrappers)

**Interfaces:**
- Consumes: Task 1's request; the `FileTabs` pattern (session.rs:61-176) verbatim as the template.
- Produces (for Tasks 4-6): commands `get_board_tabs() -> Record<tabId, BoardTab>`, `set_board_tabs(boardTabs)`, `set_plan_frontmatter_field(path, key, value)`; TS `BoardTab { workspaceId: string; contextFolder: string }`.

- [ ] **Step 1: config.rs.** Add above `AppConfig`:

```rust
/// One persisted board tab: which workspace's board, filtered to which
/// gavin context. Crosses to the frontend via get/set_board_tabs, hence
/// camelCase (verified by the shape test below).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BoardTabRecord {
    pub workspace_id: String,
    pub context_folder: String,
}
```

and to `AppConfig` after `file_tabs` (mirroring its doc comment style):

```rust
    /// Open per-context board tabs, keyed by tab id (same opaque id space
    /// as session/file tabs in the pane tree). Like file_tabs, persists
    /// alongside `workspaces` and must always be carried through
    /// persist_workspaces, or it silently resets to empty on save.
    #[serde(default)]
    pub board_tabs: HashMap<String, BoardTabRecord>,
```

Update every `AppConfig` literal in config.rs tests (add `board_tabs: HashMap::new()`), and add three tests (mirror the file_tabs ones): roundtrip with one record, absent-field default from an older config string, and:

```rust
    #[test]
    fn board_tab_record_serializes_to_the_camel_case_shape_the_frontend_expects() {
        let record = BoardTabRecord {
            workspace_id: "ws-1".to_string(),
            context_folder: "/tmp/ws/auth".to_string(),
        };
        assert_eq!(
            serde_json::to_value(&record).unwrap(),
            serde_json::json!({ "workspaceId": "ws-1", "contextFolder": "/tmp/ws/auth" })
        );
    }
```

- [ ] **Step 2: session.rs.** `persist_workspaces` gains `board_tabs: HashMap<String, crate::config::BoardTabRecord>` as a fifth param and passes it into the `AppConfig` literal. **Grep every call site** (`rg -n "persist_workspaces\(" app/src-tauri/src`) and update each to read the `BoardTabs` state (or the just-loaded config value, in `bootstrap`) — the always-carry rule from the doc comment applies. Add beside `FileTabs`:

```rust
/// Open per-context board tabs (tab id -> BoardTabRecord). Same
/// always-carry persistence contract as FileTabs.
pub struct BoardTabs(pub Mutex<HashMap<String, crate::config::BoardTabRecord>>);
```

commands mirroring `get_file_tabs`/`set_file_tabs` exactly (same states read, same persist call — copy the neighbor, substitute the map), plus:

```rust
#[tauri::command]
pub fn set_plan_frontmatter_field(
    path: String,
    key: String,
    value: String,
    state: State<CommandConnection>,
) -> Result<(), String> {
    let resp = send_command(&state.0, &Request::SetPlanFrontmatterField { path, key, value })
        .map_err(|e| e.to_string())?;
    match resp {
        Response::Ok => Ok(()),
        Response::Error { message } => Err(message),
        other => Err(format!("unexpected response: {other:?}")),
    }
}
```

In `bootstrap`: load `config.board_tabs`, `app_handle.manage(BoardTabs(Mutex::new(board_tabs.clone())))`, and extend the skip set — replace the `file_tab_ids` construction with:

```rust
    let non_session_tab_ids: HashSet<String> =
        file_tabs.keys().chain(board_tabs.keys()).cloned().collect();
```

used both by `resolve_workspaces(&mut workspaces, &command_conn, &non_session_tab_ids)` and the Attach-loop filter (rename the parameter/doc in `resolve_sessions`/`resolve_workspaces` from `file_tab_ids` to `non_session_tab_ids` — the meaning is now "ids the daemon has never heard of").

- [ ] **Step 3: lib.rs** — add `session::get_board_tabs, session::set_board_tabs, session::set_plan_frontmatter_field` to `generate_handler![]`.

- [ ] **Step 4: TS.** In `gavin.ts`:

```typescript
export interface BoardTab {
  workspaceId: string;
  contextFolder: string;
}
```

In `backend.ts` (import `BoardTab` from `./gavin`):

```typescript
export function getBoardTabs(): Promise<Record<string, BoardTab>> {
  return invoke("get_board_tabs");
}

export function setBoardTabs(boardTabs: Record<string, BoardTab>): Promise<void> {
  return invoke("set_board_tabs", { boardTabs });
}

export function setPlanFrontmatterField(path: string, key: "status" | "priority", value: string): Promise<void> {
  return invoke("set_plan_frontmatter_field", { path, key, value });
}
```

- [ ] **Step 5: Verify** — `cargo test -p app` green (config tests), `cargo build` clean, `npx svelte-check` clean.

- [ ] **Step 6: Commit** — `git add app crates && git commit -m "feat(app): persisted board tabs, plan field write command"`

---

### Task 3: Pure projection — planBoard.ts + optimistic patch

**Files:**
- Create: `app/src/lib/planBoard.ts`
- Test: `app/src/lib/planBoard.test.ts`
- Modify: `app/src/lib/gavinState.ts` (`patchPlanField`)
- Modify: `app/src/lib/gavinState.test.ts`

**Interfaces:**
- Consumes: `Board`/`Column` from `kanban.ts`, `GavinTree`/`GavinContext`/`PlanFileInfo` from `gavin.ts`.
- Produces (for Tasks 5-6): `slugStatus`, `PlanCardView`, `DisplayColumn`, `AutoColumn`, `mergePlanCards(board, tree, filter?)`, `nearestContext(tree, cwd)`, `patchPlanField(workspaceId, path, key, value)`.

- [ ] **Step 1: Write the failing tests** (`planBoard.test.ts`) — pure, no mocks:

```typescript
import { describe, it, expect } from "vitest";
import { slugStatus, mergePlanCards, nearestContext } from "./planBoard";
import type { Board, Column } from "./kanban";
import type { GavinContext, GavinTree, PlanFileInfo } from "./gavin";

function col(id: string, name: string, cardTitles: string[] = []): Column {
  return {
    id,
    name,
    position: 0,
    cards: cardTitles.map((title, i) => ({
      id: `${id}-${i}`,
      title,
      description: "",
      labelIds: [],
      priority: "none",
      position: i,
    })),
  };
}

function plan(fileName: string, status: string | null, overrides: Partial<PlanFileInfo> = {}): PlanFileInfo {
  return {
    path: `/ws/.gavin-root/plans/${fileName}`,
    fileName,
    title: fileName.replace(/\.md$/, ""),
    status,
    priority: null,
    parseWarning: false,
    ...overrides,
  };
}

function ctx(folderPath: string, name: string, plans: PlanFileInfo[]): GavinContext {
  return { folderPath, kind: "context", name, plans, docs: [], specs: [], hasPrd: false, configWarning: false };
}

function tree(contexts: GavinContext[]): GavinTree {
  return { rootPath: "/ws", rootMissing: false, contexts };
}

const board: Board = { columns: [col("c1", "To Do", ["free card"]), col("c2", "In Progress")], labels: [] };

describe("slugStatus", () => {
  it("normalizes case, spacing, and separators", () => {
    for (const s of ["In Progress", "in-progress", "in_progress", " IN  PROGRESS "]) {
      expect(slugStatus(s)).toBe("in-progress");
    }
    expect(slugStatus("—")).toBe("");
  });
});

describe("mergePlanCards", () => {
  it("matches plans to columns by slug and appends after free-form cards", () => {
    const t = tree([ctx("/ws", "root", [plan("a.md", "in_progress"), plan("b.md", "To Do")])]);
    const { columns, autoColumns } = mergePlanCards(board, t);
    expect(columns[0].column.cards).toHaveLength(1); // free-form untouched
    expect(columns[0].planCards.map((p) => p.fileName)).toEqual(["b.md"]);
    expect(columns[1].planCards.map((p) => p.fileName)).toEqual(["a.md"]);
    expect(autoColumns).toEqual([]);
  });

  it("sends missing and empty-slug statuses to the first column", () => {
    const t = tree([ctx("/ws", "root", [plan("a.md", null), plan("b.md", "—")])]);
    const { columns } = mergePlanCards(board, t);
    expect(columns[0].planCards.map((p) => p.fileName)).toEqual(["a.md", "b.md"]);
  });

  it("groups unmatched statuses into auto columns after the real ones", () => {
    const t = tree([ctx("/ws", "root", [plan("a.md", "Blocked"), plan("b.md", "blocked"), plan("c.md", "Review")])]);
    const { autoColumns } = mergePlanCards(board, t);
    expect(autoColumns.map((a) => a.status)).toEqual(["Blocked", "Review"]);
    expect(autoColumns[0].planCards).toHaveLength(2);
  });

  it("sorts plan cards by context folder then file name", () => {
    const t = tree([
      ctx("/ws/zeta", "zeta", [plan("z.md", "To Do"), plan("a.md", "To Do")]),
      ctx("/ws/alpha", "alpha", [plan("m.md", "To Do")]),
    ]);
    const { columns } = mergePlanCards(board, t);
    expect(columns[0].planCards.map((p) => `${p.contextName}/${p.fileName}`)).toEqual([
      "alpha/m.md",
      "zeta/a.md",
      "zeta/z.md",
    ]);
  });

  it("context filter keeps only that context's plans and drops free-form cards", () => {
    const t = tree([
      ctx("/ws", "root", [plan("r.md", "To Do")]),
      ctx("/ws/auth", "auth", [plan("a.md", "To Do")]),
    ]);
    const { columns } = mergePlanCards(board, t, { contextFolder: "/ws/auth" });
    expect(columns[0].column.cards).toEqual([]); // structure only
    expect(columns[0].planCards.map((p) => p.fileName)).toEqual(["a.md"]);
  });

  it("yields zero plan cards for an absent or root_missing tree", () => {
    expect(mergePlanCards(board, undefined).columns[0].planCards).toEqual([]);
    const missing: GavinTree = { rootPath: "/ws", rootMissing: true, contexts: [] };
    expect(mergePlanCards(board, missing).autoColumns).toEqual([]);
  });

  it("puts statusless plans into a '(no status)' auto column when the board has zero columns", () => {
    const empty: Board = { columns: [], labels: [] };
    const t = tree([ctx("/ws", "root", [plan("a.md", null)])]);
    const { autoColumns } = mergePlanCards(empty, t);
    expect(autoColumns).toHaveLength(1);
    expect(autoColumns[0].planCards.map((p) => p.fileName)).toEqual(["a.md"]);
  });
});

describe("nearestContext", () => {
  const t = tree([ctx("/ws", "root", []), ctx("/ws/auth", "auth", []), ctx("/ws/auth/deep", "deep", [])]);
  it("picks the deepest ancestor, including exact matches", () => {
    expect(nearestContext(t, "/ws/auth/deep/src")?.name).toBe("deep");
    expect(nearestContext(t, "/ws/auth")?.name).toBe("auth");
    expect(nearestContext(t, "/ws/other")?.name).toBe("root");
  });
  it("is path-segment aware", () => {
    expect(nearestContext(t, "/ws/auth2")?.name).toBe("root");
  });
  it("returns null without a tree, cwd, or match", () => {
    expect(nearestContext(undefined, "/ws")).toBeNull();
    expect(nearestContext(t, undefined)).toBeNull();
    expect(nearestContext(t, "/elsewhere")).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure** (`npx vitest run src/lib/planBoard.test.ts` → module not found).

- [ ] **Step 3: Implement `planBoard.ts`:**

```typescript
import type { Board, Column } from "./kanban";
import type { GavinContext, GavinTree, PlanFileInfo } from "./gavin";

export interface PlanCardView {
  id: string; // the plan file's absolute path — stable identity
  title: string;
  status: string | null;
  priority: PlanFileInfo["priority"];
  contextName: string;
  fileName: string;
  parseWarning: boolean;
}

export interface DisplayColumn {
  column: Column;
  planCards: PlanCardView[];
}

export interface AutoColumn {
  status: string;
  planCards: PlanCardView[];
}

// "In Progress", "in-progress", "in_progress", " IN  PROGRESS " all meet.
export function slugStatus(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function planView(ctx: GavinContext, plan: PlanFileInfo): PlanCardView {
  return {
    id: plan.path,
    title: plan.title,
    status: plan.status,
    priority: plan.priority,
    contextName: ctx.name,
    fileName: plan.fileName,
    parseWarning: plan.parseWarning,
  };
}

// The board's plan-card projection (spec §1). With `filter`, only that
// context's plans appear AND free-form cards are dropped (the per-session
// board shows the columns for structure only). Statuses whose slug is
// empty count as no status; no status lands in the first real column, or
// in a "(no status)" auto column when the board has none.
export function mergePlanCards(
  board: Board,
  tree: GavinTree | undefined,
  filter?: { contextFolder: string }
): { columns: DisplayColumn[]; autoColumns: AutoColumn[] } {
  const columns: DisplayColumn[] = board.columns.map((column) => ({
    column: filter ? { ...column, cards: [] } : column,
    planCards: [],
  }));

  const contexts =
    !tree || tree.rootMissing
      ? []
      : filter
        ? tree.contexts.filter((c) => c.folderPath === filter.contextFolder)
        : tree.contexts;

  const entries: Array<{ ctx: GavinContext; plan: PlanFileInfo }> = [];
  for (const ctx of contexts) {
    for (const plan of ctx.plans) entries.push({ ctx, plan });
  }
  entries.sort(
    (a, b) =>
      a.ctx.folderPath.localeCompare(b.ctx.folderPath) || a.plan.fileName.localeCompare(b.plan.fileName)
  );

  const columnBySlug = new Map<string, DisplayColumn>();
  for (const dc of columns) {
    const slug = slugStatus(dc.column.name);
    if (slug && !columnBySlug.has(slug)) columnBySlug.set(slug, dc);
  }

  const NO_STATUS = "(no status)";
  const autoByKey = new Map<string, AutoColumn>();
  for (const { ctx, plan } of entries) {
    const view = planView(ctx, plan);
    const slug = plan.status ? slugStatus(plan.status) : "";
    if (!slug) {
      if (columns.length > 0) {
        columns[0].planCards.push(view);
      } else {
        const auto = autoByKey.get("") ?? { status: NO_STATUS, planCards: [] };
        auto.planCards.push(view);
        autoByKey.set("", auto);
      }
      continue;
    }
    const target = columnBySlug.get(slug);
    if (target) {
      target.planCards.push(view);
    } else {
      // Key by slug so "Blocked" and "blocked" share one auto column;
      // label with the first raw spelling seen.
      const auto = autoByKey.get(slug) ?? { status: plan.status ?? slug, planCards: [] };
      auto.planCards.push(view);
      autoByKey.set(slug, auto);
    }
  }

  const autoColumns = [...autoByKey.values()].sort((a, b) => a.status.localeCompare(b.status));
  return { columns, autoColumns };
}

// The deepest context whose folderPath is an ancestor of (or equal to)
// cwd, path-segment aware ("/a/auth2" is not under "/a/auth"). The root
// context participates like any other.
export function nearestContext(tree: GavinTree | undefined, cwd: string | undefined): GavinContext | null {
  if (!tree || tree.rootMissing || !cwd) return null;
  let best: GavinContext | null = null;
  for (const ctx of tree.contexts) {
    const folder = ctx.folderPath;
    const isAncestor = cwd === folder || cwd.startsWith(folder.endsWith("/") ? folder : folder + "/");
    if (isAncestor && (!best || folder.length > best.folderPath.length)) {
      best = ctx;
    }
  }
  return best;
}
```

- [ ] **Step 4: Run** — planBoard tests green.

- [ ] **Step 5: `patchPlanField`** in `gavinState.ts` (+ tests). Implementation:

```typescript
// (add `import type { PlanFileInfo } from "./gavin";` to gavinState.ts)
// Optimistic bridge for the watcher's debounce+floor confirmation latency
// (spec §2): called ONLY after a successful SetPlanFrontmatterField, so a
// dragged card doesn't snap back while waiting ~2.5s for the push. The
// eventual push carries the same tree and re-renders as a no-op.
export function patchPlanField(
  workspaceId: string,
  path: string,
  key: "status" | "priority",
  value: string
): void {
  gavinTrees.update((m) => {
    const tree = m[workspaceId];
    if (!tree) return m;
    const contexts = tree.contexts.map((ctx) => ({
      ...ctx,
      plans: ctx.plans.map((p) =>
        p.path === path
          ? key === "status"
            ? { ...p, status: value }
            : { ...p, priority: value.toLowerCase() as PlanFileInfo["priority"] }
          : p
      ),
    }));
    return { ...m, [workspaceId]: { ...tree, contexts } };
  });
}
```

Tests (in `gavinState.test.ts`, reusing its `__resetForTesting`):

```typescript
  it("patchPlanField updates only the targeted plan", async () => {
    await initGavinListeners();
    const handler = vi.mocked(listen).mock.calls[0][1] as (e: { payload: [string, GavinTree] }) => void;
    const t: GavinTree = {
      rootPath: "/ws",
      rootMissing: false,
      contexts: [
        {
          folderPath: "/ws",
          kind: "root",
          name: "root",
          plans: [
            { path: "/ws/a.md", fileName: "a.md", title: "a", status: "To Do", priority: null, parseWarning: false },
            { path: "/ws/b.md", fileName: "b.md", title: "b", status: "To Do", priority: null, parseWarning: false },
          ],
          docs: [],
          specs: [],
          hasPrd: true,
          configWarning: false,
        },
      ],
    };
    handler({ payload: ["ws-1", t] });
    patchPlanField("ws-1", "/ws/a.md", "status", "Done");
    patchPlanField("ws-1", "/ws/b.md", "priority", "HIGH");
    const after = get(gavinTrees)["ws-1"].contexts[0].plans;
    expect(after[0].status).toBe("Done");
    expect(after[0].priority).toBeNull();
    expect(after[1].status).toBe("To Do");
    expect(after[1].priority).toBe("high");
  });
```

(import `patchPlanField` in the test file; `plans`' element type needs no extra import — it's structural).

- [ ] **Step 6: Run** the full frontend suite — green.

- [ ] **Step 7: Commit** — `git add app/src && git commit -m "feat(app): plan-card projection, slug matching, optimistic patch"`

---

### Task 4: layoutState — board tabs, openBoardInSplit, close paths, drag kind

**Files:**
- Modify: `app/src/lib/dragDrop.ts` (payload union + kind list)
- Modify: `app/src/lib/layoutState.ts`
- Modify: `app/src/lib/confirmClose.ts`
- Modify: `app/src/lib/layoutState.test.ts`, `app/src/lib/confirmClose.test.ts`

**Interfaces:**
- Consumes: Task 2's `getBoardTabs`/`setBoardTabs`; Task 3's types; the `fileTabsById` pattern throughout.
- Produces (for Tasks 5-6): `LayoutState.boardTabsById: Record<string, BoardTab>`; `openBoardInSplit(anchorSessionId, workspaceId, contextFolder)`; generalized `endTabs`/confirm counting; `{ kind: "plan-card"; path: string }` drag payloads.

- [ ] **Step 1: dragDrop.ts** — add to the `DragPayload` union:

```typescript
  | { kind: "plan-card"; path: string }
```

and `"plan-card"` to `DRAG_KINDS`.

- [ ] **Step 2: layoutState.ts.**
  - `import type { BoardTab } from "./gavin";` and add `boardTabsById: Record<string, BoardTab>;` to the `LayoutState` interface + `boardTabsById: {}` to `initialState`.
  - Bootstrap hydration — a third one-shot fetch mirroring `getFileTabs` (same best-effort comment style):

```typescript
  void backend
    .getBoardTabs()
    .then((boardTabsById) => {
      layoutState.update((s) => ({ ...s, boardTabsById }));
    })
    .catch(() => {});
```

  - `endTabs` generalizes (update signature and BOTH the file-tab and new board-tab branches; then grep `endTabs(` and pass `state.boardTabsById` at every call site — closeSession, closePane, closePage, closeWorkspace):

```typescript
async function endTabs(
  tabIds: string[],
  fileTabsById: Record<string, FileTab>,
  boardTabsById: Record<string, BoardTab>
): Promise<boolean> {
  const closedFileTabIds: string[] = [];
  const closedBoardTabIds: string[] = [];
  for (const id of tabIds) {
    const fileTab = fileTabsById[id];
    if (fileTab) {
      await backend.unwatchFileForViewer(fileTab.path).catch(() => {});
      closedFileTabIds.push(id);
      continue;
    }
    if (boardTabsById[id]) {
      // A board tab is not a session and holds no watcher of its own --
      // tree watching is workspace-level. Prune and persist only.
      closedBoardTabIds.push(id);
      continue;
    }
    try {
      await backend.killSession(id);
    } catch (e) {
      setError(String(e));
      return false;
    }
  }
  if (closedFileTabIds.length > 0) await pruneFileTabs(closedFileTabIds);
  if (closedBoardTabIds.length > 0) await pruneBoardTabs(closedBoardTabIds);
  return true;
}

// Mirrors pruneFileTabs: best-effort persistence, a failed prune costs a
// stale entry, never a broken close.
async function pruneBoardTabs(closedIds: string[]): Promise<void> {
  const remaining: Record<string, BoardTab> = {};
  for (const [id, tab] of Object.entries(get(layoutState).boardTabsById)) {
    if (!closedIds.includes(id)) remaining[id] = tab;
  }
  layoutState.update((s) => ({ ...s, boardTabsById: remaining }));
  await backend.setBoardTabs(remaining).catch(() => {});
}
```

  - `openBoardInSplit` right after `openFileInSplit`, mirroring it:

```typescript
// Opens a context board as a new board tab, split beside the pane holding
// `anchorSessionId` -- the pane board-icon flow's entry point. Mirrors
// openFileInSplit exactly, with boardTabsById/setBoardTabs in place of the
// file-tab map.
export async function openBoardInSplit(
  anchorSessionId: string,
  workspaceId: string,
  contextFolder: string
): Promise<void> {
  const state = get(layoutState);
  const location = activePageLocation(state);
  if (!location) return;
  const tabId = crypto.randomUUID();
  const newTree = layout.splitLeaf(location.tree, anchorSessionId, "row", tabId);
  const withTree = workspace.updatePageLayout(state, location.workspaceId, location.pageId, newTree);
  const data = workspace.setPageFocus(withTree, location.workspaceId, location.pageId, tabId);
  const boardTabsById = { ...state.boardTabsById, [tabId]: { workspaceId, contextFolder } };
  layoutState.update((s) => ({ ...s, workspaces: data.workspaces, focusedSessionId: tabId, boardTabsById }));
  try {
    await backend.setBoardTabs(boardTabsById);
  } catch (e) {
    setError(String(e));
    return;
  }
  await persistWorkspaces(data.workspaces, state.activeWorkspaceId);
}
```

- [ ] **Step 3: confirmClose.ts** — generalize the filter and the tab early-return; update all four confirm functions' calls:

```typescript
// Neither a file tab nor a board tab is a terminal session: closing one
// ends no process, so neither may appear in a "N terminal sessions will
// end" count.
function sessionTabsOnly(
  ids: string[],
  fileTabsById: Record<string, { path: string }>,
  boardTabsById: Record<string, unknown>
): string[] {
  return ids.filter((id) => !fileTabsById[id] && !boardTabsById[id]);
}
```

(in `confirmTabClose`: `if (state.fileTabsById[sessionId] || state.boardTabsById[sessionId]) return true;`).

- [ ] **Step 4: Fix every `LayoutState` literal** — `layoutState.ts` `initialState` (done in Step 2), `layoutState.test.ts` `setState` helper + `beforeEach` literal, `confirmClose.test.ts` literals; then `rg -n "restoredSessionIds: new Set" app/src` to confirm no site is missed. Add to the layoutState.test.ts mock factory: `getBoardTabs: vi.fn().mockResolvedValue({})`, `setBoardTabs: vi.fn().mockResolvedValue(undefined)`.

- [ ] **Step 5: Tests.**
  - layoutState.test.ts:

```typescript
describe("openBoardInSplit", () => {
  it("splits beside the anchor, records the board tab, persists, spawns nothing", async () => {
    setState([ws("ws-1", [page("page-1", leaf(["a"]))])], "ws-1", "a");

    await openBoardInSplit("a", "ws-1", "/ws/auth");

    const state = get(layoutState);
    const layoutNode = state.workspaces[0].pages[0].layout;
    expect(layoutNode.type).toBe("split");
    const boardTabIds = Object.keys(state.boardTabsById);
    expect(boardTabIds).toHaveLength(1);
    expect(state.boardTabsById[boardTabIds[0]]).toEqual({ workspaceId: "ws-1", contextFolder: "/ws/auth" });
    expect(state.focusedSessionId).toBe(boardTabIds[0]);
    expect(backend.setBoardTabs).toHaveBeenCalledWith(state.boardTabsById);
    expect(backend.setWorkspacesState).toHaveBeenCalled();
    expect(backend.createSession).not.toHaveBeenCalled();
  });
});

describe("closing board tabs", () => {
  it("closeSession on a board tab prunes it without killing anything", async () => {
    setState([ws("ws-1", [page("page-1", leaf(["a", "bt-1"]))])], "ws-1", "a");
    layoutState.update((s) => ({
      ...s,
      boardTabsById: { "bt-1": { workspaceId: "ws-1", contextFolder: "/ws/auth" } },
    }));

    await closeSession("bt-1");

    expect(backend.killSession).not.toHaveBeenCalled();
    expect(get(layoutState).boardTabsById).toEqual({});
    expect(backend.setBoardTabs).toHaveBeenCalledWith({});
  });
});
```

  (import `openBoardInSplit` from `./layoutState`.)
  - confirmClose.test.ts: extend the existing counting tests (read them first, follow their structure) with one case where a pane holds one session + one file tab + one board tab and the count says `1`.

- [ ] **Step 6: Run** — full frontend suite + `npx svelte-check` green.

- [ ] **Step 7: Commit** — `git add app/src && git commit -m "feat(app): board tabs in layout state, openBoardInSplit, close-path handling"`

---

### Task 5: Board UI — plan cards, auto columns, drop write-back, detail modal

**Files:**
- Create: `app/src/lib/PlanKanbanCard.svelte`
- Create: `app/src/lib/PlanDetailModal.svelte`
- Modify: `app/src/lib/KanbanColumn.svelte`
- Modify: `app/src/lib/KanbanBoard.svelte`

**Interfaces:**
- Consumes: Tasks 2-4 (`setPlanFrontmatterField`, `patchPlanField`, `mergePlanCards`, the `plan-card` drag kind); `KanbanCard.svelte`'s styling vocabulary; `CardDetailModal.svelte`'s field/select markup; `FileViewerPane.svelte`'s `openPath` usage from `@tauri-apps/plugin-opener` (read it for the exact import/error handling before writing the modal).
- Produces (for Task 6): `PlanKanbanCard` + `PlanDetailModal` reused verbatim by `BoardPane`; `KanbanColumn`'s `planCards`/`onOpenPlanCard`/`onPlanDrop` props.

- [ ] **Step 1: `PlanKanbanCard.svelte`** — visually a sibling of `KanbanCard` (same card/priority classes, dashed border + file glyph + context badge to mark it file-backed, no delete button):

```svelte
<script lang="ts">
  import type { PlanCardView } from "./planBoard";
  import { setDragPayload } from "./dragDrop";
  import { FileText, TriangleAlert } from "@lucide/svelte";

  interface Props {
    plan: PlanCardView;
    onOpen: () => void;
  }
  let { plan, onOpen }: Props = $props();

  function handleDragStart(event: DragEvent): void {
    setDragPayload(event, { kind: "plan-card", path: plan.id });
  }
</script>

<div class="card" draggable="true" ondragstart={handleDragStart} onclick={onOpen} role="button" tabindex="0">
  <div class="header">
    <span class="glyph" title="Plan file"><FileText size={11} /></span>
    {#if plan.priority && plan.priority !== "none"}
      <span class="priority priority-{plan.priority}" title="Priority: {plan.priority}"></span>
    {/if}
    {#if plan.parseWarning}
      <span class="warning" title="This plan's frontmatter has issues"><TriangleAlert size={11} /></span>
    {/if}
  </div>
  <div class="title">{plan.title}</div>
  <div class="context-badge" title={plan.id}>{plan.contextName}</div>
</div>

<style>
  .card {
    background: #262b26;
    border: 1px dashed #4c584c;
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
  .glyph {
    display: flex;
    align-items: center;
    color: #8bc98b;
  }
  .priority {
    display: inline-block;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex: 0 0 auto;
  }
  .priority-low { background: #6b8e6b; }
  .priority-medium { background: #d9a648; }
  .priority-high { background: #d97748; }
  .priority-urgent { background: #d94848; }
  .warning {
    display: flex;
    align-items: center;
    color: #d9a648;
    margin-left: auto;
  }
  .title {
    word-break: break-word;
  }
  .context-badge {
    display: inline-block;
    border: 1px solid #4c584c;
    border-radius: 10px;
    padding: 1px 6px;
    font-size: 0.8em;
    color: #8bc98b;
    margin-top: 6px;
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
```

- [ ] **Step 2: `PlanDetailModal.svelte`** — read-only fields + the one write control (priority, immediate write, D15/D16):

```svelte
<script lang="ts">
  import Modal from "./Modal.svelte";
  import type { PlanCardView } from "./planBoard";
  import type { Priority } from "./kanban";
  import * as backend from "./backend";
  import { patchPlanField } from "./gavinState";
  import { openPath } from "@tauri-apps/plugin-opener";

  interface Props {
    plan: PlanCardView;
    workspaceId: string;
    onClose: () => void;
  }
  let { plan, workspaceId, onClose }: Props = $props();

  const PRIORITIES: Priority[] = ["none", "low", "medium", "high", "urgent"];
  let priority = $state<Priority>(plan.priority ?? "none");
  let errorMessage = $state<string | null>(null);

  async function changePriority(): Promise<void> {
    errorMessage = null;
    try {
      await backend.setPlanFrontmatterField(plan.id, "priority", priority);
      patchPlanField(workspaceId, plan.id, "priority", priority);
    } catch (e) {
      errorMessage = String(e);
    }
  }

  async function openExternally(): Promise<void> {
    errorMessage = null;
    try {
      await openPath(plan.id);
    } catch (e) {
      errorMessage = `Couldn't open externally: ${e}`;
    }
  }
</script>

<Modal {onClose}>
  <div class="title">{plan.title}</div>
  <div class="meta">{plan.contextName} · {plan.fileName}</div>
  <div class="path">{plan.id}</div>
  {#if plan.parseWarning}
    <p class="warning">This plan's frontmatter has issues — status or priority may not be readable.</p>
  {/if}
  <div class="row">
    <span class="label">Status</span>
    <span>{plan.status ?? "(none — first column)"}</span>
  </div>
  <label class="row">
    <span class="label">Priority</span>
    <select bind:value={priority} onchange={changePriority}>
      {#each PRIORITIES as p (p)}
        <option value={p}>{p}</option>
      {/each}
    </select>
  </label>
  <div class="actions">
    <button type="button" onclick={openExternally}>Open externally</button>
  </div>
  {#if errorMessage}
    <p class="warning">{errorMessage}</p>
  {/if}
</Modal>

<style>
  .title {
    font-size: 1.1em;
    margin-bottom: 4px;
  }
  .meta {
    color: #8bc98b;
    font-size: 0.85em;
  }
  .path {
    color: #888;
    font-size: 0.8em;
    word-break: break-all;
    user-select: text;
    margin: 6px 0 10px;
  }
  .warning {
    color: #d9a648;
    font-size: 0.85em;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 10px;
    margin: 6px 0;
  }
  .label {
    color: #999;
    width: 70px;
    flex: 0 0 auto;
  }
  select {
    background: #1e1e1e;
    color: #eee;
    border: 1px solid #444;
    border-radius: 4px;
    font-family: monospace;
    padding: 2px 6px;
  }
  .actions {
    margin-top: 12px;
  }
  .actions button {
    background: #3a3a3a;
    border: none;
    color: #eee;
    padding: 4px 10px;
    border-radius: 4px;
    cursor: pointer;
    font-family: monospace;
  }
</style>
```

(Verify `openPath`'s import against FileViewerPane.svelte's actual usage first; note the opener capability already grants `allow-open-path` with a full scope.)

- [ ] **Step 3: `KanbanColumn.svelte`.** New props (`planCards: PlanCardView[]`, `onOpenPlanCard: (path: string) => void`, `onPlanDrop: (path: string) => void`); accept the new kind in `handleCardDragOver` (`if (kind !== "kanban-card" && kind !== "plan-card") return;`); branch in `handleCardDrop`:

```typescript
  function handleCardDrop(event: DragEvent, dropIndex: number): void {
    event.preventDefault();
    const payload = getDragPayload(event);
    if (!payload) return;
    if (payload.kind === "plan-card") {
      // Drop position is ignored: plan ordering is deterministic (spec §1).
      onPlanDrop(payload.path);
      return;
    }
    if (payload.kind !== "kanban-card") return;
    void moveCardAction(workspaceId, payload.cardId, column.id, dropIndex);
  }
```

and render plan cards after the free-form loop, inside `.cards`:

```svelte
    {#each planCards as plan (plan.id)}
      <PlanKanbanCard {plan} onOpen={() => onOpenPlanCard(plan.id)} />
    {/each}
```

(import `PlanKanbanCard` + the `PlanCardView` type; default `planCards = []` is NOT needed — every caller passes it after this task.)

- [ ] **Step 4: `KanbanBoard.svelte`.** Wire the projection + auto columns + error strip + modal:

```typescript
  import { gavinTrees, patchPlanField } from "./gavinState";
  import { mergePlanCards, type PlanCardView } from "./planBoard";
  import PlanKanbanCard from "./PlanKanbanCard.svelte";
  import PlanDetailModal from "./PlanDetailModal.svelte";
  import * as backend from "./backend";

  let openPlanPath = $state<string | null>(null);
  let planWriteError = $state<string | null>(null);

  const merged = $derived(board ? mergePlanCards(board, $gavinTrees[workspaceId]) : null);
  const openPlan = $derived<PlanCardView | null>(
    merged && openPlanPath
      ? ([...merged.columns.flatMap((c) => c.planCards), ...merged.autoColumns.flatMap((a) => a.planCards)].find(
          (p) => p.id === openPlanPath
        ) ?? null)
      : null
  );

  async function setPlanStatus(path: string, columnName: string): Promise<void> {
    planWriteError = null;
    const fileName = path.split("/").at(-1) ?? path;
    try {
      await backend.setPlanFrontmatterField(path, "status", columnName);
      patchPlanField(workspaceId, path, "status", columnName);
    } catch (e) {
      planWriteError = `Couldn't update ${fileName}: ${e}`;
    }
  }
```

Template changes: the column loop passes the projection and handlers —

```svelte
      <KanbanColumn
        {workspaceId}
        column={merged?.columns[columnIndex].column ?? column}
        planCards={merged?.columns[columnIndex].planCards ?? []}
        onOpenPlanCard={(path) => (openPlanPath = path)}
        onPlanDrop={(path) => void setPlanStatus(path, column.name)}
        …existing props unchanged…
      />
```

(switch the `{#each}` to `board.columns as column, columnIndex (column.id)` — `merged.columns` is index-aligned by construction). After the real columns and before `+ Add column`, render auto columns as read-only shells with the same drop behavior:

```svelte
    {#each merged?.autoColumns ?? [] as auto (auto.status)}
      <div
        class="auto-column"
        role="list"
        ondragover={(e) => {
          if (getDragKind(e) === "plan-card") e.preventDefault();
        }}
        ondrop={(e) => {
          e.preventDefault();
          const payload = getDragPayload(e);
          if (payload?.kind === "plan-card") void setPlanStatus(payload.path, auto.status);
        }}
      >
        <div class="auto-header" title="Status not matching any column">{auto.status}</div>
        {#each auto.planCards as plan (plan.id)}
          <PlanKanbanCard {plan} onOpen={() => (openPlanPath = plan.id)} />
        {/each}
      </div>
    {/each}
```

(import `getDragKind`/`getDragPayload` from `./dragDrop`; add `.auto-column` styles cloning the real column's width/background — read KanbanColumn's `.column` style block and copy the geometry — plus a muted dashed border and a `.auto-header` in the column-name style without buttons.) Above the board, the dismissible strip:

```svelte
  {#if planWriteError}
    <div class="plan-error">
      <span>{planWriteError}</span>
      <button type="button" onclick={() => (planWriteError = null)}>✕</button>
    </div>
  {/if}
```

with compact styles (warning border like WorkspaceRootControl's `.banner.warning`). Finally, after the CardDetailModal block:

```svelte
  {#if openPlan}
    <PlanDetailModal plan={openPlan} {workspaceId} onClose={() => (openPlanPath = null)} />
  {/if}
```

Note the drop-on-auto-column semantics: `setPlanStatus(path, auto.status)` — the raw status text (spec §2).

- [ ] **Step 5: Verify** — `npx svelte-check` clean, full vitest green (no new unit tests here — components are smoke-covered; the logic they call was tested in Task 3).

- [ ] **Step 6: Commit** — `git add app/src && git commit -m "feat(kanban): plan cards on the board — projection, drag restatus, detail modal"`

---

### Task 6: BoardPane + Pane integration + smoke list

**Files:**
- Create: `app/src/lib/BoardPane.svelte`
- Modify: `app/src/lib/Pane.svelte`

**Interfaces:**
- Consumes: everything above; `Pane.svelte`'s dispatch/label/fit patterns for file tabs; `nearestContext`; `Kanban` icon from `@lucide/svelte` (`workspaceViews.ts` precedent).
- Produces: the complete D7 flow.

- [ ] **Step 1: `BoardPane.svelte`:**

```svelte
<script lang="ts">
  import { kanbanState, fetchBoard, boardError, retryFetchBoard } from "./kanbanState";
  import { gavinTrees, patchPlanField } from "./gavinState";
  import { mergePlanCards, type PlanCardView } from "./planBoard";
  import PlanKanbanCard from "./PlanKanbanCard.svelte";
  import PlanDetailModal from "./PlanDetailModal.svelte";
  import * as backend from "./backend";
  import { getDragKind, getDragPayload } from "./dragDrop";

  interface Props {
    workspaceId: string;
    contextFolder: string;
    visible: boolean;
  }
  let { workspaceId, contextFolder, visible }: Props = $props();

  // Same contract FileViewerPane honors: Pane.svelte calls fit() on every
  // tab; a board has nothing to fit.
  export function fit(): void {}

  let openPlanPath = $state<string | null>(null);
  let planWriteError = $state<string | null>(null);

  $effect(() => {
    void fetchBoard(workspaceId);
  });

  const board = $derived($kanbanState[workspaceId]);
  const error = $derived(boardError(workspaceId));
  const tree = $derived($gavinTrees[workspaceId]);
  const contextExists = $derived(Boolean(tree && !tree.rootMissing && tree.contexts.some((c) => c.folderPath === contextFolder)));
  const contextName = $derived(
    tree?.contexts.find((c) => c.folderPath === contextFolder)?.name ?? (contextFolder.split("/").at(-1) || contextFolder)
  );
  const merged = $derived(board ? mergePlanCards(board, tree, { contextFolder }) : null);
  const openPlan = $derived<PlanCardView | null>(
    merged && openPlanPath
      ? ([...merged.columns.flatMap((c) => c.planCards), ...merged.autoColumns.flatMap((a) => a.planCards)].find(
          (p) => p.id === openPlanPath
        ) ?? null)
      : null
  );

  async function setPlanStatus(path: string, columnName: string): Promise<void> {
    planWriteError = null;
    const fileName = path.split("/").at(-1) ?? path;
    try {
      await backend.setPlanFrontmatterField(path, "status", columnName);
      patchPlanField(workspaceId, path, "status", columnName);
    } catch (e) {
      planWriteError = `Couldn't update ${fileName}: ${e}`;
    }
  }

  function allowPlanDrop(event: DragEvent): void {
    if (getDragKind(event) === "plan-card") event.preventDefault();
  }

  function dropOn(event: DragEvent, statusName: string): void {
    event.preventDefault();
    const payload = getDragPayload(event);
    if (payload?.kind === "plan-card") void setPlanStatus(payload.path, statusName);
  }
</script>

<div class="board-pane" style:display={visible ? "flex" : "none"}>
  {#if error}
    <div class="overlay">
      <p>Couldn't load this board.</p>
      <p class="detail">{error}</p>
      <button onclick={() => retryFetchBoard(workspaceId)}>Retry</button>
    </div>
  {:else if !contextExists}
    <div class="overlay">
      <p>This context no longer exists.</p>
      <p class="detail">{contextFolder}</p>
    </div>
  {:else if !board}
    <div class="overlay"><p>Loading board…</p></div>
  {:else}
    {#if planWriteError}
      <div class="plan-error">
        <span>{planWriteError}</span>
        <button type="button" onclick={() => (planWriteError = null)}>✕</button>
      </div>
    {/if}
    <div class="columns">
      {#each merged?.columns ?? [] as dc (dc.column.id)}
        <div class="column" role="list" ondragover={allowPlanDrop} ondrop={(e) => dropOn(e, dc.column.name)}>
          <div class="header">{dc.column.name}</div>
          {#each dc.planCards as plan (plan.id)}
            <PlanKanbanCard {plan} onOpen={() => (openPlanPath = plan.id)} />
          {/each}
        </div>
      {/each}
      {#each merged?.autoColumns ?? [] as auto (auto.status)}
        <div class="column auto" role="list" ondragover={allowPlanDrop} ondrop={(e) => dropOn(e, auto.status)}>
          <div class="header">{auto.status}</div>
          {#each auto.planCards as plan (plan.id)}
            <PlanKanbanCard {plan} onOpen={() => (openPlanPath = plan.id)} />
          {/each}
        </div>
      {/each}
    </div>
  {/if}
  {#if openPlan}
    <PlanDetailModal plan={openPlan} {workspaceId} onClose={() => (openPlanPath = null)} />
  {/if}
</div>

<style>
  .board-pane {
    position: absolute;
    inset: 0;
    flex-direction: column;
    background: #1e1e1e;
    overflow: hidden;
  }
  .columns {
    display: flex;
    gap: 12px;
    padding: 12px;
    overflow-x: auto;
    height: 100%;
    box-sizing: border-box;
  }
  .column {
    background: #252525;
    border-radius: 8px;
    padding: 8px;
    width: 220px;
    flex: 0 0 auto;
    align-self: flex-start;
    max-height: 100%;
    overflow-y: auto;
    font-family: monospace;
  }
  .column.auto {
    border: 1px dashed #555;
  }
  .header {
    color: #ccc;
    font-size: 0.85em;
    margin-bottom: 8px;
  }
  .plan-error {
    display: flex;
    align-items: center;
    gap: 10px;
    margin: 8px 12px 0;
    padding: 6px 10px;
    border: 1px solid #a15c2f;
    border-radius: 6px;
    color: #e0b08a;
    font-family: monospace;
    font-size: 0.8em;
  }
  .plan-error button {
    background: transparent;
    border: none;
    color: inherit;
    cursor: pointer;
    margin-left: auto;
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
    word-break: break-all;
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

(`visible` via `display:none` is safe here — that restriction is xterm's FitAddon quirk, terminals only; FileViewerPane's `visible` handling is the precedent to double-check and mirror.)

- [ ] **Step 2: Pane.svelte.**
  - Imports: `BoardPane`, `Kanban` (add to the existing `@lucide/svelte` import), `openBoardInSplit` (add to the layoutState import list), `{ gavinTrees }` from `./gavinState`, `{ nearestContext }` from `./planBoard`.
  - Helpers beside `fileTabPath`:

```typescript
  function boardTab(tabId: string): { workspaceId: string; contextFolder: string } | null {
    return $layoutState.boardTabsById[tabId] ?? null;
  }

  function boardTabLabel(tabId: string): string {
    const tab = boardTab(tabId);
    if (!tab) return tabId;
    const name =
      $gavinTrees[tab.workspaceId]?.contexts.find((c) => c.folderPath === tab.contextFolder)?.name ??
      (tab.contextFolder.split("/").at(-1) || tab.contextFolder);
    return `${name} · board`;
  }
```

  - `tabLabel`/`tabTooltip` gain a board branch before the session fallback (`if (boardTab(sessionId)) return boardTabLabel(sessionId);` / tooltip → `boardTab(sessionId)!.contextFolder`); `startEditing` guard extends to `if (fileTabPath(sessionId) || boardTab(sessionId)) return;`.
  - The pane board icon — the active tab's context, computed from the live cwd:

```typescript
  const activeBoardContext = $derived.by(() => {
    if (fileTabPath(active) || boardTab(active)) return null;
    const ws = getActiveWorkspace($layoutState);
    if (!ws) return null;
    const ctx = nearestContext($gavinTrees[ws.id], $layoutState.cwdBySessionId[active]);
    return ctx ? { workspaceId: ws.id, folderPath: ctx.folderPath, name: ctx.name } : null;
  });
```

rendered after the `.new-tab` button:

```svelte
    {#if activeBoardContext}
      <button
        class="new-tab"
        aria-label="Open context board"
        title={`Open board · ${activeBoardContext.name}`}
        onclick={() => void openBoardInSplit(active, activeBoardContext.workspaceId, activeBoardContext.folderPath)}
      >
        <Kanban size={14} />
      </button>
    {/if}
```

  - The content dispatch becomes three-way:

```svelte
      {#if boardTab(sessionId)}
        <BoardPane
          bind:this={paneRefs[sessionId]}
          workspaceId={boardTab(sessionId)?.workspaceId ?? ""}
          contextFolder={boardTab(sessionId)?.contextFolder ?? ""}
          visible={sessionId === active}
        />
      {:else if fileTabPath(sessionId)}
        …existing FileViewerPane block unchanged…
      {:else}
        …existing TerminalPane block unchanged…
      {/if}
```

- [ ] **Step 3: Verify** — `npx svelte-check` clean, full vitest green, `cargo build` + `cargo test` (workspace) green.

- [ ] **Step 4: Manual GUI smoke test (human-performed — present this list, do not claim it passed):**
  1. In this repo's workspace (root bound), create `.gavin-root/plans/demo.md` with `---\nstatus: To Do\npriority: high\n---\n# Demo` → a dashed plan card with priority dot + context badge appears in "To Do" within ~3 s.
  2. Drag it to "In Progress" → it stays there; `git diff` shows only the `status:` line changed.
  3. From a terminal, `printf -- '---\nstatus: Shipped\n---\n' > .gavin-root/plans/demo2.md` → an auto column "Shipped" appears; drag demo2 into "Done" → auto column dissolves, file updated.
  4. Click a plan card → modal shows context/path/status; change priority → file diff shows only that line; "Open externally" opens the editor.
  5. Write a plan with broken frontmatter (`---` never closed) → card shows ⚠ in the first column; modal explains.
  6. `cd` into a folder with a `.gavin` (create one via `mkdir -p auth/.gavin/plans` + a plan file) → the kanban icon appears on the pane's tab bar; click → a "auth · board" tab splits open showing only that context's plans; drag works there too.
  7. Restart the app → the board tab is still there and functional.
  8. Delete the `auth` folder → the board tab shows "This context no longer exists"; close it normally (no session-count prompt).

- [ ] **Step 5: Commit** — `git add app/src && git commit -m "feat(kanban): per-session context board tabs with pane affordance"`

---

## Testing summary

- Rust: 3 writer/validator unit tests (+3 updated), 1 protocol roundtrip, 1 socket test, 3 config tests.
- Frontend: ~11 planBoard tests, 1 patchPlanField test, 2 layoutState tests, 1 confirmClose extension.
- Components: manual smoke list (Task 6 Step 4) — no component tests, per convention.

## Out of scope

Plan creation/deletion from boards (sub-5), body editing (sub-4), MCP tools (sub-3 — `set_plan_field` is deliberately shaped as its future body), free-form card behavior changes, home tiles (sub-6).
