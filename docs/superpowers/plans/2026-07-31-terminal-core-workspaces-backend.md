# Terminal Core — Workspaces — Part 1 (Backend) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the Rust/Tauri backend a `Workspace`/`Page` data model, config persistence, and daemon-session reconciliation that supports many workspaces each holding many pages — replacing today's single global `LayoutNode` tree — with zero frontend/Svelte changes (that's Part 2).

**Architecture:** `app/src-tauri/src/config.rs`'s `AppConfig` gains `workspaces: Vec<Workspace>` / `active_workspace_id: Option<String>`, replacing its current `layout: Option<LayoutNode>` field. `app/src-tauri/src/session.rs`'s `bootstrap()` (called once at app startup) walks every page of every workspace, reconciling each page's `LayoutNode` against the daemon's live sessions with the *same* per-tree logic it already uses today (`resolve_sessions`, unchanged) — just called once per page instead of once globally, with the `ListSessions` daemon round-trip itself still happening exactly once regardless of page count. Two Tauri commands (`get_workspaces_state`/`set_workspaces_state`) replace today's `get_current_layout`/`set_layout`, giving the (not-yet-built) frontend a way to read and persist the whole workspace/page tree.

**Tech Stack:** Rust, Tauri 2 (commands + managed state + events), `serde`/`serde_json`, the existing `protocol` crate for the daemon's request/response types. No new dependencies.

## Global Constraints

- No frontend/Svelte files are touched by this plan — Part 2 (a separate, later plan) builds the UI against the commands/events this plan produces.
- `session_names: HashMap<String, String>` (already on `AppConfig`) is untouched in shape and behavior — it stays flat and keyed by session id, independent of the new `workspaces` structure.
- The daemon (`crates/daemon`) and its wire protocol (`crates/protocol`) are untouched — this plan is entirely about the Tauri app's own config/state layer, which is already a thin client to the daemon's existing per-session model.
- `Workspace`/`Page` use `#[serde(rename_all = "camelCase")]` since they're serialized both to `config.json` on disk *and* sent over Tauri IPC to the frontend — camelCase matches the frontend's TypeScript naming convention, the same reason `LayoutNode` already renames `active_tab_index` to `activeTabIndex`. `AppConfig`'s own top-level fields (`workspaces`, `active_workspace_id`, `session_names`) keep the existing snake_case convention already used for `layout`/`session_names` on disk today — only `WorkspacesData` (the IPC-only wrapper type, not persisted directly) gets its own `rename_all = "camelCase"` for its own top-level fields.
- A config file from before this milestone (`{"layout": ..., "session_names": {...}}`, no `workspaces` key) must still load successfully, with `workspaces` defaulting to `[]` and `active_workspace_id` to `None` — the app starts with an empty sidebar rather than failing to launch. No auto-migration of the old `layout` tree is performed (an explicit, already-approved product decision — the old sessions stay running in the daemon but become unreachable from the UI).
- Every task must leave `cargo build` and `cargo test` (run from the repo root, which covers the whole workspace: `app`, `crates/daemon`, `crates/protocol`) fully green before its commit — no task may leave the workspace in a non-compiling or test-failing state, even temporarily.

---

### Task 1: `config.rs` — add the `Workspace`/`Page` data model

**Files:**
- Modify: `app/src-tauri/src/config.rs`

**Interfaces:**
- Produces: `pub struct Page { pub id: String, pub name: String, pub layout: LayoutNode, pub focused_session_id: Option<String> }` and `pub struct Workspace { pub id: String, pub name: String, pub pages: Vec<Page>, pub active_page_id: Option<String> }`, both `#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]` with `#[serde(rename_all = "camelCase")]`. `AppConfig` gains `pub workspaces: Vec<Workspace>` and `pub active_workspace_id: Option<String>`, both `#[serde(default)]`.
- Note for Task 2: `AppConfig.layout: Option<LayoutNode>` is **deliberately kept** in this task, unused by anything new — `session.rs` still reads it and must keep compiling until Task 2 finishes migrating every reader/writer over to `workspaces` and removes it for good. Do not build anything new on top of it in this task.

This task only touches `config.rs`. `session.rs` is untouched and must still compile and pass all its existing tests afterward, unchanged.

- [ ] **Step 1: Replace `config.rs` with the new struct definitions, existing tests updated for the two new required `AppConfig` fields, plus new tests for the added data model**

