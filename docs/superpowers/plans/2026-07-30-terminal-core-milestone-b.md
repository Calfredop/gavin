# Terminal Core — Milestone B: Minimal Client Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a minimal Tauri + Svelte + xterm.js desktop app that auto-spawns `gavin-daemon` if needed, creates or reattaches to a single terminal session (persisted across app restarts), and renders it full-window with working input, output, and resize.

**Architecture:** Extract the daemon's wire protocol into a shared `crates/protocol` crate so the new Tauri Rust backend and `gavin-daemon` can't drift apart. The Tauri backend is a thin socket client (same role the daemon's own test clients play): on startup it connects-or-spawns the daemon, sends `CreateSession`/`Attach`, stores the connection in Tauri-managed state, and relays daemon `Response`s to the Svelte frontend as Tauri events while exposing `write_input`/`resize_session` as Tauri commands the frontend invokes.

**Tech Stack:** Rust (2021 edition, workspace), Tauri 2.x, Svelte 5 + TypeScript + Vite (via the official `create-tauri-app` scaffold), `@xterm/xterm` + `@xterm/addon-fit` for terminal rendering. `serde`/`serde_json`/`anyhow` on the Rust side, matching the daemon's existing conventions.

## Global Constraints

- Platform: **macOS only** (matches the terminal-core spec and the daemon).
- Daemon socket path is fixed and must match the daemon exactly:
  `~/Library/Application Support/gavin/daemon.sock`.
- Frontend framework is **Svelte** — locked in by explicit decision (also
  needs to carry the later kanban board work).
- No production packaging (code signing, installers, Tauri "sidecar"
  bundling) — the app locates a **sibling** `gavin-daemon` binary next to its
  own executable in the workspace's build output. This only works when both
  are built by the same `cargo build`/dev run; production distribution is a
  later milestone's concern.
- No workspaces, multiple sessions, split panes, or sidebar UI — exactly one
  hardcoded session, full-window. Milestone C's job, not this one.
- Session persistence: the app must remember its session id locally and
  reattach on the next launch rather than always creating a new session.
- Third-party tool/library exactness (the `create-tauri-app` CLI's current
  flags, Tauri 2.x's exact API surface, `@xterm/*` package names) may have
  drifted from what's written here since this plan was authored — where a
  task calls this out, verify against the actually-installed version's docs
  and adapt names/imports while preserving the described behavior. This is
  the same kind of accepted, bounded uncertainty Milestone A had with
  `portable-pty`'s exact API — it turned out to match exactly there; treat
  a mismatch here as normal, not a reason to redesign.

---

### Task 1: Extract shared `crates/protocol` crate

**Files:**
- Create: `crates/protocol/Cargo.toml`
- Create: `crates/protocol/src/lib.rs`
- Modify: `Cargo.toml` (workspace root — add member)
- Modify: `crates/daemon/Cargo.toml` (drop `serde_json` direct dep, now only
  needed transitively; add `protocol` path dep)
- Modify: `crates/daemon/src/main.rs` (remove `mod protocol;`)
- Modify: `crates/daemon/src/server.rs` (import from `protocol` crate instead
  of `crate::protocol`)
- Delete: `crates/daemon/src/protocol.rs`

**Interfaces:**
- Produces: `protocol::{Request, Response, SessionSummary, read_message, write_message}` — identical names and signatures to what `crate::protocol` already exposed inside the daemon, just now an external crate. Every other task in this plan (3, 5) depends on this.

- [ ] **Step 1: Create the new crate**

`crates/protocol/Cargo.toml`:

```toml
[package]
name = "protocol"
version = "0.1.0"
edition = "2021"

[dependencies]
serde = { version = "1", features = ["derive"] }
serde_json = "1"
anyhow = "1"
```

`crates/protocol/src/lib.rs` — move the **entire current contents** of
`crates/daemon/src/protocol.rs` here unchanged (types, `write_message`,
`read_message`, the `MAX_LINE_BYTES` constant, and the whole
`#[cfg(test)] mod tests` block with its 4 tests). Read
`crates/daemon/src/protocol.rs` first and copy it verbatim into the new
location — don't retype it from memory, to avoid transcription drift.

Also add, to the same `crates/protocol/src/lib.rs` (above the
`#[cfg(test)]` block), the daemon socket's location. This moves out of
`crates/daemon/src/main.rs` in Step 3 below — both the daemon and, later,
the Milestone B client need to agree on exactly where the socket is, so it
belongs in the crate both of them already depend on, not duplicated in two
places where it could drift:

```rust
use std::path::PathBuf;

pub fn app_support_dir() -> PathBuf {
    let home = std::env::var("HOME").expect("HOME not set");
    PathBuf::from(home)
        .join("Library")
        .join("Application Support")
        .join("gavin")
}

pub fn socket_path() -> PathBuf {
    app_support_dir().join("daemon.sock")
}
```

(`db_path()` stays daemon-only — nothing outside the daemon needs to know
where the SQLite registry lives, only where the socket is.)

- [ ] **Step 2: Wire the new crate into the workspace**

In root `Cargo.toml`, add the new member:

```toml
[workspace]
resolver = "2"
members = ["crates/daemon", "crates/protocol"]
```

- [ ] **Step 3: Point the daemon at the new crate**

In `crates/daemon/Cargo.toml`, remove the `serde_json = "1"` line (nothing in
`crates/daemon` calls `serde_json` directly once `protocol.rs` moves out —
`registry.rs`'s `Serialize`/`Deserialize` derives only need the `serde`
crate itself) and add:

```toml
protocol = { path = "../protocol" }
```

Delete `crates/daemon/src/protocol.rs` entirely.

In `crates/daemon/src/main.rs`, remove the `mod protocol;` line, remove the
now-duplicated `app_support_dir()` and `socket_path()` function definitions
(they moved to `protocol` in Step 1 above), and use the crate's versions
instead. The file should end up as:

```rust
mod pty;
mod registry;
mod server;

use registry::Registry;
use server::SessionManager;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::sync::Arc;

fn db_path() -> PathBuf {
    protocol::app_support_dir().join("registry.sqlite")
}

fn main() -> anyhow::Result<()> {
    let dir = protocol::app_support_dir();
    std::fs::create_dir_all(&dir)?;
    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))?;

    let registry = Registry::open(&db_path())?;
    let manager = Arc::new(SessionManager::new(registry));
    manager.recover()?;

    println!("gavin-daemon listening on {}", protocol::socket_path().display());
    server::run_server(&protocol::socket_path(), manager)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_are_scoped_under_app_support() {
        let dir = protocol::app_support_dir();
        assert!(protocol::socket_path().starts_with(&dir));
        assert!(db_path().starts_with(&dir));
        assert_eq!(protocol::socket_path().file_name().unwrap(), "daemon.sock");
        assert_eq!(db_path().file_name().unwrap(), "registry.sqlite");
    }
}
```

In `crates/daemon/src/server.rs`, change:

```rust
use crate::protocol::{read_message, write_message, Request, Response, SessionSummary};
```

to:

```rust
use protocol::{read_message, write_message, Request, Response, SessionSummary};
```

Nothing else in `server.rs` changes — every other use of `Request`/
`Response`/etc. already refers to them by their bare names.

- [ ] **Step 4: Run the tests**

Run: `cargo test --workspace`
Expected: PASS — 22 tests total, now split across two packages: 4 in
`protocol` (`cargo test -p protocol`), 18 in `gavin-daemon`
(`cargo test -p gavin-daemon`). Same tests as before, same total count, just
relocated.

- [ ] **Step 5: Commit**

```bash
git add Cargo.toml Cargo.lock crates/protocol crates/daemon/Cargo.toml crates/daemon/src/main.rs crates/daemon/src/server.rs
git rm crates/daemon/src/protocol.rs
git commit -m "refactor: extract wire protocol into a shared crate"
```

---

### Task 2: Scaffold the Tauri + Svelte app

**Files:**
- Create: `app/` (generated by the official scaffolding tool, then customized)
- Modify: `Cargo.toml` (workspace root — add `app/src-tauri` member)

**Interfaces:**
- Produces: a running Tauri window (default template content at this stage). Later tasks build inside `app/src-tauri/src/` and `app/src/`.

This task's exact output depends on the current version of `create-tauri-app`
and Tauri itself, which move faster than this plan can pin precisely — use
the steps below as the intent, adapting to whatever the tool actually
presents.

- [ ] **Step 1: Run the official scaffold tool**

From the repo root:

```bash
npm create tauri-app@latest app -- --help
```

Look for non-interactive flags for: project name, UI template, and package
manager. If they exist, run something equivalent to:

```bash
npm create tauri-app@latest app -- --template svelte-ts --manager npm --yes
```

choosing **Svelte + TypeScript** as the template and **npm** as the package
manager. If the installed version only supports its interactive wizard, run
it directly and answer manually: app name `app`, identifier `com.gavin.app`,
window title `gavin`, template Svelte, TypeScript variant, package manager
npm. Either way, the project must end up rooted at `app/` relative to the
repo root.

- [ ] **Step 2: Install frontend dependencies**

```bash
cd app && npm install
```

- [ ] **Step 3: Join the existing Cargo workspace**

Open `app/src-tauri/Cargo.toml`. If it contains its own `[workspace]` table,
delete that table entirely — a crate can only belong to one workspace, and
it needs to join the root one alongside `crates/daemon` and
`crates/protocol`.

In the root `Cargo.toml`, add the new member:

```toml
[workspace]
resolver = "2"
members = ["crates/daemon", "crates/protocol", "app/src-tauri"]
```

- [ ] **Step 4: Set the window title and a reasonable default size**

Open `app/src-tauri/tauri.conf.json`. Find the window configuration (under
`app.windows` in Tauri 2.x, or `tauri.windows` in older layouts — use
whichever key actually exists in the generated file) and set:

```json
"title": "gavin",
"width": 1000,
"height": 700
```

- [ ] **Step 5: Verify it builds and runs**

```bash
cargo build -p app  # or whatever package name app/src-tauri/Cargo.toml declares
cd app && npm run build
```

Then, if a display is available in this environment:

```bash
cd app && npm run tauri dev
```

Expected: a window titled "gavin" opens showing the template's default
content (not yet customized — that's later tasks). If no display is
available to confirm this visually, note that explicitly in the task report
rather than claiming it was seen.

- [ ] **Step 6: Commit**

```bash
git add app Cargo.toml Cargo.lock
git commit -m "chore: scaffold Tauri + Svelte app"
```

---

### Task 3: Rust backend — connect-or-spawn daemon logic

**Files:**
- Modify: `app/src-tauri/Cargo.toml` (add deps: `anyhow`, `protocol` path dep, `tempfile` dev-dep — check what the scaffold already added and only add what's missing)
- Create: `app/src-tauri/src/daemon.rs`
- Modify: `app/src-tauri/src/lib.rs` (add `mod daemon;` — or `main.rs` if that's where the scaffold put the app's module root; check which file has the `run()`/`main()` entry point and add the `mod` declaration there)

**Interfaces:**
- Consumes: `protocol::socket_path()` (Task 1) — the real socket location; this module doesn't redefine it, only Task 5's `session::bootstrap` calls it directly at the point of use.
- Produces: `daemon::resolve_daemon_binary_path() -> anyhow::Result<PathBuf>`, `daemon::connect_or_spawn(socket_path: &Path, timeout: Duration, spawn_daemon: impl FnMut() -> anyhow::Result<std::process::Child>) -> anyhow::Result<UnixStream>`, `daemon::spawn_real_daemon() -> anyhow::Result<std::process::Child>`.

Add `protocol = { path = "../../crates/protocol" }` to
`app/src-tauri/Cargo.toml` now if it isn't already there (adjust the
relative path if Task 2's scaffold nested `src-tauri` differently) — Task 5
needs it too, but there's no reason to wait.

- [ ] **Step 1: Write the failing tests**

Create `app/src-tauri/src/daemon.rs`:

```rust
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::net::UnixListener;

    #[test]
    fn resolve_daemon_binary_path_is_sibling_of_current_exe() {
        let path = resolve_daemon_binary_path().unwrap();
        let current_exe = std::env::current_exe().unwrap();
        assert_eq!(path.parent(), current_exe.parent());
        assert_eq!(path.file_name().unwrap(), "gavin-daemon");
    }

    #[test]
    fn connect_or_spawn_returns_immediately_if_already_listening() {
        let dir = tempfile::tempdir().unwrap();
        let socket_path = dir.path().join("already.sock");
        let _listener = UnixListener::bind(&socket_path).unwrap();

        let mut spawn_calls = 0;
        let result = connect_or_spawn(&socket_path, Duration::from_secs(1), || {
            spawn_calls += 1;
            anyhow::bail!("should not be called")
        });

        assert!(result.is_ok());
        assert_eq!(spawn_calls, 0);
    }

    #[test]
    fn connect_or_spawn_spawns_and_retries_until_listening() {
        let dir = tempfile::tempdir().unwrap();
        let socket_path = dir.path().join("spawned.sock");

        let result = connect_or_spawn(&socket_path, Duration::from_secs(5), || {
            Ok(Command::new("nc").arg("-lU").arg(&socket_path).spawn()?)
        });

        assert!(result.is_ok(), "expected connection to succeed");
    }

    #[test]
    fn connect_or_spawn_times_out_if_nothing_ever_listens() {
        let dir = tempfile::tempdir().unwrap();
        let socket_path = dir.path().join("never.sock");

        let result = connect_or_spawn(&socket_path, Duration::from_millis(300), || {
            // Spawn "succeeds" but this process never actually binds the socket.
            Ok(Command::new("sleep").arg("5").spawn()?)
        });

        assert!(result.is_err());
    }
}
```

Add the module declaration (`mod daemon;`) to whichever file has the app's
entry point (`app/src-tauri/src/lib.rs` in a standard Tauri 2.x scaffold —
check for a `run()` function there; fall back to `main.rs` if that's where
it actually lives).

If `app/src-tauri/Cargo.toml` doesn't already have `anyhow = "1"` under
`[dependencies]` and `tempfile = "3"` under `[dev-dependencies]`, add them.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test -p app daemon::` (substitute the actual package name from
`app/src-tauri/Cargo.toml` if it isn't literally `app`)
Expected: FAIL to compile — `resolve_daemon_binary_path` and
`connect_or_spawn` are not defined yet.

- [ ] **Step 3: Implement**

Add to `app/src-tauri/src/daemon.rs` (above the `#[cfg(test)]` block):

```rust
pub fn resolve_daemon_binary_path() -> anyhow::Result<PathBuf> {
    let current_exe = std::env::current_exe()?;
    let dir = current_exe
        .parent()
        .ok_or_else(|| anyhow::anyhow!("current_exe has no parent directory"))?;
    Ok(dir.join("gavin-daemon"))
}

/// Tries to connect to `socket_path`. If nothing is listening, calls
/// `spawn_daemon` to start a process expected to bind that socket, then
/// polls with a short backoff until the connection succeeds or `timeout`
/// elapses.
pub fn connect_or_spawn(
    socket_path: &Path,
    timeout: Duration,
    mut spawn_daemon: impl FnMut() -> anyhow::Result<std::process::Child>,
) -> anyhow::Result<UnixStream> {
    if let Ok(stream) = UnixStream::connect(socket_path) {
        return Ok(stream);
    }

    spawn_daemon()?;

    let deadline = Instant::now() + timeout;
    loop {
        if let Ok(stream) = UnixStream::connect(socket_path) {
            return Ok(stream);
        }
        if Instant::now() >= deadline {
            anyhow::bail!(
                "daemon did not become reachable at {} within {:?}",
                socket_path.display(),
                timeout
            );
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

pub fn spawn_real_daemon() -> anyhow::Result<std::process::Child> {
    let binary = resolve_daemon_binary_path()?;
    Ok(Command::new(binary).spawn()?)
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test -p app daemon::`
Expected: PASS — all 4 tests in `daemon::tests` green.

- [ ] **Step 5: Commit**

```bash
git add app/src-tauri/Cargo.toml app/src-tauri/Cargo.lock app/src-tauri/src/daemon.rs app/src-tauri/src/lib.rs
git commit -m "feat(app): add connect-or-spawn daemon logic"
```

---

### Task 4: Rust backend — session config persistence

**Files:**
- Create: `app/src-tauri/src/config.rs`
- Modify: `app/src-tauri/src/lib.rs` (add `mod config;`)

**Interfaces:**
- Produces: `config::AppConfig { session_id: Option<String> }` (derives `Serialize`, `Deserialize`, `Default`, `PartialEq`), `config::config_path(config_dir: &Path) -> PathBuf`, `config::load(config_dir: &Path) -> anyhow::Result<AppConfig>`, `config::save(config_dir: &Path, config: &AppConfig) -> anyhow::Result<()>`. Task 5 uses `AppConfig`/`load`/`save` directly.

- [ ] **Step 1: Write the failing tests**

Create `app/src-tauri/src/config.rs`:

```rust
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub struct AppConfig {
    pub session_id: Option<String>,
}

pub fn config_path(config_dir: &Path) -> PathBuf {
    config_dir.join("config.json")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn load_returns_default_when_no_file_exists() {
        let dir = tempfile::tempdir().unwrap();
        let config = load(dir.path()).unwrap();
        assert_eq!(config, AppConfig::default());
        assert_eq!(config.session_id, None);
    }

    #[test]
    fn save_then_load_roundtrips() {
        let dir = tempfile::tempdir().unwrap();
        let config = AppConfig {
            session_id: Some("abc-123".to_string()),
        };
        save(dir.path(), &config).unwrap();

        let loaded = load(dir.path()).unwrap();
        assert_eq!(loaded, config);
    }

    #[test]
    fn save_creates_missing_parent_directories() {
        let dir = tempfile::tempdir().unwrap();
        let nested = dir.path().join("nested").join("config-dir");
        let config = AppConfig {
            session_id: Some("xyz".to_string()),
        };
        save(&nested, &config).unwrap();

        assert!(config_path(&nested).exists());
    }
}
```

Add `mod config;` to `app/src-tauri/src/lib.rs`.

If `app/src-tauri/Cargo.toml` doesn't already have `serde_json = "1"` under
`[dependencies]`, add it (a standard Tauri scaffold usually already includes
`serde`/`serde_json` for command serialization — check first).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test -p app config::`
Expected: FAIL to compile — `load` and `save` are not defined yet.

- [ ] **Step 3: Implement**

Add to `app/src-tauri/src/config.rs` (above the `#[cfg(test)]` block):

```rust
pub fn load(config_dir: &Path) -> anyhow::Result<AppConfig> {
    let path = config_path(config_dir);
    if !path.exists() {
        return Ok(AppConfig::default());
    }
    let contents = std::fs::read_to_string(&path)?;
    Ok(serde_json::from_str(&contents)?)
}

pub fn save(config_dir: &Path, config: &AppConfig) -> anyhow::Result<()> {
    std::fs::create_dir_all(config_dir)?;
    let path = config_path(config_dir);
    let contents = serde_json::to_string_pretty(config)?;
    std::fs::write(path, contents)?;
    Ok(())
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test -p app config::`
Expected: PASS — all 3 tests in `config::tests` green.

- [ ] **Step 5: Commit**

```bash
git add app/src-tauri/Cargo.toml app/src-tauri/src/config.rs app/src-tauri/src/lib.rs
git commit -m "feat(app): add session id config persistence"
```

---

### Task 5: Tauri commands + event wiring

**Files:**
- Create: `app/src-tauri/src/session.rs`
- Modify: `app/src-tauri/src/lib.rs` (register the setup hook and the two commands)

**Interfaces:**
- Consumes: `daemon::{connect_or_spawn, spawn_real_daemon}` (Task 3), `config::{AppConfig, load, save}` (Task 4), `protocol::{Request, Response, read_message, write_message, socket_path}` (Task 1) — the `protocol` dependency was already added to `app/src-tauri/Cargo.toml` in Task 3.
- Produces: `session::bootstrap(app_handle: AppHandle) -> anyhow::Result<()>` — connects, creates-or-reattaches, manages Tauri state, spawns the background response-reader thread. `#[tauri::command] session::write_input(data: String, ...) -> Result<(), String>`. `#[tauri::command] session::resize_session(cols: u16, rows: u16, ...) -> Result<(), String>`. `#[tauri::command] session::get_current_session(...) -> Option<String>` — lets the frontend ask for already-established state instead of relying solely on catching the one-shot `session-ready` event (see Step 3). Tauri events emitted: `session-ready` (payload: session id string), `pty-output` (payload: `(id, data)` tuple), `session-exited` (payload: `(id, exit_code)` tuple), `daemon-error` (payload: error message string). Task 6 (frontend) consumes the commands and the events by these exact names/payload shapes.

This task's exact Tauri API calls (`Manager`/`Emitter` traits, `app.path()`,
`State<T>`, the `#[tauri::command]` macro, `tauri::generate_handler!`) are
written against Tauri 2.x as currently understood. Check the Tauri version
`app/src-tauri/Cargo.toml` actually pins (from Task 2's scaffold) against
that version's docs if anything here fails to compile, and adapt names while
preserving every command/event name and payload shape listed above exactly
— Task 6 depends on them by name.

- [ ] **Step 1: Implement the bootstrap and commands**

Create `app/src-tauri/src/session.rs`:

```rust
use protocol::{read_message, write_message, Request, Response};
use std::io::BufReader;
use std::os::unix::net::UnixStream;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};

pub struct DaemonConnection {
    writer: Arc<Mutex<UnixStream>>,
}

pub struct ActiveSessionId(pub Mutex<Option<String>>);

fn send_request(writer: &Arc<Mutex<UnixStream>>, req: &Request) -> anyhow::Result<()> {
    write_message(&mut *writer.lock().unwrap(), req)
}

/// Connects to (or spawns) the daemon, creates or reattaches to the saved
/// session, registers Tauri-managed state for the commands below, and
/// spawns a background thread that relays every subsequent daemon message
/// to the frontend as a Tauri event. Called once from the app's setup hook.
pub fn bootstrap(app_handle: AppHandle) -> anyhow::Result<()> {
    let socket_path = protocol::socket_path();
    let stream = crate::daemon::connect_or_spawn(
        &socket_path,
        Duration::from_secs(3),
        crate::daemon::spawn_real_daemon,
    )?;

    let writer = Arc::new(Mutex::new(stream.try_clone()?));
    let reader_stream = stream;

    let config_dir = app_handle.path().app_config_dir()?;
    let config = crate::config::load(&config_dir)?;

    let session_id = match config.session_id {
        Some(id) => {
            send_request(&writer, &Request::Attach { id: id.clone() })?;
            id
        }
        None => {
            let home = std::env::var("HOME").unwrap_or_else(|_| "/".to_string());
            send_request(
                &writer,
                &Request::CreateSession {
                    workspace_path: home.clone(),
                    cwd: home,
                    command: None,
                },
            )?;
            // The daemon's very next reply to a CreateSession request on a
            // fresh connection is SessionCreated — read it synchronously
            // here, before the background loop below starts consuming
            // everything else on this stream.
            let mut boot_reader = BufReader::new(reader_stream.try_clone()?);
            let resp: Response = read_message(&mut boot_reader)?
                .ok_or_else(|| anyhow::anyhow!("daemon closed the connection during startup"))?;
            let id = match resp {
                Response::SessionCreated { id } => id,
                other => anyhow::bail!("expected SessionCreated, got {other:?}"),
            };
            crate::config::save(
                &config_dir,
                &crate::config::AppConfig { session_id: Some(id.clone()) },
            )?;
            send_request(&writer, &Request::Attach { id: id.clone() })?;
            id
        }
    };

    app_handle.manage(DaemonConnection { writer: Arc::clone(&writer) });
    app_handle.manage(ActiveSessionId(Mutex::new(Some(session_id.clone()))));
    app_handle.emit("session-ready", &session_id)?;

    let mut reader = BufReader::new(reader_stream);
    std::thread::spawn(move || loop {
        let resp: Option<Response> = match read_message(&mut reader) {
            Ok(r) => r,
            Err(e) => {
                let _ = app_handle.emit("daemon-error", e.to_string());
                break;
            }
        };
        let Some(resp) = resp else {
            let _ = app_handle.emit("daemon-error", "daemon closed the connection");
            break;
        };
        match resp {
            Response::Output { id, data } => {
                let _ = app_handle.emit("pty-output", (id, data));
            }
            Response::SessionExited { id, exit_code } => {
                let _ = app_handle.emit("session-exited", (id, exit_code));
            }
            Response::Error { message } => {
                let _ = app_handle.emit("daemon-error", message);
            }
            _ => {}
        }
    });

    Ok(())
}

#[tauri::command]
pub fn write_input(
    data: String,
    state: State<DaemonConnection>,
    session: State<ActiveSessionId>,
) -> Result<(), String> {
    let id = session
        .0
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| "no active session".to_string())?;
    send_request(&state.writer, &Request::WriteInput { id, data }).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn resize_session(
    cols: u16,
    rows: u16,
    state: State<DaemonConnection>,
    session: State<ActiveSessionId>,
) -> Result<(), String> {
    let id = session
        .0
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| "no active session".to_string())?;
    send_request(&state.writer, &Request::ResizeSession { id, cols, rows }).map_err(|e| e.to_string())
}
```

- [ ] **Step 2: Wire it into the app entry point**

Open `app/src-tauri/src/lib.rs` (the file with `run()`, generated by Task
2's scaffold). Add `mod session;` alongside the existing `mod daemon;`/
`mod config;`. Find the `tauri::Builder::default()` call and add a `.setup`
hook that runs `session::bootstrap` on a background thread (so a slow
daemon spawn doesn't block the window from appearing), plus register the two
commands:

```rust
tauri::Builder::default()
    .setup(|app| {
        let handle = app.handle().clone();
        std::thread::spawn(move || {
            if let Err(e) = session::bootstrap(handle.clone()) {
                let _ = handle.emit("daemon-error", e.to_string());
            }
        });
        Ok(())
    })
    .invoke_handler(tauri::generate_handler![session::write_input, session::resize_session])
    // ... keep whatever else the scaffold's Builder chain already had (plugins, etc.) ...
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
```

Merge this into the scaffold's existing `Builder` chain rather than
replacing it wholesale — keep any plugin registrations Task 2's scaffold
already added.

- [ ] **Step 3: Add a query command to close a startup race**

`bootstrap` runs on a background thread started directly in `.setup()` and
can complete — including emitting `session-ready` — before the frontend's
webview has finished loading and registered its event listener (a known
class of Tauri event-timing race: an event emitted before any listener is
attached is simply not delivered, it isn't buffered/replayed). Since
`bootstrap` reconnecting to an already-running daemon can be very fast, this
isn't a rare edge case — it's the common case. Add a small command so the
frontend can ask for the current state instead of relying solely on
catching a one-shot event:

```rust
#[tauri::command]
pub fn get_current_session(session: State<ActiveSessionId>) -> Option<String> {
    session.0.lock().unwrap().clone()
}
```

Add `session::get_current_session` to the `tauri::generate_handler![...]`
list in `app/src-tauri/src/lib.rs`, alongside `write_input` and
`resize_session`.

Task 6's frontend will register its `session-ready` listener *first*, then
call this command to check whether bootstrap already finished before that
listener existed — closing the race regardless of which order things
actually happen in.

- [ ] **Step 4: Verify it compiles**

Run: `cargo build -p app` (substitute the actual package name if different)
Expected: builds successfully. There is no automated test for this task —
`bootstrap` requires a running daemon and a live Tauri `AppHandle`, neither
of which is available in a unit test context. Behavior is verified manually
in Task 7 once the frontend (Task 6) exists to observe it through.

- [ ] **Step 5: Commit**

```bash
git add app/src-tauri/src/session.rs app/src-tauri/src/lib.rs
git commit -m "feat(app): wire Tauri commands and daemon event relay"
```

---

### Task 6: Svelte frontend — terminal component

**Files:**
- Modify: `app/package.json` (add `@xterm/xterm`, `@xterm/addon-fit`)
- Create: `app/src/Terminal.svelte` (or `app/src/lib/Terminal.svelte` — match whatever directory convention Task 2's scaffold used for `App.svelte`'s siblings; check before creating)
- Modify: `app/src/App.svelte`

**Interfaces:**
- Consumes exactly the Tauri commands/events Task 5 produces: `invoke("write_input", { data })`, `invoke("resize_session", { cols, rows })`, `invoke("get_current_session")` (returns `string | null`), and the events `session-ready` (string payload), `pty-output` (`[id, data]` tuple payload), `session-exited` (`[id, exitCode]` tuple payload), `daemon-error` (string payload).

The exact npm package names for xterm.js and the Tauri JS API import paths
below reflect the current `@xterm/*` scoped packages and Tauri 2.x's
`@tauri-apps/api/core` / `@tauri-apps/api/event` modules. If `npm install`
reports these packages don't exist under those names, check
https://www.npmjs.com for xterm.js's current package name (older code uses
unscoped `xterm`/`xterm-addon-fit`) and adjust the import statements
accordingly — the component logic itself doesn't change.

- [ ] **Step 1: Install xterm.js**

```bash
cd app && npm install @xterm/xterm @xterm/addon-fit
```

- [ ] **Step 2: Create the terminal component**

Create `app/src/Terminal.svelte` (adjust path per the note above):

```svelte
<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { invoke } from "@tauri-apps/api/core";
  import { listen, type UnlistenFn } from "@tauri-apps/api/event";
  import { Terminal } from "@xterm/xterm";
  import { FitAddon } from "@xterm/addon-fit";
  import "@xterm/xterm/css/xterm.css";

  let container: HTMLDivElement;
  let status: "connecting" | "ready" | "exited" | "error" = "connecting";
  let errorMessage = "";
  let exitCode: number | null = null;

  let term: Terminal;
  let fitAddon: FitAddon;
  let currentSessionId: string | null = null;
  const unlisteners: UnlistenFn[] = [];

  function sendResize() {
    if (!fitAddon) return;
    fitAddon.fit();
    const { cols, rows } = term;
    invoke("resize_session", { cols, rows }).catch(() => {});
  }

  function handleSessionReady(id: string) {
    if (status !== "connecting") return; // already handled — see below
    currentSessionId = id;
    status = "ready";
    // Input is only wired up once a session actually exists. Attaching
    // onData unconditionally at mount time, before any session exists, is
    // exactly the bug this restructuring exists to avoid: a keystroke that
    // arrives before the session is ready would fail server-side ("no
    // active session"), and naively treating that failure as a fatal error
    // would permanently mask a perfectly working terminal — the "error"
    // status leaving "connecting" would block this very function's own
    // guard above from ever running once the session genuinely becomes
    // ready.
    term.onData((data) => {
      invoke("write_input", { data }).catch((e) => {
        status = "error";
        errorMessage = String(e);
      });
    });
    sendResize();
  }

  onMount(async () => {
    term = new Terminal({ convertEol: true });
    fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(container);
    fitAddon.fit();

    window.addEventListener("resize", sendResize);

    // Register every listener before anything else async (all four in one
    // Promise.all, not sequential awaits), so none of them can miss an
    // event bootstrap() emits from its background thread before this
    // component finishes mounting — the same race class Task 5's fix round
    // closed for session-ready specifically, now closed as tightly as
    // practical for the other three too.
    const [unlistenReady, unlistenOutput, unlistenExited, unlistenError] =
      await Promise.all([
        listen<string>("session-ready", (event) => {
          handleSessionReady(event.payload);
        }),
        listen<[string, string]>("pty-output", (event) => {
          const [id, data] = event.payload;
          if (currentSessionId && id !== currentSessionId) return;
          term.write(data);
        }),
        listen<[string, number]>("session-exited", (event) => {
          const [id, code] = event.payload;
          if (currentSessionId && id !== currentSessionId) return;
          status = "exited";
          exitCode = code;
        }),
        listen<string>("daemon-error", (event) => {
          status = "error";
          errorMessage = event.payload;
        }),
      ]);
    unlisteners.push(unlistenReady, unlistenOutput, unlistenExited, unlistenError);

    // bootstrap() may have already finished — e.g. reattaching to an
    // already-running daemon, the common case — before the listeners above
    // went live. Catch that case too. Order-independent with the
    // session-ready listener thanks to handleSessionReady's own guard.
    invoke<string | null>("get_current_session")
      .then((id) => {
        if (id) handleSessionReady(id);
      })
      .catch(() => {});
  });

  onDestroy(() => {
    window.removeEventListener("resize", sendResize);
    unlisteners.forEach((unlisten) => unlisten());
    term?.dispose();
  });
</script>

<div class="terminal-page">
  {#if status === "connecting"}
    <div class="overlay">
      <p>Connecting…</p>
    </div>
  {:else if status === "error"}
    <div class="overlay">
      <p>Couldn't connect to the daemon.</p>
      <p class="detail">{errorMessage}</p>
    </div>
  {:else if status === "exited"}
    <div class="overlay">
      <p>Session exited (code {exitCode}).</p>
    </div>
  {/if}
  <div class="terminal-container" bind:this={container}></div>
</div>

<style>
  .terminal-page {
    width: 100vw;
    height: 100vh;
    margin: 0;
    background: #1e1e1e;
    position: relative;
  }
  .terminal-container {
    width: 100%;
    height: 100%;
  }
  .overlay {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    color: #eee;
    background: rgba(0, 0, 0, 0.6);
    z-index: 10;
    font-family: monospace;
  }
  .detail {
    opacity: 0.7;
    font-size: 0.85em;
  }
</style>
```

- [ ] **Step 3: Mount it as the whole app**

Replace the contents of `app/src/App.svelte` with:

```svelte
<script lang="ts">
  import Terminal from "./Terminal.svelte";
</script>

<Terminal />

<style>
  :global(html, body) {
    margin: 0;
    padding: 0;
    overflow: hidden;
  }
</style>
```

(Adjust the import path if Task 2's scaffold put components under
`./lib/`.)

- [ ] **Step 4: Type-check and build**

```bash
cd app && npm run check   # TypeScript/Svelte type checking, if the scaffold set this script up
cd app && npm run build   # production frontend build
```

Expected: both succeed with no errors. There is no automated behavioral
test for this component — full behavior (rendering, input, resize,
reattach) is verified manually in Task 7, which is the first point where
Tasks 5 and 6 run together against a real daemon.

- [ ] **Step 5: Commit**

```bash
git add app/package.json app/package-lock.json app/src/App.svelte app/src/Terminal.svelte
git commit -m "feat(app): add xterm.js terminal component"
```

---

### Task 7: End-to-end verification

**Files:**
- Modify: `app/src-tauri/tauri.conf.json` (only if window title/size from Task 2 need adjusting after seeing the real app)

**Interfaces:**
- Consumes: everything from Tasks 1-6. Produces nothing new — this task is the manual verification pass proving the whole milestone works together, mirroring how Milestone A's final task included a manual smoke test alongside its automated ones.

- [ ] **Step 1: Full workspace build**

```bash
cargo build --workspace
cd app && npm run build
```

Expected: everything compiles/builds cleanly together — `gavin-daemon`,
`protocol`, and the Tauri app's Rust backend as one Cargo workspace, plus the
frontend.

- [ ] **Step 2: Manual smoke test — first launch (auto-spawn + create)**

Make sure no daemon is currently running:

```bash
pgrep -f gavin-daemon && pkill gavin-daemon
rm -f ~/"Library/Application Support/gavin/daemon.sock"
```

(Leave `registry.sqlite` alone — deleting it would erase any sessions from
earlier manual testing during Milestone A. If you want a fully clean slate,
you may delete `~/Library/Application Support/gavin/` entirely instead.)

Delete any leftover app config from previous manual testing so this run
exercises the "no saved session" path:

```bash
rm -rf ~/"Library/Application Support/com.gavin.app"
```

(Adjust the path if Task 2's scaffold used a different bundle identifier.)

Launch the app:

```bash
cd app && npm run tauri dev
```

Confirm, in order:
- A window titled "gavin" opens.
- A terminal renders (not a blank/error screen).
- `pgrep -f gavin-daemon` (run in a separate terminal) now shows the daemon
  running — it was auto-spawned.
- Typing `echo milestone_b_smoke_test` and pressing Enter in the app's
  terminal shows `milestone_b_smoke_test` echoed back.

- [ ] **Step 3: Manual smoke test — resize**

With the app still open, resize its window (drag a corner). Type
`tput cols` before and after resizing and confirm the reported column count
actually changes — this proves `resize_session` is reaching the daemon and
the PTY's real dimensions are changing, not just the visual terminal.

- [ ] **Step 4: Manual smoke test — persistence across restart**

In the app's terminal, run:

```bash
export SMOKE_TEST_VAR=milestone_b
```

Quit the app (Cmd+Q or close the window). In a separate terminal, confirm
the daemon process is **still running**:

```bash
pgrep -f gavin-daemon
```

Expected: a PID is printed — the daemon outlived the app, as designed.

Relaunch:

```bash
cd app && npm run tauri dev
```

Confirm the terminal reattaches to the **same** shell rather than a fresh
one: run `echo $SMOKE_TEST_VAR` in the app's terminal and confirm it prints
`milestone_b` (a variable set before the app quit, only present if this is
the same underlying shell process, not a new one).

- [ ] **Step 5: Clean up and record results**

Stop the daemon:

```bash
pkill gavin-daemon
```

Write down the actual output/behavior observed at each step above in the
task report — not just "worked as expected," but what you actually typed
and actually saw, the same evidentiary standard used for Milestone A's
manual smoke test.

- [ ] **Step 6: Commit**

If Step 2 revealed the window title/size needed adjusting, commit that:

```bash
git add app/src-tauri/tauri.conf.json
git commit -m "chore(app): adjust window defaults after manual verification"
```

If nothing needed changing, this task has no code changes to commit — note
that in the report instead.

## Self-Review Notes

- **Spec coverage:** auto-spawn-or-connect (Task 3), session create-or-reattach with local persistence (Tasks 4-5), full-window xterm.js rendering with working input/output/resize (Task 6), error states for daemon-unreachable and session-exited (Tasks 5-6), and the manual verification the spec's own Testing section calls for, including the specific "relaunch reattaches to the same session" proof (Task 7). Workspaces/panes/git-status/notifications are correctly out of scope per the spec's Non-goals and aren't touched anywhere in this plan.
- **Placeholder scan:** no vague instructions — every Rust task has complete code. Tasks 2 and 6 have explicit, bounded uncertainty about third-party tool/package exactness (flagged in Global Constraints and inline), consistent with how Milestone A handled `portable-pty`, not a "figure it out later" gap.
- **Type consistency:** `Request`/`Response`/`read_message`/`write_message` (Task 1) are consumed identically in Tasks 3 and 5. `AppConfig`/`load`/`save` (Task 4) are consumed identically in Task 5. The four event names and their payload shapes, and the two command names and their argument shapes, are defined once in Task 5 and consumed by exact match in Task 6.
