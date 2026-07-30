use protocol::{read_message, socket_path, write_message, Request, Response};
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
    let stream = crate::daemon::connect_or_spawn(
        &socket_path(),
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

#[tauri::command]
pub fn get_current_session(session: State<ActiveSessionId>) -> Option<String> {
    session.0.lock().unwrap().clone()
}