Replace the full contents of `app/src-tauri/src/config.rs` with:

```rust
use crate::layout::LayoutNode;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Page {
    pub id: String,
    pub name: String,
    pub layout: LayoutNode,
    /// The leaf (pane) last focused while this page was active. Kept in
    /// sync with the frontend's live focus while this page IS the active
    /// one; simply retained otherwise. Lets a cross-page "add as tab" drag
    /// (a later plan) target a well-defined pane even in a page that isn't
    /// currently rendered.
    pub focused_session_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub id: String,
    pub name: String,
    pub pages: Vec<Page>,
    pub active_page_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub struct AppConfig {
    // TEMPORARY for this milestone's Part 1: kept only so session.rs keeps
    // compiling until a later task migrates every reader/writer over to
    // `workspaces` and removes this field for good. Do not build anything
    // new on top of it.
    pub layout: Option<LayoutNode>,
    #[serde(default)]
    pub workspaces: Vec<Workspace>,
    #[serde(default)]
    pub active_workspace_id: Option<String>,
    /// User-assigned display names, keyed by session id. Independent of
    /// `layout`/`workspaces` (a session can be renamed regardless of where
    /// it sits) -- callers that persist one must always carry the others'
    /// current value along too, or they'll silently reset them to empty.
    #[serde(default)]
    pub session_names: HashMap<String, String>,
}

pub fn config_path(config_dir: &Path) -> PathBuf {
    config_dir.join("config.json")
}

pub fn load(config_dir: &Path) -> anyhow::Result<AppConfig> {
    let path = config_path(config_dir);
    if !path.exists() {
        return Ok(AppConfig::default());
    }
    let contents = std::fs::read_to_string(&path)?;
    // A corrupted/unparseable config file is treated the same as "no
    // saved session" rather than a startup error — a stale or missing
    // session id is already normal, expected behavior (see the
    // ListSessions check in session::bootstrap), not something that
    // should block launch.
    Ok(serde_json::from_str(&contents).unwrap_or_default())
}

pub fn save(config_dir: &Path, config: &AppConfig) -> anyhow::Result<()> {
    std::fs::create_dir_all(config_dir)?;
    let path = config_path(config_dir);
    let contents = serde_json::to_string_pretty(config)?;
    std::fs::write(path, contents)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::layout::LayoutNode;

    fn sample_layout() -> LayoutNode {
        LayoutNode::Leaf {
            tabs: vec!["abc-123".to_string()],
            active_tab_index: 0,
        }
    }

    fn sample_page() -> Page {
        Page {
            id: "page-1".to_string(),
            name: "Page 1".to_string(),
            layout: sample_layout(),
            focused_session_id: None,
        }
    }

    fn sample_workspace() -> Workspace {
        Workspace {
            id: "workspace-1".to_string(),
            name: "Workspace 1".to_string(),
            pages: vec![sample_page()],
            active_page_id: Some("page-1".to_string()),
        }
    }

    #[test]
    fn load_returns_default_when_no_file_exists() {
        let dir = tempfile::tempdir().unwrap();
        let config = load(dir.path()).unwrap();
        assert_eq!(config, AppConfig::default());
        assert_eq!(config.layout, None);
    }

    #[test]
    fn save_then_load_roundtrips() {
        let dir = tempfile::tempdir().unwrap();
        let config = AppConfig {
            layout: Some(sample_layout()),
            workspaces: vec![],
            active_workspace_id: None,
            session_names: HashMap::new(),
        };
        save(dir.path(), &config).unwrap();

        let loaded = load(dir.path()).unwrap();
        assert_eq!(loaded, config);
    }

    #[test]
    fn session_names_roundtrip_alongside_layout() {
        let dir = tempfile::tempdir().unwrap();
        let mut session_names = HashMap::new();
        session_names.insert("abc-123".to_string(), "my project".to_string());
        let config = AppConfig {
            layout: Some(sample_layout()),
            workspaces: vec![],
            active_workspace_id: None,
            session_names,
        };
        save(dir.path(), &config).unwrap();

        let loaded = load(dir.path()).unwrap();
        assert_eq!(loaded, config);
        assert_eq!(loaded.session_names.get("abc-123"), Some(&"my project".to_string()));
    }

    #[test]
    fn load_defaults_session_names_when_field_is_absent_from_an_older_config_file() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(config_path(dir.path()), r#"{"layout": null}"#).unwrap();

        let config = load(dir.path()).unwrap();
        assert_eq!(config.session_names, HashMap::new());
    }

    #[test]
    fn save_creates_missing_parent_directories() {
        let dir = tempfile::tempdir().unwrap();
        let nested = dir.path().join("nested").join("config-dir");
        let config = AppConfig {
            layout: Some(sample_layout()),
            workspaces: vec![],
            active_workspace_id: None,
            session_names: HashMap::new(),
        };
        save(&nested, &config).unwrap();

        assert!(config_path(&nested).exists());
    }

    #[test]
    fn load_treats_malformed_json_as_default() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(config_path(dir.path()), "{not valid json").unwrap();

        let config = load(dir.path()).unwrap();
        assert_eq!(config, AppConfig::default());
    }

    #[test]
    fn workspaces_roundtrip_alongside_the_old_layout_field() {
        let dir = tempfile::tempdir().unwrap();
        let config = AppConfig {
            layout: None,
            workspaces: vec![sample_workspace()],
            active_workspace_id: Some("workspace-1".to_string()),
            session_names: HashMap::new(),
        };
        save(dir.path(), &config).unwrap();

        let loaded = load(dir.path()).unwrap();
        assert_eq!(loaded, config);
        assert_eq!(loaded.active_workspace_id, Some("workspace-1".to_string()));
        assert_eq!(loaded.workspaces[0].pages[0].id, "page-1");
    }

    #[test]
    fn load_defaults_workspaces_and_active_workspace_id_when_absent_from_an_older_config_file() {
        let dir = tempfile::tempdir().unwrap();
        // Mirrors a genuine config.json from before this milestone -- only
        // `layout`/`session_names` existed, so `workspaces`/
        // `active_workspace_id` must default rather than fail to parse.
        std::fs::write(config_path(dir.path()), r#"{"layout": null, "session_names": {}}"#).unwrap();

        let config = load(dir.path()).unwrap();
        assert_eq!(config.workspaces, Vec::new());
        assert_eq!(config.active_workspace_id, None);
    }
}
```

