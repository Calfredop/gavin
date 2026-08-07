# MCP Part 2 (App Landing + Setup + Skill) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Agent-spawned sessions land visibly on an Agents page, the app refuses to talk to a protocol-mismatched daemon with an actionable message, and a "Set up agent integration" button writes `.mcp.json` + the gavin skill + a marked CLAUDE.md block into any rooted workspace.

**Architecture:** A bootstrap version probe (failure-shape mapping, `BootstrapError` overlay); an `AgentSessionSpawned` relay arm that Attaches **before** emitting; a frontend handler that finds-or-creates the "Agents" page (killing the session if the workspace vanished — no invisible agents); an app-side `agent_setup.rs` doing merge-aware writes behind a `ClaudeCodeProfile` struct; the full `SKILL.md` literal.

**Tech Stack:** Existing only — no new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-07-agent-orchestration-mcp-design.md` §3 + the app half of §4. Part 1 (protocol/daemon/shim) is shipped: `AgentSessionSpawned` pushes exist, `PROTOCOL_VERSION = 1`, `gavin-mcp` builds as a sibling binary.

## Global Constraints

- User works **directly on `main`**; inline execution is the standing fallback (subagent-cap history).
- The relay arm **sends `Attach` before emitting** the event (Milestone-C lesson: an unattached session renders blank forever).
- The kill-if-unplaceable rule: an `agent-session-spawned` event whose workspace no longer exists → `killSession`, never a silently running invisible agent.
- Setup writes are merge-aware and **never touch bytes outside their own entry/markers**; an unparseable `.mcp.json` errors instead of clobbering.
- `SKILL.md` and the CLAUDE.md marker block are gavin-managed: overwritten on every setup run.
- All profile-specific filenames come from the `ClaudeCodeProfile` struct fields, never inline literals (D4 seam).
- Version-mismatch messages verbatim from the spec: older → "the gavin daemon is older than this app — restart it (pkill gavin-daemon, then relaunch the gavin app)"; newer → "the gavin daemon is newer than this app — rebuild and restart the app".
- Vitest lessons as always: mocked backend fns that get `.catch()`ed need `.mockResolvedValue`; no Svelte component tests.

---

### Task 1: Bootstrap version probe

**Files:**
- Modify: `app/src-tauri/src/session.rs`

**Interfaces:**
- Consumes: `send_command`, the `fake_daemon_replying_with` test helper, `protocol::PROTOCOL_VERSION`.
- Produces: `verify_daemon_protocol(&Mutex<UnixStream>) -> anyhow::Result<()>`, called in `bootstrap` immediately after the command connection is established (before `resolve_workspaces`); failures propagate through bootstrap's existing error path into the `BootstrapError` overlay.

- [ ] **Step 1: The probe** (near `send_command`):

```rust
/// Spec §4: probe the daemon's protocol version before anything else.
/// Interprets FAILURE SHAPE -- a daemon older than the probe itself can't
/// parse the request and closes the connection, which must map to the
/// same actionable message as an explicit lower version (this turned the
/// 2026-08-07 stale-daemon incident's mystery close into a named state).
fn verify_daemon_protocol(command_conn: &Mutex<UnixStream>) -> anyhow::Result<()> {
    const OLDER: &str = "the gavin daemon is older than this app — restart it (pkill gavin-daemon, then relaunch the gavin app)";
    match send_command(command_conn, &Request::GetProtocolVersion) {
        Ok(Response::ProtocolVersion { version }) if version == protocol::PROTOCOL_VERSION => Ok(()),
        Ok(Response::ProtocolVersion { version }) if version > protocol::PROTOCOL_VERSION => {
            anyhow::bail!("the gavin daemon is newer than this app — rebuild and restart the app")
        }
        Ok(_) | Err(_) => anyhow::bail!(OLDER),
    }
}
```

- [ ] **Step 2: Call it in `bootstrap`** right after `let command_conn = Mutex::new(command_stream);`:

```rust
    verify_daemon_protocol(&command_conn)?;
```

- [ ] **Step 3: Tests** (mirror the existing `fake_daemon_replying_with` command tests — read one first for the harness shape):

```rust
#[cfg(test)]
mod version_probe_tests {
    use super::test_support::fake_daemon_replying_with;
    use super::*;

    #[test]
    fn matching_version_passes() {
        let (conn, _dir) = fake_daemon_replying_with(vec![Response::ProtocolVersion {
            version: protocol::PROTOCOL_VERSION,
        }]);
        assert!(verify_daemon_protocol(&conn).is_ok());
    }

