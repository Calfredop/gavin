# Orchestration Home Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** a Mission Control home tab — main agent session on screen beside PRD/board summaries and click-through tiles — and the persistence to make that agent survive restarts honestly.

**Architecture:** two new persisted `Workspace` fields (`main_session_id`, `agent_command`); a bootstrap pass that Attaches surviving main sessions and **clears** dead ones; a pure `homeSummary.ts` feeding both panels and tiles; `MainAgentPanel.svelte` embedding the existing `TerminalPane`; `HomeHubView.svelte` assembling the grid.

**Tech Stack:** existing only — no new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-19-agent-orchestration-home-design.md` (D11, D12, D31–D34).

## Global Constraints

- User works directly on `main`; inline execution is the standing fallback.
- **A stale `mainSessionId` is cleared, never replaced** — the deliberate inversion of gavin's usual stale-session rule, because spawning an agent costs money and attention. Never auto-start an agent.
- **Bootstrap must Attach main sessions.** Its Attach loop walks page trees only; a session outside them renders a permanently blank terminal (the Milestone-C failure).
- Adding `Workspace` fields breaks every Rust literal construction site: **`grep -rn "root_path:" app/src-tauri/src/*.rs`** to find them all (there are five today, in `config.rs` and `session.rs`) rather than trusting a list, plus the camelCase shape test.
- **No Svelte component tests** — logic worth testing goes in `.ts`.
- The embedded terminal needs `fit()` on visibility and resize (the CodeMirror measurement trap, same fix).
- Verification per task: `cargo test`, `npx vitest run`, `npx svelte-check` (0 errors), `npm run build` for component tasks.

---

### Task 1: Persisted `main_session_id` and `agent_command`

**Files:**
- Modify: `app/src-tauri/src/config.rs` (+ its tests)
- Modify: every Rust `Workspace` literal site (grep, see Global Constraints)
- Modify: `app/src/lib/workspace.ts`

- [ ] **Step 1: The fields** — in `config.rs`'s `Workspace`, after `root_path`:

```rust
    /// The workspace's running main agent session, deliberately OUTSIDE
    /// every page tree (D12). Cleared -- never replaced -- when it turns
    /// out to be dead, so an agent is only ever started deliberately.
    #[serde(default)]
    pub main_session_id: Option<String>,
    /// Launch command for that agent; `claude` when unset (D34).
    #[serde(default)]
    pub agent_command: Option<String>,
```

- [ ] **Step 2: Fix every literal.** Run the grep above and add `main_session_id: None, agent_command: None` to each `Workspace { .. }` construction. Update `workspace_serializes_to_the_camel_case_shape_the_frontend_expects` to expect `"mainSessionId": null, "agentCommand": null`.

- [ ] **Step 3: Config tests** (`config.rs`, beside the `root_path` ones):

```rust
    #[test]
    fn main_session_and_agent_command_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let mut ws = sample_workspace();
        ws.main_session_id = Some("session-1".to_string());
        ws.agent_command = Some("claude --model opus".to_string());
        let config = AppConfig {
            workspaces: vec![ws],
            active_workspace_id: Some("workspace-1".to_string()),
            session_names: HashMap::new(),
            file_tabs: HashMap::new(),
            board_tabs: HashMap::new(),
        };
        save(dir.path(), &config).unwrap();
        assert_eq!(load(dir.path()).unwrap(), config);
    }

    #[test]
    fn load_defaults_the_agent_fields_when_absent_from_an_older_workspace_object() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            config_path(dir.path()),
            r#"{"workspaces": [{"id": "ws-1", "name": "A", "pages": [], "activePageId": null}]}"#,
        )
        .unwrap();
        let config = load(dir.path()).unwrap();
        assert_eq!(config.workspaces[0].main_session_id, None);
        assert_eq!(config.workspaces[0].agent_command, None);
    }
```

- [ ] **Step 4: TypeScript** — in `workspace.ts`'s `Workspace` interface, after `rootPath`:

```typescript
  /// The running main agent session (D12) — outside every page tree.
  mainSessionId?: string;
  /// Launch command for it; "claude" when unset.
  agentCommand?: string;
```

- [ ] **Step 5: Verify** — `cargo test -p app`, `npx svelte-check`.

- [ ] **Step 6: Commit** — `git add app && git commit -m "feat(home): persist main agent session id and launch command"`

---

### Task 2: Bootstrap — Attach and reconcile main sessions

**Files:**
- Modify: `app/src-tauri/src/session.rs`

**Interfaces:**
- Produces: `reconcile_main_sessions(&mut [Workspace], &Mutex<UnixStream>) -> anyhow::Result<()>`, called from `bootstrap` before persisting; main session ids added to the Attach loop.

- [ ] **Step 1: The reconciler** (beside `resolve_workspaces`):

```rust
/// Clears every `main_session_id` the daemon no longer has (unknown, or
/// exited). Deliberately CLEARS rather than replacing with a fresh
/// session, unlike `resolve_sessions` does for page tabs: starting an
/// agent costs money and attention, so it only ever happens because the
/// user pressed Start (D12).
///
/// Fetches its own session list rather than sharing `resolve_workspaces`'
/// one: that function skips the round trip entirely when no page tab is a
/// session, and a workspace can legitimately have a main agent and no
/// page sessions at all.
fn reconcile_main_sessions(
    workspaces: &mut [Workspace],
    command_conn: &Mutex<UnixStream>,
) -> anyhow::Result<()> {
    if !workspaces.iter().any(|w| w.main_session_id.is_some()) {
        return Ok(());
    }
    let sessions = list_valid_session_ids(command_conn)?;
    for workspace in workspaces.iter_mut() {
        let Some(id) = workspace.main_session_id.clone() else { continue };
        let alive = sessions.get(id.as_str()).is_some_and(|s| s.status != "exited");
        if !alive {
            workspace.main_session_id = None;
        }
    }
    Ok(())
}
```

- [ ] **Step 2: Call it** in `bootstrap`, immediately after the existing `resolve_workspaces(...)?;` line:

```rust
    reconcile_main_sessions(&mut workspaces, &command_conn)?;
```

- [ ] **Step 3: Attach them.** The Attach loop currently walks page trees only, so a main session would come back blank. After `all_session_ids` is built, extend the iteration:

```rust
    // Main agent sessions live outside every page tree by design (D12),
    // so the page-tree walk above cannot see them -- without this they
    // reattach to nothing and render blank forever (Milestone C's bug).
    let main_session_ids: Vec<String> =
        workspaces_data.workspaces.iter().filter_map(|w| w.main_session_id.clone()).collect();
    for id in all_session_ids.into_iter().chain(main_session_ids) {
        send_request(&writer, &Request::Attach { id })?;
    }
```

(replacing the existing `for id in all_session_ids { … }` loop).

- [ ] **Step 4: Tests** (`session.rs`, in the module holding the other `fake_daemon_replying_with` tests):

```rust
#[cfg(test)]
mod main_session_tests {
    use super::test_support::fake_daemon_replying_with;
    use super::*;

    fn ws_with_main(id: &str, main: Option<&str>) -> Workspace {
        Workspace {
            id: id.to_string(),
            name: id.to_string(),
            pages: vec![],
            active_page_id: None,
            active_view: None,
            root_path: Some("/tmp/ws".to_string()),
            main_session_id: main.map(|m| m.to_string()),
            agent_command: None,
        }
    }

    fn summary(id: &str, status: &str) -> protocol::SessionSummary {
        protocol::SessionSummary {
            id: id.to_string(),
            workspace_path: "/tmp/ws".to_string(),
            cwd: "/tmp/ws".to_string(),
            status: status.to_string(),
            restored: false,
        }
    }

    #[test]
    fn keeps_a_live_main_session() {
        let (client, _dir) = fake_daemon_replying_with(vec![Response::SessionList {
            sessions: vec![summary("agent-1", "idle")],
        }]);
        let mut workspaces = vec![ws_with_main("ws-1", Some("agent-1"))];
        reconcile_main_sessions(&mut workspaces, &Mutex::new(client)).unwrap();
        assert_eq!(workspaces[0].main_session_id.as_deref(), Some("agent-1"));
    }

    #[test]
    fn clears_an_exited_or_unknown_main_session_without_respawning() {
        let (client, _dir) = fake_daemon_replying_with(vec![Response::SessionList {
            sessions: vec![summary("agent-1", "exited")],
        }]);
        let mut workspaces =
            vec![ws_with_main("ws-1", Some("agent-1")), ws_with_main("ws-2", Some("never-existed"))];
        reconcile_main_sessions(&mut workspaces, &Mutex::new(client)).unwrap();
        assert_eq!(workspaces[0].main_session_id, None);
        assert_eq!(workspaces[1].main_session_id, None);
    }

    #[test]
    fn skips_the_round_trip_when_no_workspace_has_a_main_session() {
        // An exhausted fake daemon errors if asked anything, so this
        // passing proves no ListSessions was sent.
        let (client, _dir) = fake_daemon_replying_with(vec![]);
        let mut workspaces = vec![ws_with_main("ws-1", None)];
        reconcile_main_sessions(&mut workspaces, &Mutex::new(client)).unwrap();
        assert_eq!(workspaces[0].main_session_id, None);
    }
}
```

- [ ] **Step 5: Verify** — `cargo test -p app` green, `cargo build` clean.

- [ ] **Step 6: Commit** — `git add app && git commit -m "feat(home): attach main agent sessions and clear dead ones at bootstrap"`

---

### Task 3: `homeSummary.ts`

**Files:**
- Create: `app/src/lib/homeSummary.ts`
- Test: `app/src/lib/homeSummary.test.ts`

**Interfaces:**
- Produces (Task 5): `boardSummary(board, tree)`, `planSummary(tree)`, `prdExcerpt(content, maxLines)`.

- [ ] **Step 1: Write the failing tests:**

```typescript
import { describe, it, expect } from "vitest";
import { boardSummary, planSummary, prdExcerpt } from "./homeSummary";
import type { Board } from "./kanban";
import type { GavinContext, GavinTree, PlanFileInfo } from "./gavin";

function plan(fileName: string, status: string | null): PlanFileInfo {
  return {
    path: `/ws/.gavin-root/plans/${fileName}`,
    fileName,
    title: fileName,
    status,
    priority: null,
    order: null,
    parseWarning: false,
  };
}

function ctx(folderPath: string, plans: PlanFileInfo[]): GavinContext {
  return {
    folderPath,
    kind: "context",
    name: folderPath.split("/").at(-1) ?? folderPath,
    plans,
    docs: [],
    specs: [],
    hasPrd: false,
    configWarning: false,
  };
}

function tree(contexts: GavinContext[]): GavinTree {
  return { rootPath: "/ws", rootMissing: false, contexts };
}

const board: Board = {
  columns: [
    {
      id: "c1",
      name: "To Do",
      position: 0,
      cards: [
        { id: "f1", title: "free", description: "", labelIds: [], priority: "none", position: 0 },
      ],
    },
    { id: "c2", name: "Done", position: 1, cards: [] },
  ],
  labels: [],
};

describe("boardSummary", () => {
  it("counts free-form and plan cards per column", () => {
    const s = boardSummary(board, tree([ctx("/ws/a", [plan("p.md", "To Do"), plan("q.md", "Done")])]));
    expect(s.columns).toEqual([
      { name: "To Do", freeFormCount: 1, planCount: 1 },
      { name: "Done", freeFormCount: 0, planCount: 1 },
    ]);
    expect(s.totalCards).toBe(3);
  });

  it("reports auto columns for statuses matching no column", () => {
    const s = boardSummary(board, tree([ctx("/ws/a", [plan("p.md", "Shipped")])]));
    expect(s.autoColumns).toEqual([{ status: "Shipped", count: 1 }]);
  });

  it("handles an absent board or tree", () => {
    expect(boardSummary(undefined, undefined).columns).toEqual([]);
    expect(boardSummary(undefined, undefined).totalCards).toBe(0);
    expect(boardSummary(board, undefined).totalCards).toBe(1);
  });
});

describe("planSummary", () => {
  it("totals plans and contexts and tallies by status", () => {
    const s = planSummary(
      tree([ctx("/ws/a", [plan("p.md", "To Do"), plan("q.md", "To Do")]), ctx("/ws/b", [plan("r.md", null)])])
    );
    expect(s.total).toBe(3);
    expect(s.contexts).toBe(2);
    expect(s.byStatus).toEqual([
      { status: "(no status)", count: 1 },
      { status: "To Do", count: 2 },
    ]);
  });

  it("is zeroed for an absent tree", () => {
    expect(planSummary(undefined)).toEqual({ total: 0, contexts: 0, byStatus: [] });
  });
});

describe("prdExcerpt", () => {
  it("takes the first non-empty lines up to the limit", () => {
    expect(prdExcerpt("# Title\n\n\nFirst\nSecond\nThird\n", 2)).toEqual(["# Title", "First"]);
  });

  it("returns everything when the file is shorter than the limit", () => {
    expect(prdExcerpt("# Title\nOnly\n", 10)).toEqual(["# Title", "Only"]);
  });

  it("handles empty content", () => {
    expect(prdExcerpt("", 5)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run, expect failure.**

- [ ] **Step 3: Implement:**

```typescript
import type { Board } from "./kanban";
import type { GavinTree } from "./gavin";
import { mergePlanCards } from "./planBoard";

export interface ColumnSummary {
  name: string;
  freeFormCount: number;
  planCount: number;
}

export interface BoardSummary {
  columns: ColumnSummary[];
  autoColumns: Array<{ status: string; count: number }>;
  totalCards: number;
}

// Built on mergePlanCards rather than re-deriving the projection, so the
// home's counts can never disagree with the board itself.
export function boardSummary(board: Board | undefined, tree: GavinTree | undefined): BoardSummary {
  if (!board) return { columns: [], autoColumns: [], totalCards: 0 };
  const merged = mergePlanCards(board, tree);
  const columns = merged.columns.map((dc) => ({
    name: dc.column.name,
    freeFormCount: dc.column.cards.length,
    planCount: dc.planCards.length,
  }));
  const autoColumns = merged.autoColumns.map((a) => ({ status: a.status, count: a.planCards.length }));
  const totalCards =
    columns.reduce((n, c) => n + c.freeFormCount + c.planCount, 0) +
    autoColumns.reduce((n, a) => n + a.count, 0);
  return { columns, autoColumns, totalCards };
}

export interface PlanSummary {
  total: number;
  contexts: number;
  byStatus: Array<{ status: string; count: number }>;
}

const NO_STATUS = "(no status)";

export function planSummary(tree: GavinTree | undefined): PlanSummary {
  if (!tree || tree.rootMissing) return { total: 0, contexts: 0, byStatus: [] };
  const counts = new Map<string, number>();
  let total = 0;
  for (const ctx of tree.contexts) {
    for (const plan of ctx.plans) {
      total += 1;
      const key = plan.status?.trim() ? plan.status : NO_STATUS;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  // Sorted by name: a tally that reorders itself as counts change is
  // harder to read at a glance than a stable one.
  const byStatus = [...counts.entries()]
    .map(([status, count]) => ({ status, count }))
    .sort((a, b) => a.status.localeCompare(b.status));
  return { total, contexts: tree.contexts.length, byStatus };
}

// First non-empty lines, so a PRD that opens with blank lines or a lone
// heading still shows something useful in a small panel.
export function prdExcerpt(content: string, maxLines: number): string[] {
  return content
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)
    .slice(0, maxLines);
}
```

- [ ] **Step 4: Run** — green.

- [ ] **Step 5: Commit** — `git add app/src/lib/homeSummary.ts app/src/lib/homeSummary.test.ts && git commit -m "feat(home): pure board/plan/prd summaries"`

---

### Task 4: Front-door default + agent actions in `layoutState`

**Files:**
- Modify: `app/src/lib/workspace.ts`, `app/src/lib/workspace.test.ts`
- Modify: `app/src/lib/layoutState.ts`, `app/src/lib/layoutState.test.ts`

**Interfaces:**
- Produces (Task 5): `startMainAgent(workspaceId)`, `stopMainAgent(workspaceId)`, `setAgentCommand(workspaceId, command)`; `getActiveView` defaulting to `home` for rooted workspaces.

- [ ] **Step 1: The front door** (`workspace.ts`):

```typescript
// Rooted workspaces land on the orchestration home (D33). A FALLBACK
// only: clicking any tab -- including the Terminal button -- persists
// activeView, so an explicit choice always wins and workspaces that
// already have one never shift.
export function getActiveView(ws: Workspace): string {
  return ws.activeView ?? (ws.rootPath ? "home" : "terminal");
}
```

- [ ] **Step 2: Its tests** (`workspace.test.ts`, in the existing `getActiveView` describe):

```typescript
  it("defaults a rooted workspace to home", () => {
    const state = createWorkspace(empty, "ws-1", "A");
    const w = { ...state.workspaces[0], rootPath: "/tmp/ws" };
    expect(getActiveView(w)).toBe("home");
  });

  it("still honours an explicit view on a rooted workspace", () => {
    const state = createWorkspace(empty, "ws-1", "A");
    const w = { ...state.workspaces[0], rootPath: "/tmp/ws", activeView: "terminal" };
    expect(getActiveView(w)).toBe("terminal");
  });
```

- [ ] **Step 3: Agent actions** (`layoutState.ts`, near `setWorkspaceRoot`):

```typescript
export const DEFAULT_AGENT_COMMAND = "claude";

// Starts the workspace's main agent: a normal daemon session at the
// workspace root, remembered on the workspace rather than placed in a
// page tree (D12). Never called automatically.
export async function startMainAgent(workspaceId: string): Promise<void> {
  const state = get(layoutState);
  const ws = state.workspaces.find((w) => w.id === workspaceId);
  if (!ws?.rootPath || ws.mainSessionId) return;
  let sessionId: string;
  try {
    sessionId = await backend.createSession(ws.rootPath, ws.agentCommand ?? DEFAULT_AGENT_COMMAND);
  } catch (e) {
    setError(String(e));
    return;
  }
  const workspaces = state.workspaces.map((w) =>
    w.id === workspaceId ? { ...w, mainSessionId: sessionId } : w
  );
  layoutState.update((s) => ({ ...s, workspaces }));
  await persistWorkspaces(workspaces, state.activeWorkspaceId);
}

export async function stopMainAgent(workspaceId: string): Promise<void> {
  const state = get(layoutState);
  const ws = state.workspaces.find((w) => w.id === workspaceId);
  if (!ws?.mainSessionId) return;
  try {
    await backend.killSession(ws.mainSessionId);
  } catch (e) {
    // A session already gone is not a reason to keep a dead id on screen.
    setError(String(e));
  }
  clearMainSession(workspaceId);
}

export async function setAgentCommand(workspaceId: string, command: string): Promise<void> {
  const state = get(layoutState);
  const trimmed = command.trim();
  const workspaces = state.workspaces.map((w) =>
    w.id === workspaceId ? { ...w, agentCommand: trimmed || undefined } : w
  );
  layoutState.update((s) => ({ ...s, workspaces }));
  await persistWorkspaces(workspaces, state.activeWorkspaceId);
}

function clearMainSession(workspaceId: string): void {
  const state = get(layoutState);
  // Captured before the clear, and only destroyed when there was one --
  // destroyTerminal("") would be a meaningless call.
  const sessionId = state.workspaces.find((w) => w.id === workspaceId)?.mainSessionId;
  if (!sessionId) return;
  const workspaces = state.workspaces.map((w) =>
    w.id === workspaceId ? { ...w, mainSessionId: undefined } : w
  );
  layoutState.update((s) => ({ ...s, workspaces }));
  terminalRegistry.destroyTerminal(sessionId);
  void persistWorkspaces(workspaces, state.activeWorkspaceId);
}
```

- [ ] **Step 4: The exit branch.** `handleSessionExited` searches page trees and returns early for anything it cannot find — a main session is never in one, so it would leave a dead id on screen. Add at the very top of the function, before the page-tree search:

```typescript
  // A main agent session lives outside every page tree (D12), so the
  // search below can never find it -- without this branch its terminal
  // would sit dead on the home forever.
  const owningWorkspace = state.workspaces.find((w) => w.mainSessionId === sessionId);
  if (owningWorkspace) {
    clearMainSession(owningWorkspace.id);
    return;
  }
```

- [ ] **Step 5: Tests** (`layoutState.test.ts`):

```typescript
describe("main agent session", () => {
  it("startMainAgent spawns at the root with the configured command and persists", async () => {
    setState([{ ...ws("ws-1", []), rootPath: "/tmp/ws", agentCommand: "claude --model opus" }], "ws-1", null);
    vi.mocked(backend.createSession).mockResolvedValue("agent-1");

    await startMainAgent("ws-1");

    expect(backend.createSession).toHaveBeenCalledWith("/tmp/ws", "claude --model opus");
    expect(get(layoutState).workspaces[0].mainSessionId).toBe("agent-1");
    expect(backend.setWorkspacesState).toHaveBeenCalled();
  });

  it("startMainAgent falls back to claude and refuses without a root or when one runs", async () => {
    setState([{ ...ws("ws-1", []), rootPath: "/tmp/ws" }], "ws-1", null);
    vi.mocked(backend.createSession).mockResolvedValue("agent-1");
    await startMainAgent("ws-1");
    expect(backend.createSession).toHaveBeenCalledWith("/tmp/ws", "claude");

    // Already running: no second spawn.
    await startMainAgent("ws-1");
    expect(backend.createSession).toHaveBeenCalledOnce();

    // No root: nothing at all.
    setState([ws("ws-2", [])], "ws-2", null);
    vi.mocked(backend.createSession).mockClear();
    await startMainAgent("ws-2");
    expect(backend.createSession).not.toHaveBeenCalled();
  });

  it("stopMainAgent kills the session and clears the id", async () => {
    setState([{ ...ws("ws-1", []), rootPath: "/tmp/ws", mainSessionId: "agent-1" }], "ws-1", null);

    await stopMainAgent("ws-1");

    expect(backend.killSession).toHaveBeenCalledWith("agent-1");
    expect(get(layoutState).workspaces[0].mainSessionId).toBeUndefined();
  });

  it("handleSessionExited clears the owning workspace's main session only", async () => {
    setState(
      [
        { ...ws("ws-1", []), mainSessionId: "agent-1" },
        { ...ws("ws-2", []), mainSessionId: "agent-2" },
      ],
      "ws-1",
      null
    );

    handleSessionExited("agent-1");

    const after = get(layoutState).workspaces;
    expect(after[0].mainSessionId).toBeUndefined();
    expect(after[1].mainSessionId).toBe("agent-2");
  });
});
```

(import `startMainAgent`, `stopMainAgent` from `./layoutState`.)

- [ ] **Step 6: Verify** — `npx vitest run` green, `npx svelte-check` clean.

- [ ] **Step 7: Commit** — `git add app/src && git commit -m "feat(home): agent start/stop actions and rooted home default"`

---

### Task 5: `MainAgentPanel.svelte` + `HomeHubView.svelte`

**Files:**
- Create: `app/src/lib/MainAgentPanel.svelte`, `app/src/lib/HomeHubView.svelte`
- Modify: `app/src/lib/workspaceViews.ts`

- [ ] **Step 1: The agent panel:**

```svelte
<script lang="ts">
  import TerminalPane from "./TerminalPane.svelte";
  import { layoutState, startMainAgent, stopMainAgent, setAgentCommand, DEFAULT_AGENT_COMMAND } from "./layoutState";

  interface Props {
    workspaceId: string;
  }
  let { workspaceId }: Props = $props();

  const ws = $derived($layoutState.workspaces.find((w) => w.id === workspaceId) ?? null);
  const sessionId = $derived(ws?.mainSessionId ?? null);

  let commandDraft = $state("");
  let draftFor = $state<string | null>(null);
  $effect(() => {
    if (draftFor !== workspaceId) {
      commandDraft = ws?.agentCommand ?? DEFAULT_AGENT_COMMAND;
      draftFor = workspaceId;
    }
  });

  let pane = $state<{ fit: () => void } | null>(null);
  // The terminal measures itself on mount; a pane mounted in a hidden or
  // just-resized grid cell needs a nudge (the same trap CodeMirror has).
  export function fit(): void {
    pane?.fit();
  }

  function start(): void {
    void setAgentCommand(workspaceId, commandDraft).then(() => startMainAgent(workspaceId));
  }
</script>

<div class="agent">
  <div class="head">
    <span class="label">Main agent</span>
    {#if sessionId}
      <button type="button" onclick={() => void stopMainAgent(workspaceId)}>Stop</button>
    {/if}
  </div>
  {#if sessionId}
    <div class="terminal">
      <TerminalPane bind:this={pane} {sessionId} visible={true} focused={false} />
    </div>
  {:else}
    <div class="idle">
      <p>No agent running in this workspace.</p>
      <div class="launcher">
        <input
          bind:value={commandDraft}
          spellcheck="false"
          onkeydown={(e) => {
            if (e.key === "Enter") start();
          }}
        />
        <button type="button" onclick={start}>Start main agent</button>
      </div>
      <p class="hint">Runs at the workspace root. Nothing starts on its own.</p>
    </div>
  {/if}
</div>

<style>
  .agent {
    display: flex;
    flex-direction: column;
    min-height: 0;
    height: 100%;
    background: #1a1a1a;
    border: 1px solid #2f2f2f;
    border-radius: 8px;
    overflow: hidden;
  }
  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 6px 10px;
    border-bottom: 1px solid #2f2f2f;
    font-family: monospace;
    font-size: 0.75em;
    color: #999;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    flex: 0 0 auto;
  }
  .head button,
  .launcher button {
    background: #3a3a3a;
    border: none;
    color: #eee;
    padding: 3px 10px;
    border-radius: 4px;
    cursor: pointer;
    font-family: monospace;
    font-size: 1em;
    text-transform: none;
  }
  .terminal {
    position: relative;
    flex: 1 1 auto;
    min-height: 0;
  }
  .idle {
    flex: 1 1 auto;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 10px;
    color: #888;
    font-family: monospace;
    font-size: 0.85em;
    padding: 16px;
    text-align: center;
  }
  .launcher {
    display: flex;
    gap: 6px;
  }
  .launcher input {
    background: #1e1e1e;
    border: 1px solid #444;
    border-radius: 4px;
    color: #eee;
    font-family: monospace;
    font-size: 1em;
    padding: 3px 8px;
    min-width: 220px;
  }
  .hint {
    font-size: 0.9em;
    opacity: 0.7;
  }
</style>
```

- [ ] **Step 2: The home view:**

```svelte
<script lang="ts">
  import { onMount } from "svelte";
  import { layoutState, switchWorkspaceView } from "./layoutState";
  import { gavinTrees } from "./gavinState";
  import { fetchBoard, kanbanState } from "./kanbanState";
  import { boardSummary, planSummary, prdExcerpt } from "./homeSummary";
  import MainAgentPanel from "./MainAgentPanel.svelte";
  import * as backend from "./backend";

  interface Props {
    workspaceId: string;
  }
  let { workspaceId }: Props = $props();

  const EXCERPT_LINES = 15;

  const ws = $derived($layoutState.workspaces.find((w) => w.id === workspaceId) ?? null);
  const root = $derived(ws?.rootPath ?? null);
  const tree = $derived($gavinTrees[workspaceId]);
  const board = $derived($kanbanState[workspaceId]);
  const boards = $derived(boardSummary(board, tree));
  const plans = $derived(planSummary(tree));

  let prdLines = $state<string[]>([]);
  let agentFileExists = $state<boolean | null>(null);
  let agent = $state<{ fit: () => void } | null>(null);
  let gridEl = $state<HTMLElement | null>(null);

  $effect(() => {
    void fetchBoard(workspaceId);
  });

  // Read on mount and whenever the bound root changes -- these panels are
  // summaries, not live views (D31), so they deliberately hold no watcher.
  $effect(() => {
    const r = root;
    if (!r) return;
    void backend
      .readFileForViewer(`${r}/.gavin-root/PRD.md`)
      .then((res) => (prdLines = prdExcerpt(res.content, EXCERPT_LINES)))
      .catch(() => (prdLines = []));
    void backend
      .readFileForViewer(`${r}/CLAUDE.md`)
      .then((res) => (agentFileExists = res.exists))
      .catch(() => (agentFileExists = null));
  });

  onMount(() => {
    if (!gridEl) return;
    const observer = new ResizeObserver(() => agent?.fit());
    observer.observe(gridEl);
    return () => observer.disconnect();
  });

  function go(view: string): void {
    void switchWorkspaceView(workspaceId, view);
  }
</script>

{#if !root}
  <div class="empty">No root folder set for this workspace.</div>
{:else}
  <div class="home">
    <div class="grid" bind:this={gridEl}>
      <div class="agent-cell">
        <MainAgentPanel bind:this={agent} {workspaceId} />
      </div>
      <div class="side">
        <button type="button" class="panel" onclick={() => go("prd")}>
          <span class="panel-head">PRD</span>
          {#if prdLines.length === 0}
            <span class="muted">No PRD yet.</span>
          {:else}
            <span class="excerpt">{prdLines.join("\n")}</span>
          {/if}
        </button>
        <button type="button" class="panel" onclick={() => go("kanban")}>
          <span class="panel-head">Board</span>
          {#if boards.columns.length === 0}
            <span class="muted">No board yet.</span>
          {:else}
            <span class="columns">
              {#each boards.columns as column (column.name)}
                <span class="column">
                  <span class="col-name">{column.name}</span>
                  <span class="col-count">{column.freeFormCount + column.planCount}</span>
                </span>
              {/each}
              {#each boards.autoColumns as auto (auto.status)}
                <span class="column auto">
                  <span class="col-name">{auto.status}</span>
                  <span class="col-count">{auto.count}</span>
                </span>
              {/each}
            </span>
          {/if}
        </button>
      </div>
    </div>
    <div class="tiles">
      <button type="button" class="tile" onclick={() => go("prd")}>
        <b>PRD</b><span>{prdLines.length > 0 ? "present" : "not created"}</span>
      </button>
      <button type="button" class="tile" onclick={() => go("agent-file")}>
        <b>CLAUDE.md</b>
        <span>{agentFileExists === null ? "—" : agentFileExists ? "present" : "not set up"}</span>
      </button>
      <button type="button" class="tile" onclick={() => go("plans")}>
        <b>Plans</b>
        <span>{plans.total} plans · {plans.contexts} contexts</span>
      </button>
      <button type="button" class="tile" onclick={() => go("kanban")}>
        <b>Board</b><span>{boards.totalCards} cards</span>
      </button>
    </div>
  </div>
{/if}

<style>
  .home {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    padding: 10px;
    gap: 10px;
    box-sizing: border-box;
  }
  .grid {
    display: grid;
    grid-template-columns: 3fr 2fr;
    gap: 10px;
    flex: 1 1 auto;
    min-height: 0;
  }
  .agent-cell {
    min-width: 0;
    min-height: 0;
  }
  .side {
    display: flex;
    flex-direction: column;
    gap: 10px;
    min-height: 0;
  }
  .panel {
    flex: 1 1 0;
    min-height: 0;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    gap: 6px;
    align-items: flex-start;
    text-align: left;
    background: #1a1a1a;
    border: 1px solid #2f2f2f;
    border-radius: 8px;
    padding: 10px;
    color: #ccc;
    font-family: monospace;
    font-size: 0.8em;
    cursor: pointer;
  }
  .panel:hover {
    border-color: #444;
  }
  .panel-head {
    color: #999;
    text-transform: uppercase;
    font-size: 0.85em;
    letter-spacing: 0.05em;
  }
  .excerpt {
    white-space: pre-wrap;
    overflow: hidden;
    opacity: 0.85;
    line-height: 1.5;
  }
  .muted {
    color: #777;
  }
  .columns {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .column {
    display: flex;
    gap: 5px;
    align-items: baseline;
    border: 1px solid #333;
    border-radius: 6px;
    padding: 2px 8px;
  }
  .column.auto {
    border-style: dashed;
  }
  .col-count {
    color: #8bc98b;
  }
  .tiles {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 10px;
    flex: 0 0 auto;
  }
  .tile {
    display: flex;
    flex-direction: column;
    gap: 3px;
    align-items: flex-start;
    background: transparent;
    border: 1px solid #333;
    border-radius: 8px;
    padding: 8px 10px;
    color: #ccc;
    font-family: monospace;
    font-size: 0.75em;
    cursor: pointer;
    text-align: left;
  }
  .tile:hover {
    border-color: #555;
  }
  .tile span {
    color: #888;
  }
  .empty {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100%;
    color: #888;
    font-family: monospace;
    font-size: 0.85em;
  }
</style>
```

- [ ] **Step 3: Register it FIRST** in `HUB_VIEWS` (`workspaceViews.ts`) — import `LayoutDashboard` from `@lucide/svelte` (**verify the name exists in the installed package first; a wrong icon name fails the build**) and `HomeHubView`, then put this entry **before** `kanban`:

```typescript
  { id: "home", label: "Home", icon: LayoutDashboard, component: HomeHubView, requiresRoot: true },
```

- [ ] **Step 4: Verify** — `npx svelte-check` 0 errors, `npx vitest run` green, `npm run build` succeeds.

- [ ] **Step 5: Commit** — `git add app/src && git commit -m "feat(home): Mission Control home tab with embedded agent session"`

---

### Task 6: Checklist, full gates, manual smoke

**Files:**
- Modify: `app/src/lib/smokeChecklist.ts`

- [ ] **Step 1: Add the section**, after "Plan explorer":

```typescript
  {
    title: "Orchestration home",
    items: [
      { id: "home-default", text: "A rooted workspace opens on Home; one where you last chose another tab still opens there" },
      { id: "home-start", text: "Start main agent spawns a live agent at the workspace root, visible in the panel" },
      {
        id: "home-restart",
        text: "Quit and relaunch — the agent terminal is still live and scrolling, not blank",
        hint: "Blank means the bootstrap Attach for main sessions regressed (Milestone C's bug).",
      },
      { id: "home-stop", text: "Stop returns the panel to the launcher; the session is gone from the daemon" },
      { id: "home-external-exit", text: "Kill the agent from a terminal (or type exit) → panel returns to the launcher on its own" },
      { id: "home-no-respawn", text: "With an agent stopped, relaunching the app does NOT start one" },
      { id: "home-command", text: "Editing the command (e.g. claude --model opus) persists and is used on the next Start" },
      { id: "home-summaries", text: "PRD excerpt and board columns/counts match reality; changing the board updates the counts" },
      { id: "home-tiles", text: "Each of the four tiles navigates to its tab" },
      { id: "home-resize", text: "Resizing the window keeps the agent terminal correctly sized, not clipped" },
    ],
  },
```

- [ ] **Step 2: Full gates** — `cargo test`, `npx vitest run`, `npx svelte-check` (0 errors), `npm run build`.

- [ ] **Step 3: Manual smoke** — run the section in the dev Smoke Test workspace. Present results honestly; `home-restart` and `home-no-respawn` are the two that matter most.

- [ ] **Step 4: Commit** — `git add app/src && git commit -m "test(home): orchestration home smoke checklist section"`

---

## Testing summary

- Rust: 2 config tests, 3 `reconcile_main_sessions` tests, plus every `Workspace` literal and the shape test updated.
- Frontend: ~9 `homeSummary` cases, 2 `getActiveView` cases, 4 main-agent action/exit cases.
- Components (MainAgentPanel, HomeHubView): manual, via the new checklist section.

## Out of scope

Adopting the agent session into a page layout; multiple agents per workspace; live mini-board interaction; nav restyling (already matches D11).
