use crate::config::Workspace;
use crate::layout::LayoutNode;
use protocol::{read_message, socket_path, write_message, Board, Column, Label, Request, Response};
use serde::Serialize;
use std::collections::HashMap;
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

/// Persists workspace/page state and session names together -- the only
/// two things that make up AppConfig. Centralizing this is what makes
/// the "always carry both along, or you'll silently reset one" rule
/// (see SessionNames's doc comment) structural rather than just
/// documented: every save site funnels through here instead of each
/// independently reconstructing the AppConfig literal.
fn persist_workspaces(
    config_dir: &std::path::Path,
    data: &WorkspacesData,
    session_names: HashMap<String, String>,
    file_tabs: HashMap<String, String>,
) -> anyhow::Result<()> {
    crate::config::save(
        config_dir,
        &crate::config::AppConfig {
            workspaces: data.workspaces.clone(),
            active_workspace_id: data.active_workspace_id.clone(),
            session_names,
            file_tabs,
        },
    )
}

/// Open file-viewer tabs (tab id -> absolute path). Independent
/// Tauri-managed state from `WorkspacesState`/`SessionNames`, but all
/// three persist into the same `AppConfig` -- every command that saves one
/// must read the others' current values too, or it would silently reset
/// them to empty on every save.
pub struct FileTabs(pub Mutex<HashMap<String, String>>);

#[cfg(test)]
mod workspaces_data_tests {
    use super::*;

    #[test]
    fn workspaces_data_serializes_to_the_camel_case_shape_the_frontend_expects() {
        let data = WorkspacesData { workspaces: vec![], active_workspace_id: None };
        let json = serde_json::to_value(&data).unwrap();
        assert_eq!(json, serde_json::json!({ "workspaces": [], "activeWorkspaceId": null }));
    }
}