    #[test]
    fn newer_daemon_names_the_app_as_stale() {
        let (conn, _dir) = fake_daemon_replying_with(vec![Response::ProtocolVersion {
            version: protocol::PROTOCOL_VERSION + 1,
        }]);
        let err = verify_daemon_protocol(&conn).unwrap_err().to_string();
        assert!(err.contains("newer than this app"));
    }

    #[test]
    fn unparsed_probe_or_error_reply_names_the_daemon_as_stale() {
        // An old daemon can't parse the probe at all: closed connection.
        let (conn, _dir) = fake_daemon_replying_with(vec![]);
        let err = verify_daemon_protocol(&conn).unwrap_err().to_string();
        assert!(err.contains("older than this app"));
        // A daemon that replies Error (unknown request) maps the same way.
        let (conn, _dir) = fake_daemon_replying_with(vec![Response::Error {
            message: "unknown".to_string(),
        }]);
        let err = verify_daemon_protocol(&conn).unwrap_err().to_string();
        assert!(err.contains("older than this app"));
    }
}
```

(Adapt to the helper's real return type — it may hand back the `Mutex<UnixStream>` wrapped differently; follow the neighboring command tests exactly.)

- [ ] **Step 4: Verify** — `cargo test -p app` green.

- [ ] **Step 5: Commit** — `git add app && git commit -m "feat(app): daemon protocol version probe at bootstrap"`

---

### Task 2: Spawn landing — relay arm + Agents page

**Files:**
- Modify: `app/src-tauri/src/session.rs` (relay arm with Attach-first)
- Modify: `app/src/lib/layoutState.ts` (listener + handler)
- Modify: `app/src/lib/layoutState.test.ts`

**Interfaces:**
- Consumes: Part 1's `AgentSessionSpawned` push; `workspace.createPage`, `layout.addTab`, `allSessionIds`.
- Produces: Tauri event `agent-session-spawned` `(workspaceId, sessionId, cwd, command)`; `handleAgentSessionSpawned(...)` exported for tests.

- [ ] **Step 1: Relay arm** in the streaming reader's match (beside `GavinTreeChanged`). The reader thread must capture its own writer clone — add `let relay_writer = Arc::clone(&writer);` beside the existing `let reader_app_handle = app_handle.clone();` before the thread spawn, then:

```rust
                Response::AgentSessionSpawned { workspace_id, session_id, cwd, command } => {
                    // Attach BEFORE emitting: a session nobody attaches
                    // renders blank forever (the Milestone-C lesson).
                    let _ = send_request(&relay_writer, &Request::Attach { id: session_id.clone() });
                    let _ = reader_app_handle
                        .emit("agent-session-spawned", (workspace_id, session_id, cwd, command));
                }
```

- [ ] **Step 2: Frontend handler** (layoutState.ts, beside the other handlers):

```typescript
// An MCP-spawned session (daemon push, already Attached by the Rust
// relay). Lands on the workspace's "Agents" page -- found by name,
// created with the session as its first tab when absent. Never steals
// focus. If the workspace no longer exists, the session is killed: an
// agent the human can't see is never allowed to keep running.
export function handleAgentSessionSpawned(workspaceId: string, sessionId: string): void {
  const state = get(layoutState);
  const ws = state.workspaces.find((w) => w.id === workspaceId);
  if (!ws) {
    void backend.killSession(sessionId).catch(() => {});
    return;
  }
  const agentsPage = ws.pages.find((p) => p.name === "Agents");
  let data: WorkspacesData;
  if (agentsPage) {
    const anchor = layout.allSessionIds(agentsPage.layout)[0];
    const newTree = layout.addTab(agentsPage.layout, anchor, sessionId);
    data = workspace.updatePageLayout(
      { workspaces: state.workspaces, activeWorkspaceId: state.activeWorkspaceId },
      workspaceId,
      agentsPage.id,
      newTree
    );
  } else {
    data = workspace.createPage(
      { workspaces: state.workspaces, activeWorkspaceId: state.activeWorkspaceId },
      workspaceId,
      crypto.randomUUID(),
      "Agents",
      { type: "leaf", tabs: [sessionId], activeTabIndex: 0 }
    );
  }
  layoutState.update((s) => ({ ...s, workspaces: data.workspaces }));
  void persistWorkspaces(data.workspaces, state.activeWorkspaceId);
}
```

**Check `workspace.createPage`'s actual behavior before relying on it:** it sets the new page as the workspace's `activePageId` — that changes what renders if the user is IN that workspace. That violates "never steals focus" for the same-workspace case. If so, follow `createPage` with a restore of the previous `activePageId` (`workspace.switchPage(data, workspaceId, previousActivePageId)` when one existed). Write it accordingly.

- [ ] **Step 3: Listener** in `bootstrap()`'s listener block:

```typescript
  unlisteners.push(
    await listen<[string, string, string, string]>("agent-session-spawned", (event) => {
      handleAgentSessionSpawned(event.payload[0], event.payload[1]);
    })
  );