- [ ] **Step 2: Run the tests**

Run: `cd /Users/coalpila/CloudStation/Coding/gavin && cargo test -p app --lib config::`
Expected: PASS — 8 tests (the 6 existing ones plus the 2 new ones above).

- [ ] **Step 3: Verify the whole workspace still builds and tests pass**

Run: `cd /Users/coalpila/CloudStation/Coding/gavin && cargo build && cargo test`
Expected: PASS, no warnings about unused `layout`/`Workspace`/`Page` (the field and new types are referenced by this file's own tests, and `session.rs` still reads `config.layout` exactly as before — nothing else in the workspace references `Workspace`/`Page` yet, which is fine since they're `pub`).

- [ ] **Step 4: Commit**

```bash
git add app/src-tauri/src/config.rs
git commit -m "feat(app): add Workspace/Page data model to config.rs"
```

---

### Task 2: `session.rs` + `lib.rs` — migrate the command/bootstrap layer to workspaces, remove the old `layout` field

**Files:**
- Modify: `app/src-tauri/src/session.rs`
- Modify: `app/src-tauri/src/lib.rs`
- Modify: `app/src-tauri/src/config.rs`

**Interfaces:**
- Consumes: `crate::config::{Page, Workspace, AppConfig}` from Task 1.
- Produces: `pub struct WorkspacesData { pub workspaces: Vec<Workspace>, pub active_workspace_id: Option<String> }` (`#[derive(Debug, Clone, Serialize)]`, `#[serde(rename_all = "camelCase")]`), `pub struct WorkspacesState(pub Mutex<WorkspacesData>)` (Tauri-managed, replaces `CurrentLayout`), `#[tauri::command] pub fn get_workspaces_state(state: State<WorkspacesState>) -> WorkspacesData`, `#[tauri::command] pub fn set_workspaces_state(workspaces: Vec<Workspace>, active_workspace_id: Option<String>, app_handle: AppHandle, state: State<WorkspacesState>, names_state: State<SessionNames>) -> Result<(), String>`. The `workspaces-ready` Tauri event (payload: `WorkspacesData`) replaces `layout-ready`.

This task removes `CurrentLayout`, `get_current_layout`, `set_layout`, `resolve_layout`, and `AppConfig.layout` entirely — by the end of this task nothing in the workspace references any of them.

- [ ] **Step 1: Replace the command/state layer in `session.rs`**

