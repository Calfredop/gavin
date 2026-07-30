use protocol::{read_message, socket_path, write_message, Request, Response};
use std::io::BufReader;
use std::os::unix::net::UnixStream;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State};

pub struct DaemonConnection {
    writer: Arc<Mutex<UnixStream>>,
}

pub struct ActiveSessionId(pub Mutex<Option<String>>);

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

/// Connects to (or spawns) the daemon, creates or reattaches to the saved
/// session, registers Tauri-managed state for the commands below, and
/// spawns a background thread that relays every subsequent daemon message
/// to the frontend as a Tauri event. Called once from the app's setup hook.
pub fn bootstrap(app_handle: AppHandle) -> anyhow::Result<()> {
    let stream = crate::daemon::connect_or_spawn(
        &socket_path(),
        Duration::from_secs(3),
        crate::daemon::spawn_real_daemon,
    )?;

    let writer = Arc::new(Mutex::new(stream.try_clone()?));
    let reader_stream = stream;
    let mut boot_reader = BufReader::new(reader_stream.try_clone()?);

    let config_dir = app_handle.path().app_config_dir()?;
    let config = crate::config::load(&config_dir)?;

    // A saved session id can be stale (registry reset, its cwd no longer
    // exists so recover() skipped it, it was killed by another client) or
    // point at a session that has since exited (e.g. the user typed
    // `exit`). Check with the daemon before trusting it — the design spec
    // requires this to be a silent, normal fallback to a fresh session,
    // not an error surfaced to the user.
    let mut existing_id = config.session_id.clone();
    if let Some(id) = &existing_id {
        send_request(&writer, &Request::ListSessions)?;
        let resp: Response = read_message(&mut boot_reader)?
            .ok_or_else(|| anyhow::anyhow!("daemon closed the connection during startup"))?;
        let sessions = match resp {
            Response::SessionList { sessions } => sessions,
            other => anyhow::bail!("expected SessionList, got {other:?}"),
        };
        let still_valid = sessions
            .iter()
            .any(|s| &s.id == id && s.status != "exited");
        if !still_valid {
            existing_id = None;
        }
    }

    let session_id = match existing_id {
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
            // The daemon's very next reply to a CreateSession request is
            // SessionCreated — read it synchronously here, on the same
            // boot_reader used for the ListSessions check above, before the
            // background loop below starts consuming everything else on
            // this stream.
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
    let reader_app_handle = app_handle.clone();
    std::thread::spawn(move || {
        // Wait for the frontend to confirm its listeners are registered
        // before reading — and therefore emitting — anything from the
        // daemon (see FrontendReady's doc comment for why). Bounded: an
        // unbounded wait here would leave the daemon's connection-handling
        // thread blocked mid-write on a full scrollback replay (the
        // AF_UNIX socket buffer is much smaller than the replay can be),
        // which backs up through the session's writer mutex into the PTY
        // pump and can stall the user's actual shell — worse than the
        // small chance of an early emit being missed if the frontend is
        // simply slow rather than broken.
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

#[tauri::command]
pub fn get_current_session(session: State<ActiveSessionId>) -> Option<String> {
    session.0.lock().unwrap().clone()
}
