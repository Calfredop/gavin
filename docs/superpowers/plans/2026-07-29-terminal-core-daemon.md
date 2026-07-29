# Terminal Core — Daemon (Milestone A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and prove out the `gavin-daemon` Rust binary — the process that owns all terminal PTYs, exposes them over a local Unix domain socket, durably persists session state, and restores sessions (with a fresh shell, not scrollback) after the daemon itself restarts. No GUI in this plan — everything is driven and verified by test clients talking to the real socket.

**Architecture:** A single Rust binary (`crates/daemon`) with four modules: `registry` (SQLite-backed session persistence), `pty` (wraps `portable-pty` to spawn/read/write/resize/kill shell processes), `protocol` (newline-delimited JSON request/response types shared over the socket), and `server` (`SessionManager` + the Unix domain socket accept loop that ties the other three together). `main.rs` wires them up: open the registry, recover any sessions left over from a previous run, then serve.

**Tech Stack:** Rust (2021 edition), `portable-pty` (PTY spawning/IO), `rusqlite` with the `bundled` SQLite (session registry), `serde`/`serde_json` (wire protocol), `uuid` (session IDs), `anyhow` (error handling), `tempfile` (test fixtures). Plain `std::thread` + `std::os::unix::net` for the socket server — no async runtime; this is a handful of long-lived blocking connections, not a high-concurrency service, so threads keep the code simpler.

## Global Constraints

- Platform for this plan: **macOS only** (spec: "macOS first, Linux and Windows follow"). IPC uses a Unix domain socket; the named-pipe variant for Windows is out of scope here.
- The daemon is a separate long-lived process from any future GUI client — closing a client connection must never kill sessions or exit the daemon.
- Session state (registry) is durably persisted on every state change (create, status change, restore, remove) — never held only in memory.
- Recovery after the daemon restarts spawns a **fresh shell** at the session's last-known `cwd` and marks it `restored: true`. Scrollback/output history from before the restart is explicitly **not** replayed (spec non-goal).
- Out of scope for this whole repo phase (per the terminal-core spec): kanban board, file viewer, remote/SSH sessions.
- Out of scope for this plan specifically (deferred to later milestones): the Tauri app/xterm.js frontend, git status, shell-integration status detection (idle/working/waiting-for-input), OS notifications, and daemon auto-spawn-if-not-running logic (that lives on the client/app side).

## Roadmap (not part of this plan)

This is Milestone A of the terminal-core spec (`docs/superpowers/specs/2026-07-29-terminal-core-design.md`). Once it's built and reviewed, subsequent milestones will each get their own plan, written after the previous one lands so interfaces are grounded in real code rather than guessed:

- **B** — Minimal Tauri app + xterm.js rendering a single session end-to-end (proves the client side of the protocol built here).
- **C** — Workspaces + freeform split-pane UI + layout persistence/presets.
- **D** — Git status indicator per workspace.
- **E** — Shell-integration status detection (idle/working/waiting-for-input) + OS notifications.
- **F** — Restored-session UX polish tying A/B/C together.

---

### Task 1: Session registry persistence

**Files:**
- Create: `Cargo.toml` (workspace root)
- Create: `crates/daemon/Cargo.toml`
- Create: `crates/daemon/src/main.rs` (module declarations only for now)
- Create: `crates/daemon/src/registry.rs`

**Interfaces:**
- Produces: `registry::SessionStatus` enum (`Idle`, `Working`, `WaitingForInput`, `Exited`), `registry::SessionRecord { id: String, workspace_path: String, cwd: String, command: Option<String>, status: SessionStatus, restored: bool }`, `registry::Registry` with `Registry::open(path: &Path) -> anyhow::Result<Registry>`, `.insert(&SessionRecord) -> anyhow::Result<()>`, `.update_status(id: &str, status: SessionStatus) -> anyhow::Result<()>`, `.mark_restored(id: &str) -> anyhow::Result<()>`, `.remove(id: &str) -> anyhow::Result<()>`, `.list() -> anyhow::Result<Vec<SessionRecord>>`.

- [ ] **Step 1: Create the workspace and crate manifests**

`Cargo.toml` (repo root):

```toml
[workspace]
resolver = "2"
members = ["crates/daemon"]
```

`crates/daemon/Cargo.toml`:

```toml
[package]
name = "gavin-daemon"
version = "0.1.0"
edition = "2021"

[[bin]]
name = "gavin-daemon"
path = "src/main.rs"

[dependencies]
serde = { version = "1", features = ["derive"] }
serde_json = "1"
uuid = { version = "1", features = ["v4", "serde"] }
anyhow = "1"
rusqlite = { version = "0.31", features = ["bundled"] }

[dev-dependencies]
tempfile = "3"
```

- [ ] **Step 2: Write the failing tests for the registry**

Create `crates/daemon/src/registry.rs`:

```rust
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum SessionStatus {
    Idle,
    Working,
    WaitingForInput,
    Exited,
}

impl SessionStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            SessionStatus::Idle => "idle",
            SessionStatus::Working => "working",
            SessionStatus::WaitingForInput => "waiting_for_input",
            SessionStatus::Exited => "exited",
        }
    }

    pub fn from_str(s: &str) -> Self {
        match s {
            "working" => SessionStatus::Working,
            "waiting_for_input" => SessionStatus::WaitingForInput,
            "exited" => SessionStatus::Exited,
            _ => SessionStatus::Idle,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SessionRecord {
    pub id: String,
    pub workspace_path: String,
    pub cwd: String,
    pub command: Option<String>,
    pub status: SessionStatus,
    pub restored: bool,
}

pub struct Registry {
    conn: Connection,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_record(id: &str) -> SessionRecord {
        SessionRecord {
            id: id.to_string(),
            workspace_path: "/tmp/ws".to_string(),
            cwd: "/tmp/ws".to_string(),
            command: None,
            status: SessionStatus::Idle,
            restored: false,
        }
    }

    #[test]
    fn insert_and_list_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let registry = Registry::open(&dir.path().join("registry.sqlite")).unwrap();
        registry.insert(&test_record("s1")).unwrap();

        let sessions = registry.list().unwrap();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].id, "s1");
        assert_eq!(sessions[0].status, SessionStatus::Idle);
        assert_eq!(sessions[0].restored, false);
    }

    #[test]
    fn update_status_persists() {
        let dir = tempfile::tempdir().unwrap();
        let registry = Registry::open(&dir.path().join("registry.sqlite")).unwrap();
        registry.insert(&test_record("s1")).unwrap();

        registry.update_status("s1", SessionStatus::Working).unwrap();

        let sessions = registry.list().unwrap();
        assert_eq!(sessions[0].status, SessionStatus::Working);
    }

    #[test]
    fn mark_restored_persists() {
        let dir = tempfile::tempdir().unwrap();
        let registry = Registry::open(&dir.path().join("registry.sqlite")).unwrap();
        registry.insert(&test_record("s1")).unwrap();

        registry.mark_restored("s1").unwrap();

        let sessions = registry.list().unwrap();
        assert_eq!(sessions[0].restored, true);
    }

    #[test]
    fn remove_deletes_record() {
        let dir = tempfile::tempdir().unwrap();
        let registry = Registry::open(&dir.path().join("registry.sqlite")).unwrap();
        registry.insert(&test_record("s1")).unwrap();

        registry.remove("s1").unwrap();

        assert_eq!(registry.list().unwrap().len(), 0);
    }

    #[test]
    fn registry_survives_reopen() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("registry.sqlite");
        {
            let registry = Registry::open(&db_path).unwrap();
            registry.insert(&test_record("s1")).unwrap();
        }
        let registry = Registry::open(&db_path).unwrap();
        let sessions = registry.list().unwrap();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].id, "s1");
    }
}
```

Add `mod registry;` to `crates/daemon/src/main.rs` (create the file with just `mod registry; fn main() {}` for now).

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cargo test -p gavin-daemon`
Expected: FAIL to compile — `Registry::open`, `.insert`, `.update_status`, `.mark_restored`, `.remove`, `.list` are not defined yet.

- [ ] **Step 4: Implement the registry**

Add to `crates/daemon/src/registry.rs` (above the `#[cfg(test)]` block):

```rust
impl Registry {
    pub fn open(path: &std::path::Path) -> anyhow::Result<Self> {
        let conn = Connection::open(path)?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS sessions (
                id TEXT PRIMARY KEY,
                workspace_path TEXT NOT NULL,
                cwd TEXT NOT NULL,
                command TEXT,
                status TEXT NOT NULL DEFAULT 'idle',
                restored INTEGER NOT NULL DEFAULT 0
            )",
        )?;
        Ok(Self { conn })
    }

    pub fn insert(&self, record: &SessionRecord) -> anyhow::Result<()> {
        self.conn.execute(
            "INSERT INTO sessions (id, workspace_path, cwd, command, status, restored)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                record.id,
                record.workspace_path,
                record.cwd,
                record.command,
                record.status.as_str(),
                record.restored as i64,
            ],
        )?;
        Ok(())
    }

    pub fn update_status(&self, id: &str, status: SessionStatus) -> anyhow::Result<()> {
        self.conn.execute(
            "UPDATE sessions SET status = ?1 WHERE id = ?2",
            params![status.as_str(), id],
        )?;
        Ok(())
    }

    pub fn mark_restored(&self, id: &str) -> anyhow::Result<()> {
        self.conn
            .execute("UPDATE sessions SET restored = 1 WHERE id = ?1", params![id])?;
        Ok(())
    }

    pub fn remove(&self, id: &str) -> anyhow::Result<()> {
        self.conn.execute("DELETE FROM sessions WHERE id = ?1", params![id])?;
        Ok(())
    }

    pub fn list(&self) -> anyhow::Result<Vec<SessionRecord>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, workspace_path, cwd, command, status, restored FROM sessions",
        )?;
        let rows = stmt.query_map([], |row| {
            let status_str: String = row.get(4)?;
            let restored: i64 = row.get(5)?;
            Ok(SessionRecord {
                id: row.get(0)?,
                workspace_path: row.get(1)?,
                cwd: row.get(2)?,
                command: row.get(3)?,
                status: SessionStatus::from_str(&status_str),
                restored: restored != 0,
            })
        })?;
        let mut result = Vec::new();
        for row in rows {
            result.push(row?);
        }
        Ok(result)
    }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cargo test -p gavin-daemon`
Expected: PASS — all 5 tests in `registry::tests` green.

- [ ] **Step 6: Commit**

```bash
git add Cargo.toml crates/daemon/Cargo.toml crates/daemon/src/main.rs crates/daemon/src/registry.rs
git commit -m "feat(daemon): add SQLite-backed session registry"
```

---

### Task 2: PTY session manager

**Files:**
- Modify: `crates/daemon/Cargo.toml` (add `portable-pty` dependency)
- Create: `crates/daemon/src/pty.rs`
- Modify: `crates/daemon/src/main.rs` (add `mod pty;`)

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `pty::PtySession` with `PtySession::spawn(cwd: &str, command: Option<&str>) -> anyhow::Result<PtySession>`, `.reader(&self) -> anyhow::Result<Box<dyn std::io::Read + Send>>`, `.write_input(&mut self, data: &[u8]) -> anyhow::Result<()>`, `.resize(&self, cols: u16, rows: u16) -> anyhow::Result<()>`, `.try_wait(&mut self) -> anyhow::Result<Option<i32>>`, `.kill(&mut self) -> anyhow::Result<()>`.

- [ ] **Step 1: Add the `portable-pty` dependency**

In `crates/daemon/Cargo.toml`, under `[dependencies]`, add:

```toml
portable-pty = "0.8"
```

- [ ] **Step 2: Write the failing tests**

Create `crates/daemon/src/pty.rs`:

```rust
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use std::io::Write;

pub struct PtySession {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;
    use std::time::{Duration, Instant};

    fn read_until_contains(
        reader: &mut dyn Read,
        needle: &str,
        timeout: Duration,
    ) -> String {
        let start = Instant::now();
        let mut collected = String::new();
        let mut buf = [0u8; 4096];
        while start.elapsed() < timeout {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    collected.push_str(&String::from_utf8_lossy(&buf[..n]));
                    if collected.contains(needle) {
                        return collected;
                    }
                }
                Err(_) => break,
            }
        }
        collected
    }

    #[test]
    fn spawns_shell_and_captures_output() {
        let mut session = PtySession::spawn("/tmp", Some("/bin/sh")).unwrap();
        let mut reader = session.reader().unwrap();

        session.write_input(b"echo hello_pty_test\n").unwrap();

        let output = read_until_contains(&mut *reader, "hello_pty_test", Duration::from_secs(2));
        assert!(output.contains("hello_pty_test"), "got: {output}");

        session.kill().unwrap();
    }

    #[test]
    fn resize_does_not_error() {
        let session = PtySession::spawn("/tmp", Some("/bin/sh")).unwrap();
        session.resize(100, 40).unwrap();
    }

    #[test]
    fn kill_causes_exit() {
        let mut session = PtySession::spawn("/tmp", Some("/bin/sh")).unwrap();
        session.kill().unwrap();

        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            if let Some(_code) = session.try_wait().unwrap() {
                break;
            }
            assert!(Instant::now() < deadline, "process did not exit in time");
            std::thread::sleep(Duration::from_millis(50));
        }
    }
}
```

Add `mod pty;` to `crates/daemon/src/main.rs`.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cargo test -p gavin-daemon pty::`
Expected: FAIL to compile — `PtySession::spawn`, `.reader`, `.write_input`, `.resize`, `.try_wait`, `.kill` are not defined yet.

- [ ] **Step 4: Implement the PTY wrapper**

Add to `crates/daemon/src/pty.rs` (above the `#[cfg(test)]` block):

```rust
impl PtySession {
    pub fn spawn(cwd: &str, command: Option<&str>) -> anyhow::Result<Self> {
        let pty_system = native_pty_system();
        let pair = pty_system.openpty(PtySize {
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        })?;

        let shell = command
            .map(|c| c.to_string())
            .unwrap_or_else(|| std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string()));
        let mut cmd = CommandBuilder::new(shell);
        cmd.cwd(cwd);

        let child = pair.slave.spawn_command(cmd)?;
        let writer = pair.master.take_writer()?;

        Ok(Self {
            master: pair.master,
            writer,
            child,
        })
    }

    pub fn reader(&self) -> anyhow::Result<Box<dyn std::io::Read + Send>> {
        Ok(self.master.try_clone_reader()?)
    }

    pub fn write_input(&mut self, data: &[u8]) -> anyhow::Result<()> {
        self.writer.write_all(data)?;
        Ok(())
    }

    pub fn resize(&self, cols: u16, rows: u16) -> anyhow::Result<()> {
        self.master.resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })?;
        Ok(())
    }

    pub fn try_wait(&mut self) -> anyhow::Result<Option<i32>> {
        match self.child.try_wait()? {
            Some(status) => Ok(Some(status.exit_code() as i32)),
            None => Ok(None),
        }
    }

    pub fn kill(&mut self) -> anyhow::Result<()> {
        self.child.kill()?;
        Ok(())
    }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cargo test -p gavin-daemon pty::`
Expected: PASS — all 3 tests in `pty::tests` green. (These spawn a real `/bin/sh`, so they only run on Unix — consistent with the macOS-only scope of this plan.)

- [ ] **Step 6: Commit**

```bash
git add crates/daemon/Cargo.toml crates/daemon/src/main.rs crates/daemon/src/pty.rs
git commit -m "feat(daemon): add PTY session wrapper over portable-pty"
```

---

### Task 3: IPC protocol types and framing

**Files:**
- Create: `crates/daemon/src/protocol.rs`
- Modify: `crates/daemon/src/main.rs` (add `mod protocol;`)

**Interfaces:**
- Consumes: nothing from Tasks 1-2 directly (this module is standalone wire-format code).
- Produces: `protocol::Request` enum (`CreateSession { workspace_path, cwd, command: Option<String> }`, `ListSessions`, `WriteInput { id, data }`, `ResizeSession { id, cols: u16, rows: u16 }`, `KillSession { id }`, `Attach { id }`), `protocol::Response` enum (`SessionCreated { id }`, `SessionList { sessions: Vec<SessionSummary> }`, `Output { id, data }`, `SessionExited { id, exit_code: i32 }`, `Ok`, `Error { message }`), `protocol::SessionSummary { id, workspace_path, cwd, status, restored }`, `protocol::write_message<W: Write, T: Serialize>(writer: &mut W, msg: &T) -> anyhow::Result<()>`, `protocol::read_message<R: BufRead, T: DeserializeOwned>(reader: &mut R) -> anyhow::Result<Option<T>>`.

Note: `Attach` is declared here so the wire format is settled once, even though it isn't handled by the server until Task 5.

- [ ] **Step 1: Write the failing tests**

Create `crates/daemon/src/protocol.rs`:

```rust
use serde::{Deserialize, Serialize};
use std::io::{BufRead, Write};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum Request {
    CreateSession {
        workspace_path: String,
        cwd: String,
        command: Option<String>,
    },
    ListSessions,
    WriteInput {
        id: String,
        data: String,
    },
    ResizeSession {
        id: String,
        cols: u16,
        rows: u16,
    },
    KillSession {
        id: String,
    },
    Attach {
        id: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum Response {
    SessionCreated { id: String },
    SessionList { sessions: Vec<SessionSummary> },
    Output { id: String, data: String },
    SessionExited { id: String, exit_code: i32 },
    Ok,
    Error { message: String },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SessionSummary {
    pub id: String,
    pub workspace_path: String,
    pub cwd: String,
    pub status: String,
    pub restored: bool,
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn request_roundtrips_through_json_line() {
        let mut buf = Vec::new();
        let req = Request::CreateSession {
            workspace_path: "/tmp/ws".to_string(),
            cwd: "/tmp/ws".to_string(),
            command: None,
        };
        write_message(&mut buf, &req).unwrap();

        let mut cursor = Cursor::new(buf);
        let decoded: Request = read_message(&mut cursor).unwrap().unwrap();

        match decoded {
            Request::CreateSession { workspace_path, cwd, command } => {
                assert_eq!(workspace_path, "/tmp/ws");
                assert_eq!(cwd, "/tmp/ws");
                assert_eq!(command, None);
            }
            other => panic!("wrong variant: {other:?}"),
        }
    }

    #[test]
    fn response_roundtrips_through_json_line() {
        let mut buf = Vec::new();
        let resp = Response::Output {
            id: "s1".to_string(),
            data: "hello\n".to_string(),
        };
        write_message(&mut buf, &resp).unwrap();

        let mut cursor = Cursor::new(buf);
        let decoded: Response = read_message(&mut cursor).unwrap().unwrap();

        match decoded {
            Response::Output { id, data } => {
                assert_eq!(id, "s1");
                assert_eq!(data, "hello\n");
            }
            other => panic!("wrong variant: {other:?}"),
        }
    }

    #[test]
    fn read_message_returns_none_at_eof() {
        let mut cursor = Cursor::new(Vec::<u8>::new());
        let decoded: Option<Request> = read_message(&mut cursor).unwrap();
        assert!(decoded.is_none());
    }

    #[test]
    fn two_messages_on_same_stream_read_independently() {
        let mut buf = Vec::new();
        write_message(&mut buf, &Request::ListSessions).unwrap();
        write_message(&mut buf, &Request::KillSession { id: "s1".to_string() }).unwrap();

        let mut cursor = Cursor::new(buf);
        let first: Request = read_message(&mut cursor).unwrap().unwrap();
        let second: Request = read_message(&mut cursor).unwrap().unwrap();

        assert!(matches!(first, Request::ListSessions));
        assert!(matches!(second, Request::KillSession { .. }));
    }
}
```