```

- [ ] **Step 4: Tests** (layoutState.test.ts; import `handleAgentSessionSpawned`):

```typescript
describe("handleAgentSessionSpawned", () => {
  it("appends to an existing Agents page without changing the active page", async () => {
    const agents = { ...page("agents-1", leaf(["a1"])), name: "Agents" };
    setState([ws("ws-1", [page("page-1", leaf(["a"])), agents], "page-1")], "ws-1", "a");

    handleAgentSessionSpawned("ws-1", "spawned-1");

    const state = get(layoutState);
    expect(state.workspaces[0].pages[1].layout).toEqual(leaf(["a1", "spawned-1"], 1));
    expect(state.workspaces[0].activePageId).toBe("page-1");
    expect(backend.setWorkspacesState).toHaveBeenCalled();
    expect(backend.killSession).not.toHaveBeenCalled();
  });

  it("creates the Agents page when absent, keeping the active page", async () => {
    setState([ws("ws-1", [page("page-1", leaf(["a"]))], "page-1")], "ws-1", "a");

    handleAgentSessionSpawned("ws-1", "spawned-1");

    const state = get(layoutState);
    const agents = state.workspaces[0].pages.find((p) => p.name === "Agents");
    expect(agents?.layout).toEqual(leaf(["spawned-1"]));
    expect(state.workspaces[0].activePageId).toBe("page-1");
  });

  it("kills the session when the workspace no longer exists", async () => {
    setState([ws("ws-1", [page("page-1", leaf(["a"]))])], "ws-1", "a");

    handleAgentSessionSpawned("ws-gone", "spawned-1");

    expect(backend.killSession).toHaveBeenCalledWith("spawned-1");
    expect(backend.setWorkspacesState).not.toHaveBeenCalled();
  });
});
```

(`layout.addTab` activates the new tab — hence `leaf(["a1", "spawned-1"], 1)`; verify against `addTab`'s real semantics and adjust the expected index if it doesn't activate.)

- [ ] **Step 5: Verify** — full vitest + `cargo build` green.

- [ ] **Step 6: Commit** — `git add app && git commit -m "feat(app): agent-spawned sessions land on the Agents page"`

---

### Task 3: agent_setup.rs — merge-aware integration writes

**Files:**
- Create: `app/src-tauri/src/agent_setup.rs`
- Create: `app/src-tauri/src/gavin_skill.md` (the SKILL.md literal, pulled in via `include_str!`)
- Modify: `app/src-tauri/src/lib.rs` (`mod agent_setup;` — check where modules are declared, likely `lib.rs` or `main.rs` — plus command registration)
- Modify: `app/src/lib/backend.ts`

**Interfaces:**
- Consumes: the `resolve_daemon_binary_path` sibling-lookup pattern (`daemon.rs:6-12`) — mirror it for `gavin-mcp`.
- Produces: Tauri command `setup_agent_integration(root_path) -> Result<Vec<String>, String>` (the list of files written, for the UI note); `backend.setupAgentIntegration(rootPath)`.

- [ ] **Step 1: The module:**

```rust
use std::path::{Path, PathBuf};

/// D4's seam: everything profile-specific lives in fields. One profile
/// exists today; the writers below read fields, never literals.
struct ClaudeCodeProfile {
    mcp_config: &'static str,
    server_key: &'static str,
    skill_dir: &'static str,
    skill_file: &'static str,
    instructions_file: &'static str,
}

const CLAUDE_CODE: ClaudeCodeProfile = ClaudeCodeProfile {
    mcp_config: ".mcp.json",
    server_key: "gavin",
    skill_dir: ".claude/skills/gavin",
    skill_file: "SKILL.md",
    instructions_file: "CLAUDE.md",
};

const MARKER_START: &str = "<!-- gavin:start -->";
const MARKER_END: &str = "<!-- gavin:end -->";

