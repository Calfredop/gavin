# MCP Part 1 (Protocol + Daemon + Shim) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The daemon serves the full gavin tool surface (scan, PRD, plan authoring, board-by-root, agent-session spawning, version probe), and a new `gavin-mcp` bin crate exposes it to agents as an MCP stdio server.

**Architecture:** Six new protocol requests + five responses; daemon handlers reuse shipped `gavin.rs` bodies plus two new file operations and two watched-root-resolved manager methods (spawn pushes `AgentSessionSpawned` on the watching app connection); the shim is a hand-rolled, sync, tools-only MCP JSON-RPC server that resolves its gavin root from cwd and forwards over the daemon socket behind an injectable transport trait.

**Tech Stack:** Rust only; the new crate depends on `protocol` + `serde`/`serde_json`/`anyhow` — **no other dependencies, no tokio, no MCP SDK**.

**Spec:** `docs/superpowers/specs/2026-08-07-agent-orchestration-mcp-design.md` §§1, 2, 4 + the shim half of testing. Part 2 (app landing, setup button, skill file) is a separate plan.

## Global Constraints

- User works **directly on `main`** — no worktree (standing preference). Subagent-cap history: inline execution is the standing fallback.
- `protocol::PROTOCOL_VERSION` starts at `1`; from now on any wire-breaking change bumps it.
- The shim's **stdout is MCP-protocol-only**; every diagnostic goes to stderr.
- The shim stays thin: argument shaping, path resolution, error wording — all operations execute in the daemon.
- `create_plan` **never overwrites** an existing file; validation errors name the offending value/path.
- Spawn and board-by-root **require a watched root** (D19: no invisible agents); error text: "workspace not open in gavin".
- Watchers store **canonicalized** roots — every root comparison canonicalizes the incoming path first.
- Test conventions unchanged: tempdir units, socket-level integration with blocking reads, `UnixStream::pair` for negative/mock cases.

---

### Task 1: Protocol — version const + six requests + five responses

**Files:**
- Modify: `Cargo.toml` (workspace members — add `"crates/gavin-mcp"` now so later tasks slot in; the crate itself arrives in Task 4, so ALSO create a placeholder in this task: minimal `crates/gavin-mcp/Cargo.toml` + `src/main.rs` containing `fn main() {}` to keep the workspace building)
- Modify: `crates/protocol/src/lib.rs`
- Modify: `crates/daemon/src/server.rs` (temporary grouped stub arm, replaced in Tasks 2–3)

**Interfaces:**
- Produces: `pub const PROTOCOL_VERSION: u32 = 1;`; `Request::{ScanGavinRoot, ReadPrd, CreatePlan, GetBoardByRoot, SpawnAgentSession, GetProtocolVersion}`; `Response::{GavinTreeScanned, PrdContent, PlanCreated, AgentSessionSpawned, ProtocolVersion}`.

- [ ] **Step 1: Constant** near the top of `crates/protocol/src/lib.rs` (after `MAX_LINE_BYTES`):

```rust
/// Bumped on ANY wire-breaking change. The daemon reports it via
/// Request::GetProtocolVersion; the app (at bootstrap) and gavin-mcp (at
/// connect) probe it and turn mismatches -- including the
/// connection-close an older daemon produces when it can't parse the
/// probe at all -- into actionable "restart the daemon" errors instead of
/// mysteries (see the 2026-08-07 stale-daemon incident).
pub const PROTOCOL_VERSION: u32 = 1;
```

- [ ] **Step 2: Request variants** (after `SetPlanFrontmatterField`):

```rust
    /// Stateless scan -- no watch required (gavin-mcp's gavin_get_tree).
    ScanGavinRoot {
        root_path: String,
    },
    ReadPrd {
        root_path: String,
    },
    /// Canonical plan authoring for agents. Validated daemon-side; never
    /// overwrites.
    CreatePlan {
        context_folder: String,
        file_name: String,
        title: String,
        status: Option<String>,
        priority: Option<String>,
        body: Option<String>,
    },
    /// The SQLite board of the WATCHED workspace whose root matches.
    GetBoardByRoot {
        root_path: String,
    },
    /// Creates a session and pushes AgentSessionSpawned on the watching
    /// app connection (D19: spawning requires the workspace to be open).
    SpawnAgentSession {
        root_path: String,
        cwd: String,
        command: String,
    },
    GetProtocolVersion,
```

- [ ] **Step 3: Response variants** (after `GavinTreeChanged`):

```rust
    GavinTreeScanned { tree: GavinTree },
    PrdContent { content: String },
    PlanCreated { path: String },
    AgentSessionSpawned { workspace_id: String, session_id: String, cwd: String, command: String },
    ProtocolVersion { version: u32 },
```

- [ ] **Step 4: Temporary stub arm** in `handle_request`'s match (same pattern Task 1 of the previous plan used; Tasks 2–3 replace it):

```rust
        // Stubs until the gavin MCP handlers land (same branch, next tasks):
        Request::ScanGavinRoot { .. }
        | Request::ReadPrd { .. }
        | Request::CreatePlan { .. }
        | Request::GetBoardByRoot { .. }
        | Request::SpawnAgentSession { .. }
        | Request::GetProtocolVersion => {
            Ok(Response::Error { message: "gavin mcp requests not yet implemented".to_string() })
        }
```

- [ ] **Step 5: Tests** in protocol's `mod tests` — roundtrips for `CreatePlan` (all optionals `Some`), `SpawnAgentSession`, `GetProtocolVersion` → `ProtocolVersion`, and `AgentSessionSpawned`; plus:

```rust
    #[test]
    fn protocol_version_is_one_until_a_breaking_change_bumps_it() {
        assert_eq!(PROTOCOL_VERSION, 1);
    }
```

(Write each roundtrip in the file's established write/read/match style.)

- [ ] **Step 6: Placeholder crate.** `crates/gavin-mcp/Cargo.toml`:

```toml
[package]
name = "gavin-mcp"
version = "0.1.0"
edition = "2021"

[dependencies]
serde = { version = "1", features = ["derive"] }
serde_json = "1"
anyhow = "1"
protocol = { path = "../protocol" }

[dev-dependencies]
tempfile = "3"
```

`crates/gavin-mcp/src/main.rs`: `fn main() {}` (replaced in Task 4). Add `"crates/gavin-mcp"` to the workspace `members`.

- [ ] **Step 7: Verify** — `cargo test -p protocol` green; `cargo build` (workspace) green.

- [ ] **Step 8: Commit** — `git add Cargo.toml crates && git commit -m "feat(protocol): mcp requests, spawn push, protocol version const"`

---

### Task 2: Daemon — create_plan_file, read_prd, and the four simple arms

**Files:**
- Modify: `crates/daemon/src/gavin.rs`
- Modify: `crates/daemon/src/server.rs`

**Interfaces:**
- Consumes: `parse_priority`, `GAVIN_ROOT_DIR`/`GAVIN_DIR`, `scan_root`.
- Produces (for Task 4's tools): daemon handling of `ScanGavinRoot`, `ReadPrd`, `CreatePlan`, `GetProtocolVersion`.

- [ ] **Step 1: `gavin.rs` additions:**

```rust
const MAX_PRD_BYTES: u64 = 1024 * 1024;

pub fn read_prd(root: &Path) -> anyhow::Result<String> {
    let prd = root.join(GAVIN_ROOT_DIR).join("PRD.md");
    if !prd.is_file() {
        anyhow::bail!("no PRD found at {}", prd.display());
    }
    if std::fs::metadata(&prd)?.len() > MAX_PRD_BYTES {
        anyhow::bail!("PRD exceeds the 1 MB read cap");
    }
    Ok(std::fs::read_to_string(&prd)?)
}

/// Canonical plan authoring for agents (spec §2): everything validated,
/// nothing ever overwritten. Returns the created file's path.
pub fn create_plan_file(
    context_folder: &Path,
    file_name: &str,
    title: &str,
    status: Option<&str>,
    priority: Option<&str>,
    body: Option<&str>,
) -> anyhow::Result<PathBuf> {
    let gavin_dir = if context_folder.join(GAVIN_ROOT_DIR).is_dir() {
        context_folder.join(GAVIN_ROOT_DIR)
    } else if context_folder.join(GAVIN_DIR).is_dir() {
        context_folder.join(GAVIN_DIR)
    } else {
        anyhow::bail!(
            "not a gavin context (no .gavin or .gavin-root): {}",
            context_folder.display()
        );
    };

    let valid_name = !file_name.is_empty()
        && file_name.len() > ".md".len()
        && file_name.ends_with(".md")
        && file_name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'));
    if !valid_name {
        anyhow::bail!("file_name must match [A-Za-z0-9._-]+.md, got: {file_name}");
    }

    let title = title.trim();
    if title.is_empty() || title.contains('\n') {
        anyhow::bail!("title must be a non-empty single line");
    }
    let status = status.map(str::trim).filter(|s| !s.is_empty()).unwrap_or("To Do");
    if status.contains('\n') {
        anyhow::bail!("status must be a single line");
    }
    if let Some(p) = priority {
        if parse_priority(p).is_none() {
            anyhow::bail!("invalid priority value: {p}");
        }
    }

    let plans = gavin_dir.join("plans");
    std::fs::create_dir_all(&plans)?;
    let path = plans.join(file_name);
    if path.exists() {
        anyhow::bail!("plan file already exists: {}", path.display());
    }

    let mut content = format!("---\ntitle: {title}\nstatus: {status}\n");
    if let Some(p) = priority {
        content.push_str(&format!("priority: {p}\n"));
    }
    content.push_str("---\n");
    match body.map(str::trim).filter(|b| !b.is_empty()) {
        Some(b) => {
            content.push_str(b);
            content.push('\n');
        }
        None => content.push_str(&format!("# {title}\n")),
    }
    std::fs::write(&path, content)?;
    Ok(path)
}
```

- [ ] **Step 2: Unit tests** (gavin.rs `mod tests`):

```rust
    #[test]
    fn create_plan_file_writes_canonical_content_with_defaults() {
        let dir = tempfile::tempdir().unwrap();
        init_gavin_root(dir.path(), "WS").unwrap();
        let path = create_plan_file(dir.path(), "auth.md", "Auth flow", None, None, None).unwrap();
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "---\ntitle: Auth flow\nstatus: To Do\n---\n# Auth flow\n"
        );
        let path2 = create_plan_file(
            dir.path(),
            "auth2.md",
            "Auth 2",
            Some("In Progress"),
            Some("high"),
            Some("Body text"),
        )
        .unwrap();
        assert_eq!(
            std::fs::read_to_string(&path2).unwrap(),
            "---\ntitle: Auth 2\nstatus: In Progress\npriority: high\n---\nBody text\n"
        );
    }

    #[test]
    fn create_plan_file_validates_and_never_overwrites() {
        let dir = tempfile::tempdir().unwrap();
        init_gavin_root(dir.path(), "WS").unwrap();
        // Not a context:
        assert!(create_plan_file(&dir.path().join("nope"), "a.md", "T", None, None, None).is_err());
        // Bad names:
        for bad in ["", ".md", "no-extension", "sp ace.md", "../esc.md"] {
            assert!(create_plan_file(dir.path(), bad, "T", None, None, None).is_err(), "{bad}");
        }
        // Bad priority / bad title:
        assert!(create_plan_file(dir.path(), "a.md", "T", None, Some("banana"), None).is_err());
        assert!(create_plan_file(dir.path(), "a.md", "  ", None, None, None).is_err());
        // Never overwrites:
        create_plan_file(dir.path(), "a.md", "T", None, None, None).unwrap();
        let dup = create_plan_file(dir.path(), "a.md", "T2", None, None, None);
        assert!(dup.unwrap_err().to_string().contains("already exists"));
    }

    #[test]
    fn read_prd_returns_content_and_errors_when_absent() {
        let dir = tempfile::tempdir().unwrap();
        assert!(read_prd(dir.path()).is_err());
        init_gavin_root(dir.path(), "My WS").unwrap();
        assert!(read_prd(dir.path()).unwrap().starts_with("# My WS — Product Requirements"));
    }
```

(Note `"sp ace.md"` and `"../esc.md"` both fail the charset check — the latter is also the path-escape guard.)

- [ ] **Step 3: Replace four stubs** with real arms in `handle_request` (leave `GetBoardByRoot`/`SpawnAgentSession` stubbed for Task 3):

```rust
        Request::ScanGavinRoot { root_path } => Ok(Response::GavinTreeScanned {
            tree: crate::gavin::scan_root(std::path::Path::new(&root_path)),
        }),
        Request::ReadPrd { root_path } => crate::gavin::read_prd(std::path::Path::new(&root_path))
            .map(|content| Response::PrdContent { content }),
        Request::CreatePlan { context_folder, file_name, title, status, priority, body } => {
            crate::gavin::create_plan_file(
                std::path::Path::new(&context_folder),
                &file_name,
                &title,
                status.as_deref(),
                priority.as_deref(),
                body.as_deref(),
            )
            .map(|p| Response::PlanCreated { path: p.to_string_lossy().to_string() })
        }
        Request::GetProtocolVersion => {
            Ok(Response::ProtocolVersion { version: protocol::PROTOCOL_VERSION })
        }
```

- [ ] **Step 4: Socket test** (server.rs `mod tests`):

```rust
    #[test]
    fn scan_prd_create_plan_and_version_over_socket() {
        let (socket_path, _dir) = start_test_server();
        let ws_dir = tempfile::tempdir().unwrap();
        crate::gavin::init_gavin_root(ws_dir.path(), "WS").unwrap();
        let root = ws_dir.path().to_string_lossy().to_string();
        let mut cmd = UnixStream::connect(&socket_path).unwrap();

        let resp = request(&mut cmd, &Request::GetProtocolVersion);
        assert!(matches!(resp, Response::ProtocolVersion { version: protocol::PROTOCOL_VERSION }));

        let resp = request(&mut cmd, &Request::ReadPrd { root_path: root.clone() });
        assert!(matches!(resp, Response::PrdContent { .. }));

        let resp = request(
            &mut cmd,
            &Request::CreatePlan {
                context_folder: root.clone(),
                file_name: "over-socket.md".to_string(),
                title: "Over socket".to_string(),
                status: None,
                priority: Some("low".to_string()),
                body: None,
            },
        );
        let created_path = match resp {
            Response::PlanCreated { path } => path,
            other => panic!("expected PlanCreated, got {other:?}"),
        };
        assert!(std::path::Path::new(&created_path).is_file());

        let resp = request(&mut cmd, &Request::ScanGavinRoot { root_path: root });
        match resp {
            Response::GavinTreeScanned { tree } => {
                assert!(!tree.root_missing);
                assert_eq!(tree.contexts[0].plans.len(), 1);
                assert_eq!(tree.contexts[0].plans[0].title, "Over socket");
            }
            other => panic!("expected GavinTreeScanned, got {other:?}"),
        }
    }
```

(`matches!` with a const in the pattern: use a guard instead — `matches!(resp, Response::ProtocolVersion { version } if version == protocol::PROTOCOL_VERSION)`.)

- [ ] **Step 5: Verify** — `cargo test -p gavin-daemon` green.

- [ ] **Step 6: Commit** — `git add crates && git commit -m "feat(daemon): plan authoring, prd read, stateless scan, version probe"`

---

### Task 3: Daemon — board-by-root and agent spawn with push

**Files:**
- Modify: `crates/daemon/src/gavin.rs` (`GavinWatcher::push_response`)
- Modify: `crates/daemon/src/server.rs` (two manager methods, two arms, tests)

**Interfaces:**
- Consumes: `gavin_watchers` registry (watchers hold canonicalized `root_path` + `workspace_id`), `create_session`, `get_board`.
- Produces: daemon handling of `GetBoardByRoot` and `SpawnAgentSession` (reply `SessionCreated`; push `AgentSessionSpawned` on the watching connection).

- [ ] **Step 1: `GavinWatcher::push_response`** (gavin.rs, in the impl):

```rust
    /// Best-effort push on the watching app connection -- same
    /// dead-writer semantics as rescan_and_push (a restarted app's fresh
    /// WatchGavinRoot replaces this watcher).
    pub fn push_response(&self, resp: &Response) {
        let mut writer = self.writer.lock().unwrap();
        let _ = protocol::write_message(&mut *writer, resp);
    }
```

- [ ] **Step 2: Manager methods** (server.rs, beside the other gavin methods):

```rust
    /// The watched workspace whose root matches `root_path`. Watchers
    /// store canonicalized roots, so the incoming path is canonicalized
    /// before comparison (spec Global Constraint).
    fn find_watcher_by_root(&self, root_path: &str) -> Option<Arc<crate::gavin::GavinWatcher>> {
        let canonical = std::path::Path::new(root_path)
            .canonicalize()
            .unwrap_or_else(|_| std::path::PathBuf::from(root_path));
        self.gavin_watchers
            .lock()
            .unwrap()
            .values()
            .find(|w| w.root_path == canonical)
            .cloned()
    }

    pub fn board_by_root(&self, root_path: &str) -> anyhow::Result<protocol::Board> {
        let watcher = self
            .find_watcher_by_root(root_path)
            .ok_or_else(|| anyhow::anyhow!("workspace not open in gavin"))?;
        self.get_board(&watcher.workspace_id)
    }

    /// D19: spawning requires the workspace to be open (watched) -- an
    /// agent session the human can't see is never allowed. The push rides
    /// the watching connection; the app Attaches, then lands it on the
    /// Agents page (Part 2).
    pub fn spawn_agent_session(
        &self,
        root_path: &str,
        cwd: &str,
        command: &str,
    ) -> anyhow::Result<String> {
        let watcher = self
            .find_watcher_by_root(root_path)
            .ok_or_else(|| anyhow::anyhow!("workspace not open in gavin"))?;
        let id = self.create_session(root_path, cwd, Some(command))?;
        watcher.push_response(&Response::AgentSessionSpawned {
            workspace_id: watcher.workspace_id.clone(),
            session_id: id.clone(),
            cwd: cwd.to_string(),
            command: command.to_string(),
        });
        Ok(id)
    }
```

(Check `get_board`'s actual receiver/signature before writing — the existing arm calls `manager.get_board(&workspace_id)`; match it.)

- [ ] **Step 3: Replace the last two stubs:**

```rust
        Request::GetBoardByRoot { root_path } => manager
            .board_by_root(&root_path)
            .map(|board| Response::Board { columns: board.columns, labels: board.labels }),
        Request::SpawnAgentSession { root_path, cwd, command } => manager
            .spawn_agent_session(&root_path, &cwd, &command)
            .map(|id| Response::SessionCreated { id }),
```

(Delete the now-empty stub arm entirely; the match must stay exhaustive with no catch-all.)

- [ ] **Step 4: Socket tests:**

```rust
    #[test]
    fn board_and_spawn_require_a_watched_root() {
        let (socket_path, _dir) = start_test_server();
        let ws_dir = tempfile::tempdir().unwrap();
        crate::gavin::init_gavin_root(ws_dir.path(), "WS").unwrap();
        let root = ws_dir.path().to_string_lossy().to_string();
        let mut cmd = UnixStream::connect(&socket_path).unwrap();

        let resp = request(&mut cmd, &Request::GetBoardByRoot { root_path: root.clone() });
        assert!(matches!(resp, Response::Error { .. }));
        let resp = request(
            &mut cmd,
            &Request::SpawnAgentSession {
                root_path: root,
                cwd: "/tmp".to_string(),
                command: "/bin/sh".to_string(),
            },
        );
        assert!(matches!(resp, Response::Error { .. }));
    }

    #[test]
    fn spawn_replies_session_id_and_pushes_on_the_watching_connection() {
        let (socket_path, _dir) = start_test_server();
        let ws_dir = tempfile::tempdir().unwrap();
        crate::gavin::init_gavin_root(ws_dir.path(), "WS").unwrap();
        let root = ws_dir.path().to_string_lossy().to_string();

        // The "app": watches the root on a streaming connection.
        let mut app = UnixStream::connect(&socket_path).unwrap();
        write_message(
            &mut app,
            &Request::WatchGavinRoot { workspace_id: "ws-a".to_string(), root_path: root.clone() },
        )
        .unwrap();
        let mut app_reader = BufReader::new(app.try_clone().unwrap());
        let first: Response = read_message(&mut app_reader).unwrap().unwrap();
        assert!(matches!(first, Response::GavinTreeChanged { .. }));

        // The "shim": spawns over a command connection.
        let mut cmd = UnixStream::connect(&socket_path).unwrap();
        let resp = request(
            &mut cmd,
            &Request::SpawnAgentSession {
                root_path: root.clone(),
                cwd: root.clone(),
                command: "/bin/sh".to_string(),
            },
        );
        let session_id = match resp {
            Response::SessionCreated { id } => id,
            other => panic!("expected SessionCreated, got {other:?}"),
        };

        // The push arrives on the WATCHING connection.
        let push: Response = read_message(&mut app_reader).unwrap().unwrap();
        match push {
            Response::AgentSessionSpawned { workspace_id, session_id: pushed, cwd, command } => {
                assert_eq!(workspace_id, "ws-a");
                assert_eq!(pushed, session_id);
                assert_eq!(cwd, root);
                assert_eq!(command, "/bin/sh");
            }
            other => panic!("expected AgentSessionSpawned, got {other:?}"),
        }

        // Tidy the spawned shell.
        let resp = request(&mut cmd, &Request::KillSession { id: session_id });
        assert!(matches!(resp, Response::Ok));
    }
```

(Board happy path over the socket needs a watched root AND a seeded board — `get_board` seeds defaults, so add to the second test, after the push assertions: `let resp = request(&mut cmd, &Request::GetBoardByRoot { root_path: root });` and assert `Response::Board { columns, .. }` has 3 default columns.)

- [ ] **Step 5: Verify** — `cargo test -p gavin-daemon` green (watch for the spawn test leaving no stray shells: the KillSession step is part of the test).

- [ ] **Step 6: Commit** — `git add crates && git commit -m "feat(daemon): board-by-root and agent spawn with watching-connection push"`

---

### Task 4: The gavin-mcp shim

**Files:**
- Replace: `crates/gavin-mcp/src/main.rs` (the real implementation + tests)

**Interfaces:**
- Consumes: everything above via the `protocol` crate (`Request`/`Response`/`read_message`/`write_message`/`socket_path`/`PROTOCOL_VERSION`).
- Produces: the `gavin-mcp` binary Part 2 registers in `.mcp.json`.

**Structure (single file, ~450 lines incl. tests — split into `mod` blocks in-file only if it grows past that):** a `DaemonTransport` trait so tests inject a mock; a `SocketTransport` with lazy connect + version probe + one reconnect; `find_gavin_root` walking up from cwd; a `TOOLS` table (name, description, JSON schema); `handle_line` dispatching JSON-RPC; `dispatch_tool` mapping tool calls to requests.

- [ ] **Step 1: Write the implementation.** The complete file:

```rust
use protocol::{read_message, write_message, Request, Response, PROTOCOL_VERSION};
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};

// ---------- daemon transport ----------

pub trait DaemonTransport {
    fn request(&mut self, req: &Request) -> anyhow::Result<Response>;
}

/// Lazy persistent connection to the daemon socket. Every fresh connect
/// runs the version probe (spec §4): a daemon too old to parse the probe
/// closes the connection, which maps to the same "restart the daemon"
/// error as an explicit lower version.
struct SocketTransport {
    stream: Option<BufReader<UnixStream>>,
}

impl SocketTransport {
    fn new() -> Self {
        Self { stream: None }
    }

    fn connect(&mut self) -> anyhow::Result<()> {
        let stream = UnixStream::connect(protocol::socket_path())
            .map_err(|_| anyhow::anyhow!("gavin daemon isn't running — open the gavin app"))?;
        let mut reader = BufReader::new(stream);
        write_message(reader.get_mut(), &Request::GetProtocolVersion)
            .map_err(|_| anyhow::anyhow!("gavin daemon isn't running — open the gavin app"))?;
        match read_message::<_, Response>(&mut reader) {
            Ok(Some(Response::ProtocolVersion { version })) if version == PROTOCOL_VERSION => {
                self.stream = Some(reader);
                Ok(())
            }
            Ok(Some(Response::ProtocolVersion { version })) if version > PROTOCOL_VERSION => {
                anyhow::bail!(
                    "the gavin daemon is newer than this gavin-mcp — rebuild and restart the app"
                )
            }
            _ => anyhow::bail!(
                "the gavin daemon is older than this app — restart it (pkill gavin-daemon, then relaunch the gavin app)"
            ),
        }
    }

    fn request_once(&mut self, req: &Request) -> anyhow::Result<Response> {
        if self.stream.is_none() {
            self.connect()?;
        }
        let reader = self.stream.as_mut().unwrap();
        write_message(reader.get_mut(), req)?;
        match read_message::<_, Response>(reader)? {
            Some(resp) => Ok(resp),
            None => anyhow::bail!("daemon closed the connection"),
        }
    }
}

impl DaemonTransport for SocketTransport {
    fn request(&mut self, req: &Request) -> anyhow::Result<Response> {
        match self.request_once(req) {
            Ok(resp) => Ok(resp),
            Err(_) => {
                // One reconnect per call: the daemon may have restarted.
                self.stream = None;
                self.request_once(req)
            }
        }
    }
}

// ---------- root resolution ----------

/// Walks up from `start` to the nearest directory containing .gavin-root.
fn find_gavin_root(start: &Path) -> Option<PathBuf> {
    let mut current = Some(start);
    while let Some(dir) = current {
        if dir.join(".gavin-root").is_dir() {
            return Some(dir.to_path_buf());
        }
        current = dir.parent();
    }
    None
}

/// Absolute as-is; relative resolved against the gavin root (spec §2).
fn resolve_against_root(root: &Path, input: &str) -> PathBuf {
    let p = Path::new(input);
    if p.is_absolute() {
        p.to_path_buf()
    } else {
        root.join(p)
    }
}

// ---------- tools ----------

const NOT_IN_WORKSPACE: &str =
    "not inside a gavin workspace (no .gavin-root above the current directory) — run gavin_init_root first";

fn tool_definitions() -> Value {
    json!([
        { "name": "gavin_get_tree", "description": "The gavin workspace's contexts and plan files (canonical parse, incl. statuses and warnings).", "inputSchema": { "type": "object", "properties": {} } },
        { "name": "gavin_read_prd", "description": "Read the workspace PRD — the lead document for all development.", "inputSchema": { "type": "object", "properties": {} } },
        { "name": "gavin_create_plan", "description": "Create a plan file in a gavin context with canonical frontmatter. Never overwrites.", "inputSchema": { "type": "object", "properties": {
            "context_folder": { "type": "string", "description": "Folder that is the root or contains .gavin (relative allowed)" },
            "file_name": { "type": "string", "description": "kebab-case-name.md" },
            "title": { "type": "string" },
            "status": { "type": "string", "description": "Board column name; default To Do" },
            "priority": { "type": "string", "enum": ["none", "low", "medium", "high", "urgent"] },
            "body": { "type": "string" }
        }, "required": ["context_folder", "file_name", "title"] } },
        { "name": "gavin_set_plan_field", "description": "Update one frontmatter field (status or priority) of a plan file, preserving every other byte.", "inputSchema": { "type": "object", "properties": {
            "path": { "type": "string" },
            "key": { "type": "string", "enum": ["status", "priority"] },
            "value": { "type": "string" }
        }, "required": ["path", "key", "value"] } },
        { "name": "gavin_create_context", "description": "Turn a folder into a gavin context (.gavin scaffold) for a feature/library.", "inputSchema": { "type": "object", "properties": {
            "parent_folder": { "type": "string" }
        }, "required": ["parent_folder"] } },
        { "name": "gavin_init_root", "description": "Initialize .gavin-root (PRD template, plans/docs/specs) in a folder; idempotent, never overwrites.", "inputSchema": { "type": "object", "properties": {
            "path": { "type": "string", "description": "Defaults to the current directory" }
        } } },
        { "name": "gavin_get_board", "description": "The workspace kanban board: columns (the status vocabulary) and the human's free-form cards. Requires the workspace open in gavin.", "inputSchema": { "type": "object", "properties": {} } },
        { "name": "gavin_spawn_session", "description": "Spawn a terminal session in the gavin app (visible to the human on the Agents page). Requires the workspace open in gavin.", "inputSchema": { "type": "object", "properties": {
            "command": { "type": "string", "description": "Program to run, e.g. claude" },
            "cwd": { "type": "string", "description": "Defaults to the workspace root" }
        }, "required": ["command"] } }
    ])
}

fn str_arg(args: &Value, key: &str) -> Option<String> {
    args.get(key).and_then(|v| v.as_str()).map(|s| s.to_string())
}

fn require_arg(args: &Value, key: &str) -> anyhow::Result<String> {
    str_arg(args, key).ok_or_else(|| anyhow::anyhow!("missing required argument: {key}"))
}

/// Maps one tool call to a daemon request, shapes the result as text.
fn dispatch_tool(
    name: &str,
    args: &Value,
    root: Option<&Path>,
    transport: &mut dyn DaemonTransport,
) -> anyhow::Result<String> {
    // gavin_init_root is the only tool that works without a resolved root.
    if name == "gavin_init_root" {
        let cwd = std::env::current_dir()?;
        let path = str_arg(args, "path")
            .map(|p| resolve_against_root(&cwd, &p))
            .unwrap_or(cwd);
        let workspace_name = path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "workspace".to_string());
        let resp = transport.request(&Request::InitGavinRoot {
            root_path: path.to_string_lossy().to_string(),
            workspace_name,
        })?;
        return match resp {
            Response::Ok => Ok(format!("initialized gavin root at {}", path.display())),
            Response::Error { message } => Err(anyhow::anyhow!(message)),
            other => Err(anyhow::anyhow!("unexpected response: {other:?}")),
        };
    }

    let root = root.ok_or_else(|| anyhow::anyhow!(NOT_IN_WORKSPACE))?;
    let root_str = root.to_string_lossy().to_string();

    let req = match name {
        "gavin_get_tree" => Request::ScanGavinRoot { root_path: root_str },
        "gavin_read_prd" => Request::ReadPrd { root_path: root_str },
        "gavin_create_plan" => Request::CreatePlan {
            context_folder: resolve_against_root(root, &require_arg(args, "context_folder")?)
                .to_string_lossy()
                .to_string(),
            file_name: require_arg(args, "file_name")?,
            title: require_arg(args, "title")?,
            status: str_arg(args, "status"),
            priority: str_arg(args, "priority"),
            body: str_arg(args, "body"),
        },
        "gavin_set_plan_field" => Request::SetPlanFrontmatterField {
            path: resolve_against_root(root, &require_arg(args, "path")?)
                .to_string_lossy()
                .to_string(),
            key: require_arg(args, "key")?,
            value: require_arg(args, "value")?,
        },
        "gavin_create_context" => Request::CreateGavinContext {
            parent_folder: resolve_against_root(root, &require_arg(args, "parent_folder")?)
                .to_string_lossy()
                .to_string(),
        },
        "gavin_get_board" => Request::GetBoardByRoot { root_path: root_str },
        "gavin_spawn_session" => Request::SpawnAgentSession {
            root_path: root_str.clone(),
            cwd: str_arg(args, "cwd")
                .map(|c| resolve_against_root(root, &c).to_string_lossy().to_string())
                .unwrap_or(root_str),
            command: require_arg(args, "command")?,
        },
        other => anyhow::bail!("unknown tool: {other}"),
    };

    let resp = transport.request(&req)?;
    match resp {
        Response::GavinTreeScanned { tree } => Ok(serde_json::to_string_pretty(&tree)?),
        Response::PrdContent { content } => Ok(content),
        Response::PlanCreated { path } => Ok(format!("created plan: {path}")),
        Response::Board { columns, labels } => {
            Ok(serde_json::to_string_pretty(&json!({ "columns": columns, "labels": labels }))?)
        }
        Response::SessionCreated { id } => {
            Ok(format!("spawned session {id} — visible on the Agents page in gavin"))
        }
        Response::Ok => Ok("ok".to_string()),
        Response::Error { message } => Err(anyhow::anyhow!(message)),
        other => Err(anyhow::anyhow!("unexpected response: {other:?}")),
    }
}

// ---------- JSON-RPC ----------

fn rpc_result(id: &Value, result: Value) -> String {
    json!({ "jsonrpc": "2.0", "id": id, "result": result }).to_string()
}

fn rpc_error(id: &Value, code: i64, message: &str) -> String {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } }).to_string()
}

fn tool_text_result(id: &Value, text: String, is_error: bool) -> String {
    rpc_result(id, json!({ "content": [{ "type": "text", "text": text }], "isError": is_error }))
}

/// One request line in, at most one reply line out (None for
/// notifications and unparseable input -- MCP stdio never replies to
/// those).
fn handle_line(line: &str, root: Option<&Path>, transport: &mut dyn DaemonTransport) -> Option<String> {
    let msg: Value = serde_json::from_str(line).ok()?;
    let method = msg.get("method")?.as_str()?.to_string();
    let id = msg.get("id").cloned();
    let id = match id {
        Some(id) => id,
        None => return None, // notification (e.g. notifications/initialized)
    };

    match method.as_str() {
        "initialize" => {
            let requested = msg
                .pointer("/params/protocolVersion")
                .and_then(|v| v.as_str())
                .unwrap_or("2024-11-05");
            Some(rpc_result(
                &id,
                json!({
                    "protocolVersion": requested,
                    "capabilities": { "tools": {} },
                    "serverInfo": { "name": "gavin-mcp", "version": env!("CARGO_PKG_VERSION") }
                }),
            ))
        }
        "ping" => Some(rpc_result(&id, json!({}))),
        "tools/list" => Some(rpc_result(&id, json!({ "tools": tool_definitions() }))),
        "tools/call" => {
            let name = msg.pointer("/params/name").and_then(|v| v.as_str()).unwrap_or("");
            let empty = json!({});
            let args = msg.pointer("/params/arguments").unwrap_or(&empty);
            match dispatch_tool(name, args, root, transport) {
                Ok(text) => Some(tool_text_result(&id, text, false)),
                Err(e) => Some(tool_text_result(&id, e.to_string(), true)),
            }
        }
        _ => Some(rpc_error(&id, -32601, &format!("method not found: {method}"))),
    }
}

fn main() {
    let root = std::env::current_dir().ok().and_then(|cwd| find_gavin_root(&cwd));
    match &root {
        Some(r) => eprintln!("gavin-mcp: workspace root {}", r.display()),
        None => eprintln!("gavin-mcp: no .gavin-root above cwd — only gavin_init_root will work"),
    }
    let mut transport = SocketTransport::new();
    let stdin = std::io::stdin();
    let stdout = std::io::stdout();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        if let Some(reply) = handle_line(&line, root.as_deref(), &mut transport) {
            let mut out = stdout.lock();
            let _ = writeln!(out, "{reply}");
            let _ = out.flush();
        }
    }
}
```

- [ ] **Step 2: Tests** (same file, `#[cfg(test)] mod tests`) — a queue-backed mock transport plus:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    struct MockTransport {
        replies: Vec<Response>,
        requests: Vec<Request>,
    }
    impl DaemonTransport for MockTransport {
        fn request(&mut self, req: &Request) -> anyhow::Result<Response> {
            self.requests.push(req.clone());
            if self.replies.is_empty() {
                anyhow::bail!("mock exhausted")
            }
            Ok(self.replies.remove(0))
        }
    }
    fn mock(replies: Vec<Response>) -> MockTransport {
        MockTransport { replies, requests: vec![] }
    }

    #[test]
    fn find_gavin_root_walks_up_and_stops() {
        let dir = tempfile::tempdir().unwrap();
        let nested = dir.path().join("a").join("b");
        std::fs::create_dir_all(&nested).unwrap();
        assert_eq!(find_gavin_root(&nested), None);
        std::fs::create_dir_all(dir.path().join(".gavin-root")).unwrap();
        assert_eq!(find_gavin_root(&nested).unwrap(), dir.path());
    }

    #[test]
    fn initialize_echoes_version_and_lists_tools() {
        let mut t = mock(vec![]);
        let reply = handle_line(
            r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26"}}"#,
            None,
            &mut t,
        )
        .unwrap();
        let v: Value = serde_json::from_str(&reply).unwrap();
        assert_eq!(v.pointer("/result/protocolVersion").unwrap(), "2025-03-26");
        assert_eq!(v.pointer("/result/serverInfo/name").unwrap(), "gavin-mcp");

        let reply = handle_line(r#"{"jsonrpc":"2.0","id":2,"method":"tools/list"}"#, None, &mut t).unwrap();
        let v: Value = serde_json::from_str(&reply).unwrap();
        assert_eq!(v.pointer("/result/tools").unwrap().as_array().unwrap().len(), 8);
    }

    #[test]
    fn notifications_and_garbage_produce_no_reply_and_unknown_methods_error() {
        let mut t = mock(vec![]);
        assert!(handle_line(r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#, None, &mut t).is_none());
        assert!(handle_line("not json at all", None, &mut t).is_none());
        let reply = handle_line(r#"{"jsonrpc":"2.0","id":3,"method":"resources/list"}"#, None, &mut t).unwrap();
        assert!(reply.contains("-32601"));
    }

    #[test]
    fn tools_require_a_root_except_init() {
        let mut t = mock(vec![Response::Ok]);
        let reply = handle_line(
            r#"{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"gavin_get_tree","arguments":{}}}"#,
            None,
            &mut t,
        )
        .unwrap();
        let v: Value = serde_json::from_str(&reply).unwrap();
        assert_eq!(v.pointer("/result/isError").unwrap(), true);
        assert!(reply.contains("not inside a gavin workspace"));
        assert!(t.requests.is_empty(), "no daemon call without a root");
    }

    #[test]
    fn create_plan_resolves_relative_context_and_maps_arguments() {
        let root = Path::new("/ws");
        let mut t = mock(vec![Response::PlanCreated { path: "/ws/.gavin-root/plans/a.md".into() }]);
        let reply = handle_line(
            r#"{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"gavin_create_plan","arguments":{"context_folder":".","file_name":"a.md","title":"A","priority":"high"}}}"#,
            Some(root),
            &mut t,
        )
        .unwrap();
        assert!(reply.contains("created plan"));
        match &t.requests[0] {
            Request::CreatePlan { context_folder, file_name, title, priority, .. } => {
                assert_eq!(context_folder, "/ws/.");
                assert_eq!(file_name, "a.md");
                assert_eq!(title, "A");
                assert_eq!(priority.as_deref(), Some("high"));
            }
            other => panic!("wrong request: {other:?}"),
        }
    }

    #[test]
    fn spawn_defaults_cwd_to_root_and_reports_the_agents_page() {
        let root = Path::new("/ws");
        let mut t = mock(vec![Response::SessionCreated { id: "s-1".into() }]);
        let reply = handle_line(
            r#"{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"gavin_spawn_session","arguments":{"command":"claude"}}}"#,
            Some(root),
            &mut t,
        )
        .unwrap();
        assert!(reply.contains("Agents page"));
        match &t.requests[0] {
            Request::SpawnAgentSession { root_path, cwd, command } => {
                assert_eq!(root_path, "/ws");
                assert_eq!(cwd, "/ws");
                assert_eq!(command, "claude");
            }
            other => panic!("wrong request: {other:?}"),
        }
    }

    #[test]
    fn daemon_errors_surface_as_tool_errors() {
        let root = Path::new("/ws");
        let mut t = mock(vec![Response::Error { message: "workspace not open in gavin".into() }]);
        let reply = handle_line(
            r#"{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"gavin_get_board","arguments":{}}}"#,
            Some(root),
            &mut t,
        )
        .unwrap();
        let v: Value = serde_json::from_str(&reply).unwrap();
        assert_eq!(v.pointer("/result/isError").unwrap(), true);
        assert!(reply.contains("workspace not open in gavin"));
    }
}
```

(`Request`/`Response` need `Clone` for the mock's `req.clone()` — both already derive it. `CreatePlan`'s `context_folder` assertion expects `/ws/.` — `resolve_against_root` joins verbatim; if the implementer normalizes instead, adjust the assertion to `/ws`, not the code.)

- [ ] **Step 3: Verify** — `cargo test -p gavin-mcp` green; `cargo build` (workspace) green; `cargo test` (workspace) green.

- [ ] **Step 4: Commit** — `git add Cargo.toml crates && git commit -m "feat(mcp): gavin-mcp stdio server with eight tools and version probe"`

---

### Task 5: End-to-end verification against the real daemon

No new source files — a scripted proof that the built shim + built daemon speak real MCP over real sockets, mirroring the wire-smoke pattern (isolated daemon `$HOME` under a short `$TMPDIR` path — AF_UNIX's ~104-byte cap; kill the daemon and clean up afterwards).

- [ ] **Step 1:** Build both binaries (`cargo build -p gavin-daemon -p gavin-mcp`).

- [ ] **Step 2:** Script (scratchpad, not committed): start the isolated daemon; make a temp root; run `gavin-mcp` with cwd = that root, feeding it, one JSON line each: `initialize`, `notifications/initialized`, `tools/list`, `tools/call gavin_init_root`, `tools/call gavin_get_tree`, `tools/call gavin_create_plan` (title "E2E", priority "low"), `tools/call gavin_get_tree` again, `tools/call gavin_get_board` (expect the friendly not-open error), and assert on the outputs: initialize echoes the version; tools/list has 8 entries; the second tree contains "E2E"; the board call has `isError: true` with "workspace not open in gavin"; **stdout contained nothing but JSON-RPC lines**. Then kill the daemon, remove the temp dirs.

- [ ] **Step 3:** Present results; if any check fails, debug root-cause-first before touching the tests.

- [ ] **Step 4: Commit** any fixes surfaced (with their own regression tests), otherwise nothing to commit.

---

## Testing summary

- Protocol: 4 roundtrips + the version-const test.
- Daemon: 3 `create_plan_file`/`read_prd` unit tests; 3 socket tests (scan/prd/create/version, unwatched errors, spawn reply + push + board happy path).
- gavin-mcp: 7 unit tests (root walk, initialize/tools list, notification/garbage/unknown, root-required gating, argument mapping ×2, error surfacing).
- End-to-end: the Task 5 scripted pass.

## Out of scope (Part 2)

App bootstrap version probe + `BootstrapError` wiring, the `AgentSessionSpawned` relay arm + Attach + Agents-page landing, the setup button and its merge-aware writes, `SKILL.md` content, manual smoke with a real Claude Code session.