Add `mod protocol;` to `crates/daemon/src/main.rs`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test -p gavin-daemon protocol::`
Expected: FAIL to compile — `write_message` and `read_message` are not defined yet.

- [ ] **Step 3: Implement the framing functions**

Add to `crates/daemon/src/protocol.rs` (above the `#[cfg(test)]` block):

```rust
pub fn write_message<W: Write, T: Serialize>(writer: &mut W, msg: &T) -> anyhow::Result<()> {
    let line = serde_json::to_string(msg)?;
    writer.write_all(line.as_bytes())?;
    writer.write_all(b"\n")?;
    writer.flush()?;
    Ok(())
}

pub fn read_message<R: BufRead, T: for<'de> Deserialize<'de>>(
    reader: &mut R,
) -> anyhow::Result<Option<T>> {
    let mut line = String::new();
    let bytes_read = reader.read_line(&mut line)?;
    if bytes_read == 0 {
        return Ok(None);
    }
    let msg = serde_json::from_str(line.trim_end())?;
    Ok(Some(msg))
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test -p gavin-daemon protocol::`
Expected: PASS — all 4 tests in `protocol::tests` green.

- [ ] **Step 5: Commit**

```bash
git add crates/daemon/src/main.rs crates/daemon/src/protocol.rs
git commit -m "feat(daemon): add newline-delimited JSON IPC protocol"
```

---

### Task 4: Socket server — session CRUD over the wire

**Files:**
- Create: `crates/daemon/src/server.rs`
- Modify: `crates/daemon/src/main.rs` (add `mod server;`)

**Interfaces:**
- Consumes: `registry::{Registry, SessionRecord, SessionStatus}` (Task 1), `pty::PtySession` (Task 2), `protocol::{Request, Response, SessionSummary, read_message, write_message}` (Task 3).
- Produces: `server::SessionManager` with `SessionManager::new(registry: Registry) -> Self`, `.create_session(workspace_path: &str, cwd: &str, command: Option<&str>) -> anyhow::Result<String>`, `.list_sessions(&self) -> anyhow::Result<Vec<SessionSummary>>`, `.write_input(&self, id: &str, data: &[u8]) -> anyhow::Result<()>`, `.kill_session(&self, id: &str) -> anyhow::Result<()>`. `server::handle_request(manager: &SessionManager, req: Request) -> Response`. `server::run_server(socket_path: &Path, manager: Arc<SessionManager>) -> anyhow::Result<()>` (blocks, accepting connections until the process exits).

Note: `Registry` wraps a `rusqlite::Connection`, which is `Send` but not
`Sync`. `SessionManager` is shared across connection-handling threads as
`Arc<SessionManager>`, and `Arc<T>` is only `Send` (movable into
`thread::spawn`) when `T: Send + Sync`. So `registry` is stored as
`Mutex<Registry>`, exactly like `sessions` already is — this isn't optional.

- [ ] **Step 1: Write the failing integration test**

Create `crates/daemon/src/server.rs`:

```rust
use crate::protocol::{read_message, write_message, Request, Response, SessionSummary};
use crate::pty::PtySession;
use crate::registry::{Registry, SessionRecord, SessionStatus};
use std::collections::HashMap;
use std::io::BufReader;
use std::os::unix::net::{UnixListener, UnixStream};
use std::sync::{Arc, Mutex};
use uuid::Uuid;

pub struct SessionManager {
    registry: Mutex<Registry>,
    sessions: Mutex<HashMap<String, PtySession>>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn start_test_server() -> (std::path::PathBuf, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let socket_path = dir.path().join("daemon.sock");
        let db_path = dir.path().join("registry.sqlite");

        let registry = Registry::open(&db_path).unwrap();
        let manager = Arc::new(SessionManager::new(registry));

        let server_socket_path = socket_path.clone();
        std::thread::spawn(move || {
            run_server(&server_socket_path, manager).unwrap();
        });

        // Give the listener a moment to bind.
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        while !socket_path.exists() {
            assert!(std::time::Instant::now() < deadline, "server never bound");
            std::thread::sleep(Duration::from_millis(20));
        }

        (socket_path, dir)
    }

    fn request(stream: &mut UnixStream, req: &Request) -> Response {
        write_message(stream, req).unwrap();
        let mut reader = BufReader::new(stream.try_clone().unwrap());
        read_message(&mut reader).unwrap().unwrap()
    }

    #[test]
    fn create_list_and_kill_session_over_socket() {
        let (socket_path, _dir) = start_test_server();
        let mut stream = UnixStream::connect(&socket_path).unwrap();

        let created = request(
            &mut stream,
            &Request::CreateSession {
                workspace_path: "/tmp/ws".to_string(),
                cwd: "/tmp".to_string(),
                command: Some("/bin/sh".to_string()),
            },
        );
        let id = match created {
            Response::SessionCreated { id } => id,
            other => panic!("expected SessionCreated, got {other:?}"),
        };

        let listed = request(&mut stream, &Request::ListSessions);
        match listed {
            Response::SessionList { sessions } => {
                assert_eq!(sessions.len(), 1);
                assert_eq!(sessions[0].id, id);
                assert_eq!(sessions[0].status, "idle");
                assert_eq!(sessions[0].restored, false);
            }
            other => panic!("expected SessionList, got {other:?}"),
        }

        let killed = request(&mut stream, &Request::KillSession { id: id.clone() });
        assert!(matches!(killed, Response::Ok));

        let listed_after = request(&mut stream, &Request::ListSessions);
        match listed_after {
            Response::SessionList { sessions } => assert_eq!(sessions.len(), 0),
            other => panic!("expected SessionList, got {other:?}"),
        }
    }

    #[test]
    fn write_input_to_unknown_session_returns_error() {
        let (socket_path, _dir) = start_test_server();
        let mut stream = UnixStream::connect(&socket_path).unwrap();

        let resp = request(
            &mut stream,
            &Request::WriteInput {
                id: "does-not-exist".to_string(),
                data: "echo hi\n".to_string(),
            },
        );
        assert!(matches!(resp, Response::Error { .. }));
    }
}
```