const CLAUDE_MD_BLOCK: &str = "## Gavin workspace\n\n\
This repo is a gavin workspace. Read `.gavin-root/PRD.md` first — it leads all\n\
development. Follow the gavin workflow skill in `.claude/skills/gavin/SKILL.md`\n\
(plan before coding, keep plan statuses current, use the gavin_* MCP tools).\n";

const SKILL_MD: &str = include_str!("gavin_skill.md");

fn resolve_mcp_binary_path() -> anyhow::Result<PathBuf> {
    let current_exe = std::env::current_exe()?;
    let dir = current_exe
        .parent()
        .ok_or_else(|| anyhow::anyhow!("current_exe has no parent directory"))?;
    let path = dir.join("gavin-mcp");
    if !path.is_file() {
        anyhow::bail!(
            "gavin-mcp binary not found beside the app ({}) — build it with `cargo build -p gavin-mcp`",
            path.display()
        );
    }
    Ok(path)
}

/// Merge-aware: only mcpServers.<key> is created/replaced; every other
/// byte of an existing file's structure survives. Unparseable JSON errors
/// instead of clobbering.
fn write_mcp_config(root: &Path, profile: &ClaudeCodeProfile, binary: &Path) -> anyhow::Result<PathBuf> {
    let path = root.join(profile.mcp_config);
    let mut doc: serde_json::Value = if path.exists() {
        serde_json::from_str(&std::fs::read_to_string(&path)?)
            .map_err(|_| anyhow::anyhow!("existing {} is not valid JSON — fix or remove it first", path.display()))?
    } else {
        serde_json::json!({})
    };
    let obj = doc
        .as_object_mut()
        .ok_or_else(|| anyhow::anyhow!("existing {} is not a JSON object", path.display()))?;
    let servers = obj
        .entry("mcpServers")
        .or_insert_with(|| serde_json::json!({}))
        .as_object_mut()
        .ok_or_else(|| anyhow::anyhow!("mcpServers is not a JSON object"))?;
    servers.insert(
        profile.server_key.to_string(),
        serde_json::json!({ "command": binary.to_string_lossy(), "args": [] }),
    );
    std::fs::write(&path, format!("{}\n", serde_json::to_string_pretty(&doc)?))?;
    Ok(path)
}

fn write_skill(root: &Path, profile: &ClaudeCodeProfile) -> anyhow::Result<PathBuf> {
    let dir = root.join(profile.skill_dir);
    std::fs::create_dir_all(&dir)?;
    let path = dir.join(profile.skill_file);
    std::fs::write(&path, SKILL_MD)?;
    Ok(path)
}

/// Replaces the marker block in place, appends it otherwise (creating the
/// file if absent). Nothing outside the markers is ever touched.
fn write_instructions_block(root: &Path, profile: &ClaudeCodeProfile) -> anyhow::Result<PathBuf> {
    let path = root.join(profile.instructions_file);
    let block = format!("{MARKER_START}\n{CLAUDE_MD_BLOCK}{MARKER_END}\n");
    let content = if path.exists() {
        let existing = std::fs::read_to_string(&path)?;
        match (existing.find(MARKER_START), existing.find(MARKER_END)) {
            (Some(start), Some(end)) if end >= start => {
                let after = existing[end + MARKER_END.len()..].trim_start_matches('\n');
                format!("{}{}{}", &existing[..start], block, after)
            }
            _ => {
                let sep = if existing.is_empty() || existing.ends_with("\n\n") {
                    ""
                } else if existing.ends_with('\n') {
                    "\n"
                } else {
                    "\n\n"
                };
                format!("{existing}{sep}{block}")
            }
        }
    } else {
        block
    };
    std::fs::write(&path, content)?;
    Ok(path)
}

#[tauri::command]
pub fn setup_agent_integration(root_path: String) -> Result<Vec<String>, String> {
    let root = Path::new(&root_path);
    if !root.is_dir() {
        return Err(format!("root does not exist: {root_path}"));
    }
    let profile = &CLAUDE_CODE;
    let binary = resolve_mcp_binary_path().map_err(|e| e.to_string())?;
    let mut written = Vec::new();
    written.push(write_mcp_config(root, profile, &binary).map_err(|e| e.to_string())?);
    written.push(write_skill(root, profile).map_err(|e| e.to_string())?);
    written.push(write_instructions_block(root, profile).map_err(|e| e.to_string())?);
    Ok(written.into_iter().map(|p| p.to_string_lossy().to_string()).collect())
}
```

- [ ] **Step 2: `app/src-tauri/src/gavin_skill.md`** — the full skill (gavin-managed; `include_str!` keeps it a real file):

```markdown
---
name: gavin
description: Use when working in this repository — it is a gavin workspace with a PRD, plan files, and a kanban board the human watches.
---

