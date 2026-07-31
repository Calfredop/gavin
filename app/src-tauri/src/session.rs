use crate::layout::LayoutNode;
use protocol::{read_message, socket_path, write_message, Request, Response};
use std::collections::{HashMap, HashSet};
use std::io::BufReader;
use std::os::unix::net::UnixStream;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State};

pub struct DaemonConnection {
    writer: Arc<Mutex<UnixStream>>,
}

pub struct CurrentLayout(pub Mutex<LayoutNode>);

/// User-assigned session display names, keyed by session id. Independent
/// Tauri-managed state from `CurrentLayout`, but both persist into the
/// same `AppConfig` -- every command that saves one must read the other's
/// current value too (see `set_layout`/`set_session_name`), or it would
/// silently reset the other field to empty on every save.
pub struct SessionNames(pub Mutex<HashMap<String, String>>);

#[tauri::command]
pub fn get_current_layout(state: State<CurrentLayout>) -> LayoutNode {
    state.0.lock().unwrap().clone()
}

#[tauri::command]
pub fn set_layout(
    layout: LayoutNode,
    app_handle: AppHandle,
    state: State<CurrentLayout>,
    names_state: State<SessionNames>,
) -> Result<(), String> {
    *state.0.lock().unwrap() = layout.clone();
    let session_names = names_state.0.lock().unwrap().clone();
    let config_dir = app_handle.path().app_config_dir().map_err(|e| e.to_string())?;
    crate::config::save(
        &config_dir,
        &crate::config::AppConfig { layout: Some(layout), session_names, ..Default::default() },
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
    layout_state: State<CurrentLayout>,
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
    let layout = layout_state.0.lock().unwrap().clone();
    let config_dir = app_handle.path().app_config_dir().map_err(|e| e.to_string())?;
    crate::config::save(
        &config_dir,
        &crate::config::AppConfig { layout: Some(layout), session_names, ..Default::default() },
    )
    .map_err(|e| e.to_string())
}

/// Set once (`AtomicBool`, not a one-shot channel — a one-shot signal sent
/// before anyone is waiting on it would be lost) when the frontend confirms
/// its event listeners are registered. Managed via `Builder::manage` before
/// `.setup()` runs (not inside it — window creation can precede the setup
/// closure), so `signal_frontend_ready` is always valid to call.
pub struct FrontendReady(pub std::sync::atomic::AtomicBool);

/// Set if `bootstrap` fails before it can emit `daemon-error` to a listener
/// that might not exist yet. Same eager-`manage` rationale as `FrontendReady`.
pub struct BootstrapError(pub Mutex<Option<String>>);

#[tauri::command]
pub fn signal_frontend_ready(state: State<FrontendReady>) {
    state.0.store(true, std::sync::atomic::Ordering::SeqCst);
}

#[tauri::command]
pub fn get_bootstrap_error(state: State<BootstrapError>) -> Option<String> {
    state.0.lock().unwrap().clone()
}

fn send_request(writer: &Arc<Mutex<UnixStream>>, req: &Request) -> anyhow::Result<()> {
    write_message(&mut *writer.lock().unwrap(), req)
}

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
    let session_names = config.session_names;

    let layout = resolve_layout(&command_conn, config.layout)?;
    crate::config::save(
        &config_dir,
        &crate::config::AppConfig { layout: Some(layout.clone()), session_names: session_names.clone(), ..Default::default() },
    )?;

    for id in layout.all_session_ids() {
        send_request(&writer, &Request::Attach { id })?;
    }

    app_handle.manage(DaemonConnection { writer: Arc::clone(&writer) });
    app_handle.manage(CommandConnection(command_conn));
    app_handle.manage(CurrentLayout(Mutex::new(layout.clone())));
    app_handle.manage(SessionNames(Mutex::new(session_names)));
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
                Response::CwdChanged { id, cwd } => {
                    let _ = reader_app_handle.emit("cwd-changed", (id, cwd));
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

/// Shared by the create_session command below and, starting in Task 3,
/// resolve_layout's per-tab fallback for stale/exited saved session ids —
/// defined once here rather than duplicated, since both are exactly
/// "create a fresh session at $HOME and return its id."
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

#[tauri::command]
pub fn create_session(
    command_state: State<CommandConnection>,
    daemon_state: State<DaemonConnection>,
) -> Result<String, String> {
    let id = create_fresh_session(&command_state.0).map_err(|e| e.to_string())?;
    send_request(&daemon_state.writer, &Request::Attach { id: id.clone() })
        .map_err(|e| e.to_string())?;
    Ok(id)
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