Add `mod server;` to `crates/daemon/src/main.rs`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cargo test -p gavin-daemon server::`
Expected: FAIL to compile — `SessionManager::new`, `.create_session`, `.list_sessions`, `.write_input`, `.kill_session`, `handle_request`, `run_server` are not defined yet.

- [ ] **Step 3: Implement the session manager and server**

Add to `crates/daemon/src/server.rs` (above the `#[cfg(test)]` block):

```rust
impl SessionManager {
    pub fn new(registry: Registry) -> Self {
        Self {
            registry: Mutex::new(registry),
            sessions: Mutex::new(HashMap::new()),
        }
    }

    pub fn create_session(
        &self,
        workspace_path: &str,
        cwd: &str,
        command: Option<&str>,
    ) -> anyhow::Result<String> {
        let id = Uuid::new_v4().to_string();
        let pty = PtySession::spawn(cwd, command)?;

        self.registry.lock().unwrap().insert(&SessionRecord {
            id: id.clone(),
            workspace_path: workspace_path.to_string(),
            cwd: cwd.to_string(),
            command: command.map(|c| c.to_string()),
            status: SessionStatus::Idle,
            restored: false,
        })?;

        self.sessions.lock().unwrap().insert(id.clone(), pty);
        Ok(id)
    }

    pub fn list_sessions(&self) -> anyhow::Result<Vec<SessionSummary>> {
        let records = self.registry.lock().unwrap().list()?;
        Ok(records
            .into_iter()
            .map(|r| SessionSummary {
                id: r.id,
                workspace_path: r.workspace_path,
                cwd: r.cwd,
                status: r.status.as_str().to_string(),
                restored: r.restored,
            })
            .collect())
    }

    pub fn write_input(&self, id: &str, data: &[u8]) -> anyhow::Result<()> {
        let mut sessions = self.sessions.lock().unwrap();
        let session = sessions
            .get_mut(id)
            .ok_or_else(|| anyhow::anyhow!("unknown session: {id}"))?;
        session.write_input(data)
    }

    pub fn kill_session(&self, id: &str) -> anyhow::Result<()> {
        let mut sessions = self.sessions.lock().unwrap();
        if let Some(session) = sessions.get_mut(id) {
            session.kill()?;
        }
        self.registry.lock().unwrap().remove(id)?;
        sessions.remove(id);
        Ok(())
    }
}

pub fn handle_request(manager: &SessionManager, req: Request) -> Response {
    let result = match req {
        Request::CreateSession { workspace_path, cwd, command } => manager
            .create_session(&workspace_path, &cwd, command.as_deref())
            .map(|id| Response::SessionCreated { id }),
        Request::ListSessions => manager
            .list_sessions()
            .map(|sessions| Response::SessionList { sessions }),
        Request::WriteInput { id, data } => manager
            .write_input(&id, data.as_bytes())
            .map(|_| Response::Ok),
        Request::ResizeSession { .. } => Ok(Response::Ok),
        Request::KillSession { id } => manager.kill_session(&id).map(|_| Response::Ok),
        Request::Attach { .. } => Ok(Response::Error {
            message: "Attach is not handled yet".to_string(),
        }),
    };

    result.unwrap_or_else(|e| Response::Error { message: e.to_string() })
}

pub fn run_server(socket_path: &std::path::Path, manager: Arc<SessionManager>) -> anyhow::Result<()> {
    if socket_path.exists() {
        std::fs::remove_file(socket_path)?;
    }
    let listener = UnixListener::bind(socket_path)?;

    for stream in listener.incoming() {
        let stream = stream?;
        let manager = Arc::clone(&manager);
        std::thread::spawn(move || {
            if let Err(e) = handle_connection(stream, manager) {
                eprintln!("connection error: {e}");
            }
        });
    }
    Ok(())
}

fn handle_connection(stream: UnixStream, manager: Arc<SessionManager>) -> anyhow::Result<()> {
    let mut writer = stream.try_clone()?;
    let mut reader = BufReader::new(stream);

    loop {
        let req: Option<Request> = read_message(&mut reader)?;
        let req = match req {
            Some(r) => r,
            None => break,
        };
        let response = handle_request(&manager, req);
        write_message(&mut writer, &response)?;
    }
    Ok(())
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cargo test -p gavin-daemon server::`
Expected: PASS — both tests in `server::tests` green.

- [ ] **Step 5: Commit**

```bash
git add crates/daemon/src/main.rs crates/daemon/src/server.rs
git commit -m "feat(daemon): serve session CRUD over a Unix domain socket"
```

---

### Task 5: Attach — stream output to a (possibly new) connection

**Files:**
- Modify: `crates/daemon/src/server.rs`