# Working in a gavin workspace

This repo is managed by gavin. The human sees your plans as cards on a kanban
board and your spawned sessions on an Agents page. Follow this workflow:

## 1. Read the PRD first

`gavin_read_prd` (or read `.gavin-root/PRD.md`). It is the lead document —
every piece of work should trace back to it.

## 2. Plan before coding

Before touching code, create a plan in the nearest context:
`gavin_create_plan` with `context_folder` (the repo root, or a folder
containing `.gavin`), a kebab-case `file_name`, a `title`, and optionally
`status`/`priority`/`body`. Plans are markdown files with frontmatter — you may
also author them directly:

    ---
    title: My plan
    status: To Do
    priority: medium
    ---
    # My plan
    ...

## 3. Keep status current

The board's COLUMN NAMES are the status vocabulary — check them with
`gavin_get_board`. Update a plan as you work:
`gavin_set_plan_field(path, "status", "<column name>")` (matching is
case/spacing-insensitive: "In Progress" == "in-progress"). Do this when you
start, when you finish, and when you get blocked.

## 4. New feature or library? New context

`gavin_create_context(parent_folder)` scaffolds `.gavin/` there; its plans get
their own board for anyone working in that folder.

## 5. Parallel work: spawn visible sessions

`gavin_spawn_session(command, cwd?)` opens a terminal in the gavin app, visible
to the human on the Agents page. Never run long-lived background agents any
other way — visibility is the contract. (If a tool says the workspace isn't
open in gavin, ask the human to open it.)

## Notes

- `gavin_get_tree` is the canonical parse of every context and plan (statuses,
  warnings) — trust it over your own frontmatter parsing.
- After `gavin_init_root` in a fresh repo, reconnect MCP so the tools pick up
  the new root.
```

- [ ] **Step 3: Unit tests** (agent_setup.rs `mod tests`, tempdir):

```rust
    #[test]
    fn mcp_config_merges_preserving_other_servers_and_replacing_stale_gavin() {
        let dir = tempfile::tempdir().unwrap();
        let binary = Path::new("/apps/gavin-mcp");
        // Absent → created.
        let p = write_mcp_config(dir.path(), &CLAUDE_CODE, binary).unwrap();
        let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&p).unwrap()).unwrap();
        assert_eq!(v.pointer("/mcpServers/gavin/command").unwrap(), "/apps/gavin-mcp");
        // Existing with another server + stale gavin → both handled.
        std::fs::write(
            &p,
            r#"{ "mcpServers": { "other": { "command": "/bin/other" }, "gavin": { "command": "/old" } }, "unrelated": true }"#,
        )
        .unwrap();
        write_mcp_config(dir.path(), &CLAUDE_CODE, binary).unwrap();
        let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&p).unwrap()).unwrap();
        assert_eq!(v.pointer("/mcpServers/other/command").unwrap(), "/bin/other");
        assert_eq!(v.pointer("/mcpServers/gavin/command").unwrap(), "/apps/gavin-mcp");
        assert_eq!(v.pointer("/unrelated").unwrap(), true);
        // Unparseable → error, file untouched.
        std::fs::write(&p, "{not json").unwrap();
        assert!(write_mcp_config(dir.path(), &CLAUDE_CODE, binary).is_err());
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "{not json");
    }

    #[test]
    fn instructions_block_appends_replaces_and_never_touches_the_rest() {
        let dir = tempfile::tempdir().unwrap();
        // Absent → created with just the block.
        let p = write_instructions_block(dir.path(), &CLAUDE_CODE).unwrap();
        let first = std::fs::read_to_string(&p).unwrap();
        assert!(first.starts_with(MARKER_START));
        // Existing content → appended after it.
        std::fs::write(&p, "# My rules\n\nKeep tests green.\n").unwrap();
        write_instructions_block(dir.path(), &CLAUDE_CODE).unwrap();
        let appended = std::fs::read_to_string(&p).unwrap();
        assert!(appended.starts_with("# My rules"));
        assert!(appended.contains(MARKER_START));
        // Re-run → block replaced in place, custom content above AND below intact.
        let with_tail = format!("{appended}## After\n\ntail text\n");
        std::fs::write(&p, &with_tail).unwrap();
        write_instructions_block(dir.path(), &CLAUDE_CODE).unwrap();
        let replaced = std::fs::read_to_string(&p).unwrap();
        assert!(replaced.starts_with("# My rules"));
        assert!(replaced.contains("tail text"));
        assert_eq!(replaced.matches(MARKER_START).count(), 1);
    }

    #[test]
    fn skill_is_written_and_overwritten() {
        let dir = tempfile::tempdir().unwrap();
        let p = write_skill(dir.path(), &CLAUDE_CODE).unwrap();
        assert!(std::fs::read_to_string(&p).unwrap().contains("gavin_create_plan"));
        std::fs::write(&p, "mangled").unwrap();
        write_skill(dir.path(), &CLAUDE_CODE).unwrap();
        assert!(std::fs::read_to_string(&p).unwrap().contains("gavin_create_plan"));
    }