/// Returns the current workspace/page state. An empty `WorkspacesData`
/// (`workspaces: []`) is a normal, permanent steady state -- e.g. every
/// user's first launch after this migration, before they've created any
/// workspace -- not a "not ready yet" signal. The only reliable
/// not-ready signal is this command's invoke rejecting outright (the
/// state hasn't been `manage`d yet, i.e. `bootstrap` hasn't finished) --
/// callers must not infer readiness from whether the payload is empty.
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
    file_tabs_state: State<FileTabs>,
) -> Result<(), String> {
    let data = WorkspacesData { workspaces, active_workspace_id };
    *state.0.lock().unwrap() = data.clone();
    let session_names = names_state.0.lock().unwrap().clone();
    let file_tabs = file_tabs_state.0.lock().unwrap().clone();
    let config_dir = app_handle.path().app_config_dir().map_err(|e| e.to_string())?;
    persist_workspaces(&config_dir, &data, session_names, file_tabs).map_err(|e| e.to_string())
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
    file_tabs_state: State<FileTabs>,
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
    let file_tabs = file_tabs_state.0.lock().unwrap().clone();
    let data = workspaces_state.0.lock().unwrap().clone();
    let config_dir = app_handle.path().app_config_dir().map_err(|e| e.to_string())?;
    persist_workspaces(&config_dir, &data, session_names, file_tabs).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_file_tabs(state: State<FileTabs>) -> HashMap<String, String> {
    state.0.lock().unwrap().clone()
}

/// Replaces the whole file-tab map. Whole-map rather than per-tab
/// (unlike `set_session_name`) because Part 2's callers always mutate it
/// alongside a pane-tree change they're already persisting wholesale --
/// there is no "rename one file tab" operation the way there is for
/// session names.
#[tauri::command]
pub fn set_file_tabs(
    file_tabs: HashMap<String, String>,
    app_handle: AppHandle,
    workspaces_state: State<WorkspacesState>,
    names_state: State<SessionNames>,
    file_tabs_state: State<FileTabs>,
) -> Result<(), String> {
    *file_tabs_state.0.lock().unwrap() = file_tabs.clone();
    let session_names = names_state.0.lock().unwrap().clone();
    let data = workspaces_state.0.lock().unwrap().clone();
    let config_dir = app_handle.path().app_config_dir().map_err(|e| e.to_string())?;
    persist_workspaces(&config_dir, &data, session_names, file_tabs).map_err(|e| e.to_string())
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
    all_sessions: &HashMap<String, protocol::SessionSummary>,
) -> anyhow::Result<()> {
    match node {
        LayoutNode::Leaf { tabs, .. } => {
            for id in tabs.iter_mut() {
                let is_valid = all_sessions.get(id.as_str()).is_some_and(|s| s.status != "exited");
                if !is_valid {
                    let last_known_cwd = all_sessions.get(id.as_str()).map(|s| s.cwd.as_str());
                    *id = create_fresh_session(command_conn, last_known_cwd, None)?;
                }
            }
            Ok(())
        }
        LayoutNode::Split { children, .. } => {
            for child in children.iter_mut() {
                resolve_sessions(child, command_conn, all_sessions)?;
            }
            Ok(())
        }
    }
}

/// Fetches the full session list once -- every record, exited ones
/// included -- keyed by id. Called at most once per bootstrap, regardless
/// of how many pages/workspaces need reconciling against it. Exited
/// records are kept (not filtered out here) so `resolve_sessions` can look
/// up an exited session's own last-known `cwd` before replacing it, rather
/// than falling back to `$HOME`.
fn list_valid_session_ids(
    command_conn: &Mutex<UnixStream>,
) -> anyhow::Result<HashMap<String, protocol::SessionSummary>> {
    let resp = send_command(command_conn, &Request::ListSessions)?;
    match resp {
        Response::SessionList { sessions } => {
            Ok(sessions.into_iter().map(|s| (s.id.clone(), s)).collect())
        }
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
    let all_sessions = list_valid_session_ids(command_conn)?;
    for workspace in workspaces.iter_mut() {
        for page in workspace.pages.iter_mut() {
            resolve_sessions(&mut page.layout, command_conn, &all_sessions)?;
        }
    }
    Ok(())
}

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

    /// Like `fake_daemon_replying_with`, but also captures every request
    /// the fake daemon receives, in order, into the returned `Vec` (shared
    /// via `Arc<Mutex<...>>` since the daemon thread and the test both
    /// need it) -- for tests that need to assert not just the final
    /// resolved state, but specifically what was SENT to get there (e.g.
    /// which `cwd` a `CreateSession` request carried).
    pub fn fake_daemon_capturing_requests(
        responses: Vec<Response>,
    ) -> (UnixStream, Arc<Mutex<Vec<Request>>>, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let socket_path = dir.path().join("fake.sock");
        let listener = UnixListener::bind(&socket_path).unwrap();
        let captured = Arc::new(Mutex::new(Vec::new()));
        let captured_clone = Arc::clone(&captured);

        std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            for response in responses {
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let req: Request = read_message(&mut reader).unwrap().unwrap();
                captured_clone.lock().unwrap().push(req);
                write_message(&mut stream, &response).unwrap();
            }
        });

        let client = UnixStream::connect(&socket_path).unwrap();
        (client, captured, dir)
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
    use super::test_support::fake_daemon_capturing_requests;
    use super::test_support::fake_daemon_replying_with;
    use super::*;
    use crate::config::Page;

    fn leaf(tabs: &[&str]) -> LayoutNode {
        LayoutNode::Leaf { tabs: tabs.iter().map(|s| s.to_string()).collect(), active_tab_index: 0 }
    }

    fn page(id: &str, layout: LayoutNode) -> Page {
        Page { id: id.to_string(), name: id.to_string(), layout, focused_session_id: None }
    }

    fn workspace(id: &str, pages: Vec<Page>) -> Workspace {
        Workspace { id: id.to_string(), name: id.to_string(), pages, active_page_id: None, active_view: None }
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

    fn exited_session(id: &str, cwd: &str) -> protocol::SessionSummary {
        protocol::SessionSummary {
            id: id.to_string(),
            workspace_path: cwd.to_string(),
            cwd: cwd.to_string(),
            status: "exited".to_string(),
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

    #[test]
    fn replaces_an_exited_session_at_its_own_last_known_cwd_not_home() {
        let (client, captured, _dir) = fake_daemon_capturing_requests(vec![
            Response::SessionList {
                sessions: vec![exited_session("exited-1", "/Users/alice/project")],
            },
            Response::SessionCreated { id: "fresh-a".to_string() },
        ]);
        let conn = Mutex::new(client);
        let mut workspaces = vec![workspace("ws-1", vec![page("page-1", leaf(&["exited-1"]))])];

        resolve_workspaces(&mut workspaces, &conn).unwrap();

        assert_eq!(workspaces[0].pages[0].layout, leaf(&["fresh-a"]));
        let requests = captured.lock().unwrap();
        match &requests[1] {
            Request::CreateSession { cwd, workspace_path, .. } => {
                assert_eq!(cwd, "/Users/alice/project");
                assert_eq!(workspace_path, "/Users/alice/project");
            }
            other => panic!("expected the second request to be CreateSession, got {other:?}"),
        }
    }

    #[test]
    fn falls_back_to_home_only_when_the_id_has_no_registry_record_at_all() {
        let (client, captured, _dir) = fake_daemon_capturing_requests(vec![
            Response::SessionList { sessions: vec![] },
            Response::SessionCreated { id: "fresh-b".to_string() },
        ]);
        let conn = Mutex::new(client);
        let mut workspaces = vec![workspace("ws-1", vec![page("page-1", leaf(&["unknown-id"]))])];

        resolve_workspaces(&mut workspaces, &conn).unwrap();

        assert_eq!(workspaces[0].pages[0].layout, leaf(&["fresh-b"]));
        let requests = captured.lock().unwrap();
        let home = std::env::var("HOME").unwrap();
        match &requests[1] {
            Request::CreateSession { cwd, .. } => assert_eq!(cwd, &home),
            other => panic!("expected the second request to be CreateSession, got {other:?}"),
        }
    }

    #[test]
    fn falls_back_to_home_when_the_last_known_cwd_is_rejected_instead_of_failing_the_whole_bootstrap() {
        // The exact scenario recover()'s own workspace_path-missing fix
        // produces: an exited record whose last-known cwd no longer
        // exists, so the daemon rejects the first CreateSession attempt.
        // Before the fallback, this Error propagated all the way up
        // through resolve_workspaces -- this test is what would have
        // failed (via the unwrap() below) had that regression shipped.
        let (client, captured, _dir) = fake_daemon_capturing_requests(vec![
            Response::SessionList {
                sessions: vec![exited_session("exited-2", "/definitely/does/not/exist/anywhere")],
            },
            Response::Error { message: "cwd does not exist or is not a directory".to_string() },
            Response::SessionCreated { id: "fresh-c".to_string() },
        ]);
        let conn = Mutex::new(client);
        let mut workspaces = vec![workspace("ws-1", vec![page("page-1", leaf(&["exited-2"]))])];

        resolve_workspaces(&mut workspaces, &conn).unwrap();

        assert_eq!(workspaces[0].pages[0].layout, leaf(&["fresh-c"]));
        let requests = captured.lock().unwrap();
        assert_eq!(requests.len(), 3, "expected the rejected attempt plus a fallback retry at $HOME");
        let home = std::env::var("HOME").unwrap();
        match &requests[1] {
            Request::CreateSession { cwd, .. } => assert_eq!(cwd, "/definitely/does/not/exist/anywhere"),
            other => panic!("expected the second request to be the rejected CreateSession, got {other:?}"),
        }
        match &requests[2] {
            Request::CreateSession { cwd, .. } => assert_eq!(cwd, &home),
            other => panic!("expected the third request to be the $HOME fallback, got {other:?}"),
        }
    }

    #[test]
    fn create_fresh_session_with_no_command_sends_none() {
        let (client, captured, _dir) =
            fake_daemon_capturing_requests(vec![Response::SessionCreated { id: "s1".to_string() }]);
        let conn = Mutex::new(client);

        create_fresh_session(&conn, Some("/tmp"), None).unwrap();

        let requests = captured.lock().unwrap();
        match &requests[0] {
            Request::CreateSession { command, .. } => assert_eq!(command, &None),
            other => panic!("expected CreateSession, got {other:?}"),
        }
    }

    #[test]
    fn create_fresh_session_threads_an_explicit_command_through() {
        let (client, captured, _dir) =
            fake_daemon_capturing_requests(vec![Response::SessionCreated { id: "s1".to_string() }]);
        let conn = Mutex::new(client);

        create_fresh_session(&conn, Some("/tmp"), Some("npm test")).unwrap();

        let requests = captured.lock().unwrap();
        match &requests[0] {
            Request::CreateSession { command, .. } => assert_eq!(command, &Some("npm test".to_string())),
            other => panic!("expected CreateSession, got {other:?}"),
        }
    }
}

/// Connects to (or spawns) the daemon over two connections — one for the
/// continuous Attach/Output relay, one for one-shot request/response
/// commands (see CommandConnection's doc comment) — resolves every page of
/// every saved workspace (or does nothing if none are saved), attaches every
/// session it references, registers Tauri-managed state for the commands
/// below, and spawns a background thread that relays every subsequent daemon
/// message to the frontend as a Tauri event. Called once from the app's setup
/// hook.
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
    let file_tabs = config.file_tabs;

    let mut workspaces = config.workspaces;
    // A truly fresh install (no config.json yet, or one from before this
    // feature) has zero workspaces -- in that case the app should open
    // directly into the newly-created Unfiled workspace rather than the
    // usual "no workspace, create one" empty state. An install that
    // already has real workspaces keeps whatever was active, and Unfiled
    // is just silently added to the list without disturbing it.
    let had_no_workspaces = workspaces.is_empty();
    if !workspaces.iter().any(|w| w.id == crate::config::UNFILED_WORKSPACE_ID) {
        workspaces.insert(
            0,
            Workspace {
                id: crate::config::UNFILED_WORKSPACE_ID.to_string(),
                name: "Unfiled".to_string(),
                pages: vec![],
                active_page_id: None,
                active_view: None,
            },
        );
    }
    resolve_workspaces(&mut workspaces, &command_conn)?;
    let active_workspace_id = if had_no_workspaces {
        Some(crate::config::UNFILED_WORKSPACE_ID.to_string())
    } else {
        config.active_workspace_id
    };
    let workspaces_data = WorkspacesData { workspaces, active_workspace_id };
    persist_workspaces(&config_dir, &workspaces_data, session_names.clone(), file_tabs.clone())?;

    let all_session_ids: Vec<String> = workspaces_data
        .workspaces
        .iter()
        .flat_map(|w| w.pages.iter())
        .flat_map(|p| p.layout.all_session_ids())
        .collect();
    for id in all_session_ids {
        send_request(&writer, &Request::Attach { id })?;
    }

    app_handle.manage(DaemonConnection { writer: Arc::clone(&writer) });
    app_handle.manage(CommandConnection(command_conn));
    app_handle.manage(WorkspacesState(Mutex::new(workspaces_data.clone())));
    app_handle.manage(SessionNames(Mutex::new(session_names)));
    app_handle.manage(FileTabs(Mutex::new(file_tabs)));
    app_handle.emit("workspaces-ready", &workspaces_data)?;

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
                Response::StatusChanged { id, status } => {
                    let _ = reader_app_handle.emit("session-status-changed", (id, status));
                }
                Response::GitStatusChanged { id, status } => {
                    let _ = reader_app_handle.emit("git-status-changed", (id, status));
                }
                Response::SessionRestored { id } => {
                    let _ = reader_app_handle.emit("session-restored", id);
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

/// Shared by the create_session command below and resolve_sessions's
/// per-tab fallback (via resolve_workspaces) -- "create a fresh session at
/// the given cwd (or $HOME when there is none), and return its id."
///
/// A `cwd` from a stale registry record (resolve_sessions's last-known-cwd
/// case) can point at a directory that no longer exists -- exactly the
/// scenario recover() itself marks Exited when a session's workspace_path
/// vanishes. The daemon's own create_session rejects a non-directory cwd,
/// and that Error would otherwise propagate all the way up through
/// resolve_workspaces into bootstrap(), which turns any Err into an
/// app-wide "daemon-error" event -- the exact whole-app-blanking failure
/// mode this milestone exists to avoid, except now hit on every
/// subsequent launch (persist_workspaces never runs to fix up the config,
/// since it's gated on resolve_workspaces succeeding). So a rejected
/// non-$HOME target falls back to $HOME once before giving up for real.
fn create_fresh_session(
    command_conn: &Mutex<UnixStream>,
    cwd: Option<&str>,
    command: Option<&str>,
) -> anyhow::Result<String> {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/".to_string());
    let target = cwd.map(str::to_string).unwrap_or_else(|| home.clone());
    let command = command.map(str::to_string);

    let resp = send_command(
        command_conn,
        &Request::CreateSession { workspace_path: target.clone(), cwd: target.clone(), command: command.clone() },
    )?;
    match resp {
        Response::SessionCreated { id } => return Ok(id),
        Response::Error { message } if target != home => {
            eprintln!("failed to recreate session at last-known cwd {target}, falling back to $HOME: {message}");
        }
        other => anyhow::bail!("expected SessionCreated, got {other:?}"),
    }

    let resp = send_command(
        command_conn,
        &Request::CreateSession { workspace_path: home.clone(), cwd: home.clone(), command },
    )?;
    match resp {
        Response::SessionCreated { id } => Ok(id),
        other => anyhow::bail!("expected SessionCreated, got {other:?}"),
    }
}

#[tauri::command]
pub fn create_session(
    cwd: Option<String>,
    command: Option<String>,
    command_state: State<CommandConnection>,
    daemon_state: State<DaemonConnection>,
) -> Result<String, String> {
    let id = create_fresh_session(&command_state.0, cwd.as_deref(), command.as_deref())
        .map_err(|e| e.to_string())?;
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

fn get_board_impl(command_conn: &Mutex<UnixStream>, workspace_id: String) -> anyhow::Result<Board> {
    let resp = send_command(command_conn, &Request::GetBoard { workspace_id })?;
    match resp {
        Response::Board { columns, labels } => Ok(Board { columns, labels }),
        other => anyhow::bail!("expected Board, got {other:?}"),
    }
}

#[tauri::command]
pub fn get_board(workspace_id: String, state: State<CommandConnection>) -> Result<Board, String> {
    get_board_impl(&state.0, workspace_id).map_err(|e| e.to_string())
}

fn set_board_impl(
    command_conn: &Mutex<UnixStream>,
    workspace_id: String,
    columns: Vec<Column>,
    labels: Vec<Label>,
) -> anyhow::Result<()> {
    let resp = send_command(command_conn, &Request::SetBoard { workspace_id, columns, labels })?;
    match resp {
        Response::Ok => Ok(()),
        other => anyhow::bail!("expected Ok, got {other:?}"),
    }
}

#[tauri::command]
pub fn set_board(
    workspace_id: String,
    columns: Vec<Column>,
    labels: Vec<Label>,
    state: State<CommandConnection>,
) -> Result<(), String> {
    set_board_impl(&state.0, workspace_id, columns, labels).map_err(|e| e.to_string())
}

fn delete_board_impl(command_conn: &Mutex<UnixStream>, workspace_id: String) -> anyhow::Result<()> {
    let resp = send_command(command_conn, &Request::DeleteBoard { workspace_id })?;
    match resp {
        Response::Ok => Ok(()),
        other => anyhow::bail!("expected Ok, got {other:?}"),
    }
}

#[tauri::command]
pub fn delete_board(workspace_id: String, state: State<CommandConnection>) -> Result<(), String> {
    delete_board_impl(&state.0, workspace_id).map_err(|e| e.to_string())
}

#[cfg(test)]
mod kanban_command_tests {
    use super::test_support::{fake_daemon_capturing_requests, fake_daemon_replying_with};
    use super::*;

    #[test]
    fn get_board_impl_returns_the_boards_columns_and_labels() {
        let (client, _dir) = fake_daemon_replying_with(vec![Response::Board {
            columns: vec![Column { id: "c1".to_string(), name: "To Do".to_string(), position: 0, cards: vec![] }],
            labels: vec![Label { id: "l1".to_string(), name: "urgent".to_string(), color: "#f00".to_string() }],
        }]);
        let conn = Mutex::new(client);

        let board = get_board_impl(&conn, "ws-1".to_string()).unwrap();

        assert_eq!(board.columns.len(), 1);
        assert_eq!(board.columns[0].name, "To Do");
        assert_eq!(board.labels.len(), 1);
    }

    #[test]
    fn get_board_impl_sends_the_given_workspace_id() {
        let (client, captured, _dir) =
            fake_daemon_capturing_requests(vec![Response::Board { columns: vec![], labels: vec![] }]);
        let conn = Mutex::new(client);

        get_board_impl(&conn, "ws-42".to_string()).unwrap();

        let requests = captured.lock().unwrap();
        match &requests[0] {
            Request::GetBoard { workspace_id } => assert_eq!(workspace_id, "ws-42"),
            other => panic!("expected GetBoard, got {other:?}"),
        }
    }

    #[test]
    fn get_board_impl_propagates_a_daemon_error() {
        let (client, _dir) =
            fake_daemon_replying_with(vec![Response::Error { message: "board fetch failed".to_string() }]);
        let conn = Mutex::new(client);

        let result = get_board_impl(&conn, "ws-1".to_string());

        assert!(result.is_err());
    }

    #[test]
    fn set_board_impl_sends_the_given_columns_and_labels() {
        let (client, captured, _dir) = fake_daemon_capturing_requests(vec![Response::Ok]);
        let conn = Mutex::new(client);
        let columns = vec![Column { id: "c1".to_string(), name: "Only".to_string(), position: 0, cards: vec![] }];

        set_board_impl(&conn, "ws-1".to_string(), columns.clone(), vec![]).unwrap();

        let requests = captured.lock().unwrap();
        match &requests[0] {
            Request::SetBoard { workspace_id, columns: sent_columns, .. } => {
                assert_eq!(workspace_id, "ws-1");
                assert_eq!(sent_columns.len(), 1);
                assert_eq!(sent_columns[0].name, "Only");
            }
            other => panic!("expected SetBoard, got {other:?}"),
        }
    }

    #[test]
    fn set_board_impl_propagates_a_daemon_error() {
        let (client, _dir) =
            fake_daemon_replying_with(vec![Response::Error { message: "board save failed".to_string() }]);
        let conn = Mutex::new(client);

        let result = set_board_impl(&conn, "ws-1".to_string(), vec![], vec![]);

        assert!(result.is_err());
    }

    #[test]
    fn delete_board_impl_sends_the_given_workspace_id() {
        let (client, captured, _dir) = fake_daemon_capturing_requests(vec![Response::Ok]);
        let conn = Mutex::new(client);

        delete_board_impl(&conn, "ws-1".to_string()).unwrap();

        let requests = captured.lock().unwrap();
        match &requests[0] {
            Request::DeleteBoard { workspace_id } => assert_eq!(workspace_id, "ws-1"),
            other => panic!("expected DeleteBoard, got {other:?}"),
        }
    }
}
