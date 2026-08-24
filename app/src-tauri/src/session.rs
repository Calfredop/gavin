use crate::config::Workspace;
use crate::layout::LayoutNode;
use protocol::{
    read_message, socket_path, write_message, Board, Column, ConflictNote, Label, Orchestration, Rail,
    Request, Response,
};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::io::BufReader;
use std::os::unix::net::UnixStream;
use std::path::Path;
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
/// Tauri-managed state from `WorkspacesState`/`FileTabs`, but all three
/// persist into the same `AppConfig` -- every command that saves one must
/// read the others' current values too (see `set_workspaces_state`/
/// `set_session_name`/`set_file_tabs`), or it would silently reset the
/// other fields to empty on every save.
pub struct SessionNames(pub Mutex<HashMap<String, String>>);

/// Persists workspace/page state, session names, and file tabs together --
/// the three things that make up AppConfig. Centralizing this is what
/// makes the "always carry the others along, or you'll silently reset one"
/// rule (see SessionNames's doc comment) structural rather than just
/// documented: every save site funnels through here instead of each
/// independently reconstructing the AppConfig literal.
fn persist_workspaces(
    config_dir: &std::path::Path,
    data: &WorkspacesData,
    session_names: HashMap<String, String>,
    file_tabs: HashMap<String, String>,
    board_tabs: HashMap<String, crate::config::BoardTabRecord>,
    theme: Option<String>,
) -> anyhow::Result<()> {
    crate::config::save(
        config_dir,
        &crate::config::AppConfig {
            workspaces: data.workspaces.clone(),
            active_workspace_id: data.active_workspace_id.clone(),
            session_names,
            file_tabs,
            board_tabs,
            theme,
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

    /// The regression D48 exists to prevent: theme is a fourth field on
    /// AppConfig, so a save that reconstructs the struct without carrying
    /// it would silently reset it -- exactly what already bit
    /// session_names and file_tabs.
    #[test]
    fn persist_workspaces_carries_theme_through() {
        let dir = tempfile::tempdir().unwrap();
        let data = WorkspacesData { workspaces: vec![], active_workspace_id: None };
        persist_workspaces(
            dir.path(),
            &data,
            HashMap::new(),
            HashMap::new(),
            HashMap::new(),
            Some("light".to_string()),
        )
        .unwrap();
        assert_eq!(crate::config::load(dir.path()).unwrap().theme, Some("light".to_string()));
    }
}

// These tests run under debug_assertions (cargo test defaults to the dev
// profile), so they cover the dev arm of the smoke-test reconciliation;
// the release strip arm is compile-gated on the same single cfg! condition.
#[cfg(test)]
mod smoketest_tests {
    use super::*;

    #[test]
    fn reconcile_appends_the_smoketest_workspace_once() {
        let mut workspaces = vec![];
        reconcile_smoketest_workspace(&mut workspaces);
        assert_eq!(workspaces.len(), 1);
        assert_eq!(workspaces[0].id, crate::config::SMOKETEST_WORKSPACE_ID);
        assert_eq!(workspaces[0].name, "Smoke Test");
        reconcile_smoketest_workspace(&mut workspaces);
        assert_eq!(workspaces.len(), 1, "must not duplicate on later launches");
    }

    #[test]
    fn reconcile_preserves_an_existing_smoketest_workspace_and_its_root() {
        let mut workspaces = vec![Workspace {
            id: crate::config::SMOKETEST_WORKSPACE_ID.to_string(),
            name: "Smoke Test".to_string(),
            pages: vec![],
            active_page_id: None,
            active_view: None,
            hub_view: None,
            root_path: Some("/tmp/scratch".to_string()),
            main_session_id: None,
            legacy_agent_command: None,
            color: None,
            notify_needs_input: true,
            notify_finished: true,
            git_view: None,
        }];
        reconcile_smoketest_workspace(&mut workspaces);
        assert_eq!(workspaces.len(), 1);
        assert_eq!(workspaces[0].root_path.as_deref(), Some("/tmp/scratch"));
    }

    /// True when the `---`-delimited block declares `key:`.
    fn frontmatter_has_key(body: &str, key: &str) -> bool {
        body.lines()
            .skip(1)
            .take_while(|l| *l != "---")
            .any(|l| l.trim_start().starts_with(&format!("{key}:")))
    }

    // A typo like "In progress" would still seed fine, but the board
    // would invent an auto column for it and three checklist items would
    // quietly test the wrong thing. Pin the exact statuses.
    #[test]
    fn seeded_plans_use_only_the_default_columns_plus_one_deliberate_stray() {
        let mut statuses: Vec<&str> = SEED_FILES
            .iter()
            .filter(|(rel, _)| rel.contains("/plans/"))
            .filter_map(|(_, body)| {
                body.lines().find_map(|l| l.strip_prefix("status: ")).map(str::trim)
            })
            .collect();
        statuses.sort_unstable();
        assert_eq!(
            statuses,
            [
                "Done",
                "In Progress", // auth-rework, the nesting parent
                "In Progress",
                "In Progress",
                "In Progress",
                "In Progress",
                "Shipped", // the deliberate auto-column card
                "To Do",
                "To Do",
                "To Do",
                "To Do",
                "To Do", // auth-key-rotation, freed from its parent
                "To Do", // scratch-note
            ]
        );
        // The two genuinely nested cards carry no status at all -- that is
        // what puts them inside the parent card instead of a column.
        let nested: Vec<&str> = SEED_FILES
            .iter()
            .filter(|(rel, body)| rel.contains("/plans/") && body.contains("parent: auth-rework.md"))
            // Frontmatter only: the body prose legitimately mentions
            // statuses, and a substring match over the whole file would
            // read that as a key.
            .filter(|(_, body)| !frontmatter_has_key(body, "status"))
            .map(|(rel, _)| *rel)
            .collect();
        assert_eq!(
            nested,
            [".gavin-root/plans/auth-token-refresh.md", ".gavin-root/plans/auth-cookie-flags.md"]
        );
    }

    #[test]
    fn seed_writes_fixtures_into_an_initialized_root_and_rejects_a_bare_one() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_string_lossy().to_string();

        // Bare folder: refused with a pointer to the init flow.
        assert!(seed_smoke_test_data(root.clone()).is_err());

        std::fs::create_dir_all(dir.path().join(".gavin-root")).unwrap();
        seed_smoke_test_data(root.clone()).unwrap();
        for (rel, _) in SEED_FILES {
            assert!(dir.path().join(rel).is_file(), "{rel} was not written");
        }
        // The over-cap file must actually exceed the cap, or the
        // "no Edit mode for a big file" item silently tests nothing.
        let big = dir.path().join("big.log");
        assert!(
            std::fs::metadata(&big).unwrap().len() as usize > crate::fileviewer::MAX_VIEWER_FILE_BYTES
        );

        // Idempotent: a re-seed (the reset) succeeds and restores content.
        std::fs::write(dir.path().join(".gavin-root").join("plans").join("demo.md"), "mangled").unwrap();
        seed_smoke_test_data(root).unwrap();
        let demo =
            std::fs::read_to_string(dir.path().join(".gavin-root").join("plans").join("demo.md")).unwrap();
        assert!(demo.starts_with("---\ntitle: Demo plan\nstatus: To Do\npriority: high\n---\n"));
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
    board_tabs_state: State<BoardTabs>,
    theme_state: State<ThemePref>,
) -> Result<(), String> {
    let data = WorkspacesData { workspaces, active_workspace_id };
    *state.0.lock().unwrap() = data.clone();
    let session_names = names_state.0.lock().unwrap().clone();
    let file_tabs = file_tabs_state.0.lock().unwrap().clone();
    let board_tabs = board_tabs_state.0.lock().unwrap().clone();
    let config_dir = app_handle.path().app_config_dir().map_err(|e| e.to_string())?;
    let theme = theme_state.0.lock().unwrap().clone();
    persist_workspaces(&config_dir, &data, session_names, file_tabs, board_tabs, theme)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_theme_pref(state: State<ThemePref>) -> Option<String> {
    state.0.lock().unwrap().clone()
}

#[tauri::command]
pub fn set_theme_pref(
    theme: Option<String>,
    app_handle: AppHandle,
    state: State<WorkspacesState>,
    names_state: State<SessionNames>,
    file_tabs_state: State<FileTabs>,
    board_tabs_state: State<BoardTabs>,
    theme_state: State<ThemePref>,
) -> Result<(), String> {
    // An absent or blank value clears the override back to System rather
    // than persisting an empty string -- there's no separate "clear"
    // command, the same shape as set_session_name.
    let theme = {
        let mut current = theme_state.0.lock().unwrap();
        *current = theme.filter(|t| !t.trim().is_empty());
        current.clone()
    };
    let data = state.0.lock().unwrap().clone();
    let session_names = names_state.0.lock().unwrap().clone();
    let file_tabs = file_tabs_state.0.lock().unwrap().clone();
    let board_tabs = board_tabs_state.0.lock().unwrap().clone();
    let config_dir = app_handle.path().app_config_dir().map_err(|e| e.to_string())?;
    persist_workspaces(&config_dir, &data, session_names, file_tabs, board_tabs, theme)
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
    file_tabs_state: State<FileTabs>,
    board_tabs_state: State<BoardTabs>,
    theme_state: State<ThemePref>,
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
    let board_tabs = board_tabs_state.0.lock().unwrap().clone();
    let data = workspaces_state.0.lock().unwrap().clone();
    let config_dir = app_handle.path().app_config_dir().map_err(|e| e.to_string())?;
    let theme = theme_state.0.lock().unwrap().clone();
    persist_workspaces(&config_dir, &data, session_names, file_tabs, board_tabs, theme)
        .map_err(|e| e.to_string())
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
    board_tabs_state: State<BoardTabs>,
    theme_state: State<ThemePref>,
) -> Result<(), String> {
    *file_tabs_state.0.lock().unwrap() = file_tabs.clone();
    let session_names = names_state.0.lock().unwrap().clone();
    let board_tabs = board_tabs_state.0.lock().unwrap().clone();
    let data = workspaces_state.0.lock().unwrap().clone();
    let config_dir = app_handle.path().app_config_dir().map_err(|e| e.to_string())?;
    let theme = theme_state.0.lock().unwrap().clone();
    persist_workspaces(&config_dir, &data, session_names, file_tabs, board_tabs, theme)
        .map_err(|e| e.to_string())
}

/// Open per-context board tabs (tab id -> BoardTabRecord). Same
/// always-carry persistence contract as FileTabs.
pub struct BoardTabs(pub Mutex<HashMap<String, crate::config::BoardTabRecord>>);

/// App-global light/dark preference: "light", "dark", or None for
/// System. Same always-carry persistence contract as FileTabs/BoardTabs.
pub struct ThemePref(pub Mutex<Option<String>>);

#[tauri::command]
pub fn get_board_tabs(state: State<BoardTabs>) -> HashMap<String, crate::config::BoardTabRecord> {
    state.0.lock().unwrap().clone()
}

/// Replaces the whole board-tab map -- whole-map for the same reason as
/// set_file_tabs: callers always mutate it alongside a pane-tree change
/// they're already persisting wholesale.
#[tauri::command]
pub fn set_board_tabs(
    board_tabs: HashMap<String, crate::config::BoardTabRecord>,
    app_handle: AppHandle,
    workspaces_state: State<WorkspacesState>,
    names_state: State<SessionNames>,
    file_tabs_state: State<FileTabs>,
    board_tabs_state: State<BoardTabs>,
    theme_state: State<ThemePref>,
) -> Result<(), String> {
    *board_tabs_state.0.lock().unwrap() = board_tabs.clone();
    let session_names = names_state.0.lock().unwrap().clone();
    let file_tabs = file_tabs_state.0.lock().unwrap().clone();
    let data = workspaces_state.0.lock().unwrap().clone();
    let config_dir = app_handle.path().app_config_dir().map_err(|e| e.to_string())?;
    let theme = theme_state.0.lock().unwrap().clone();
    persist_workspaces(&config_dir, &data, session_names, file_tabs, board_tabs, theme)
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

/// Bumped on every deliberate reconnect (`reconnect`). A relay thread
/// captures the epoch it was spawned in and reports a disconnect only
/// while that epoch is still current -- without it, the OLD thread's
/// "daemon closed the connection" would throw the connection-error
/// overlay over a restart the human just asked for.
///
/// An epoch rather than a "restarting" flag: the old thread can notice
/// its socket close at any point, including after the new connection is
/// already live and serving, and a flag lowered at the end of the
/// restart would still race it. An epoch it can never win.
pub struct ConnectionEpoch(pub std::sync::atomic::AtomicU64);

#[tauri::command]
pub fn signal_frontend_ready(state: State<FrontendReady>) {
    state.0.store(true, std::sync::atomic::Ordering::SeqCst);
}

#[tauri::command]
pub fn get_bootstrap_error(state: State<BootstrapError>) -> Option<String> {
    state.0.lock().unwrap().clone()
}

/// Restarts `gavin-daemon` and puts this app back on it.
///
/// Two paths, both ending fully connected. If the app never bootstrapped
/// (a version mismatch or missing daemon at startup, behind the
/// connection-error overlay) it kills whatever is running, clears the
/// stale bootstrap error and bootstraps cleanly. If it HAS bootstrapped
/// -- the Settings button, with a live app around it -- it reconnects in
/// place; see `reconnect` for why that is not simply "bootstrap again".
///
/// Restarting is destructive to sessions and callers must say so first:
/// `SessionManager::recover` does not reattach to the old PTYs (they die
/// with the daemon), it spawns a FRESH shell per surviving registry
/// record. Every running agent is stopped.
#[tauri::command]
pub fn restart_daemon(app_handle: AppHandle) -> Result<(), String> {
    if app_handle.try_state::<DaemonConnection>().is_some() {
        return reconnect(&app_handle).map_err(|e| e.to_string());
    }
    crate::daemon::kill_running_daemons().map_err(|e| e.to_string())?;
    // Let the old process actually exit before connect_or_spawn looks for
    // a listener, so it doesn't reach a half-dead one.
    std::thread::sleep(DAEMON_EXIT_GRACE);
    if let Some(state) = app_handle.try_state::<BootstrapError>() {
        *state.0.lock().unwrap() = None;
    }
    bootstrap(app_handle).map_err(|e| e.to_string())
}

/// How long to let a killed daemon actually exit before looking for a
/// listener again -- otherwise `connect_or_spawn` can reach the dying
/// process's socket and believe it succeeded.
const DAEMON_EXIT_GRACE: Duration = Duration::from_millis(300);

/// Rewires a running app onto a freshly restarted daemon, with no
/// relaunch.
///
/// The obvious implementation -- call `bootstrap` again -- cannot work:
/// it publishes the connections with `app_handle.manage(...)`, and
/// Tauri's `manage` keeps the first value for a given type, so the second
/// call would leave the app writing to the dead socket. (That is exactly
/// why this command used to return "restarted, now relaunch".)
///
/// But the state does not need replacing. Both connections are already
/// mutexes around a `UnixStream`, so a reconnect just assigns fresh
/// streams into the ones the app is holding, and every command that
/// borrows them keeps working untouched.
fn reconnect(app_handle: &AppHandle) -> anyhow::Result<()> {
    // Bump BEFORE killing: the old relay thread notices its socket close
    // almost immediately, and this is the only thing keeping it quiet.
    app_handle.state::<ConnectionEpoch>().0.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    crate::daemon::kill_running_daemons()?;
    std::thread::sleep(DAEMON_EXIT_GRACE);
    if let Some(state) = app_handle.try_state::<BootstrapError>() {
        *state.0.lock().unwrap() = None;
    }

    let stream_conn = crate::daemon::connect_or_spawn(
        &socket_path(),
        Duration::from_secs(3),
        crate::daemon::spawn_real_daemon,
    )?;
    let probe = Mutex::new(UnixStream::connect(socket_path())?);
    // Verified before ANYTHING is swapped in: a daemon that fails the
    // version probe must leave a named error and an app that is merely
    // disconnected, never one wired half onto each daemon.
    let compat = verify_daemon_protocol(&probe)?;

    // A restart can hand the app a differently-versioned daemon than the
    // one it started with -- refresh the stored verdict BEFORE either
    // connection is repointed at the new daemon. A concurrent Tauri
    // command reads this state via `current_compat` and gates its
    // `send_request` against it; if the verdict still described the
    // outgoing daemon while the writer below already pointed at the
    // incoming one, that command could pass the gate and write a request
    // the new (older) daemon can't parse -- closing the connection and
    // taking every push riding on it down with it, the exact failure this
    // compatibility window exists to prevent. `compat` was already
    // computed above via `verify_daemon_protocol`, and `DaemonCompat` is
    // `Copy`, so this is a pure reorder.
    *app_handle.state::<DaemonCompatState>().0.lock().unwrap() = Some(compat);

    let writer = Arc::clone(&app_handle.state::<DaemonConnection>().writer);
    *writer.lock().unwrap() = stream_conn.try_clone()?;
    *app_handle.state::<CommandConnection>().0.lock().unwrap() =
        probe.into_inner().expect("protocol probe mutex poisoned");

    let data = app_handle.state::<WorkspacesState>().0.lock().unwrap().clone();
    let non_session_tab_ids = non_session_tab_ids(
        &app_handle.state::<FileTabs>().0.lock().unwrap(),
        &app_handle.state::<BoardTabs>().0.lock().unwrap(),
    );
    attach_and_relay(
        app_handle,
        &writer,
        stream_conn,
        attachable_session_ids(&data, &non_session_tab_ids),
        compat,
    )?;

    // The daemon's gavin watchers were per-connection and died with it.
    // Re-armed here rather than from the frontend because this is where
    // the new connection exists: miss it and the Plans, Kanban and
    // Orchestration tabs go quietly dead after a restart -- the exact
    // failure the fs-sync work just removed.
    for ws in &data.workspaces {
        if let Some(root) = &ws.root_path {
            send_request(
                &writer,
                &Request::WatchGavinRoot {
                    workspace_id: ws.id.clone(),
                    root_path: root.clone(),
                },
                &compat,
            )?;
        }
    }
    Ok(())
}

/// The wire guard. An older daemon cannot PARSE a request it predates,
/// and a parse error there closes the whole connection (see
/// handle_connection) -- taking every push with it. So the check has to
/// happen here, before the bytes leave, not as error handling after.
pub fn gate(req: &Request, compat: &DaemonCompat) -> Result<(), String> {
    let needed = protocol::min_version_for(req);
    if needed > compat.daemon_version {
        return Err(format!(
            "this needs daemon protocol v{needed}, but the running daemon is v{} — restart the daemon to use it",
            compat.daemon_version
        ));
    }
    Ok(())
}

fn send_request(
    writer: &Arc<Mutex<UnixStream>>,
    req: &Request,
    compat: &DaemonCompat,
) -> anyhow::Result<()> {
    gate(req, compat).map_err(|e| anyhow::anyhow!(e))?;
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

/// What the app negotiated with the daemon it just connected to.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DaemonCompat {
    pub daemon_version: u32,
    pub app_version: u32,
    /// True when the daemon is older than us but still inside the
    /// window: usable, with the newer requests gated off.
    pub degraded: bool,
}

/// Holds the verdict from the most recent `verify_daemon_protocol` call, so
/// commands issued later (and, eventually, the frontend) can see whether
/// they're talking to a degraded daemon without re-probing it. `None`
/// until the first successful probe.
pub struct DaemonCompatState(pub Mutex<Option<DaemonCompat>>);

/// The verdict for a `#[tauri::command]` to `gate` its own `send_request`
/// calls against. `DaemonCompatState` is `.manage()`d at app setup (see
/// lib.rs) and only ever turns `Some` -- both `bootstrap` and `reconnect`
/// populate it before they publish (`bootstrap`, via `.manage()`) or
/// repoint (`reconnect`, by overwriting the `Mutex`es in place) the
/// connection state a command would need to even be reachable -- so
/// `None` here means a command ran before bootstrap finished, which
/// should not be possible, and a command that does run never sees a
/// verdict for a daemon other than the one its connection currently
/// points at.
fn current_compat(state: &DaemonCompatState) -> DaemonCompat {
    state.0.lock().unwrap().expect("DaemonCompatState populated before any command runs")
}

/// Sorts a daemon's advertised version into one of three bands relative to
/// this app: too new (hard error -- this app has no idea how to speak an
/// unreleased protocol newer than its own), too old (below `floor`, i.e.
/// `MIN_COMPATIBLE_VERSION` -- the daemon predates the oldest request
/// shape this app still knows how to send), or inside the window, which
/// is usable either at parity or degraded.
///
/// Pure so the bands are testable without a daemon. Split out of
/// `verify_daemon_protocol`, which owns the I/O.
pub fn classify(daemon: u32, app: u32, floor: u32) -> Result<DaemonCompat, String> {
    if daemon > app {
        return Err(format!(
            "the gavin daemon is newer than this app (v{daemon} vs v{app}) — update the app"
        ));
    }
    if daemon < floor {
        return Err(format!(
            "the gavin daemon is too old to use (v{daemon}, minimum v{floor}) — restart it"
        ));
    }
    Ok(DaemonCompat { daemon_version: daemon, app_version: app, degraded: daemon < app })
}

/// Spec §4: probe the daemon's protocol version before anything else.
/// Interprets FAILURE SHAPE -- a daemon older than the probe itself can't
/// parse the request and closes the connection, which must map to the
/// same actionable message as an explicit lower version (this turned the
/// 2026-08-07 stale-daemon incident's mystery close into a named state).
fn verify_daemon_protocol(command_conn: &Mutex<UnixStream>) -> anyhow::Result<DaemonCompat> {
    const UNREACHABLE: &str = "the gavin daemon is too old to talk to this app — restart it (quit gavin, then relaunch)";
    match send_command(command_conn, &Request::GetProtocolVersion) {
        Ok(Response::ProtocolVersion { version }) => {
            classify(version, protocol::PROTOCOL_VERSION, protocol::MIN_COMPATIBLE_VERSION)
                .map_err(|e| anyhow::anyhow!(e))
        }
        // A daemon too old to parse the probe closes the connection.
        // Preserved from the 2026-08-07 stale-daemon incident: this
        // failure SHAPE has to map to the same named state as an
        // explicit too-low version, not to a mystery.
        Ok(_) | Err(_) => anyhow::bail!(UNREACHABLE),
    }
}

fn send_command(conn: &Mutex<UnixStream>, req: &Request) -> anyhow::Result<Response> {
    let mut stream = conn.lock().unwrap();
    write_message(&mut *stream, req)?;
    let mut reader = BufReader::new(&mut *stream);
    read_message(&mut reader)?
        .ok_or_else(|| anyhow::anyhow!("daemon closed the command connection"))
}

/// One reconnect per call, mirroring gavin-mcp's `SocketTransport`
/// (`crates/gavin-mcp/src/main.rs`), which has done this since it was
/// written. Without it, any single command failure -- daemon restart, or
/// a request an older/newer daemon can't parse -- leaves `conn` closed
/// with nothing to ever reopen it, turning one bad request into a
/// permanently dead app.
///
/// Known gap, deliberately not fixed here: reconnecting re-opens the
/// socket but does NOT re-run the version probe. If the daemon was
/// replaced by a different version between the original failure and this
/// reconnect, the app keeps serving its previous `DaemonCompat` verdict
/// until the next explicit `reconnect()` or restart.
///
/// Also known, also deliberately not fixed here: the retry gives the app
/// at-least-once request semantics it did not previously have. If the
/// first `send_command` fails because the reply never arrived rather than
/// because the request never went out -- e.g. the daemon processed
/// `CreateSession` and then died before the response crossed the wire --
/// the retry resends the same request to the (now different) connection,
/// which creates a second session and orphans the first one's PTY. This
/// is inherited from gavin-mcp's transport shape (see the mirror note
/// above), and the alternative -- no retry -- was demonstrably worse: one
/// failed request left `conn` permanently closed and the app permanently
/// dead, which is the whole reason this function exists.
///
/// Takes `socket_path` as a parameter rather than resolving one itself so
/// this core logic stays directly testable against a throwaway tempdir
/// socket. `send_command_reconnecting` below is the production wrapper
/// call sites should use -- it derives `socket_path` from the connection's
/// own peer address rather than from a fixed, globally-resolved one; see
/// its doc comment for why.
fn send_command_reconnecting_at(
    conn: &Mutex<UnixStream>,
    socket_path: &Path,
    req: &Request,
) -> anyhow::Result<Response> {
    match send_command(conn, req) {
        Ok(resp) => Ok(resp),
        Err(_) => {
            *conn.lock().unwrap() = UnixStream::connect(socket_path)?;
            send_command(conn, req)
        }
    }
}

/// Production entry point for every command site: see
/// `send_command_reconnecting_at` for the reconnect logic and its
/// documented gap. `verify_daemon_protocol` deliberately does NOT go
/// through this -- see its own doc comment for why a closed connection
/// there must stay a hard failure rather than get retried away.
///
/// Reconnects to the peer THIS connection was already opened against,
/// read back from the socket itself via `peer_addr()`, rather than
/// resolving `protocol::socket_path()` (the real daemon) globally. Several
/// of this function's callers -- `list_valid_session_ids`,
/// `create_fresh_session`, `get_board_impl`, `set_board_impl`,
/// `delete_board_impl` -- are themselves unit-tested against a bare
/// `Mutex<UnixStream>` pointed at a tempdir fake socket, with no path
/// threaded through for a reconnect to target. A global-path resolution
/// here would have meant any of those tests reaching the retry branch --
/// today only by accident, tomorrow by a one-off regression -- silently
/// redirects the test process into issuing real requests against the
/// developer's actual running daemon. Deriving the reconnect target from
/// the connection's own peer address closes that off structurally instead
/// of relying on every test's response queue never running short.
///
/// Falls back to a single, non-retried attempt if the peer address can't
/// be determined (not a `SocketAddr::as_pathname` case, e.g. an unnamed
/// or abstract socket) -- a missed retry is recoverable, a retry aimed at
/// an unknown or wrong peer is not.
///
/// Gated here rather than in `send_command_reconnecting_at`: this function
/// has TWO branches that can put bytes on the wire -- the peer-derived
/// retry path through `_at`, and the `peer_addr()`-failed fallback that
/// calls `send_command` directly. Gating only inside `_at` would leave
/// that fallback branch unprotected, and a gated request reaching the
/// socket by that one uncommon path is exactly the failure this exists to
/// rule out. Checked before the bytes leave, not as error handling after:
/// an older daemon cannot PARSE a request it predates, and read_message
/// propagates that parse error with `?`, dropping the connection and
/// every push riding on it.
fn send_command_reconnecting(
    conn: &Mutex<UnixStream>,
    compat: &DaemonCompat,
    req: &Request,
) -> anyhow::Result<Response> {
    gate(req, compat).map_err(|e| anyhow::anyhow!(e))?;
    let peer = conn
        .lock()
        .unwrap()
        .peer_addr()
        .ok()
        .and_then(|addr| addr.as_pathname().map(|p| p.to_path_buf()));
    match peer {
        Some(path) => send_command_reconnecting_at(conn, &path, req),
        None => send_command(conn, req),
    }
}

/// Walks the tree, replacing any session id not present in `valid_ids`
/// (stale, exited, or never existed) with a freshly created session — the
/// same silent, normal fallback Milestone B established for its one
/// session, now applied uniformly to every tab in every pane.
/// Ids in `non_session_tab_ids` are file-viewer tabs, not terminal sessions --
/// they're skipped entirely. The daemon has never heard of them, so
/// without this check every persisted file tab would be treated as a
/// stale session and silently replaced by a freshly spawned shell on
/// every single launch.
fn resolve_sessions(
    node: &mut LayoutNode,
    command_conn: &Mutex<UnixStream>,
    all_sessions: &HashMap<String, protocol::SessionSummary>,
    non_session_tab_ids: &HashSet<String>,
    compat: &DaemonCompat,
) -> anyhow::Result<()> {
    match node {
        LayoutNode::Leaf { tabs, pinned, .. } => {
            for id in tabs.iter_mut() {
                if non_session_tab_ids.contains(id.as_str()) {
                    continue;
                }
                let is_valid = all_sessions.get(id.as_str()).is_some_and(|s| s.status != "exited");
                if !is_valid {
                    let last_known_cwd = all_sessions.get(id.as_str()).map(|s| s.cwd.as_str());
                    let fresh = create_fresh_session(command_conn, last_known_cwd, None, compat)?;
                    // A pin belongs to the tab slot, not the dead process:
                    // carry it over so a daemon restart doesn't unpin it.
                    if let Some(pin) = pinned.iter_mut().find(|p| **p == *id) {
                        *pin = fresh.clone();
                    }
                    *id = fresh;
                }
            }
            Ok(())
        }
        LayoutNode::Split { children, .. } => {
            for child in children.iter_mut() {
                resolve_sessions(child, command_conn, all_sessions, non_session_tab_ids, compat)?;
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
    compat: &DaemonCompat,
) -> anyhow::Result<HashMap<String, protocol::SessionSummary>> {
    let resp = send_command_reconnecting(command_conn, compat, &Request::ListSessions)?;
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
    non_session_tab_ids: &HashSet<String>,
    compat: &DaemonCompat,
) -> anyhow::Result<()> {
    if workspaces.is_empty() {
        return Ok(());
    }
    // Every tab across every page is a file tab -- there are no sessions to
    // reconcile, so skip the ListSessions round-trip entirely (matching the
    // empty-workspaces early return above).
    let has_any_session_tab = workspaces
        .iter()
        .flat_map(|w| w.pages.iter())
        .flat_map(|p| p.layout.all_session_ids())
        .any(|id| !non_session_tab_ids.contains(&id));
    if !has_any_session_tab {
        return Ok(());
    }
    let all_sessions = list_valid_session_ids(command_conn, compat)?;
    for workspace in workspaces.iter_mut() {
        for page in workspace.pages.iter_mut() {
            resolve_sessions(&mut page.layout, command_conn, &all_sessions, non_session_tab_ids, compat)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod test_support {
    use super::*;
    use std::os::unix::net::UnixListener;

    /// A daemon at exact parity with this app -- gates nothing, so the
    /// tests below that aren't specifically exercising the gate itself
    /// don't have to think about it. `gate_tests` and
    /// `command_connection_tests`'s two gating tests build their own
    /// `DaemonCompat` deliberately instead, since an intentionally-old
    /// `daemon_version` is the whole point there.
    pub fn parity_compat() -> DaemonCompat {
        DaemonCompat {
            daemon_version: protocol::PROTOCOL_VERSION,
            app_version: protocol::PROTOCOL_VERSION,
            degraded: false,
        }
    }

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
    use super::test_support::{fake_daemon_replying_with, parity_compat};
    use super::*;
    use std::os::unix::net::UnixListener;

    /// A closed command connection must not stay dead forever: the daemon
    /// may simply have restarted between calls. The first connection
    /// closes without answering (simulating exactly that), and
    /// send_command_reconnecting must reconnect and retry once rather
    /// than surfacing the failure to the caller.
    ///
    /// Goes through the production `send_command_reconnecting` wrapper,
    /// not `_at` directly -- this is the empirical check for whether
    /// `UnixStream::peer_addr()` still resolves to the original peer path
    /// once that peer has already hung up (the state the retry branch
    /// always runs in). If it didn't, the wrapper would silently fall back
    /// to a single non-retried attempt and this test's second `accept()`
    /// would never fire, hanging the test. Passing quickly is the proof:
    /// peer_addr() survives the disconnect, and the retry lands back on
    /// this exact tempdir socket rather than on `protocol::socket_path()`
    /// (the real daemon), which reconnecting into would be the hazard this
    /// whole design change exists to close off.
    #[test]
    fn a_command_retries_once_on_a_closed_connection() {
        // Serve two connections: the first closes immediately (simulating a
        // daemon that hung up), the second answers properly.
        let dir = tempfile::tempdir().unwrap();
        let sock = dir.path().join("retry.sock");
        let listener = UnixListener::bind(&sock).unwrap();

        let server = std::thread::spawn(move || {
            let (first, _) = listener.accept().unwrap();
            drop(first);
            let (mut second, _) = listener.accept().unwrap();
            let mut reader = BufReader::new(second.try_clone().unwrap());
            let _req: Option<Request> = read_message(&mut reader).unwrap();
            write_message(&mut second, &Response::ProtocolVersion { version: 12 }).unwrap();
        });

        let conn = Mutex::new(UnixStream::connect(&sock).unwrap());
        let resp = send_command_reconnecting(&conn, &parity_compat(), &Request::GetProtocolVersion).unwrap();
        assert!(matches!(resp, Response::ProtocolVersion { version: 12 }));
        server.join().unwrap();
    }

    /// The property that actually matters for the compat window: the
    /// daemon must receive NOTHING -- not a request it answers with an
    /// error, but no bytes at all. An older daemon can't parse a variant
    /// it predates, and that parse error closes the whole connection.
    #[test]
    fn a_command_the_daemon_predates_never_reaches_the_wire() {
        let dir = tempfile::tempdir().unwrap();
        let sock = dir.path().join("gated.sock");
        let listener = UnixListener::bind(&sock).unwrap();

        let server = std::thread::spawn(move || {
            let (conn, _) = listener.accept().unwrap();
            let mut reader = BufReader::new(conn.try_clone().unwrap());
            // Returns None if the client correctly sent nothing and hung up.
            read_message::<_, Request>(&mut reader).unwrap()
        });

        let conn = Mutex::new(UnixStream::connect(&sock).unwrap());
        let compat = DaemonCompat { daemon_version: 9, app_version: 12, degraded: true };
        let too_new = Request::NameSession { session_id: "s-1".into(), name: "x".into() };

        let err = send_command_reconnecting(&conn, &compat, &too_new).unwrap_err().to_string();
        assert!(err.contains("v10"), "should name the version needed: {err}");
        assert!(err.contains("v9"), "should name the version running: {err}");

        drop(conn);
        assert!(server.join().unwrap().is_none(), "a gated request must not reach the daemon");
    }

    #[test]
    fn a_command_the_daemon_understands_still_reaches_the_wire() {
        let dir = tempfile::tempdir().unwrap();
        let sock = dir.path().join("allowed.sock");
        let listener = UnixListener::bind(&sock).unwrap();

        let server = std::thread::spawn(move || {
            let (mut conn, _) = listener.accept().unwrap();
            let mut reader = BufReader::new(conn.try_clone().unwrap());
            let _req: Option<Request> = read_message(&mut reader).unwrap();
            write_message(&mut conn, &Response::SessionList { sessions: vec![] }).unwrap();
        });

        let conn = Mutex::new(UnixStream::connect(&sock).unwrap());
        let compat = DaemonCompat { daemon_version: 9, app_version: 12, degraded: true };

        // ListSessions is v1, so a v9 daemon serves it fine.
        let resp = send_command_reconnecting(&conn, &compat, &Request::ListSessions).unwrap();
        assert!(matches!(resp, Response::SessionList { .. }));
        server.join().unwrap();
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

#[cfg(test)]
mod resolve_workspaces_tests {
    use super::test_support::fake_daemon_capturing_requests;
    use super::test_support::fake_daemon_replying_with;
    use super::test_support::parity_compat;
    use super::*;
    use crate::config::Page;

    fn leaf(tabs: &[&str]) -> LayoutNode {
        LayoutNode::Leaf { tabs: tabs.iter().map(|s| s.to_string()).collect(), active_tab_index: 0, pinned: Vec::new() }
    }

    fn page(id: &str, layout: LayoutNode) -> Page {
        Page { id: id.to_string(), name: id.to_string(), layout, focused_session_id: None }
    }

    fn workspace(id: &str, pages: Vec<Page>) -> Workspace {
        Workspace {
            id: id.to_string(),
            name: id.to_string(),
            pages,
            active_page_id: None,
            active_view: None,
            hub_view: None,
            root_path: None,
            main_session_id: None,
            legacy_agent_command: None,
            color: None,
            notify_needs_input: true,
            notify_finished: true,
            git_view: None,
        }
    }

    fn no_file_tabs() -> HashSet<String> {
        HashSet::new()
    }

    #[test]
    fn a_file_tab_id_is_left_alone_not_replaced_with_a_fresh_session() {
        // Zero queued responses: if resolve_workspaces treated the file tab
        // as a stale session it would try to CreateSession and hang/fail on
        // the empty queue. A workspace whose only tab is a file tab must
        // not even call ListSessions.
        let (client, captured, _dir) = fake_daemon_capturing_requests(vec![]);
        let conn = Mutex::new(client);
        let mut workspaces = vec![workspace("ws-1", vec![page("page-1", leaf(&["file-tab-1"]))])];
        let non_session_tab_ids: HashSet<String> = ["file-tab-1".to_string()].into_iter().collect();

        resolve_workspaces(&mut workspaces, &conn, &non_session_tab_ids, &parity_compat()).unwrap();

        assert_eq!(workspaces[0].pages[0].layout, leaf(&["file-tab-1"]));
        assert!(captured.lock().unwrap().is_empty(), "no daemon calls at all for a file-tab-only workspace");
    }

    #[test]
    fn a_file_tab_alongside_a_stale_session_leaves_the_file_tab_and_replaces_only_the_session() {
        let (client, _captured, _dir) = fake_daemon_capturing_requests(vec![
            Response::SessionList { sessions: vec![] },
            Response::SessionCreated { id: "fresh-a".to_string() },
        ]);
        let conn = Mutex::new(client);
        let mut workspaces =
            vec![workspace("ws-1", vec![page("page-1", leaf(&["file-tab-1", "stale-session"]))])];
        let non_session_tab_ids: HashSet<String> = ["file-tab-1".to_string()].into_iter().collect();

        resolve_workspaces(&mut workspaces, &conn, &non_session_tab_ids, &parity_compat()).unwrap();

        assert_eq!(workspaces[0].pages[0].layout, leaf(&["file-tab-1", "fresh-a"]));
    }

    #[test]
    fn a_pinned_stale_session_stays_pinned_under_its_fresh_id() {
        let (client, _captured, _dir) = fake_daemon_capturing_requests(vec![
            Response::SessionList { sessions: vec![] },
            Response::SessionCreated { id: "fresh-a".to_string() },
            Response::SessionCreated { id: "fresh-b".to_string() },
        ]);
        let conn = Mutex::new(client);
        let pinned_leaf = LayoutNode::Leaf {
            tabs: vec!["stale-a".to_string(), "stale-b".to_string()],
            active_tab_index: 1,
            pinned: vec!["stale-a".to_string()],
        };
        let mut workspaces = vec![workspace("ws-1", vec![page("page-1", pinned_leaf)])];

        resolve_workspaces(&mut workspaces, &conn, &no_file_tabs(), &parity_compat()).unwrap();

        assert_eq!(
            workspaces[0].pages[0].layout,
            LayoutNode::Leaf {
                tabs: vec!["fresh-a".to_string(), "fresh-b".to_string()],
                active_tab_index: 1,
                pinned: vec!["fresh-a".to_string()],
            }
        );
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

        resolve_workspaces(&mut workspaces, &conn, &no_file_tabs(), &parity_compat()).unwrap();

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

        resolve_workspaces(&mut workspaces, &conn, &no_file_tabs(), &parity_compat()).unwrap();

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

        resolve_workspaces(&mut workspaces, &conn, &no_file_tabs(), &parity_compat()).unwrap();

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

        resolve_workspaces(&mut workspaces, &conn, &no_file_tabs(), &parity_compat()).unwrap();

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

        resolve_workspaces(&mut workspaces, &conn, &no_file_tabs(), &parity_compat()).unwrap();

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

        resolve_workspaces(&mut workspaces, &conn, &no_file_tabs(), &parity_compat()).unwrap();

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

        create_fresh_session(&conn, Some("/tmp"), None, &parity_compat()).unwrap();

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

        create_fresh_session(&conn, Some("/tmp"), Some("npm test"), &parity_compat()).unwrap();

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
/// Dev builds always offer a "Smoke Test" workspace (appended at the end,
/// preserved if it already exists -- including its bound root); release
/// builds strip it so a dev config.json can never leak it into prod. It is
/// an ordinary, closable workspace: closing it just means the next dev
/// launch recreates it empty.
fn reconcile_smoketest_workspace(workspaces: &mut Vec<Workspace>) {
    if cfg!(debug_assertions) {
        if !workspaces.iter().any(|w| w.id == crate::config::SMOKETEST_WORKSPACE_ID) {
            workspaces.push(Workspace {
                id: crate::config::SMOKETEST_WORKSPACE_ID.to_string(),
                name: "Smoke Test".to_string(),
                pages: vec![],
                active_page_id: None,
                active_view: None,
                hub_view: None,
                root_path: None,
                main_session_id: None,
                legacy_agent_command: None,
                color: None,
                notify_needs_input: true,
                notify_finished: true,
                git_view: None,
            });
        }
    } else {
        workspaces.retain(|w| w.id != crate::config::SMOKETEST_WORKSPACE_ID);
    }
}

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
    compat: &DaemonCompat,
) -> anyhow::Result<()> {
    if !workspaces.iter().any(|w| w.main_session_id.is_some()) {
        return Ok(());
    }
    let sessions = list_valid_session_ids(command_conn, compat)?;
    for workspace in workspaces.iter_mut() {
        let Some(id) = workspace.main_session_id.clone() else { continue };
        let alive = sessions.get(id.as_str()).is_some_and(|s| s.status != "exited");
        if !alive {
            workspace.main_session_id = None;
        }
    }
    Ok(())
}

/// Tab ids that are NOT sessions. File and board tabs live in the same id
/// space as sessions in the layout tree, but the daemon has never heard
/// of them -- attaching one would fail for an id that was never a
/// session.
fn non_session_tab_ids(
    file_tabs: &HashMap<String, String>,
    board_tabs: &HashMap<String, crate::config::BoardTabRecord>,
) -> HashSet<String> {
    file_tabs.keys().chain(board_tabs.keys()).cloned().collect()
}

/// Every session id this app expects the daemon to stream for it.
///
/// Main agent sessions live outside every page tree by design (D12), so
/// the page-tree walk cannot see them -- without the second half they
/// reattach to nothing and render blank forever (Milestone C's bug).
fn attachable_session_ids(
    data: &WorkspacesData,
    non_session_tab_ids: &HashSet<String>,
) -> Vec<String> {
    data.workspaces
        .iter()
        .flat_map(|w| w.pages.iter())
        .flat_map(|p| p.layout.all_session_ids())
        .filter(|id| !non_session_tab_ids.contains(id))
        .chain(data.workspaces.iter().filter_map(|w| w.main_session_id.clone()))
        .collect()
}

/// A relay thread's stream ended. Silent when a newer connection has
/// already taken over (see `ConnectionEpoch`) -- that disconnect WAS the
/// restart, and surfacing it would flash the connection-error overlay
/// over a reconnect that is going fine.
fn report_disconnect(app_handle: &AppHandle, epoch: u64, message: String) {
    if app_handle.state::<ConnectionEpoch>().0.load(std::sync::atomic::Ordering::SeqCst) != epoch {
        return;
    }
    let _ = app_handle.emit("daemon-error", message);
}

/// Attaches every session on the streaming connection and starts the
/// thread that relays the daemon's pushes to the frontend as Tauri
/// events. Shared by the cold path (`bootstrap`) and the reconnect path
/// (`reconnect`) so the two can never drift on what gets attached or
/// which pushes are forwarded.
fn attach_and_relay(
    app_handle: &AppHandle,
    writer: &Arc<Mutex<UnixStream>>,
    reader_stream: UnixStream,
    session_ids: Vec<String>,
    // By value, not `&`: `DaemonCompat` is `Copy`, and the relay thread
    // spawned below needs its own owned copy to move into the `'static`
    // closure -- there is no `AppHandle`-free way to borrow it instead.
    compat: DaemonCompat,
) -> anyhow::Result<()> {
    for id in session_ids {
        send_request(writer, &Request::Attach { id }, &compat)?;
    }

    let epoch = app_handle.state::<ConnectionEpoch>().0.load(std::sync::atomic::Ordering::SeqCst);
    let mut reader = BufReader::new(reader_stream);
    let reader_app_handle = app_handle.clone();
    let relay_writer = Arc::clone(writer);
    std::thread::spawn(move || {
        // Wait for the frontend to confirm its listeners are registered
        // before reading -- and therefore emitting -- anything from the
        // daemon (see FrontendReady's doc comment). Bounded: an unbounded
        // wait here would leave the daemon's connection-handling thread
        // blocked mid-write on a full scrollback replay, backing up
        // through the session's writer mutex into the PTY pump -- worse
        // than the small chance of an early emit being missed if the
        // frontend is simply slow rather than broken. On a reconnect the
        // flag is long since set, so this falls straight through.
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
                    report_disconnect(&reader_app_handle, epoch, e.to_string());
                    break;
                }
            };
            let Some(resp) = resp else {
                report_disconnect(
                    &reader_app_handle,
                    epoch,
                    "daemon closed the connection".to_string(),
                );
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
                Response::OrchestrationChanged { workspace_id, orchestration } => {
                    let _ = reader_app_handle
                        .emit("orchestration-changed", (workspace_id, orchestration));
                }
                Response::GavinTreeChanged { workspace_id, tree } => {
                    let _ = reader_app_handle.emit("gavin-tree-changed", (workspace_id, tree));
                }
                Response::SessionNamed { session_id, name } => {
                    // The frontend applies it through setSessionName, the
                    // very path the tab's own rename UI takes -- so an
                    // agent rename and a human rename persist identically.
                    let _ = reader_app_handle.emit("session-named", (session_id, name));
                }
                Response::AgentSessionSpawned { workspace_id, session_id, cwd, command } => {
                    // Attach BEFORE emitting: a session nobody attaches
                    // renders blank forever (the Milestone-C lesson).
                    let _ = send_request(
                        &relay_writer,
                        &Request::Attach { id: session_id.clone() },
                        &compat,
                    );
                    let _ = reader_app_handle
                        .emit("agent-session-spawned", (workspace_id, session_id, cwd, command));
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


/// One-time carry-over of D34's `agentCommand` from config.json into
/// config.toml (D41). Writes only when config.toml has no
/// `[agent].command`, so the file always wins on later launches and a
/// user's own edit is never reverted. Unrooted workspaces have nowhere to
/// carry to and are skipped by the caller -- no loss, since
/// startMainAgent already refuses to run without a root.
fn carry_over_agent_command(root_path: &str, legacy: Option<&str>) -> anyhow::Result<()> {
    let Some(legacy) = legacy.filter(|c| !c.trim().is_empty()) else { return Ok(()) };
    let path = std::path::Path::new(root_path).join(".gavin-root").join("config.toml");
    let existing = std::fs::read_to_string(&path).unwrap_or_default();
    let already = existing
        .parse::<toml::Table>()
        .ok()
        .and_then(|t| Some(t.get("agent")?.as_table()?.contains_key("command")))
        .unwrap_or(false);
    if already {
        return Ok(());
    }
    crate::agent_setup::write_root_config_key(std::path::Path::new(root_path), "command", legacy)
}

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
    let compat = verify_daemon_protocol(&command_conn)?;
    *app_handle.state::<DaemonCompatState>().0.lock().unwrap() = Some(compat);

    let writer = Arc::new(Mutex::new(stream_conn.try_clone()?));
    let reader_stream = stream_conn;

    let config_dir = app_handle.path().app_config_dir()?;
    let config = crate::config::load(&config_dir)?;
    let session_names = config.session_names;
    let file_tabs = config.file_tabs;
    let board_tabs = config.board_tabs;

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
                hub_view: None,
                root_path: None,
                main_session_id: None,
                legacy_agent_command: None,
                color: None,
                notify_needs_input: true,
                notify_finished: true,
                git_view: None,
            },
        );
    }
    reconcile_smoketest_workspace(&mut workspaces);
    // D41: take() clears the legacy value, so the next save drops the key
    // from config.json permanently.
    for ws in workspaces.iter_mut() {
        if let (Some(root), Some(legacy)) = (ws.root_path.clone(), ws.legacy_agent_command.take()) {
            if let Err(e) = carry_over_agent_command(&root, Some(&legacy)) {
                eprintln!("agent command carry-over failed for {}: {e}", ws.id);
            }
        }
    }
    reconcile_main_sessions(&mut workspaces, &command_conn, &compat)?;
    let non_session_tab_ids = non_session_tab_ids(&file_tabs, &board_tabs);
    resolve_workspaces(&mut workspaces, &command_conn, &non_session_tab_ids, &compat)?;
    let active_workspace_id = if had_no_workspaces {
        Some(crate::config::UNFILED_WORKSPACE_ID.to_string())
    } else {
        config.active_workspace_id
    };
    let workspaces_data = WorkspacesData { workspaces, active_workspace_id };
    persist_workspaces(
        &config_dir,
        &workspaces_data,
        session_names.clone(),
        file_tabs.clone(),
        board_tabs.clone(),
        config.theme.clone(),
    )?;

    let session_ids = attachable_session_ids(&workspaces_data, &non_session_tab_ids);

    app_handle.manage(DaemonConnection { writer: Arc::clone(&writer) });
    app_handle.manage(CommandConnection(command_conn));
    app_handle.manage(WorkspacesState(Mutex::new(workspaces_data.clone())));
    app_handle.manage(SessionNames(Mutex::new(session_names)));
    app_handle.manage(FileTabs(Mutex::new(file_tabs)));
    app_handle.manage(BoardTabs(Mutex::new(board_tabs)));
    app_handle.manage(ThemePref(Mutex::new(config.theme)));
    app_handle.emit("workspaces-ready", &workspaces_data)?;

    attach_and_relay(&app_handle, &writer, reader_stream, session_ids, compat)?;
    Ok(())
}

#[tauri::command]
pub fn write_input(
    session_id: String,
    data: String,
    state: State<DaemonConnection>,
    compat: State<DaemonCompatState>,
) -> Result<(), String> {
    send_request(
        &state.writer,
        &Request::WriteInput { id: session_id, data },
        &current_compat(&compat),
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn resize_session(
    session_id: String,
    cols: u16,
    rows: u16,
    state: State<DaemonConnection>,
    compat: State<DaemonCompatState>,
) -> Result<(), String> {
    send_request(
        &state.writer,
        &Request::ResizeSession { id: session_id, cols, rows },
        &current_compat(&compat),
    )
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
    compat: &DaemonCompat,
) -> anyhow::Result<String> {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/".to_string());
    let target = cwd.map(str::to_string).unwrap_or_else(|| home.clone());
    let command = command.map(str::to_string);

    let resp = send_command_reconnecting(
        command_conn,
        compat,
        &Request::CreateSession { workspace_path: target.clone(), cwd: target.clone(), command: command.clone() },
    )?;
    match resp {
        Response::SessionCreated { id } => return Ok(id),
        Response::Error { message } if target != home => {
            eprintln!("failed to recreate session at last-known cwd {target}, falling back to $HOME: {message}");
        }
        other => anyhow::bail!("expected SessionCreated, got {other:?}"),
    }

    let resp = send_command_reconnecting(
        command_conn,
        compat,
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
    compat: State<DaemonCompatState>,
) -> Result<String, String> {
    let compat = current_compat(&compat);
    let id = create_fresh_session(&command_state.0, cwd.as_deref(), command.as_deref(), &compat)
        .map_err(|e| e.to_string())?;
    send_request(&daemon_state.writer, &Request::Attach { id: id.clone() }, &compat)
        .map_err(|e| e.to_string())?;
    Ok(id)
}

#[tauri::command]
pub fn kill_session(
    session_id: String,
    state: State<CommandConnection>,
    compat: State<DaemonCompatState>,
) -> Result<(), String> {
    let resp = send_command_reconnecting(&state.0, &current_compat(&compat), &Request::KillSession { id: session_id })
        .map_err(|e| e.to_string())?;
    match resp {
        Response::Ok => Ok(()),
        Response::Error { message } => Err(message),
        other => Err(format!("unexpected response: {other:?}")),
    }
}

fn get_board_impl(
    command_conn: &Mutex<UnixStream>,
    workspace_id: String,
    compat: &DaemonCompat,
) -> anyhow::Result<Board> {
    let resp = send_command_reconnecting(command_conn, compat, &Request::GetBoard { workspace_id })?;
    match resp {
        Response::Board { columns, labels, card_sessions } => Ok(Board { columns, labels, card_sessions }),
        other => anyhow::bail!("expected Board, got {other:?}"),
    }
}

#[tauri::command]
pub fn get_board(
    workspace_id: String,
    state: State<CommandConnection>,
    compat: State<DaemonCompatState>,
) -> Result<Board, String> {
    get_board_impl(&state.0, workspace_id, &current_compat(&compat)).map_err(|e| e.to_string())
}

fn set_board_impl(
    command_conn: &Mutex<UnixStream>,
    workspace_id: String,
    columns: Vec<Column>,
    labels: Vec<Label>,
    compat: &DaemonCompat,
) -> anyhow::Result<()> {
    let resp =
        send_command_reconnecting(command_conn, compat, &Request::SetBoard { workspace_id, columns, labels })?;
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
    compat: State<DaemonCompatState>,
) -> Result<(), String> {
    set_board_impl(&state.0, workspace_id, columns, labels, &current_compat(&compat)).map_err(|e| e.to_string())
}

// --- Orchestration (SP1) ----------------------------------------------------
//
// `state_value` rather than `state`: the Tauri State<CommandConnection>
// parameter already owns the name `state` in this file's convention.

fn get_orchestration_impl(
    command_conn: &Mutex<UnixStream>,
    workspace_id: String,
    compat: &DaemonCompat,
) -> anyhow::Result<Orchestration> {
    let resp = send_command_reconnecting(command_conn, compat, &Request::GetOrchestration { workspace_id })?;
    match resp {
        Response::Orchestration { rails, conflict_notes, rail_runs, step_runs } => {
            Ok(Orchestration { rails, conflict_notes, rail_runs, step_runs })
        }
        other => anyhow::bail!("expected Orchestration, got {other:?}"),
    }
}

#[tauri::command]
pub fn get_orchestration(
    workspace_id: String,
    state: State<CommandConnection>,
    compat: State<DaemonCompatState>,
) -> Result<Orchestration, String> {
    get_orchestration_impl(&state.0, workspace_id, &current_compat(&compat)).map_err(|e| e.to_string())
}

/// A refused write (the running-step guard) comes back as
/// Response::Error and must reach the caller verbatim -- the board's
/// save-error strip shows it, so it has to name the step.
fn expect_ok(resp: Response) -> Result<(), String> {
    match resp {
        Response::Ok => Ok(()),
        Response::Error { message } => Err(message),
        other => Err(format!("expected Ok, got {other:?}")),
    }
}

#[tauri::command]
pub fn set_orchestration(
    workspace_id: String,
    rails: Vec<Rail>,
    conflict_notes: Vec<ConflictNote>,
    state: State<CommandConnection>,
    compat: State<DaemonCompatState>,
) -> Result<(), String> {
    let resp = send_command_reconnecting(
        &state.0,
        &current_compat(&compat),
        &Request::SetOrchestration { workspace_id, rails, conflict_notes },
    )
    .map_err(|e| e.to_string())?;
    expect_ok(resp)
}

#[tauri::command]
pub fn set_rail_run(
    rail_id: String,
    state_value: String,
    current_stage_id: Option<String>,
    state: State<CommandConnection>,
    compat: State<DaemonCompatState>,
) -> Result<(), String> {
    let resp = send_command_reconnecting(
        &state.0,
        &current_compat(&compat),
        &Request::SetRailRun { rail_id, state: state_value, current_stage_id },
    )
    .map_err(|e| e.to_string())?;
    expect_ok(resp)
}

#[tauri::command]
pub fn set_step_run(
    step_id: String,
    state_value: String,
    session_id: Option<String>,
    reason: Option<String>,
    state: State<CommandConnection>,
    compat: State<DaemonCompatState>,
) -> Result<(), String> {
    let resp = send_command_reconnecting(
        &state.0,
        &current_compat(&compat),
        &Request::SetStepRun { step_id, state: state_value, session_id, reason },
    )
    .map_err(|e| e.to_string())?;
    expect_ok(resp)
}

fn delete_board_impl(
    command_conn: &Mutex<UnixStream>,
    workspace_id: String,
    compat: &DaemonCompat,
) -> anyhow::Result<()> {
    let resp = send_command_reconnecting(command_conn, compat, &Request::DeleteBoard { workspace_id })?;
    match resp {
        Response::Ok => Ok(()),
        other => anyhow::bail!("expected Ok, got {other:?}"),
    }
}

#[tauri::command]
pub fn delete_board(
    workspace_id: String,
    state: State<CommandConnection>,
    compat: State<DaemonCompatState>,
) -> Result<(), String> {
    delete_board_impl(&state.0, workspace_id, &current_compat(&compat)).map_err(|e| e.to_string())
}

/// Rides the STREAMING connection (fire-and-forget, mirroring
/// write_input): the daemon intercepts WatchGavinRoot to capture that
/// connection's writer for pushes, and the initial scan arrives as the
/// first gavin-tree-changed event rather than a reply.
#[tauri::command]
pub fn watch_gavin_root(
    workspace_id: String,
    root_path: String,
    conn: State<DaemonConnection>,
    compat: State<DaemonCompatState>,
) -> Result<(), String> {
    send_request(
        &conn.writer,
        &Request::WatchGavinRoot { workspace_id, root_path },
        &current_compat(&compat),
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn unwatch_gavin_root(
    workspace_id: String,
    state: State<CommandConnection>,
    compat: State<DaemonCompatState>,
) -> Result<(), String> {
    let resp = send_command_reconnecting(&state.0, &current_compat(&compat), &Request::UnwatchGavinRoot { workspace_id })
        .map_err(|e| e.to_string())?;
    match resp {
        Response::Ok => Ok(()),
        Response::Error { message } => Err(message),
        other => Err(format!("unexpected response: {other:?}")),
    }
}

#[tauri::command]
pub fn get_gavin_tree(
    workspace_id: String,
    state: State<CommandConnection>,
    compat: State<DaemonCompatState>,
) -> Result<protocol::GavinTree, String> {
    let resp = send_command_reconnecting(&state.0, &current_compat(&compat), &Request::GetGavinTree { workspace_id })
        .map_err(|e| e.to_string())?;
    match resp {
        Response::GavinTreeSnapshot { tree, .. } => Ok(tree),
        Response::Error { message } => Err(message),
        other => Err(format!("unexpected response: {other:?}")),
    }
}

#[tauri::command]
pub fn init_gavin_root(
    root_path: String,
    workspace_name: String,
    state: State<CommandConnection>,
    compat: State<DaemonCompatState>,
) -> Result<(), String> {
    let resp = send_command_reconnecting(
        &state.0,
        &current_compat(&compat),
        &Request::InitGavinRoot { root_path, workspace_name },
    )
    .map_err(|e| e.to_string())?;
    match resp {
        Response::Ok => Ok(()),
        Response::Error { message } => Err(message),
        other => Err(format!("unexpected response: {other:?}")),
    }
}

#[tauri::command]
pub fn create_gavin_context(
    parent_folder: String,
    state: State<CommandConnection>,
    compat: State<DaemonCompatState>,
) -> Result<(), String> {
    let resp = send_command_reconnecting(&state.0, &current_compat(&compat), &Request::CreateGavinContext { parent_folder })
        .map_err(|e| e.to_string())?;
    match resp {
        Response::Ok => Ok(()),
        Response::Error { message } => Err(message),
        other => Err(format!("unexpected response: {other:?}")),
    }
}

#[tauri::command]
pub fn add_external_gavin_context(
    root_path: String,
    folder: String,
    state: State<CommandConnection>,
    compat: State<DaemonCompatState>,
) -> Result<(), String> {
    let resp = send_command_reconnecting(
        &state.0,
        &current_compat(&compat),
        &Request::AddExternalGavinContext { root_path, folder },
    )
    .map_err(|e| e.to_string())?;
    match resp {
        Response::Ok => Ok(()),
        Response::Error { message } => Err(message),
        other => Err(format!("unexpected response: {other:?}")),
    }
}

#[tauri::command]
pub fn remove_external_gavin_context(
    root_path: String,
    folder: String,
    state: State<CommandConnection>,
    compat: State<DaemonCompatState>,
) -> Result<(), String> {
    let resp = send_command_reconnecting(
        &state.0,
        &current_compat(&compat),
        &Request::RemoveExternalGavinContext { root_path, folder },
    )
    .map_err(|e| e.to_string())?;
    match resp {
        Response::Ok => Ok(()),
        Response::Error { message } => Err(message),
        other => Err(format!("unexpected response: {other:?}")),
    }
}

/// Local fs probe for the set-root flow's init-vs-bind fork (spec §2) --
/// the frontend can't stat the disk itself, and watching hasn't started
/// yet at the moment the picker returns.
#[tauri::command]
pub fn gavin_root_exists(root_path: String) -> bool {
    std::path::Path::new(&root_path).join(".gavin-root").is_dir()
}

/// The demo fixture, as (path relative to the bound root, contents).
/// One table on purpose: every smoke-checklist section's data is visible
/// at once, and re-seeding is a plain overwrite -- the README's
/// "re-click = reset".
///
/// Two things are deliberately NOT here: `CLAUDE.md` (the "edit-creates"
/// item needs it absent so the first save creates it) and `.mcp.json`
/// (the "mcp-setup" item writes it). `src/api/` is left without a
/// `.gavin/` for the explorer's "+ context" item to scaffold.
const SEED_FILES: &[(&str, &str)] = &[
    // -- Root context: PRD (overwritten with real prose, so the home's
    // 15-line excerpt shows something worth reading).
    (
        ".gavin-root/PRD.md",
        "# Smoke Test — Product Requirements\n\n\
         > Lead document for this workspace. The main agent reads it first;\n\
         > every plan under `.gavin*/plans/` should trace back to a line here.\n\n\
         ## Vision\n\n\
         A terminal workspace where coding agents and the person directing them\n\
         share one surface: sessions, plans, and the documents that govern them\n\
         all live in the same window, and the files on disk are the only truth.\n\n\
         ## Current focus\n\n\
         - Plans are markdown files; the board is a projection of their frontmatter.\n\
         - A main agent session per workspace, started deliberately, never on its own.\n\
         - Editing a plan, a PRD, or CLAUDE.md happens in-app without a context switch.\n\
         - Agents reach the same data over MCP that the UI shows.\n\n\
         ## Out of scope\n\n\
         - Renaming or deleting plans from the UI (create-only, by design).\n\
         - Hosting more than one main agent per workspace.\n\
         - Anything that would make the board, rather than the files, canonical.\n",
    ),
    // -- Root plans. Statuses span all three default columns plus one
    // unmatched status, so the board has an auto column from the start.
    (
        ".gavin-root/plans/demo.md",
        "---\ntitle: Demo plan\nstatus: To Do\npriority: high\n---\n# Demo plan\n\n\
         Drag me between columns -- the status line in this file follows.\n",
    ),
    (
        ".gavin-root/plans/stray.md",
        "---\ntitle: Stray status\nstatus: Shipped\n---\n# Stray\n\n\
         My status matches no column, so I live in an auto column until dragged out.\n",
    ),
    (".gavin-root/plans/broken.md", "---\nstatus: To Do\nthis frontmatter never closes\n"),
    // Three plans sharing one column, with distinct priorities: enough to
    // drag one DOWN past two others, which is the placeholder off-by-one
    // the kanban rework fixed ("drag-placeholder"). None carry `order:` --
    // the first reorder materializing it is itself an assertion.
    (
        ".gavin-root/plans/drag-one.md",
        "---\ntitle: Reorder me (first)\nstatus: In Progress\npriority: urgent\n---\n\
         # Reorder me (first)\n\n\
         Drag this card DOWN past the other two: it must land exactly where the\n\
         dashed placeholder sat, not one slot further.\n",
    ),
    (
        ".gavin-root/plans/drag-two.md",
        "---\ntitle: Reorder me (second)\nstatus: In Progress\npriority: medium\n---\n\
         # Reorder me (second)\n\n\
         After a reorder, `git diff` on this folder should show `order:` lines\n\
         and nothing else.\n",
    ),
    (
        ".gavin-root/plans/drag-three.md",
        "---\ntitle: Reorder me (third)\nstatus: In Progress\npriority: low\n---\n\
         # Reorder me (third)\n\n\
         The order must survive the ~3s watcher echo, not snap back.\n",
    ),
    (
        ".gavin-root/plans/shipped-note.md",
        "---\ntitle: Already done\nstatus: Done\n---\n# Already done\n\n\
         Gives the Done column a card, so column counts on the home are not all zero.\n",
    ),
    // -- Card nesting (card-model spec). A plan with a checklist for its
    // n/m progress, two tasks nested inside it (parent + NO status), one
    // freed into a column (parent + status, wearing the plan's chip), a
    // task pointing at a parent that does not exist, and a note -- the
    // kind that must refuse to nest at all.
    (
        ".gavin-root/plans/auth-rework.md",
        "---\ntitle: Auth rework\nkind: plan\nstatus: In Progress\npriority: high\n\
         labels: backend, security\n---\n# Auth rework\n\n\
         The parent card for the nesting fixtures. Expand it to see its children.\n\n\
         - [x] Audit the current token flow\n\
         - [x] Pick a refresh strategy\n\
         - [ ] Rotate signing keys\n\
         - [ ] Migrate existing sessions\n",
    ),
    (
        ".gavin-root/plans/auth-token-refresh.md",
        "---\ntitle: Token refresh\nkind: task\nparent: auth-rework.md\n---\n\
         # Token refresh\n\n\
         A parent and no status line, so this renders INSIDE the Auth rework\n\
         card rather than in any column. Give it a status to free it.\n",
    ),
    (
        ".gavin-root/plans/auth-cookie-flags.md",
        "---\ntitle: Cookie flags\nkind: task\nparent: auth-rework.md\n---\n\
         # Cookie flags\n\n\
         A second nested child, so the expandable area has more than one row\n\
         and un-parenting one leaves the other in place.\n",
    ),
    (
        ".gavin-root/plans/auth-key-rotation.md",
        "---\ntitle: Key rotation\nkind: task\nstatus: To Do\nparent: auth-rework.md\n\
         priority: urgent\n---\n# Key rotation\n\n\
         Parent AND status: freed into its column, still wearing the parent\n\
         plan's title as a chip.\n",
    ),
    (
        ".gavin-root/plans/orphan-task.md",
        "---\ntitle: Orphaned task\nkind: task\nparent: no-such-plan.md\n---\n\
         # Orphaned task\n\n\
         Points at a parent that does not exist: must degrade visibly with a\n\
         warning, never vanish from the board.\n",
    ),
    (
        ".gavin-root/plans/scratch-note.md",
        "---\ntitle: Scratch note\nkind: note\nstatus: To Do\n---\n# Scratch note\n\n\
         A note. Notes refuse to nest -- dragging this onto a plan card must not\n\
         parent it.\n",
    ),
    // -- Root docs and specs: the explorer's tree groups are empty
    // without these, which reads like a bug rather than an empty folder.
    (
        ".gavin-root/docs/architecture.md",
        "# Architecture notes\n\n\
         Files are truth. The daemon owns PTYs and the gavin file model; the app\n\
         renders projections of both and writes back through the same requests an\n\
         MCP agent uses.\n\n\
         ## Why a daemon\n\n\
         Sessions outlive the window. Closing the app must not kill a running\n\
         agent, and reopening it must reattach rather than respawn.\n",
    ),
    (
        ".gavin-root/docs/glossary.md",
        "# Glossary\n\n\
         - **root context** — the `.gavin-root/` at the workspace root.\n\
         - **context** — any folder holding a `.gavin/`, scoped to its subtree.\n\
         - **plan** — a markdown file whose frontmatter drives a board card.\n\
         - **auto column** — a column the board invents for an unmatched status.\n",
    ),
    (
        ".gavin-root/specs/board-behaviour.md",
        "# Spec — board behaviour\n\n\
         A card's position is a projection. Dragging writes frontmatter; the\n\
         watcher echoes the change back within ~3s and the card must not move a\n\
         second time when it does.\n\n\
         ## Open questions\n\n\
         Whether `order:` should be dense or sparse. Currently sparse.\n",
    ),
    // -- Second context: proves a context board shows ONLY its own plans,
    // and gives the explorer a non-root context with all three groups.
    (
        "src/auth/.gavin/plans/login.md",
        "---\ntitle: Login flow\nstatus: To Do\npriority: high\n---\n# Login flow\n\n\
         cd into src/auth in a terminal to see the pane's board icon.\n",
    ),
    (
        "src/auth/.gavin/plans/session-expiry.md",
        "---\ntitle: Session expiry\nstatus: In Progress\npriority: medium\n---\n\
         # Session expiry\n\n\
         A second plan here, so the context board is visibly filtered rather than\n\
         coincidentally showing one card.\n",
    ),
    (
        "src/auth/.gavin/docs/auth-notes.md",
        "# Auth notes\n\n\
         Tokens are refreshed on the client; the server only ever validates.\n",
    ),
    // -- Third context: makes the home's \"N contexts\" count meaningful and
    // gives the board icon a second target to cd between.
    (
        "services/billing/.gavin/plans/invoices.md",
        "---\ntitle: Invoice generation\nstatus: To Do\npriority: medium\n---\n\
         # Invoice generation\n\n\
         Lives in a third context, two levels down from the root.\n",
    ),
    (
        "services/billing/.gavin/specs/pricing.md",
        "# Spec — pricing\n\n\
         Prices are integers in minor units. No floats anywhere near money.\n",
    ),
    // -- Plain source file, no gavin involvement: the editor must offer
    // Plain / Edit and NOT Formatted for a non-markdown file.
    (
        "src/api/handler.rs",
        "// A plain source file: cmd+click its path in terminal output to open it,\n\
         // and check the mode switch offers Plain / Edit but no Formatted.\n\
         pub fn handle(request: &str) -> String {\n    \
             format!(\"handled: {request}\")\n\
         }\n",
    ),
];

/// Content for the over-cap file, generated rather than stored so the
/// fixture tracks `MAX_VIEWER_FILE_BYTES` instead of drifting from it if
/// the cap ever moves.
fn oversized_log() -> String {
    let cap = crate::fileviewer::MAX_VIEWER_FILE_BYTES;
    let mut out = String::with_capacity(cap + 128);
    let mut line = 1;
    while out.len() <= cap {
        out.push_str(&format!("{line:07} over-cap log line; the editor must refuse to edit this file\n"));
        line += 1;
    }
    out
}

/// Dev-only: writes the smoke-test demo fixtures into an already-initialized
/// root. Idempotent -- re-seeding overwrites the demo files (that IS the
/// reset). The live watcher turns each write into board updates, so this
/// also exercises the whole push pipeline end to end.
#[tauri::command]
pub fn seed_smoke_test_data(root_path: String) -> Result<(), String> {
    if !cfg!(debug_assertions) {
        return Err("seed_smoke_test_data is dev-only".to_string());
    }
    let root = std::path::Path::new(&root_path);
    if !root.join(".gavin-root").is_dir() {
        return Err("initialize gavin in this folder first (Set root… → Initialize)".to_string());
    }
    let err = |e: std::io::Error| e.to_string();
    for (rel, contents) in SEED_FILES {
        let path = root.join(rel);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(err)?;
        }
        std::fs::write(path, contents).map_err(err)?;
    }
    std::fs::write(root.join("big.log"), oversized_log()).map_err(err)?;
    Ok(())
}

/// Plan authoring from the app (the explorer's "New plan"). Routes
/// through the same daemon request MCP agents use, so validation and the
/// never-overwrite guarantee are identical no matter who creates a plan.
/// Returns the created path.
#[tauri::command]
pub fn delete_card_file(
    path: String,
    state: State<CommandConnection>,
    compat: State<DaemonCompatState>,
) -> Result<(), String> {
    let resp = send_command_reconnecting(&state.0, &current_compat(&compat), &Request::DeleteCardFile { path })
        .map_err(|e| e.to_string())?;
    match resp {
        Response::Ok => Ok(()),
        Response::Error { message } => Err(message),
        other => Err(format!("unexpected daemon reply: {other:?}")),
    }
}

#[tauri::command]
pub fn link_card_session(
    workspace_id: String,
    path: String,
    session_id: String,
    cwd: String,
    command: Option<String>,
    state: State<CommandConnection>,
    compat: State<DaemonCompatState>,
) -> Result<(), String> {
    let resp = send_command_reconnecting(
        &state.0,
        &current_compat(&compat),
        &Request::LinkCardSession { workspace_id, path, session_id, cwd, command },
    )
    .map_err(|e| e.to_string())?;
    match resp {
        Response::Ok => Ok(()),
        Response::Error { message } => Err(message),
        other => Err(format!("unexpected daemon reply: {other:?}")),
    }
}

#[tauri::command]
pub fn unlink_card_session(
    workspace_id: String,
    path: String,
    state: State<CommandConnection>,
    compat: State<DaemonCompatState>,
) -> Result<(), String> {
    let resp = send_command_reconnecting(
        &state.0,
        &current_compat(&compat),
        &Request::UnlinkCardSession { workspace_id, path },
    )
    .map_err(|e| e.to_string())?;
    match resp {
        Response::Ok => Ok(()),
        Response::Error { message } => Err(message),
        other => Err(format!("unexpected daemon reply: {other:?}")),
    }
}

#[tauri::command]
pub fn set_checklist_item(
    path: String,
    line_index: u32,
    expected_text: String,
    checked: bool,
    state: State<CommandConnection>,
    compat: State<DaemonCompatState>,
) -> Result<(), String> {
    let resp = send_command_reconnecting(
        &state.0,
        &current_compat(&compat),
        &Request::SetChecklistItem { path, line_index, expected_text, checked },
    )
    .map_err(|e| e.to_string())?;
    match resp {
        Response::Ok => Ok(()),
        Response::Error { message } => Err(message),
        other => Err(format!("unexpected daemon reply: {other:?}")),
    }
}

/// Returns the created task card's path.
#[tauri::command]
pub fn promote_checklist_item(
    plan_path: String,
    item: String,
    state: State<CommandConnection>,
    compat: State<DaemonCompatState>,
) -> Result<String, String> {
    let resp = send_command_reconnecting(
        &state.0,
        &current_compat(&compat),
        &Request::PromoteChecklistItem { plan_path, item },
    )
    .map_err(|e| e.to_string())?;
    match resp {
        Response::TaskPromoted { path } => Ok(path),
        Response::Error { message } => Err(message),
        other => Err(format!("unexpected daemon reply: {other:?}")),
    }
}

#[tauri::command]
pub fn create_plan(
    context_folder: String,
    file_name: String,
    title: String,
    status: Option<String>,
    priority: Option<String>,
    body: Option<String>,
    kind: Option<String>,
    parent: Option<String>,
    state: State<CommandConnection>,
    compat: State<DaemonCompatState>,
) -> Result<String, String> {
    let resp = send_command_reconnecting(
        &state.0,
        &current_compat(&compat),
        &Request::CreatePlan { context_folder, file_name, title, status, priority, body, kind, parent },
    )
    .map_err(|e| e.to_string())?;
    match resp {
        Response::PlanCreated { path } => Ok(path),
        Response::Error { message } => Err(message),
        other => Err(format!("unexpected response: {other:?}")),
    }
}

#[tauri::command]
/// Returns the card's path AFTER the write: a status write can archive
/// the file into `plans/done/`, and the UI holds that path as identity.
pub fn set_plan_frontmatter_field(
    path: String,
    key: String,
    value: String,
    state: State<CommandConnection>,
    compat: State<DaemonCompatState>,
) -> Result<String, String> {
    let resp = send_command_reconnecting(
        &state.0,
        &current_compat(&compat),
        &Request::SetPlanFrontmatterField { path, key, value },
    )
    .map_err(|e| e.to_string())?;
    match resp {
        Response::PlanFieldSet { path } => Ok(path),
        Response::Error { message } => Err(message),
        other => Err(format!("unexpected response: {other:?}")),
    }
}

#[tauri::command]
pub fn set_root_config_field(
    root_path: String,
    key: String,
    value: String,
    state: State<CommandConnection>,
    compat: State<DaemonCompatState>,
) -> Result<(), String> {
    let resp = send_command_reconnecting(
        &state.0,
        &current_compat(&compat),
        &Request::SetRootConfigField { root_path, key, value },
    )
    .map_err(|e| e.to_string())?;
    match resp {
        Response::Ok => Ok(()),
        Response::Error { message } => Err(message),
        other => Err(format!("unexpected response: {other:?}")),
    }
}

#[cfg(test)]
mod migration_tests {
    use super::*;

    fn rooted(dir: &std::path::Path) -> String {
        let g = dir.join(".gavin-root");
        std::fs::create_dir_all(&g).unwrap();
        std::fs::write(g.join("config.toml"), "version = 1\n").unwrap();
        dir.to_string_lossy().to_string()
    }

    #[test]
    fn carries_a_legacy_agent_command_into_config_toml_once() {
        let dir = tempfile::tempdir().unwrap();
        let root = rooted(dir.path());

        carry_over_agent_command(&root, Some("claude --model opus")).unwrap();
        let after = std::fs::read_to_string(dir.path().join(".gavin-root/config.toml")).unwrap();
        assert!(after.contains("command = \"claude --model opus\""));

        // Runs again with a different legacy value -> no-op, the file wins.
        carry_over_agent_command(&root, Some("something-else")).unwrap();
        let after2 = std::fs::read_to_string(dir.path().join(".gavin-root/config.toml")).unwrap();
        assert!(after2.contains("command = \"claude --model opus\""));
        assert!(!after2.contains("something-else"));
    }

    #[test]
    fn carry_over_is_a_no_op_without_a_legacy_value() {
        let dir = tempfile::tempdir().unwrap();
        let root = rooted(dir.path());
        carry_over_agent_command(&root, None).unwrap();
        carry_over_agent_command(&root, Some("   ")).unwrap();
        assert_eq!(
            std::fs::read_to_string(dir.path().join(".gavin-root/config.toml")).unwrap(),
            "version = 1\n"
        );
    }
}

#[cfg(test)]
mod main_session_tests {
    use super::test_support::{fake_daemon_replying_with, parity_compat};
    use super::*;

    fn ws_with_main(id: &str, main: Option<&str>) -> Workspace {
        Workspace {
            id: id.to_string(),
            name: id.to_string(),
            pages: vec![],
            active_page_id: None,
            active_view: None,
            hub_view: None,
            root_path: Some("/tmp/ws".to_string()),
            main_session_id: main.map(|m| m.to_string()),
            legacy_agent_command: None,
            color: None,
            notify_needs_input: true,
            notify_finished: true,
            git_view: None,
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
        reconcile_main_sessions(&mut workspaces, &Mutex::new(client), &parity_compat()).unwrap();
        assert_eq!(workspaces[0].main_session_id.as_deref(), Some("agent-1"));
    }

    #[test]
    fn clears_an_exited_or_unknown_main_session_without_respawning() {
        let (client, _dir) = fake_daemon_replying_with(vec![Response::SessionList {
            sessions: vec![summary("agent-1", "exited")],
        }]);
        let mut workspaces =
            vec![ws_with_main("ws-1", Some("agent-1")), ws_with_main("ws-2", Some("never-existed"))];
        reconcile_main_sessions(&mut workspaces, &Mutex::new(client), &parity_compat()).unwrap();
        assert_eq!(workspaces[0].main_session_id, None);
        assert_eq!(workspaces[1].main_session_id, None);
    }

    #[test]
    fn skips_the_round_trip_when_no_workspace_has_a_main_session() {
        // An exhausted fake daemon cannot answer, so this passing proves
        // no ListSessions was sent at all.
        let (client, _dir) = fake_daemon_replying_with(vec![]);
        let mut workspaces = vec![ws_with_main("ws-1", None)];
        reconcile_main_sessions(&mut workspaces, &Mutex::new(client), &parity_compat()).unwrap();
        assert_eq!(workspaces[0].main_session_id, None);
    }
}

#[cfg(test)]
mod version_probe_tests {
    use super::test_support::fake_daemon_replying_with;
    use super::*;

    #[test]
    fn matching_version_passes() {
        let (client, _dir) = fake_daemon_replying_with(vec![Response::ProtocolVersion {
            version: protocol::PROTOCOL_VERSION,
        }]);
        let compat = verify_daemon_protocol(&Mutex::new(client)).unwrap();
        assert_eq!(compat.daemon_version, protocol::PROTOCOL_VERSION);
        assert!(!compat.degraded);
    }

    #[test]
    fn an_older_in_window_daemon_connects_degraded_instead_of_erroring() {
        // This is the behaviour the whole feature exists for: an older
        // daemon inside the window used to be a hard error that forced a
        // daemon-killing restart. It must now come back Ok, just flagged.
        let (client, _dir) = fake_daemon_replying_with(vec![Response::ProtocolVersion {
            version: protocol::MIN_COMPATIBLE_VERSION,
        }]);
        let compat = verify_daemon_protocol(&Mutex::new(client)).unwrap();
        assert_eq!(compat.daemon_version, protocol::MIN_COMPATIBLE_VERSION);
        assert!(compat.degraded);
    }

    #[test]
    fn newer_daemon_names_the_app_as_stale() {
        let (client, _dir) = fake_daemon_replying_with(vec![Response::ProtocolVersion {
            version: protocol::PROTOCOL_VERSION + 1,
        }]);
        let err = verify_daemon_protocol(&Mutex::new(client)).unwrap_err().to_string();
        assert!(err.contains("newer than this app"));
    }

    #[test]
    fn unparsed_probe_or_error_reply_names_the_daemon_as_unreachable() {
        // An old daemon can't parse the probe at all: closed connection.
        // This is a distinct band from an explicit too-low version -- the
        // daemon never got far enough to report one -- but per the
        // 2026-08-07 incident it must still land on a named, actionable
        // error rather than a bare connection-closed mystery.
        let (client, _dir) = fake_daemon_replying_with(vec![]);
        let err = verify_daemon_protocol(&Mutex::new(client)).unwrap_err().to_string();
        assert!(err.contains("too old to talk to this app"));
        // A daemon that replies Error (unknown request) maps the same way.
        let (client, _dir) = fake_daemon_replying_with(vec![Response::Error {
            message: "unknown".to_string(),
        }]);
        let err = verify_daemon_protocol(&Mutex::new(client)).unwrap_err().to_string();
        assert!(err.contains("too old to talk to this app"));
    }
}

#[cfg(test)]
mod classify_tests {
    use super::*;

    #[test]
    fn an_exactly_matching_daemon_is_not_degraded() {
        let c = classify(12, 12, 5).unwrap();
        assert_eq!(c.daemon_version, 12);
        assert!(!c.degraded);
    }

    #[test]
    fn an_older_daemon_inside_the_window_is_usable_but_degraded() {
        let c = classify(9, 12, 5).unwrap();
        assert!(c.degraded);
        assert_eq!(c.daemon_version, 9);
    }

    #[test]
    fn the_floor_itself_is_inside_the_window() {
        assert!(classify(5, 12, 5).is_ok());
    }

    #[test]
    fn a_daemon_below_the_floor_is_rejected() {
        let err = classify(4, 12, 5).unwrap_err();
        assert!(err.contains("too old"), "message should say what to do: {err}");
    }

    #[test]
    fn a_daemon_newer_than_the_app_is_rejected() {
        let err = classify(13, 12, 5).unwrap_err();
        assert!(err.contains("newer"));
    }
}

#[cfg(test)]
mod gate_tests {
    use super::*;

    #[test]
    fn a_request_the_daemon_predates_is_refused_before_it_is_sent() {
        let compat = DaemonCompat { daemon_version: 9, app_version: 12, degraded: true };
        let too_new = Request::NameSession { session_id: "s-1".into(), name: "x".into() };
        let err = gate(&too_new, &compat).unwrap_err();
        assert!(err.contains("v10"), "should name the version needed: {err}");
        assert!(err.contains("v9"), "should name the version running: {err}");
    }

    #[test]
    fn a_request_the_daemon_understands_passes() {
        let compat = DaemonCompat { daemon_version: 9, app_version: 12, degraded: true };
        assert!(gate(&Request::ListSessions, &compat).is_ok());
    }

    #[test]
    fn an_exact_match_gates_nothing() {
        let compat = DaemonCompat { daemon_version: 12, app_version: 12, degraded: false };
        let newest = Request::NameSession { session_id: "s-1".into(), name: "x".into() };
        assert!(gate(&newest, &compat).is_ok());
    }

    /// One sample of every `Request` variant, `Unknown` included. Field
    /// values are placeholders -- `gate` and `min_version_for` only look at
    /// which variant a request is, never its payload -- so the only thing
    /// that has to be right here is that every variant in
    /// `crates/protocol/src/lib.rs` has exactly one entry below. A variant
    /// added there without a matching entry here would silently narrow the
    /// sweep below rather than fail loudly, which is a real gap: nothing
    /// else forces this list to stay exhaustive the way `min_version_for`'s
    /// own match does. Reviewed by hand against the enum each time it
    /// changes.
    fn one_of_every_request_variant() -> Vec<Request> {
        vec![
            Request::CreateSession { workspace_path: "w".into(), cwd: "c".into(), command: None },
            Request::ListSessions,
            Request::WriteInput { id: "s".into(), data: "d".into() },
            Request::ResizeSession { id: "s".into(), cols: 80, rows: 24 },
            Request::KillSession { id: "s".into() },
            Request::Attach { id: "s".into() },
            Request::GetBoard { workspace_id: "w".into() },
            Request::SetBoard { workspace_id: "w".into(), columns: vec![], labels: vec![] },
            Request::DeleteBoard { workspace_id: "w".into() },
            Request::WatchGavinRoot { workspace_id: "w".into(), root_path: "r".into() },
            Request::UnwatchGavinRoot { workspace_id: "w".into() },
            Request::GetGavinTree { workspace_id: "w".into() },
            Request::InitGavinRoot { root_path: "r".into(), workspace_name: "n".into() },
            Request::CreateGavinContext { parent_folder: "p".into() },
            Request::AddExternalGavinContext { root_path: "r".into(), folder: "f".into() },
            Request::RemoveExternalGavinContext { root_path: "r".into(), folder: "f".into() },
            Request::SetPlanFrontmatterField { path: "p".into(), key: "k".into(), value: "v".into() },
            Request::SetRootConfigField { root_path: "r".into(), key: "k".into(), value: "v".into() },
            Request::ScanGavinRoot { root_path: "r".into() },
            Request::ReadPrd { root_path: "r".into() },
            Request::CreatePlan {
                context_folder: "c".into(),
                file_name: "f".into(),
                title: "t".into(),
                status: None,
                priority: None,
                body: None,
                kind: None,
                parent: None,
            },
            Request::GetBoardByRoot { root_path: "r".into() },
            Request::SpawnAgentSession { root_path: "r".into(), cwd: "c".into(), command: "cmd".into() },
            Request::DeleteCardFile { path: "p".into() },
            Request::SetChecklistItem {
                path: "p".into(),
                line_index: 0,
                expected_text: "x".into(),
                checked: true,
            },
            Request::PromoteChecklistItem { plan_path: "p".into(), item: "i".into() },
            Request::LinkCardSession {
                workspace_id: "w".into(),
                path: "p".into(),
                session_id: "s".into(),
                cwd: "c".into(),
                command: None,
            },
            Request::UnlinkCardSession { workspace_id: "w".into(), path: "p".into() },
            Request::GetOrchestration { workspace_id: "w".into() },
            Request::SetOrchestration { workspace_id: "w".into(), rails: vec![], conflict_notes: vec![] },
            Request::SetRailRun { rail_id: "r".into(), state: "idle".into(), current_stage_id: None },
            Request::SetStepRun { step_id: "s".into(), state: "pending".into(), session_id: None, reason: None },
            Request::GetOrchestrationByRoot { root_path: "r".into() },
            Request::SetOrchestrationByRoot { root_path: "r".into(), rails: vec![], conflict_notes: vec![] },
            Request::GitDirtyPaths { cwd: "c".into(), limit: 10 },
            Request::NameSession { session_id: "s".into(), name: "n".into() },
            Request::GetProtocolVersion,
            Request::Shutdown,
            // Deserialize-only in production, but nothing stops Rust code
            // from constructing it -- and the sweep needs to, to prove it
            // is refused everywhere rather than just trusting the comment
            // on `min_version_for`'s `u32::MAX` arm.
            Request::Unknown,
        ]
    }

    /// The sweep: across EVERY daemon version in the compat window (not
    /// just a representative slice of it), `gate`'s verdict must agree
    /// with what `min_version_for` reports for EVERY request variant, not
    /// just the couple of variants the tests above exercise.
    ///
    /// This used to sample only three daemon versions (the floor, v9, and
    /// parity). Because the version table jumps v8 -> v10, no variant
    /// needs exactly v9, so that sample put only 3 of the request variants
    /// on their own `needed == daemon_version` boundary -- the case below
    /// that actually catches comparison-operator drift. Iterating the
    /// whole window instead costs nothing (39 variants * 8 versions = 312
    /// trivial assertions) and puts roughly a third of the variants on
    /// their boundary.
    ///
    /// Honest limit: `gate` computes `needed = min_version_for(req)` and
    /// this test's own `should_pass` comes from that same call, so this
    /// cannot catch a version number in the table that is simply wrong in
    /// an absolute sense (e.g. a variant attributed to v9 when it should
    /// truly be v10) -- only the humans maintaining the table can catch
    /// that. What it DOES catch, at every variant and (crucially) right at
    /// the `needed == daemon_version` boundary rather than only away from
    /// it: `gate`'s comparison drifting from "permitted exactly when
    /// `needed <= daemon_version`" -- an accidental `>=` in place of `>`,
    /// say. Verified empirically while writing this test: that exact
    /// one-character change made this sweep fail (LinkCardSession, needed
    /// v5, refused by a v5 daemon) while the narrower tests earlier in
    /// this module and `a_command_the_daemon_predates_never_reaches_the_wire`
    /// (each pinned to one variant away from any boundary) stayed green.
    #[test]
    fn gate_agrees_with_min_version_for_across_every_variant_at_every_version_in_the_window() {
        let daemon_versions =
            (protocol::MIN_COMPATIBLE_VERSION..=protocol::PROTOCOL_VERSION).collect::<Vec<_>>();

        for &daemon_version in &daemon_versions {
            let compat = DaemonCompat {
                daemon_version,
                app_version: protocol::PROTOCOL_VERSION,
                degraded: daemon_version < protocol::PROTOCOL_VERSION,
            };
            for req in one_of_every_request_variant() {
                let needed = protocol::min_version_for(&req);
                let should_pass = needed <= daemon_version;
                let verdict = gate(&req, &compat);
                assert_eq!(
                    verdict.is_ok(),
                    should_pass,
                    "{req:?} needs v{needed}; a v{daemon_version} daemon should {} it, but gate returned {verdict:?}",
                    if should_pass { "permit" } else { "refuse" },
                );
            }
        }
    }
}

#[cfg(test)]
mod kanban_command_tests {
    use super::test_support::{fake_daemon_capturing_requests, fake_daemon_replying_with, parity_compat};
    use super::*;
    use std::os::unix::net::UnixListener;

    #[test]
    fn get_board_impl_returns_the_boards_columns_and_labels() {
        let (client, _dir) = fake_daemon_replying_with(vec![Response::Board {
            card_sessions: vec![],
            columns: vec![Column { id: "c1".to_string(), name: "To Do".to_string(), position: 0 }],
            labels: vec![Label { id: "l1".to_string(), name: "urgent".to_string(), color: "#f00".to_string() }],
        }]);
        let conn = Mutex::new(client);

        let board = get_board_impl(&conn, "ws-1".to_string(), &parity_compat()).unwrap();

        assert_eq!(board.columns.len(), 1);
        assert_eq!(board.columns[0].name, "To Do");
        assert_eq!(board.labels.len(), 1);
    }

    /// Regression for the Critical finding in fix round 1: `get_board_impl`
    /// -- one of the several functions here that are unit-tested against a
    /// bare `Mutex<UnixStream>` pointed at a tempdir fake socket, with no
    /// path threaded through for a reconnect -- must retry against THAT
    /// SAME fake socket when its connection drops, never against
    /// `protocol::socket_path()` (the real daemon). Built by hand rather
    /// than via `fake_daemon_replying_with` because that helper serves only
    /// one connection; this needs a second `accept()` on the identical
    /// listener to prove the reconnect targets it. If the retry instead
    /// resolved the real socket path, this test would either fail fast (no
    /// real daemon in the test environment) or hang forever waiting on a
    /// second local connection that would never arrive -- either way it
    /// would not pass quickly and cleanly the way it does here.
    #[test]
    fn get_board_impl_retries_against_the_same_fake_socket_not_the_real_daemon() {
        let dir = tempfile::tempdir().unwrap();
        let sock = dir.path().join("board-retry.sock");
        let listener = UnixListener::bind(&sock).unwrap();

        let server = std::thread::spawn(move || {
            let (first, _) = listener.accept().unwrap();
            drop(first);
            let (mut second, _) = listener.accept().unwrap();
            let mut reader = BufReader::new(second.try_clone().unwrap());
            let _req: Request = read_message(&mut reader).unwrap().unwrap();
            write_message(
                &mut second,
                &Response::Board {
                    columns: vec![Column { id: "c1".to_string(), name: "To Do".to_string(), position: 0 }],
                    labels: vec![],
                    card_sessions: vec![],
                },
            )
            .unwrap();
        });

        let conn = Mutex::new(UnixStream::connect(&sock).unwrap());
        let board = get_board_impl(&conn, "ws-1".to_string(), &parity_compat()).unwrap();

        assert_eq!(board.columns.len(), 1);
        assert_eq!(board.columns[0].name, "To Do");
        server.join().unwrap();
    }

    #[test]
    fn get_board_impl_sends_the_given_workspace_id() {
        let (client, captured, _dir) =
            fake_daemon_capturing_requests(vec![Response::Board { columns: vec![], labels: vec![], card_sessions: vec![] }]);
        let conn = Mutex::new(client);

        get_board_impl(&conn, "ws-42".to_string(), &parity_compat()).unwrap();

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

        let result = get_board_impl(&conn, "ws-1".to_string(), &parity_compat());

        assert!(result.is_err());
    }

    #[test]
    fn set_board_impl_sends_the_given_columns_and_labels() {
        let (client, captured, _dir) = fake_daemon_capturing_requests(vec![Response::Ok]);
        let conn = Mutex::new(client);
        let columns = vec![Column { id: "c1".to_string(), name: "Only".to_string(), position: 0,  }];

        set_board_impl(&conn, "ws-1".to_string(), columns.clone(), vec![], &parity_compat()).unwrap();

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

        let result = set_board_impl(&conn, "ws-1".to_string(), vec![], vec![], &parity_compat());

        assert!(result.is_err());
    }

    #[test]
    fn delete_board_impl_sends_the_given_workspace_id() {
        let (client, captured, _dir) = fake_daemon_capturing_requests(vec![Response::Ok]);
        let conn = Mutex::new(client);

        delete_board_impl(&conn, "ws-1".to_string(), &parity_compat()).unwrap();

        let requests = captured.lock().unwrap();
        match &requests[0] {
            Request::DeleteBoard { workspace_id } => assert_eq!(workspace_id, "ws-1"),
            other => panic!("expected DeleteBoard, got {other:?}"),
        }
    }
}

#[cfg(test)]
mod attach_target_tests {
    use super::*;
    use crate::config::Page;

    fn leaf(tabs: &[&str]) -> LayoutNode {
        LayoutNode::Leaf {
            tabs: tabs.iter().map(|s| s.to_string()).collect(),
            active_tab_index: 0,
            pinned: Vec::new(),
        }
    }

    fn ws(id: &str, tabs: &[&str], main: Option<&str>) -> Workspace {
        Workspace {
            id: id.to_string(),
            name: id.to_string(),
            pages: vec![Page {
                id: format!("{id}-p1"),
                name: "p1".to_string(),
                layout: leaf(tabs),
                focused_session_id: None,
            }],
            active_page_id: None,
            active_view: None,
            hub_view: None,
            root_path: None,
            main_session_id: main.map(|m| m.to_string()),
            legacy_agent_command: None,
            color: None,
            notify_needs_input: true,
            notify_finished: true,
            git_view: None,
        }
    }

    fn data(workspaces: Vec<Workspace>) -> WorkspacesData {
        WorkspacesData { workspaces, active_workspace_id: None }
    }

    #[test]
    fn non_session_tab_ids_covers_both_file_and_board_tabs() {
        let mut files = HashMap::new();
        files.insert("f1".to_string(), "/tmp/a.md".to_string());
        let mut boards = HashMap::new();
        boards.insert(
            "b1".to_string(),
            crate::config::BoardTabRecord {
                workspace_id: "w1".to_string(),
                context_folder: "/tmp/ws".to_string(),
            },
        );

        let ids = non_session_tab_ids(&files, &boards);

        assert_eq!(ids, HashSet::from(["f1".to_string(), "b1".to_string()]));
    }

    #[test]
    fn attachable_ids_include_main_agents_that_live_outside_every_page_tree() {
        // D12: a main agent session is remembered on the workspace, not
        // placed in a page. Walking page trees alone misses it, and a
        // session nobody attaches renders blank forever.
        let d = data(vec![ws("w1", &["s1", "s2"], Some("main-1"))]);

        let ids = attachable_session_ids(&d, &HashSet::new());

        assert_eq!(ids, vec!["s1".to_string(), "s2".to_string(), "main-1".to_string()]);
    }

    #[test]
    fn attachable_ids_skip_file_and_board_tabs() {
        // These share the layout tree's id space but were never sessions
        // -- the daemon would reject an Attach for them.
        let d = data(vec![ws("w1", &["s1", "f1", "b1"], None)]);

        let ids = attachable_session_ids(
            &d,
            &HashSet::from(["f1".to_string(), "b1".to_string()]),
        );

        assert_eq!(ids, vec!["s1".to_string()]);
    }

    #[test]
    fn attachable_ids_span_every_workspace() {
        let d = data(vec![ws("w1", &["s1"], Some("m1")), ws("w2", &["s2"], None)]);

        let ids = attachable_session_ids(&d, &HashSet::new());

        assert_eq!(ids, vec!["s1".to_string(), "s2".to_string(), "m1".to_string()]);
    }
}