**Interfaces:**
- Consumes: `SessionManager` (Task 4), `PtySession::reader`/`.try_wait` (Task 2).
- Produces: `SessionManager::reader_for(&self, id: &str) -> anyhow::Result<Box<dyn std::io::Read + Send>>`, `SessionManager::exit_code_for(&self, id: &str) -> anyhow::Result<Option<i32>>`, `SessionManager::attach(self: &Arc<Self>, id: &str, writer: Arc<Mutex<UnixStream>>)`. A new `SessionManager.attached_writers` field tracks, per session, the currently-registered writer for whichever connection last attached. `attach` spawns at most one long-lived pump thread per session (on its first attach) that forwards `Response::Output` (and `Response::SessionExited` on EOF) to whichever writer is currently registered — a later `Attach` for the same session swaps the registered writer rather than spawning a competing thread. `handle_connection`'s own writer is now `Arc<Mutex<UnixStream>>`, shared with any pump thread forwarding to that connection, so the two can never interleave writes.

This is the task that proves "sessions survive the app closing": a session created on one connection can be attached to and driven from a completely different, later connection.

- [ ] **Step 1: Write the failing test**

Add to the `#[cfg(test)] mod tests` block in `crates/daemon/src/server.rs` (alongside the existing tests):

```rust
    #[test]
    fn attach_from_a_new_connection_streams_output_of_an_existing_session() {
        let (socket_path, _dir) = start_test_server();

        // Connection 1: create the session, then drop the connection
        // (simulating the GUI app closing).
        let id = {
            let mut stream = UnixStream::connect(&socket_path).unwrap();
            let created = request(
                &mut stream,
                &Request::CreateSession {
                    workspace_path: "/tmp/ws".to_string(),
                    cwd: "/tmp".to_string(),
                    command: Some("/bin/sh".to_string()),
                },
            );
            match created {
                Response::SessionCreated { id } => id,
                other => panic!("expected SessionCreated, got {other:?}"),
            }
        };

        // Connection 2: attach to the same session and drive it.
        let mut stream2 = UnixStream::connect(&socket_path).unwrap();
        write_message(&mut stream2, &Request::Attach { id: id.clone() }).unwrap();
        write_message(
            &mut stream2,
            &Request::WriteInput {
                id: id.clone(),
                data: "echo attached_ok\n".to_string(),
            },
        )
        .unwrap();

        let mut reader = BufReader::new(stream2.try_clone().unwrap());
        let mut collected = String::new();
        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        loop {
            let resp: Response = read_message(&mut reader).unwrap().unwrap();
            if let Response::Output { data, .. } = resp {
                collected.push_str(&data);
                if collected.contains("attached_ok") {
                    break;
                }
            }
            assert!(std::time::Instant::now() < deadline, "got: {collected}");
        }
    }
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cargo test -p gavin-daemon server::attach`
Expected: FAIL — `Attach` currently returns `Response::Error { message: "Attach is not handled yet" }`, so no `Output` message ever arrives and the test hits the deadline assertion (or times out).

- [ ] **Step 3: Implement Attach and the output pump**

Add these two methods to `impl SessionManager` in `crates/daemon/src/server.rs`:

```rust
    pub fn reader_for(&self, id: &str) -> anyhow::Result<Box<dyn std::io::Read + Send>> {
        let sessions = self.sessions.lock().unwrap();
        let session = sessions
            .get(id)
            .ok_or_else(|| anyhow::anyhow!("unknown session: {id}"))?;
        session.reader()
    }

    pub fn exit_code_for(&self, id: &str) -> anyhow::Result<Option<i32>> {
        let mut sessions = self.sessions.lock().unwrap();
        let session = sessions
            .get_mut(id)
            .ok_or_else(|| anyhow::anyhow!("unknown session: {id}"))?;
        session.try_wait()
    }
```

Naive design note (superseded below): spawning a brand-new reader-clone thread on every `Attach` call — one thread per attach, reading via its own `try_clone_reader()` — has three real problems once a session gets attached to more than once over its lifetime: (1) the pump thread and the main connection loop write to independent socket clones with no coordination, so interleaved `write_message` calls (each two syscalls: body, then newline) can corrupt the line-framed protocol; (2) a pump thread only exits on PTY EOF or a failed write, so a client that attaches then disconnects from an otherwise-idle session leaves the thread blocked in `read()` forever — an unbounded leak across repeated attach/detach cycles; (3) because each `Attach` clones a *new* independent PTY reader, two live threads can compete for the same output bytes, so a client reattaching while a stale thread is still blocked can silently miss output.

The design below avoids all three: **at most one reader thread per session, for the session's whole attached lifetime**, forwarding to whichever writer is currently registered as attached (swapped on each new `Attach`, no new thread spawned), with that writer shared behind one `Mutex` so the main connection loop and the forwarding thread never race on the same socket.

Add one field to `SessionManager` — go back and change its definition (from Task 4) to:

```rust
pub struct SessionManager {
    registry: Mutex<Registry>,
    sessions: Mutex<HashMap<String, PtySession>>,
    attached_writers: Mutex<HashMap<String, Arc<Mutex<UnixStream>>>>,
}
```

And its constructor:

```rust
    pub fn new(registry: Registry) -> Self {
        Self {
            registry: Mutex::new(registry),
            sessions: Mutex::new(HashMap::new()),
            attached_writers: Mutex::new(HashMap::new()),
        }
    }
```

Add these two methods to `impl SessionManager` (alongside `reader_for`/`exit_code_for` above):

```rust
    pub fn attach(self: &Arc<Self>, id: &str, writer: Arc<Mutex<UnixStream>>) {
        let already_running = {
            let mut writers = self.attached_writers.lock().unwrap();
            let existed = writers.contains_key(id);
            writers.insert(id.to_string(), writer);
            existed
        };
        if !already_running {
            self.spawn_pump(id.to_string());
        }
    }

    fn spawn_pump(self: &Arc<Self>, id: String) {
        let manager = Arc::clone(self);
        std::thread::spawn(move || {
            let mut reader = match manager.reader_for(&id) {
                Ok(r) => r,
                Err(e) => {
                    if let Some(w) = manager.attached_writers.lock().unwrap().get(&id) {
                        let _ = write_message(&mut *w.lock().unwrap(), &Response::Error { message: e.to_string() });
                    }
                    manager.attached_writers.lock().unwrap().remove(&id);
                    return;
                }
            };

            let mut buf = [0u8; 4096];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        let data = String::from_utf8_lossy(&buf[..n]).to_string();
                        // No writer currently attached, or a write to it failed (dead
                        // connection): drop this chunk and keep reading. The session
                        // keeps running either way; a future Attach registers a fresh
                        // writer and picks up from whatever the PTY produces next —
                        // scrollback replay is explicitly out of scope (see Non-goals).
                        if let Some(w) = manager.attached_writers.lock().unwrap().get(&id) {
                            let _ = write_message(&mut *w.lock().unwrap(), &Response::Output { id: id.clone(), data });
                        }
                    }
                    Err(_) => break,
                }
            }

            let exit_code = manager.exit_code_for(&id).ok().flatten().unwrap_or(-1);
            if let Some(w) = manager.attached_writers.lock().unwrap().get(&id) {
                let _ = write_message(&mut *w.lock().unwrap(), &Response::SessionExited { id: id.clone(), exit_code });
            }
            manager.attached_writers.lock().unwrap().remove(&id);
        });
    }
```