In `app/src-tauri/src/session.rs`, replace the whole block from the top of the file (`use crate::layout::LayoutNode;`) down through the end of `set_session_name` (i.e. everything up to, but not including, the `/// Set once (\`AtomicBool\`...` doc comment above `FrontendReady`) with:

```rust
use crate::config::{Page, Workspace};
use crate::layout::LayoutNode;
use protocol::{read_message, socket_path, write_message, Request, Response};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::io::BufReader;
use std::os::unix::net::UnixStream;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State};

pub struct DaemonConnection {
    writer: Arc<Mutex<UnixStream>>,
}

/// The frontend's whole view of workspace/page state, sent over IPC (the
/// return value of `get_workspaces_state`, and the payload of the
/// `workspaces-ready` event). camelCase to match the frontend's TypeScript
/// naming -- the same reason `Workspace`/`Page` themselves use it, and the
/// same reason `LayoutNode` already renames `active_tab_index`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspacesData {
    pub workspaces: Vec<Workspace>,
    pub active_workspace_id: Option<String>,
}

pub struct WorkspacesState(pub Mutex<WorkspacesData>);

/// User-assigned session display names, keyed by session id. Independent
/// Tauri-managed state from `WorkspacesState`, but both persist into the
/// same `AppConfig` -- every command that saves one must read the other's
/// current value too (see `set_workspaces_state`/`set_session_name`), or it
/// would silently reset the other field to empty on every save.
pub struct SessionNames(pub Mutex<HashMap<String, String>>);

#[tauri::command]
pub fn get_workspaces_state(state: State<WorkspacesState>) -> WorkspacesData {
    state.0.lock().unwrap().clone()
}

#[tauri::command]
pub fn set_workspaces_state(
    workspaces: Vec<Workspace>,
    active_workspace_id: Option<String>,
    app_handle: AppHandle,
    state: State<WorkspacesState>,
    names_state: State<SessionNames>,
) -> Result<(), String> {
    let data = WorkspacesData { workspaces, active_workspace_id };
    *state.0.lock().unwrap() = data.clone();
    let session_names = names_state.0.lock().unwrap().clone();
    let config_dir = app_handle.path().app_config_dir().map_err(|e| e.to_string())?;
    crate::config::save(
        &config_dir,
        &crate::config::AppConfig {
            workspaces: data.workspaces,
            active_workspace_id: data.active_workspace_id,
            session_names,
        },
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_session_names(state: State<SessionNames>) -> HashMap<String, String> {
    state.0.lock().unwrap().clone()
}

#[tauri::command]
pub fn set_session_name(
    session_id: String,
    name: String,
    app_handle: AppHandle,
    workspaces_state: State<WorkspacesState>,
    names_state: State<SessionNames>,
) -> Result<(), String> {
    // An empty (or whitespace-only) name clears the override rather than
    // persisting an empty string -- there's no separate "clear" command,
    // this is the one way a rename can be undone.
    let session_names = {
        let mut names = names_state.0.lock().unwrap();
        let trimmed = name.trim();
        if trimmed.is_empty() {
            names.remove(&session_id);
        } else {
            names.insert(session_id, trimmed.to_string());
        }
        names.clone()
    };
    let data = workspaces_state.0.lock().unwrap().clone();
    let config_dir = app_handle.path().app_config_dir().map_err(|e| e.to_string())?;
    crate::config::save(
        &config_dir,
        &crate::config::AppConfig {
            workspaces: data.workspaces,
            active_workspace_id: data.active_workspace_id,
            session_names,
        },
    )
    .map_err(|e| e.to_string())
}
```

- [ ] **Step 2: Replace `resolve_layout` with `list_valid_session_ids` + `resolve_workspaces`, extract the shared test-daemon helper, and add the new reconciliation tests**

Immediately below `resolve_sessions` (which stays exactly as it is — do not modify its body), replace the whole `resolve_layout` function with:

```rust
/// Fetches the full session list once and returns the set of ids that are
/// still alive (not exited). Called at most once per bootstrap, regardless
/// of how many pages/workspaces need reconciling against it.
fn list_valid_session_ids(command_conn: &Mutex<UnixStream>) -> anyhow::Result<HashSet<String>> {
    let resp = send_command(command_conn, &Request::ListSessions)?;
    match resp {
        Response::SessionList { sessions } => Ok(sessions
            .into_iter()
            .filter(|s| s.status != "exited")
            .map(|s| s.id)
            .collect()),
        other => anyhow::bail!("expected SessionList, got {other:?}"),
    }
}

/// Resolves every session id referenced by every page of every workspace
/// against the daemon's actual live sessions, replacing any that are stale
/// in place. An empty `workspaces` list -- nothing saved yet, or a config
/// from before this milestone -- is left untouched: no default workspace
/// or session is auto-created, and `ListSessions` isn't even called.
fn resolve_workspaces(
    workspaces: &mut [Workspace],
    command_conn: &Mutex<UnixStream>,
) -> anyhow::Result<()> {
    if workspaces.is_empty() {
        return Ok(());
    }
    let valid_ids = list_valid_session_ids(command_conn)?;
    for workspace in workspaces.iter_mut() {
        for page in workspace.pages.iter_mut() {
            resolve_sessions(&mut page.layout, command_conn, &valid_ids)?;
        }
    }
    Ok(())
}
```

Now find the existing `#[cfg(test)] mod command_connection_tests { ... }` block. Extract its `fake_daemon_replying_with` helper into a new, sibling `test_support` module that both it and the new reconciliation tests can share. Replace the whole `command_connection_tests` module with:

```rust
#[cfg(test)]
mod test_support {
    use super::*;
    use std::os::unix::net::UnixListener;

    /// Spins up a minimal fake daemon: accepts one connection, then for
    /// each response given, reads exactly one Request and replies with
    /// that Response, in order. Returns the connected client-side
    /// UnixStream ready to pass to send_command. Shared by
    /// command_connection_tests and resolve_workspaces_tests.
    pub fn fake_daemon_replying_with(responses: Vec<Response>) -> (UnixStream, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let socket_path = dir.path().join("fake.sock");
        let listener = UnixListener::bind(&socket_path).unwrap();

        std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            for response in responses {
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let _req: Request = read_message(&mut reader).unwrap().unwrap();
                write_message(&mut stream, &response).unwrap();
            }
        });

        let client = UnixStream::connect(&socket_path).unwrap();
        (client, dir)
    }
}

#[cfg(test)]
mod command_connection_tests {
    use super::test_support::fake_daemon_replying_with;
    use super::*;

    #[test]
    fn send_command_round_trips_a_request_and_response() {
        let (client, _dir) = fake_daemon_replying_with(vec![Response::SessionCreated {
            id: "new-session-id".to_string(),
        }]);
        let conn = Mutex::new(client);

        let resp = send_command(
            &conn,
            &Request::CreateSession {
                workspace_path: "/tmp".to_string(),
                cwd: "/tmp".to_string(),
                command: None,
            },
        )
        .unwrap();

        match resp {
            Response::SessionCreated { id } => assert_eq!(id, "new-session-id"),
            other => panic!("expected SessionCreated, got {other:?}"),
        }
    }

    #[test]
    fn send_command_returns_the_error_response() {
        let (client, _dir) = fake_daemon_replying_with(vec![Response::Error {
            message: "unknown session: xyz".to_string(),
        }]);
        let conn = Mutex::new(client);

        let resp = send_command(&conn, &Request::KillSession { id: "xyz".to_string() }).unwrap();

        match resp {
            Response::Error { message } => assert_eq!(message, "unknown session: xyz"),
            other => panic!("expected Error, got {other:?}"),
        }
    }

    #[test]
    fn send_command_sequential_calls_dont_cross_streams() {
        // Two calls in a row on the same connection must each get their own
        // reply, in order -- this is the whole reason CommandConnection
        // exists as a separate, mutex-serialized connection.
        let (client, _dir) = fake_daemon_replying_with(vec![
            Response::SessionCreated { id: "session-0".to_string() },
            Response::SessionCreated { id: "session-1".to_string() },
        ]);
        let conn = Mutex::new(client);

        let make_req = || Request::CreateSession {
            workspace_path: "/tmp".to_string(),
            cwd: "/tmp".to_string(),
            command: None,
        };

        let first = send_command(&conn, &make_req()).unwrap();
        let second = send_command(&conn, &make_req()).unwrap();

        match (first, second) {
            (Response::SessionCreated { id: id0 }, Response::SessionCreated { id: id1 }) => {
                assert_eq!(id0, "session-0");
                assert_eq!(id1, "session-1");
            }
            other => panic!("unexpected: {other:?}"),
        }
    }
}

#[cfg(test)]
mod resolve_workspaces_tests {
    use super::test_support::fake_daemon_replying_with;
    use super::*;

    fn leaf(tabs: &[&str]) -> LayoutNode {
        LayoutNode::Leaf { tabs: tabs.iter().map(|s| s.to_string()).collect(), active_tab_index: 0 }
    }

    fn page(id: &str, layout: LayoutNode) -> Page {
        Page { id: id.to_string(), name: id.to_string(), layout, focused_session_id: None }
    }

    fn workspace(id: &str, pages: Vec<Page>) -> Workspace {
        Workspace { id: id.to_string(), name: id.to_string(), pages, active_page_id: None }
    }

    fn valid_session(id: &str) -> protocol::SessionSummary {
        protocol::SessionSummary {
            id: id.to_string(),
            workspace_path: "/tmp".to_string(),
            cwd: "/tmp".to_string(),
            status: "idle".to_string(),
            restored: false,
        }
    }

    #[test]
    fn empty_workspaces_makes_no_daemon_calls_at_all() {
        // Zero queued responses -- if resolve_workspaces called
        // ListSessions anyway, send_command would hit a connection the fake
        // daemon thread already closed and error, which the unwrap() below
        // would turn into a clear panic rather than silently passing.
        let (client, _dir) = fake_daemon_replying_with(vec![]);
        let conn = Mutex::new(client);
        let mut workspaces: Vec<Workspace> = vec![];

        resolve_workspaces(&mut workspaces, &conn).unwrap();

        assert_eq!(workspaces, vec![]);
    }

    #[test]
    fn calls_list_sessions_exactly_once_regardless_of_page_count() {
        // Only one SessionList reply is queued. If resolve_workspaces
        // called ListSessions more than once (e.g. once per page instead
        // of once total), the second send_command would hit a connection
        // the fake daemon thread already closed after its one reply, and
        // the unwrap() below would panic on that error.
        let (client, _dir) = fake_daemon_replying_with(vec![Response::SessionList {
            sessions: vec![valid_session("valid-1"), valid_session("valid-2")],
        }]);
        let conn = Mutex::new(client);
        let mut workspaces = vec![
            workspace("ws-1", vec![page("page-1", leaf(&["valid-1"]))]),
            workspace("ws-2", vec![page("page-2", leaf(&["valid-2"]))]),
        ];

        resolve_workspaces(&mut workspaces, &conn).unwrap();

        assert_eq!(workspaces[0].pages[0].layout, leaf(&["valid-1"]));
        assert_eq!(workspaces[1].pages[0].layout, leaf(&["valid-2"]));
    }

    #[test]
    fn replaces_stale_session_ids_across_multiple_pages_and_workspaces() {
        let (client, _dir) = fake_daemon_replying_with(vec![
            Response::SessionList { sessions: vec![valid_session("valid-1")] },
            Response::SessionCreated { id: "fresh-a".to_string() },
            Response::SessionCreated { id: "fresh-b".to_string() },
        ]);
        let conn = Mutex::new(client);
        let mut workspaces = vec![
            workspace("ws-1", vec![page("page-1", leaf(&["valid-1", "stale-1"]))]),
            workspace("ws-2", vec![page("page-2", leaf(&["stale-2"]))]),
        ];

        resolve_workspaces(&mut workspaces, &conn).unwrap();

        assert_eq!(workspaces[0].pages[0].layout, leaf(&["valid-1", "fresh-a"]));
        assert_eq!(workspaces[1].pages[0].layout, leaf(&["fresh-b"]));
    }
}
```

- [ ] **Step 3: Run the new and existing session.rs tests**

Run: `cd /Users/coalpila/CloudStation/Coding/gavin && cargo test -p app --lib session::`
Expected: FAIL to compile — Step 1 removed `CurrentLayout`/`get_current_layout`/`set_layout` and Step 2 removed `resolve_layout` entirely, but `bootstrap()` (further down in the file, not yet touched) still references all three, plus `config.layout` and the `layout-ready` event. This is expected; the next step fixes it.

- [ ] **Step 4: Rewrite `bootstrap()` to use `resolve_workspaces`/`WorkspacesState`**

Replace `bootstrap()`'s body from `let config_dir = app_handle.path().app_config_dir()?;` through the `app_handle.emit("layout-ready", &layout)?;` line with:

```rust
    let config_dir = app_handle.path().app_config_dir()?;
    let config = crate::config::load(&config_dir)?;
    let session_names = config.session_names;

    let mut workspaces = config.workspaces;
    resolve_workspaces(&mut workspaces, &command_conn)?;
    let active_workspace_id = config.active_workspace_id;
    crate::config::save(
        &config_dir,
        &crate::config::AppConfig {
            layout: None,
            workspaces: workspaces.clone(),
            active_workspace_id: active_workspace_id.clone(),
            session_names: session_names.clone(),
        },
    )?;

    let all_session_ids: Vec<String> = workspaces
        .iter()
        .flat_map(|w| w.pages.iter())
        .flat_map(|p| p.layout.all_session_ids())
        .collect();
    for id in all_session_ids {
        send_request(&writer, &Request::Attach { id })?;
    }

    app_handle.manage(DaemonConnection { writer: Arc::clone(&writer) });
    app_handle.manage(CommandConnection(command_conn));
    let workspaces_data = WorkspacesData { workspaces, active_workspace_id };
    app_handle.manage(WorkspacesState(Mutex::new(workspaces_data.clone())));
    app_handle.manage(SessionNames(Mutex::new(session_names)));
    app_handle.emit("workspaces-ready", &workspaces_data)?;
```

(Everything below this, starting from `let mut reader = BufReader::new(reader_stream);`, is unchanged.)

Also update `create_fresh_session`'s doc comment, which currently reads "Shared by the create_session command below and, starting in Task 3, resolve_layout's per-tab fallback" — change it to:

```rust
/// Shared by the create_session command below and resolve_sessions's
/// per-tab fallback (via resolve_workspaces) -- both are exactly "create a
/// fresh session at $HOME and return its id."
fn create_fresh_session(command_conn: &Mutex<UnixStream>) -> anyhow::Result<String> {
```

- [ ] **Step 5: Run the full app test suite**

Run: `cd /Users/coalpila/CloudStation/Coding/gavin && cargo test -p app`
Expected: PASS — every symbol `bootstrap()` now references (`WorkspacesData`, `WorkspacesState`, `resolve_workspaces`) was added in Steps 1-2, and `layout: None` in the rewritten `AppConfig { ... }` literal above still compiles fine since Task 1 deliberately kept that field around for exactly this reason. If it doesn't pass, re-check Step 4's edit was applied completely and matches the block boundaries described.

- [ ] **Step 6: Remove `AppConfig.layout` and update `lib.rs`'s registered commands**

In `app/src-tauri/src/config.rs`:
1. Delete the `pub layout: Option<LayoutNode>,` field and its `// TEMPORARY for this milestone's Part 1...` comment from `AppConfig`.
2. Update `session_names`'s doc comment to remove the now-dangling reference to `layout`:

```rust
    /// User-assigned display names, keyed by session id. Independent of
    /// `workspaces` (a session can be renamed regardless of which
    /// page/workspace it sits in) -- callers that persist one must always
    /// carry the other's current value along too, or they'll silently
    /// reset it to empty.
    #[serde(default)]
    pub session_names: HashMap<String, String>,
```
3. In the `tests` module, remove `sample_layout()`'s only remaining direct callers that construct a bare `layout: Some(...)`/`layout: None` field: update every `AppConfig { ... }` literal to drop the `layout` field entirely, and delete the now-meaningless `workspaces_roundtrip_alongside_the_old_layout_field` test (superseded — every remaining test already exercises `workspaces` without a `layout` field to be "alongside"). The final test module should read:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::layout::LayoutNode;

    fn sample_layout() -> LayoutNode {
        LayoutNode::Leaf {
            tabs: vec!["abc-123".to_string()],
            active_tab_index: 0,
        }
    }

    fn sample_page() -> Page {
        Page {
            id: "page-1".to_string(),
            name: "Page 1".to_string(),
            layout: sample_layout(),
            focused_session_id: None,
        }
    }

    fn sample_workspace() -> Workspace {
        Workspace {
            id: "workspace-1".to_string(),
            name: "Workspace 1".to_string(),
            pages: vec![sample_page()],
            active_page_id: Some("page-1".to_string()),
        }
    }

    #[test]
    fn load_returns_default_when_no_file_exists() {
        let dir = tempfile::tempdir().unwrap();
        let config = load(dir.path()).unwrap();
        assert_eq!(config, AppConfig::default());
        assert_eq!(config.workspaces, Vec::new());
    }

    #[test]
    fn save_then_load_roundtrips() {
        let dir = tempfile::tempdir().unwrap();
        let config = AppConfig {
            workspaces: vec![sample_workspace()],
            active_workspace_id: Some("workspace-1".to_string()),
            session_names: HashMap::new(),
        };
        save(dir.path(), &config).unwrap();

        let loaded = load(dir.path()).unwrap();
        assert_eq!(loaded, config);
    }

    #[test]
    fn session_names_roundtrip_alongside_workspaces() {
        let dir = tempfile::tempdir().unwrap();
        let mut session_names = HashMap::new();
        session_names.insert("abc-123".to_string(), "my project".to_string());
        let config = AppConfig {
            workspaces: vec![sample_workspace()],
            active_workspace_id: Some("workspace-1".to_string()),
            session_names,
        };
        save(dir.path(), &config).unwrap();

        let loaded = load(dir.path()).unwrap();
        assert_eq!(loaded, config);
        assert_eq!(loaded.session_names.get("abc-123"), Some(&"my project".to_string()));
    }

    #[test]
    fn load_defaults_session_names_when_field_is_absent_from_an_older_config_file() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            config_path(dir.path()),
            r#"{"workspaces": [], "active_workspace_id": null}"#,
        )
        .unwrap();

        let config = load(dir.path()).unwrap();
        assert_eq!(config.session_names, HashMap::new());
    }

    #[test]
    fn load_defaults_workspaces_and_active_workspace_id_when_absent_from_an_older_config_file() {
        let dir = tempfile::tempdir().unwrap();
        // Mirrors a genuine config.json from before this milestone -- only
        // `layout`/`session_names` existed. `layout`'s value here is
        // irrelevant: the field no longer exists on AppConfig at all, so
        // serde silently drops it rather than reading it into anything.
        std::fs::write(config_path(dir.path()), r#"{"layout": null, "session_names": {}}"#).unwrap();

        let config = load(dir.path()).unwrap();
        assert_eq!(config.workspaces, Vec::new());
        assert_eq!(config.active_workspace_id, None);
    }

    #[test]
    fn save_creates_missing_parent_directories() {
        let dir = tempfile::tempdir().unwrap();
        let nested = dir.path().join("nested").join("config-dir");
        let config = AppConfig {
            workspaces: vec![sample_workspace()],
            active_workspace_id: Some("workspace-1".to_string()),
            session_names: HashMap::new(),
        };
        save(&nested, &config).unwrap();

        assert!(config_path(&nested).exists());
    }

    #[test]
    fn load_treats_malformed_json_as_default() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(config_path(dir.path()), "{not valid json").unwrap();

        let config = load(dir.path()).unwrap();
        assert_eq!(config, AppConfig::default());
    }
}
```

Also update `bootstrap()` in `session.rs`: remove the now-invalid `layout: None,` field from the `crate::config::AppConfig { ... }` literal written in Step 4 above (it no longer exists on `AppConfig`), so that block reads:

```rust
    crate::config::save(
        &config_dir,
        &crate::config::AppConfig {
            workspaces: workspaces.clone(),
            active_workspace_id: active_workspace_id.clone(),
            session_names: session_names.clone(),
        },
    )?;
```

In `app/src-tauri/src/lib.rs`, inside the `tauri::generate_handler![...]` list, replace the line `session::get_current_layout,` and `session::set_layout,` with `session::get_workspaces_state,` and `session::set_workspaces_state,` (keep every other line unchanged).

- [ ] **Step 7: Run the full workspace build and test suite**

Run: `cd /Users/coalpila/CloudStation/Coding/gavin && cargo build && cargo test`
Expected: PASS — every crate (`app`, `crates/daemon`, `crates/protocol`) compiles and all tests pass, with zero references to `layout`, `CurrentLayout`, `get_current_layout`, `set_layout`, or `resolve_layout` remaining anywhere in the workspace. Confirm with:

Run: `cd /Users/coalpila/CloudStation/Coding/gavin && grep -rn "CurrentLayout\|get_current_layout\|set_layout\|resolve_layout\|layout-ready" app/src-tauri/src/`
Expected: no output.

- [ ] **Step 8: Commit**

```bash
git add app/src-tauri/src/session.rs app/src-tauri/src/lib.rs app/src-tauri/src/config.rs
git commit -m "feat(app): migrate bootstrap/config-persistence to Workspace/Page, replacing the single global layout"
```