```

- [ ] **Step 4: Wire up** — `mod agent_setup;` beside the other module declarations, `agent_setup::setup_agent_integration` in `generate_handler![]`, and in backend.ts:

```typescript
export function setupAgentIntegration(rootPath: string): Promise<string[]> {
  return invoke("setup_agent_integration", { rootPath });
}
```

- [ ] **Step 5: Verify** — `cargo test -p app` green, `cargo build` green.

- [ ] **Step 6: Commit** — `git add app && git commit -m "feat(app): merge-aware agent integration setup writes"`

---

### Task 4: Setup UI row + gates + smoke list

**Files:**
- Modify: `app/src/lib/WorkspaceRootControl.svelte`

**Interfaces:**
- Consumes: Task 3's `setupAgentIntegration`; the existing seed-row pattern in the same component.

- [ ] **Step 1: The row** — for **every** rooted, healthy workspace (not dev-gated, unlike the seed row), after the seed block:

```svelte
  {#if workspace.rootPath && !rootMissing}
    <div class="banner seed">
      <span>Agent integration — write .mcp.json, the gavin skill, and a CLAUDE.md pointer into this root.</span>
      <button type="button" onclick={setupIntegration}>Set up / update</button>
    </div>
    {#if setupNote}
      <div class="banner seed"><span>{setupNote}</span></div>
    {/if}
  {/if}
```

with, in the script:

```typescript
  let setupNote = $state<string | null>(null);

  async function setupIntegration(): Promise<void> {
    if (!workspace.rootPath) return;
    setupNote = null;
    try {
      const files = await backend.setupAgentIntegration(workspace.rootPath);
      setupNote = `Wrote: ${files.map((f) => f.replace(workspace.rootPath + "/", "")).join(", ")} — re-run any time to update.`;
    } catch (e) {
      setupNote = `Couldn't set up: ${e}`;
    }
  }
```

- [ ] **Step 2: Verify** — `npx svelte-check` 0 errors, full vitest green, full `cargo test` green.

- [ ] **Step 3: Manual smoke list (human-performed — present, don't claim):**
  1. Stale-daemon drill: run an old daemon build (or `pkill` after checkout of an older commit) → app startup shows "the gavin daemon is older than this app — restart it…" instead of a mystery. Restore, relaunch.
  2. In the Smoke Test workspace (root bound, initialized): click **Set up / update** → note lists `.mcp.json`, `.claude/skills/gavin/SKILL.md`, `CLAUDE.md`; inspect all three; re-run → identical, no duplication; add a manual line to CLAUDE.md outside the markers → re-run → line survives.
  3. `cd` the playground root in a terminal and run `claude` → `/mcp` lists **gavin** with 8 tools.
  4. Ask the agent to read the PRD, create a plan (card appears on the board within ~3 s), set its status to "In Progress" (card moves).
  5. Ask it to `gavin_spawn_session` with command `claude` (or `/bin/sh` for a cheap test) → an **Agents** page appears in the sidebar with the session tab, attached and scrolling; the active page you were on didn't change.
  6. `gavin_get_board` returns columns + your free-form cards.
  7. Close the workspace mid-spawn-storm? (optional) — spawn, then close the workspace: the arriving session is killed, nothing invisible left (`ps aux | grep` the command).

- [ ] **Step 4: Commit** — `git add app && git commit -m "feat(app): agent integration setup row"`

---

## Testing summary

- Rust: 3 probe tests, 3 agent_setup tests.
- Frontend: 3 `handleAgentSessionSpawned` tests.
- Manual: the 7-step smoke list (the first real-agent end-to-end of the whole phase).

## Out of scope

Additional agent profiles; auto-refresh of `.mcp.json` when the binary path moves (re-run the button); Agents-page fleet UI beyond plain tabs (sub-6).