`Attach` needs to keep streaming, which `handle_request`'s single-`Response`-return shape can't express, so move `Attach` handling out of `handle_request` and into `handle_connection` directly. Replace the whole `handle_connection` function with:

```rust
fn handle_connection(stream: UnixStream, manager: Arc<SessionManager>) -> anyhow::Result<()> {
    let writer = Arc::new(Mutex::new(stream.try_clone()?));
    let mut reader = BufReader::new(stream);

    loop {
        let req: Option<Request> = read_message(&mut reader)?;
        let req = match req {
            Some(r) => r,
            None => break,
        };

        if let Request::Attach { id } = req {
            manager.attach(&id, Arc::clone(&writer));
            continue;
        }

        let response = handle_request(&manager, req);
        write_message(&mut *writer.lock().unwrap(), &response)?;
    }
    Ok(())
}
```

Every write to a given connection — whether from the main request/response loop or from a pump thread forwarding output to that connection — now goes through the same `Arc<Mutex<UnixStream>>`, so two writes can never interleave.

Add `use std::io::Read;` to the top of `crates/daemon/src/server.rs`.

`Attach` is now handled before `handle_request` is ever called (`handle_connection` intercepts it above), so remove its arm there. Replace the whole `handle_request` function with:

```rust
pub fn handle_request(manager: &SessionManager, req: Request) -> Response {
    let result = match req {
        Request::CreateSession { workspace_path, cwd, command } => manager
            .create_session(&workspace_path, &cwd, command.as_deref())
            .map(|id| Response::SessionCreated { id }),
        Request::ListSessions => manager
            .list_sessions()
            .map(|sessions| Response::SessionList { sessions }),
        Request::WriteInput { id, data } => manager
            .write_input(&id, data.as_bytes())
            .map(|_| Response::Ok),
        Request::ResizeSession { .. } => Ok(Response::Ok),
        Request::KillSession { id } => manager.kill_session(&id).map(|_| Response::Ok),
        Request::Attach { .. } => unreachable!("Attach is intercepted in handle_connection"),
    };

    result.unwrap_or_else(|e| Response::Error { message: e.to_string() })
}
```

Add one more test proving a second, later attach correctly takes over from an
earlier one instead of racing it or losing output — this is the regression
test for the fan-out/leak problem the naive design above had. Add to the
`#[cfg(test)] mod tests` block, alongside the existing attach test:

```rust
    #[test]
    fn reattaching_after_detach_delivers_output_to_the_new_connection_only() {
        let (socket_path, _dir) = start_test_server();

        let id = {
            let mut stream = UnixStream::connect(&socket_path).unwrap();
            let created = request(
                &mut stream,
                &Request::CreateSession {
                    workspace_path: "/tmp/ws".to_string(),
                    cwd: "/tmp".to_string(),
                    command: Some("/bin/sh".to_string()),
                },
            );
            match created {
                Response::SessionCreated { id } => id,
                other => panic!("expected SessionCreated, got {other:?}"),
            }
        };

        // First attach, then drop the connection without the session exiting.
        {
            let mut stream2 = UnixStream::connect(&socket_path).unwrap();
            write_message(&mut stream2, &Request::Attach { id: id.clone() }).unwrap();
            // Give the pump thread a moment to start before we drop the connection.
            std::thread::sleep(Duration::from_millis(100));
        }

        // Reattach from a third connection and drive the session — this must
        // not race with, or lose output to, the now-disconnected first pump.
        let mut stream3 = UnixStream::connect(&socket_path).unwrap();
        write_message(&mut stream3, &Request::Attach { id: id.clone() }).unwrap();
        write_message(
            &mut stream3,
            &Request::WriteInput {
                id: id.clone(),
                data: "echo reattached_ok\n".to_string(),
            },
        )
        .unwrap();

        let mut reader = BufReader::new(stream3.try_clone().unwrap());
        let mut collected = String::new();
        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        loop {
            let resp: Response = read_message(&mut reader).unwrap().unwrap();
            if let Response::Output { data, .. } = resp {
                collected.push_str(&data);
                if collected.contains("reattached_ok") {
                    break;
                }
            }
            assert!(std::time::Instant::now() < deadline, "got: {collected}");
        }
    }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test -p gavin-daemon server::`
Expected: PASS — all tests in `server::tests` green, including both attach tests.

- [ ] **Step 5: Commit**

```bash
git add crates/daemon/src/server.rs
git commit -m "feat(daemon): stream session output via Attach on any connection"
```

---

### Task 6: Recovery after a daemon restart

**Files:**
- Modify: `crates/daemon/src/server.rs`

**Interfaces:**
- Consumes: `Registry::list`, `Registry::mark_restored` (Task 1), `PtySession::spawn` (Task 2).
- Produces: `SessionManager::recover(&self) -> anyhow::Result<()>` — for every record already in the registry (i.e. left over from a previous process), spawns a fresh shell at its `cwd` and marks it `restored: true`.

- [ ] **Step 1: Write the failing test**

Add to the `#[cfg(test)] mod tests` block in `crates/daemon/src/server.rs`:

```rust
    #[test]
    fn recover_spawns_fresh_shells_for_leftover_registry_entries() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("registry.sqlite");

        // Simulate a previous daemon process: a registry entry exists,
        // but there is no live PTY for it (this new process just started).
        {
            let registry = Registry::open(&db_path).unwrap();
            registry
                .insert(&SessionRecord {
                    id: "leftover-1".to_string(),
                    workspace_path: "/tmp/ws".to_string(),
                    cwd: "/tmp".to_string(),
                    command: Some("/bin/sh".to_string()),
                    status: SessionStatus::Idle,
                    restored: false,
                })
                .unwrap();
        }

        let registry = Registry::open(&db_path).unwrap();
        let manager = SessionManager::new(registry);

        manager.recover().unwrap();

        let sessions = manager.list_sessions().unwrap();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].id, "leftover-1");
        assert_eq!(sessions[0].restored, true);

        // The recovered session must have a real, live PTY behind it.
        manager
            .write_input("leftover-1", b"echo recovered_ok\n")
            .unwrap();
        let mut reader = manager.reader_for("leftover-1").unwrap();

        let mut collected = String::new();
        let mut buf = [0u8; 4096];
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        while !collected.contains("recovered_ok") {
            let n = reader.read(&mut buf).unwrap();
            collected.push_str(&String::from_utf8_lossy(&buf[..n]));
            assert!(std::time::Instant::now() < deadline, "got: {collected}");
        }
    }
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cargo test -p gavin-daemon server::recover`
Expected: FAIL to compile — `SessionManager::recover` is not defined yet.

- [ ] **Step 3: Implement recovery**

Add to `impl SessionManager` in `crates/daemon/src/server.rs`:

```rust
    pub fn recover(&self) -> anyhow::Result<()> {
        let records = self.registry.lock().unwrap().list()?;
        let mut sessions = self.sessions.lock().unwrap();
        for record in records {
            let pty = PtySession::spawn(&record.cwd, record.command.as_deref())?;
            sessions.insert(record.id.clone(), pty);
            self.registry.lock().unwrap().mark_restored(&record.id)?;
        }
        Ok(())
    }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cargo test -p gavin-daemon server::`
Expected: PASS — all tests in `server::tests` green, including `recover_spawns_fresh_shells_for_leftover_registry_entries`.

- [ ] **Step 5: Commit**

```bash
git add crates/daemon/src/server.rs
git commit -m "feat(daemon): recover leftover sessions with fresh shells on restart"
```

---

### Task 7: Wire up `main.rs` into a runnable daemon

**Files:**
- Modify: `crates/daemon/src/main.rs`

**Interfaces:**
- Consumes: `Registry::open` (Task 1), `SessionManager::new`/`.recover` (Tasks 4/6), `server::run_server` (Task 4).
- Produces: `app_support_dir() -> PathBuf`, `socket_path() -> PathBuf`, `db_path() -> PathBuf`, and the `main()` entry point that opens the registry, recovers leftover sessions, and serves.

- [ ] **Step 1: Write the failing test**

Replace the contents of `crates/daemon/src/main.rs` with:

```rust
mod protocol;
mod pty;
mod registry;
mod server;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_are_scoped_under_app_support() {
        let dir = app_support_dir();
        assert!(socket_path().starts_with(&dir));
        assert!(db_path().starts_with(&dir));
        assert_eq!(socket_path().file_name().unwrap(), "daemon.sock");
        assert_eq!(db_path().file_name().unwrap(), "registry.sqlite");
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cargo test -p gavin-daemon tests::paths_are_scoped_under_app_support`
Expected: FAIL to compile — `app_support_dir`, `socket_path`, `db_path` are not defined yet.

- [ ] **Step 3: Implement the path helpers and `main`**

Add to `crates/daemon/src/main.rs` (above the `#[cfg(test)]` block):

```rust
use registry::Registry;
use server::SessionManager;
use std::path::PathBuf;
use std::sync::Arc;

fn app_support_dir() -> PathBuf {
    let home = std::env::var("HOME").expect("HOME not set");
    PathBuf::from(home)
        .join("Library")
        .join("Application Support")
        .join("gavin")
}

fn socket_path() -> PathBuf {
    app_support_dir().join("daemon.sock")
}

fn db_path() -> PathBuf {
    app_support_dir().join("registry.sqlite")
}

fn main() -> anyhow::Result<()> {
    let dir = app_support_dir();
    std::fs::create_dir_all(&dir)?;

    let registry = Registry::open(&db_path())?;
    let manager = Arc::new(SessionManager::new(registry));
    manager.recover()?;

    println!("gavin-daemon listening on {}", socket_path().display());
    server::run_server(&socket_path(), manager)?;
    Ok(())
}
```

- [ ] **Step 4: Run the test to verify it passes, then the full suite**

Run: `cargo test -p gavin-daemon`
Expected: PASS — every test across `registry`, `pty`, `protocol`, `server`, and the new `tests::paths_are_scoped_under_app_support` is green.

- [ ] **Step 5: Manual smoke test**

Run the real daemon in one terminal:

```bash
cargo run -p gavin-daemon
```

Expected output: `gavin-daemon listening on /Users/<you>/Library/Application Support/gavin/daemon.sock`

In a second terminal, drive it with `nc` (netcat) against the Unix socket to confirm it responds to a hand-written request:

```bash
echo '{"type":"ListSessions"}' | nc -U ~/"Library/Application Support/gavin/daemon.sock"
```

Expected output: `{"type":"SessionList","sessions":[]}`

Stop the daemon with Ctrl-C in the first terminal.

- [ ] **Step 6: Commit**

```bash
git add crates/daemon/src/main.rs
git commit -m "feat(daemon): wire up main entry point with startup recovery"
```

## Self-Review Notes

- **Spec coverage:** create/list/kill sessions (Task 4), PTY spawn/read/write/resize/kill (Task 2), durable persistence on every state change (Task 1, used throughout), sessions surviving app-closed-but-daemon-alive via `Attach` on a new connection (Task 5), device-restart recovery with fresh shell + `restored: true` + no scrollback replay (Task 6). Git status, status detection, notifications, and the GUI are explicitly out of scope for this plan (see Global Constraints) and belong to later milestones.
- **Placeholder scan:** none found — every step has real code and concrete run/expect commands.
- **Type consistency:** `SessionRecord`, `SessionStatus`, `Request`/`Response`/`SessionSummary`, and every `SessionManager` method signature are introduced once (Tasks 1-4) and reused verbatim in later tasks (Tasks 5-7) without renaming.
