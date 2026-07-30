# Terminal Core — Milestone C, Part 1: Backend Session/Layout Model

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the Tauri app's session model to support multiple simultaneous sessions (one per tab, many tabs per pane, many panes in a split tree) instead of Milestone B's single hardcoded session — without touching the daemon or its protocol at all.

**Architecture:** Two daemon connections instead of one. The existing connection keeps doing exactly what it did in Milestone B — `Attach` calls (now one per session in the layout, not just one) plus the continuous background relay of `Output`/`SessionExited`/`Error` as Tauri events. A **new second connection** is added exclusively for one-shot request/response commands (`ListSessions`/`CreateSession`/`KillSession`) — necessary because `create_session` needs to return a real session id synchronously to the frontend, and reading that reply off the *same* connection the background relay thread is continuously reading would race for bytes on the socket with no way to tell which reply belongs to which request. The new connection is `Mutex`-serialized (one full request-then-response cycle at a time), which is what makes correlation unambiguous without needing a request-id field the daemon protocol doesn't have.

**Tech Stack:** Rust, unchanged dependencies (no new crates needed for this backend-only plan — clipboard/UI work is Part 2).

## Global Constraints

- Platform: macOS only (unchanged).
- **Daemon protocol: zero changes.** Everything here works against the exact `Request`/`Response` shapes already in `crates/protocol` — `CreateSession`/`Attach`/`WriteInput`/`ResizeSession`/`KillSession`/`ListSessions` already operate per-session-id.
- This plan is backend-only. No frontend (Svelte) files change. `Terminal.svelte` will break against these new command signatures until Part 2 (a separate, subsequent plan, written once this one has landed) updates it — that's expected and fine; this plan's own verification is `cargo build -p app` succeeding, not the frontend working end-to-end.
- Every session id referenced anywhere in a persisted layout gets the same stale/exited fallback Milestone B's final review established for its one session: if the daemon doesn't recognize an id, or reports it `exited`, silently replace it with a freshly created session — never surface an error to the user for this case.
- `ActiveSessionId` (Milestone B's single-session state) is removed entirely by the end of this plan. `write_input`/`resize_session` take an explicit `session_id` parameter from the caller instead.

## Roadmap (not part of this plan)

**Part 2** (a separate plan, written after this one is built and reviewed):
the frontend — extracting a reusable pane component, the tab bar, the
recursive split-tree layout renderer with resize dividers, keyboard
shortcuts, a toolbar, layout presets, and clipboard copy/paste (a new
`tauri-plugin-clipboard-manager` dependency). Grounding Part 2's design in
this plan's actual shipped command signatures and event shapes, rather than
guessing them during Part 1, is the whole reason for this split — the same
reasoning Milestone A's plan used for deferring B/C/etc.

---

### Task 1: Layout data model + config migration

**Files:**
- Create: `app/src-tauri/src/layout.rs`
- Modify: `app/src-tauri/src/lib.rs` (add `mod layout;`)
- Modify: `app/src-tauri/src/config.rs` (replace `AppConfig.session_id` with `AppConfig.layout`, update all existing tests)

**Interfaces:**
- Produces: `layout::{Direction, LayoutNode}` — `LayoutNode::Leaf { tabs: Vec<String>, active_tab_index: usize }` and `LayoutNode::Split { direction: Direction, children: Vec<LayoutNode>, sizes: Vec<f64> }`, serializing to `{ "type": "leaf", "tabs": [...], "activeTabIndex": N }` / `{ "type": "split", "direction": "row"|"column", "children": [...], "sizes": [...] }` — this exact shape is what Part 2's frontend will consume directly as a TypeScript discriminated union, so the JSON shape is load-bearing, not incidental. `LayoutNode::all_session_ids(&self) -> Vec<String>`. `config::AppConfig { layout: Option<LayoutNode> }`.

- [ ] **Step 1: Write the failing tests**

Create `app/src-tauri/src/layout.rs`:

```rust
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Direction {
    Row,
    Column,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum LayoutNode {
    Leaf {
        tabs: Vec<String>,
        #[serde(rename = "activeTabIndex")]
        active_tab_index: usize,
    },
    Split {
        direction: Direction,
        children: Vec<LayoutNode>,
        sizes: Vec<f64>,
    },
}

#[cfg(test)]
mod tests {
    use super::*;

    fn leaf(tabs: &[&str]) -> LayoutNode {
        LayoutNode::Leaf {
            tabs: tabs.iter().map(|s| s.to_string()).collect(),
            active_tab_index: 0,
        }
    }

    #[test]
    fn all_session_ids_on_a_single_leaf() {
        let tree = leaf(&["a", "b"]);
        assert_eq!(tree.all_session_ids(), vec!["a".to_string(), "b".to_string()]);
    }

    #[test]
    fn all_session_ids_across_a_split() {
        let tree = LayoutNode::Split {
            direction: Direction::Row,
            children: vec![leaf(&["a"]), leaf(&["b", "c"])],
            sizes: vec![0.5, 0.5],
        };
        assert_eq!(
            tree.all_session_ids(),
            vec!["a".to_string(), "b".to_string(), "c".to_string()]
        );
    }

    #[test]
    fn serializes_to_the_shape_the_frontend_expects() {
        let tree = leaf(&["s1"]);
        let json = serde_json::to_value(&tree).unwrap();
        assert_eq!(
            json,
            serde_json::json!({ "type": "leaf", "tabs": ["s1"], "activeTabIndex": 0 })
        );
    }

    #[test]
    fn split_serializes_to_the_shape_the_frontend_expects() {
        let tree = LayoutNode::Split {
            direction: Direction::Column,
            children: vec![leaf(&["s1"]), leaf(&["s2"])],
            sizes: vec![0.6, 0.4],
        };
        let json = serde_json::to_value(&tree).unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "type": "split",
                "direction": "column",
                "children": [
                    { "type": "leaf", "tabs": ["s1"], "activeTabIndex": 0 },
                    { "type": "leaf", "tabs": ["s2"], "activeTabIndex": 0 }
                ],
                "sizes": [0.6, 0.4]
            })
        );
    }
}
```

Add `mod layout;` to `app/src-tauri/src/lib.rs`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test -p app layout::`
Expected: FAIL to compile — `all_session_ids` is not defined yet.

- [ ] **Step 3: Implement `all_session_ids`**

Add to `app/src-tauri/src/layout.rs` (above the `#[cfg(test)]` block):

```rust
impl LayoutNode {
    /// Every session id referenced anywhere in the tree, in tree order.
    pub fn all_session_ids(&self) -> Vec<String> {
        match self {
            LayoutNode::Leaf { tabs, .. } => tabs.clone(),
            LayoutNode::Split { children, .. } => {
                children.iter().flat_map(|c| c.all_session_ids()).collect()
            }
        }
    }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test -p app layout::`
Expected: PASS — all 4 tests green.

- [ ] **Step 5: Migrate `AppConfig`**

Open `app/src-tauri/src/config.rs`. Replace the `AppConfig` struct and update
every test that constructs one:

```rust
use crate::layout::LayoutNode;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub struct AppConfig {
    pub layout: Option<LayoutNode>,
}
```

`config_path`, `load`, and `save` themselves don't change — they're generic
over whatever `AppConfig` contains. Update the 4 existing tests to use
`layout` instead of `session_id`:

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
        let config = AppConfig { layout: Some(sample_layout()) };
        save(dir.path(), &config).unwrap();

        let loaded = load(dir.path()).unwrap();
        assert_eq!(loaded, config);
    }

    #[test]
    fn save_creates_missing_parent_directories() {
        let dir = tempfile::tempdir().unwrap();
        let nested = dir.path().join("nested").join("config-dir");
        let config = AppConfig { layout: Some(sample_layout()) };
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

- [ ] **Step 6: Run the full test suite**

Run: `cargo test -p app`
Expected: PASS — layout's 4 tests plus config's 4 (updated) tests, all
green. `cargo build -p app` will still fail at this point — `session.rs`
still references the old `AppConfig.session_id` field. That's expected;
Task 3 fixes it. Confirm the *test* command passes even though the full
crate doesn't build yet by running `cargo test -p app layout:: config::`
specifically (scoped past the not-yet-updated `session.rs`).

- [ ] **Step 7: Commit**

```bash
git add app/src-tauri/src/layout.rs app/src-tauri/src/lib.rs app/src-tauri/src/config.rs
git commit -m "feat(app): add layout tree data model, migrate AppConfig"
```

---

### Task 2: Dual-connection command channel

**Files:**
- Modify: `app/src-tauri/src/session.rs` (add `CommandConnection`, `send_command`, `create_session`, `kill_session` — does not touch `bootstrap` yet)

**Interfaces:**
- Produces: `session::CommandConnection(pub Mutex<UnixStream>)`, `session::send_command(conn: &Mutex<UnixStream>, req: &Request) -> anyhow::Result<Response>` (private helper, not a Tauri command — the two commands below are its only callers for now), `#[tauri::command] session::create_session(state: State<CommandConnection>) -> Result<String, String>`, `#[tauri::command] session::kill_session(session_id: String, state: State<CommandConnection>) -> Result<(), String>`.

This task deliberately does **not** wire `CommandConnection` into `bootstrap` or `lib.rs`'s command registration yet — that's Task 3, once `bootstrap` itself is generalized. Adding the machinery first, proven correct in isolation via the tests below, then wiring it into the bigger integration change keeps each task's diff reviewable on its own.

- [ ] **Step 1: Write the failing tests**

Open `app/src-tauri/src/session.rs`. Add, anywhere in the file above the
existing `#[tauri::command]` functions:

```rust
/// A second, dedicated connection to the daemon, used only for one-shot
/// request/response commands (ListSessions/CreateSession/KillSession).
/// Kept separate from the streaming connection (DaemonConnection) whose
/// background thread continuously reads Output/SessionExited off the
/// socket — reading a CreateSession reply off *that* connection would
/// race the relay thread for bytes, with no way to tell which reply
/// belongs to which request. The Mutex serializes this connection's own
/// request-then-response cycles, one at a time, which is what makes
/// correlation unambiguous without the daemon protocol needing a
/// request-id field.
pub struct CommandConnection(pub Mutex<UnixStream>);

fn send_command(conn: &Mutex<UnixStream>, req: &Request) -> anyhow::Result<Response> {
    let mut stream = conn.lock().unwrap();
    write_message(&mut *stream, req)?;
    let mut reader = BufReader::new(&mut *stream);
    read_message(&mut reader)?
        .ok_or_else(|| anyhow::anyhow!("daemon closed the command connection"))
}
```

Add a new test module (a sibling of any existing `#[cfg(test)]` block in
this file, not nested inside it):

```rust
#[cfg(test)]
mod command_connection_tests {
    use super::*;
    use std::os::unix::net::UnixListener;

    /// Spins up a minimal fake daemon: accepts one connection, then for
    /// each response given, reads exactly one Request and replies with
    /// that Response, in order. Returns the connected client-side
    /// UnixStream ready to pass to send_command.
    fn fake_daemon_replying_with(responses: Vec<Response>) -> (UnixStream, tempfile::TempDir) {
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test -p app session::command_connection_tests`
Expected: the crate fails to build at this point regardless (Task 1 left
`session.rs` referencing the old `AppConfig.session_id` field, not fixed
until Task 3) — confirm instead that the specific errors are about the
*new* test code compiling correctly in isolation by reading the compiler
output: there should be no errors pointing at `command_connection_tests`
itself, only at the pre-existing `AppConfig.session_id` reference
elsewhere in the file. If there are errors inside
`command_connection_tests`, fix those before proceeding — don't rely on
Task 3 to paper over a mistake here.

- [ ] **Step 3: Implement `create_session` and `kill_session`**

Add, alongside the existing `#[tauri::command]` functions in
`app/src-tauri/src/session.rs`:

```rust
#[tauri::command]
pub fn create_session(state: State<CommandConnection>) -> Result<String, String> {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/".to_string());
    let resp = send_command(
        &state.0,
        &Request::CreateSession {
            workspace_path: home.clone(),
            cwd: home,
            command: None,
        },
    )
    .map_err(|e| e.to_string())?;
    match resp {
        Response::SessionCreated { id } => Ok(id),
        Response::Error { message } => Err(message),
        other => Err(format!("unexpected response: {other:?}")),
    }
}

#[tauri::command]
pub fn kill_session(session_id: String, state: State<CommandConnection>) -> Result<(), String> {
    let resp = send_command(&state.0, &Request::KillSession { id: session_id })
        .map_err(|e| e.to_string())?;
    match resp {
        Response::Ok => Ok(()),
        Response::Error { message } => Err(message),
        other => Err(format!("unexpected response: {other:?}")),
    }
}
```

Do **not** register these in `lib.rs`'s `generate_handler!` yet, and do
**not** call `.manage(CommandConnection(...))` anywhere yet — the crate
still won't build until Task 3 fixes `bootstrap`'s `AppConfig` usage, and
wiring up state management for a connection that's never constructed
would just be more code to immediately touch again next task. `dead_code`
warnings on `create_session`/`kill_session` here are expected and
temporary, same pattern as earlier milestones' intermediate tasks.

- [ ] **Step 4: Run the new tests to verify they pass**

Run: `cargo test -p app session::command_connection_tests`
Expected: PASS — all 3 tests green, independent of whether the rest of the
crate currently builds (this specific test module only depends on code
this task and Task 1 already added correctly).

- [ ] **Step 5: Commit**

```bash
git add app/src-tauri/src/session.rs
git commit -m "feat(app): add dual-connection command channel (create_session, kill_session)"
```

---

### Task 3: Generalize bootstrap for multi-session layouts

**Files:**
- Modify: `app/src-tauri/src/session.rs` (remove `ActiveSessionId`; add `resolve_layout`/`resolve_sessions`/`create_fresh_session`/`CurrentLayout`/`get_current_layout`; generalize `bootstrap`; change `write_input`/`resize_session` signatures)
- Modify: `app/src-tauri/src/lib.rs` (register the new commands, drop the removed ones)

**Interfaces:**
- Consumes: `layout::LayoutNode` (Task 1), `CommandConnection`/`send_command`/`create_session`/`kill_session` (Task 2).
- Produces: `session::CurrentLayout(pub Mutex<LayoutNode>)`, `#[tauri::command] session::get_current_layout(state: State<CurrentLayout>) -> LayoutNode`. Changed: `#[tauri::command] session::write_input(session_id: String, data: String, state: State<DaemonConnection>) -> Result<(), String>`, `#[tauri::command] session::resize_session(session_id: String, cols: u16, rows: u16, state: State<DaemonConnection>) -> Result<(), String>` (both now take an explicit `session_id`, replacing the old implicit `ActiveSessionId` lookup). Removed: `ActiveSessionId`, `get_current_session`. Tauri events: `layout-ready` (payload: the resolved `LayoutNode`) replaces `session-ready`; `pty-output`/`session-exited`/`daemon-error` unchanged in shape (still per-session-id-tagged, already correct for multiplexing).

This is the task that ties Tasks 1 and 2 into a working whole. There is no
automated test for `bootstrap` itself — same as Milestone B's equivalent
task, it requires a running daemon and a live Tauri `AppHandle`, neither
available in a unit test context. Verification here is `cargo build -p app`
succeeding cleanly. Full behavioral verification (does a saved multi-tab
layout actually reattach correctly) happens once Part 2 exists to observe
it through.

- [ ] **Step 1: Replace `bootstrap` and remove `ActiveSessionId`**

Open `app/src-tauri/src/session.rs`. Add this import (merge with what's
already there — `resolve_sessions` below needs it, nothing added in Task 2
did):

```rust
use std::collections::HashSet;
```

Delete the `ActiveSessionId` struct and the `get_current_session` command
entirely. Add, near the top of the file (alongside the other managed-state
structs):

```rust
pub struct CurrentLayout(pub Mutex<LayoutNode>);

#[tauri::command]
pub fn get_current_layout(state: State<CurrentLayout>) -> LayoutNode {
    state.0.lock().unwrap().clone()
}
```

Add these helper functions (private, not commands) near `send_command`:

```rust
fn create_fresh_session(command_conn: &Mutex<UnixStream>) -> anyhow::Result<String> {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/".to_string());
    let resp = send_command(
        command_conn,
        &Request::CreateSession {
            workspace_path: home.clone(),
            cwd: home,
            command: None,
        },
    )?;
    match resp {
        Response::SessionCreated { id } => Ok(id),
        other => anyhow::bail!("expected SessionCreated, got {other:?}"),
    }
}

/// Walks the tree, replacing any session id not present in `valid_ids`
/// (stale, exited, or never existed) with a freshly created session — the
/// same silent, normal fallback Milestone B established for its one
/// session, now applied uniformly to every tab in every pane.
fn resolve_sessions(
    node: &mut LayoutNode,
    command_conn: &Mutex<UnixStream>,
    valid_ids: &HashSet<String>,
) -> anyhow::Result<()> {
    match node {
        LayoutNode::Leaf { tabs, .. } => {
            for id in tabs.iter_mut() {
                if !valid_ids.contains(id.as_str()) {
                    *id = create_fresh_session(command_conn)?;
                }
            }
            Ok(())
        }
        LayoutNode::Split { children, .. } => {
            for child in children.iter_mut() {
                resolve_sessions(child, command_conn, valid_ids)?;
            }
            Ok(())
        }
    }
}

/// Loads the persisted layout (or builds a fresh single-pane default if
/// none was saved) and resolves every session id it references against
/// the daemon's actual live sessions, replacing any that are stale.
fn resolve_layout(
    command_conn: &Mutex<UnixStream>,
    saved: Option<LayoutNode>,
) -> anyhow::Result<LayoutNode> {
    match saved {
        Some(mut layout) => {
            let resp = send_command(command_conn, &Request::ListSessions)?;
            let valid_ids: HashSet<String> = match resp {
                Response::SessionList { sessions } => sessions
                    .into_iter()
                    .filter(|s| s.status != "exited")
                    .map(|s| s.id)
                    .collect(),
                other => anyhow::bail!("expected SessionList, got {other:?}"),
            };
            resolve_sessions(&mut layout, command_conn, &valid_ids)?;
            Ok(layout)
        }
        None => {
            let id = create_fresh_session(command_conn)?;
            Ok(LayoutNode::Leaf { tabs: vec![id], active_tab_index: 0 })
        }
    }
}
```

Replace the whole `bootstrap` function with:

```rust
/// Connects to (or spawns) the daemon over two connections — one for the
/// continuous Attach/Output relay, one for one-shot request/response
/// commands (see CommandConnection's doc comment) — resolves the saved
/// layout (or builds a fresh default), attaches every session it
/// references, registers Tauri-managed state for the commands below, and
/// spawns a background thread that relays every subsequent daemon message
/// to the frontend as a Tauri event. Called once from the app's setup hook.
pub fn bootstrap(app_handle: AppHandle) -> anyhow::Result<()> {
    let stream_conn = crate::daemon::connect_or_spawn(
        &socket_path(),
        Duration::from_secs(3),
        crate::daemon::spawn_real_daemon,
    )?;
    // The daemon is confirmed reachable by the connect above (which may
    // have just spawned it) — this second connection should succeed
    // immediately, no retry/backoff needed.
    let command_stream = UnixStream::connect(socket_path())?;
    let command_conn = Mutex::new(command_stream);

    let writer = Arc::new(Mutex::new(stream_conn.try_clone()?));
    let reader_stream = stream_conn;

    let config_dir = app_handle.path().app_config_dir()?;
    let config = crate::config::load(&config_dir)?;

    let layout = resolve_layout(&command_conn, config.layout)?;
    crate::config::save(
        &config_dir,
        &crate::config::AppConfig { layout: Some(layout.clone()) },
    )?;

    for id in layout.all_session_ids() {
        send_request(&writer, &Request::Attach { id })?;
    }

    app_handle.manage(DaemonConnection { writer: Arc::clone(&writer) });
    app_handle.manage(CommandConnection(command_conn));
    app_handle.manage(CurrentLayout(Mutex::new(layout.clone())));
    app_handle.emit("layout-ready", &layout)?;

    let mut reader = BufReader::new(reader_stream);
    let reader_app_handle = app_handle.clone();
    std::thread::spawn(move || {
        // Wait for the frontend to confirm its listeners are registered
        // before reading — and therefore emitting — anything from the
        // daemon (see FrontendReady's doc comment). Bounded: an unbounded
        // wait here would leave the daemon's connection-handling thread
        // blocked mid-write on a full scrollback replay, backing up
        // through the session's writer mutex into the PTY pump — worse
        // than the small chance of an early emit being missed if the
        // frontend is simply slow rather than broken.
        let gate_deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if reader_app_handle
                .state::<FrontendReady>()
                .0
                .load(std::sync::atomic::Ordering::SeqCst)
            {
                break;
            }
            if Instant::now() >= gate_deadline {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }

        loop {
            let resp: Option<Response> = match read_message(&mut reader) {
                Ok(r) => r,
                Err(e) => {
                    let _ = reader_app_handle.emit("daemon-error", e.to_string());
                    break;
                }
            };
            let Some(resp) = resp else {
                let _ = reader_app_handle.emit("daemon-error", "daemon closed the connection");
                break;
            };
            match resp {
                Response::Output { id, data } => {
                    let _ = reader_app_handle.emit("pty-output", (id, data));
                }
                Response::SessionExited { id, exit_code } => {
                    let _ = reader_app_handle.emit("session-exited", (id, exit_code));
                }
                Response::Error { message } => {
                    let _ = reader_app_handle.emit("daemon-error", message);
                }
                _ => {}
            }
        }
    });

    Ok(())
}
```

- [ ] **Step 2: Update `write_input` and `resize_session`**

Replace both functions:

```rust
#[tauri::command]
pub fn write_input(
    session_id: String,
    data: String,
    state: State<DaemonConnection>,
) -> Result<(), String> {
    send_request(&state.writer, &Request::WriteInput { id: session_id, data })
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn resize_session(
    session_id: String,
    cols: u16,
    rows: u16,
    state: State<DaemonConnection>,
) -> Result<(), String> {
    send_request(&state.writer, &Request::ResizeSession { id: session_id, cols, rows })
        .map_err(|e| e.to_string())
}
```

- [ ] **Step 3: Update `lib.rs`**

Register the new/changed commands and drop the removed one:

```rust
.invoke_handler(tauri::generate_handler![
    session::write_input,
    session::resize_session,
    session::create_session,
    session::kill_session,
    session::get_current_layout,
    session::signal_frontend_ready,
    session::get_bootstrap_error
])
```

(Everything else in `lib.rs` — the plugin registrations, the `.setup()`
hook spawning `bootstrap`, the eager `.manage()` calls for `FrontendReady`/
`BootstrapError` — stays exactly as it is.)

- [ ] **Step 4: Run the full test suite and build**

Run: `cargo test -p app`
Expected: PASS — `layout::` (4), `config::` (4), `session::command_connection_tests` (3), plus any other pre-existing tests in `daemon.rs`, all green.

Run: `cargo build -p app`
Expected: builds successfully with no errors. Check the warning output
specifically: `create_session`/`kill_session` should no longer show
`dead_code` warnings (Task 2 left them temporarily unused; this task wires
them into `generate_handler!`), and there should be no leftover reference
to `ActiveSessionId` or `get_current_session` anywhere (`grep -rn
"ActiveSessionId\|get_current_session" app/src-tauri/src` should return
nothing).

- [ ] **Step 5: Commit**

```bash
git add app/src-tauri/src/session.rs app/src-tauri/src/lib.rs
git commit -m "feat(app): generalize bootstrap for multi-session layouts"
```

## Self-Review Notes

- **Spec coverage:** this plan covers the backend half of the Milestone C
  spec's Architecture section (the dual-connection design, `LayoutNode`,
  the generalized `bootstrap`/`resolve_layout`/`resolve_sessions`, the new
  `create_session`/`kill_session`/`get_current_layout` commands) and
  nothing else — the frontend half (tab bar, split-tree rendering,
  shortcuts, toolbar, presets, copy/paste) is explicitly Part 2, not yet
  written, per the spec's own scope and this plan's Roadmap section.
- **Placeholder scan:** none found — every step has complete code, and the
  one explicitly-deferred piece (frontend wiring) is called out as a
  separate future plan, not glossed over as "TODO" inside this one.
- **Type consistency:** `LayoutNode` (Task 1) is consumed identically by
  `resolve_layout`/`resolve_sessions` (Task 3) and `CurrentLayout`. `Mutex<UnixStream>`-based `CommandConnection`/`send_command` (Task 2) are
  reused verbatim by `create_fresh_session`/`resolve_layout` (Task 3) —
  the exact same helper, not reimplemented.
