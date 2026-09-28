//! The desktop's forwarding connection (ADR 0003, companion-13).
//!
//! While the daemon is new enough (v47), the app opens a third connection
//! Hello'd as `ConnectionKind::Forward`. Over it the daemon hands gated
//! Tauri commands (`ForwardCommand`); this module dispatches each through
//! the **same** invoke handler the webview's `invoke` reaches, and writes
//! `ForwardResult` back. Events the host emits to its webview are offered
//! on the same connection as `OfferDesktopEvent`, so subscribed Devices
//! hear them.
//!
//! One thread owns the connection: offers and results both travel through
//! it, so an Ok reply is never mistaken for a ForwardCommand. Concurrent
//! Device invokes queue in the socket; they are answered in order.

use protocol::transport::Stream;
use protocol::{read_message, write_message, ConnectionKind, Request, Response};
use serde::Serialize;
use std::io::BufReader;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::ipc::{CallbackFn, InvokeBody, InvokeError, InvokeResponse, InvokeResponseBody};
use tauri::webview::InvokeRequest;
use tauri::{AppHandle, Emitter, Manager, Runtime};

/// Protocol version that introduced the Forward connection and the five
/// forwarding request types (`PROTOCOL_VERSION` v47 / companion-12).
pub const FORWARDING_MIN_VERSION: u32 = 47;

/// How long a single forwarded command may take before we answer the
/// daemon with an error. Matches the daemon's own wait in
/// `SessionManager::invoke_desktop`.
const DISPATCH_BUDGET: Duration = Duration::from_secs(60);

/// Process-wide epoch: bumped on every start so a dying loop from a
/// previous daemon cannot register itself over the live one.
static FORWARDING_EPOCH: AtomicU64 = AtomicU64::new(0);

/// Managed state: the live forwarding writer and the channel that offers
/// events to its owning thread.
#[derive(Default)]
pub struct Forwarding {
    /// Sender into the forwarding thread's offer queue. `None` until the
    /// first connection comes up, and again while a reconnect is between
    /// daemons.
    offer: Mutex<Option<Sender<(String, serde_json::Value)>>>,
}

/// Opens (or re-opens) the forwarding connection against the local
/// daemon. No-op when the daemon is older than v47 or has no token yet.
///
/// Called from `bootstrap` and `reconnect` once the command and push
/// connections are live. The previous loop, if any, exits when its socket
/// closes or when it notices the epoch bump.
pub fn start<R: Runtime>(app: &AppHandle<R>, daemon_version: u32) {
    if daemon_version < FORWARDING_MIN_VERSION {
        return;
    }
    let Some(token) = crate::session::read_daemon_token() else {
        return;
    };
    let Ok(socket) = protocol::socket_path() else {
        return;
    };
    let epoch = FORWARDING_EPOCH.fetch_add(1, Ordering::SeqCst) + 1;
    // Drop any prior offer sender: the old loop is about to die, and a
    // stale send would only wake a thread that can no longer write.
    if let Some(state) = app.try_state::<Forwarding>() {
        *state.offer.lock().unwrap() = None;
    }
    let app = app.clone();
    std::thread::Builder::new()
        .name("gavin-forwarding".into())
        .spawn(move || {
            if let Err(e) = run_loop(app, socket, token, epoch) {
                eprintln!("gavin forwarding connection ended: {e}");
            }
        })
        .expect("spawn forwarding thread");
}

/// Emit to every webview **and** offer the same event on the forwarding
/// connection. The single place host-side events are spelled for both
/// audiences (ADR 0003).
pub fn emit<R: Runtime, S: Serialize + Clone>(
    app: &AppHandle<R>,
    event: &str,
    payload: S,
) -> tauri::Result<()> {
    let json = serde_json::to_value(&payload).unwrap_or(serde_json::Value::Null);
    let result = app.emit(event, payload);
    offer(app, event, json);
    result
}

/// Queue an event for the forwarding thread. Silent when no connection
/// is live — Devices then simply hear nothing, which is the "desktop app
/// not running" half of a dropped offer.
pub fn offer<R: Runtime>(app: &AppHandle<R>, event: &str, payload: serde_json::Value) {
    let Some(state) = app.try_state::<Forwarding>() else {
        return;
    };
    let guard = state.offer.lock().unwrap();
    if let Some(tx) = guard.as_ref() {
        let _ = tx.send((event.to_string(), payload));
    }
}

/// Dispatch `command` with JSON `args` through the same invoke handler
/// the webview reaches. Public so tests can drive it without a live
/// forwarding socket.
pub fn dispatch<R: Runtime>(
    app: &AppHandle<R>,
    command: &str,
    args: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let webview = app
        .webview_windows()
        .into_values()
        .next()
        .ok_or_else(|| "gavin: no webview to dispatch a forwarded command through".to_string())?;

    let url = if cfg!(any(windows, target_os = "android")) {
        "http://tauri.localhost"
    } else {
        "tauri://localhost"
    }
    .parse()
    .expect("static invoke URL");

    let (tx, rx) = mpsc::sync_channel(1);
    let request = InvokeRequest {
        cmd: command.to_string(),
        callback: CallbackFn(0),
        error: CallbackFn(1),
        url,
        body: InvokeBody::Json(args),
        headers: Default::default(),
        invoke_key: app.invoke_key().to_string(),
    };
    webview.as_ref().clone().on_message(
        request,
        Box::new(move |_webview, _cmd, response, _callback, _error| {
            let _ = tx.send(response);
        }),
    );

    match rx.recv_timeout(DISPATCH_BUDGET) {
        Ok(InvokeResponse::Ok(body)) => body_to_value(body),
        Ok(InvokeResponse::Err(InvokeError(v))) => Err(match v {
            serde_json::Value::String(s) => s,
            other => other.to_string(),
        }),
        Err(_) => Err(format!(
            "gavin: forwarded command `{command}` timed out after {}s",
            DISPATCH_BUDGET.as_secs()
        )),
    }
}

fn body_to_value(body: InvokeResponseBody) -> Result<serde_json::Value, String> {
    body.deserialize::<serde_json::Value>().map_err(|e| e.to_string())
}

fn run_loop<R: Runtime>(
    app: AppHandle<R>,
    socket: std::path::PathBuf,
    token: String,
    epoch: u64,
) -> anyhow::Result<()> {
    let stream = connect_forward(&socket)?;
    handshake_forward(&stream, &token)?;

    let reader_stream = stream.try_clone()?;
    let writer_stream = stream;
    let writer = Arc::new(Mutex::new(writer_stream));

    let (offer_tx, offer_rx) = mpsc::channel::<(String, serde_json::Value)>();
    if let Some(state) = app.try_state::<Forwarding>() {
        // Only publish if we are still the current epoch — a faster
        // reconnect would otherwise be overwritten by this stale loop.
        if FORWARDING_EPOCH.load(Ordering::SeqCst) == epoch {
            *state.offer.lock().unwrap() = Some(offer_tx);
        } else {
            return Ok(());
        }
    }

    let mut reader = BufReader::new(reader_stream);
    // Short timeout so offers are drained promptly and an epoch bump is
    // noticed without waiting for the next ForwardCommand.
    writer
        .lock()
        .unwrap()
        .set_read_timeout(Some(Duration::from_millis(50)))
        .ok();
    // The reader's timeout is on the clone — set it on the reader side.
    // BufReader wraps the stream; set via get_mut.
    reader.get_mut().set_read_timeout(Some(Duration::from_millis(50))).ok();

    loop {
        if FORWARDING_EPOCH.load(Ordering::SeqCst) != epoch {
            break;
        }

        while let Ok((event, payload)) = offer_rx.try_recv() {
            write_and_ack(&writer, &mut reader, &Request::OfferDesktopEvent { event, payload })?;
        }

        match read_message::<_, Response>(&mut reader) {
            Ok(Some(Response::ForwardCommand { call_id, command, args })) => {
                let outcome = dispatch(&app, &command, args);
                let (value, error) = match outcome {
                    Ok(v) => (Some(v), None),
                    Err(e) => (None, Some(e)),
                };
                write_and_ack(
                    &writer,
                    &mut reader,
                    &Request::ForwardResult { call_id, value, error },
                )?;
            }
            Ok(Some(Response::Ok)) => {
                // A stray Ok (e.g. from an offer that raced a timeout
                // drain) is harmless.
            }
            Ok(Some(other)) => {
                eprintln!("gavin forwarding: unexpected push {other:?}");
            }
            Ok(None) => break,
            Err(e) => {
                let msg = format!("{e:#}");
                if is_timeout(&msg) {
                    continue;
                }
                return Err(e);
            }
        }
    }
    Ok(())
}

fn write_and_ack(
    writer: &Arc<Mutex<Stream>>,
    reader: &mut BufReader<Stream>,
    req: &Request,
) -> anyhow::Result<()> {
    write_message(&mut *writer.lock().unwrap(), req)?;
    // Bound the wait for Ok so a wedged daemon cannot pin this thread.
    reader
        .get_mut()
        .set_read_timeout(Some(Duration::from_secs(5)))
        .ok();
    let ack = read_message::<_, Response>(reader)?;
    reader
        .get_mut()
        .set_read_timeout(Some(Duration::from_millis(50)))
        .ok();
    match ack {
        Some(Response::Ok) => Ok(()),
        Some(Response::Error { message }) => anyhow::bail!("forwarding ack: {message}"),
        Some(other) => anyhow::bail!("forwarding ack was {other:?}"),
        None => anyhow::bail!("daemon closed the forwarding connection during ack"),
    }
}

fn connect_forward(socket: &Path) -> anyhow::Result<Stream> {
    // Same connect path the command connection uses — the daemon is
    // already up (bootstrap/reconnect just talked to it).
    crate::session::connect_local(socket)
}

fn handshake_forward(stream: &Stream, token: &str) -> anyhow::Result<()> {
    let nonce = protocol::random_hex(16)?;
    let hello = crate::session::app_hello(token, &nonce, ConnectionKind::Forward);
    write_message(&mut &*stream, &hello)?;
    let mut reader = BufReader::with_capacity(1, stream.try_clone()?);
    let ack = read_message(&mut reader)?
        .ok_or_else(|| anyhow::anyhow!("daemon closed during forwarding Hello"))?;
    crate::session::verify_app_ack(ack, token, &nonce)
}

fn is_timeout(msg: &str) -> bool {
    msg.contains("timed out")
        || msg.contains("WouldBlock")
        || msg.contains("Resource temporarily unavailable")
        || msg.contains("os error 35") // macOS EAGAIN
        || msg.contains("os error 11") // Linux EAGAIN
}

/// Test-only: a Hello that claims Forward, used by the unit that pins
/// the connection kind without opening a real daemon socket.
#[cfg(test)]
pub(crate) fn forward_hello_for_test(token: &str, nonce: &str) -> Request {
    crate::session::app_hello(token, nonce, ConnectionKind::Forward)
}

#[cfg(test)]
mod tests {
    use super::*;
    use protocol::{HelloAuth, PROTOCOL_VERSION};
    use std::sync::atomic::AtomicUsize;
    use tauri::test::{get_ipc_response, mock_builder, mock_context, noop_assets, INVOKE_KEY};

    /// A command the mock app registers — both the webview invoke path
    /// and `dispatch` must reach it.
    #[tauri::command]
    fn ping_forward(value: String) -> String {
        format!("pong:{value}")
    }

    #[tauri::command]
    fn ping_counter(hits: tauri::State<'_, Arc<AtomicUsize>>) -> usize {
        hits.fetch_add(1, Ordering::SeqCst) + 1
    }

    fn mock_app_with(hits: Arc<AtomicUsize>) -> (tauri::App<tauri::test::MockRuntime>, tauri::WebviewWindow<tauri::test::MockRuntime>) {
        let app = mock_builder()
            .manage(hits)
            .manage(Forwarding::default())
            .invoke_handler(tauri::generate_handler![ping_forward, ping_counter])
            .build(mock_context(noop_assets()))
            .expect("mock app");
        let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .expect("mock webview");
        (app, webview)
    }

    fn invoke_url() -> url::Url {
        if cfg!(any(windows, target_os = "android")) {
            "http://tauri.localhost".parse().unwrap()
        } else {
            "tauri://localhost".parse().unwrap()
        }
    }

    /// A forwarded call reaches the same handler the webview's `invoke`
    /// does: both return the handler's result, and both increment the
    /// shared counter once.
    #[test]
    fn a_forwarded_call_reaches_the_same_handler_as_webview_invoke() {
        let hits = Arc::new(AtomicUsize::new(0));
        let (app, webview) = mock_app_with(Arc::clone(&hits));
        let handle = app.handle().clone();

        // Webview path.
        let via_webview = get_ipc_response(
            &webview,
            InvokeRequest {
                cmd: "ping_counter".into(),
                callback: CallbackFn(0),
                error: CallbackFn(1),
                url: invoke_url(),
                body: InvokeBody::default(),
                headers: Default::default(),
                invoke_key: INVOKE_KEY.to_string(),
            },
        )
        .expect("webview invoke")
        .deserialize::<usize>()
        .unwrap();
        assert_eq!(via_webview, 1);

        // Forwarding dispatch — same handler, same state.
        let via_forward = dispatch(&handle, "ping_counter", serde_json::json!({}))
            .expect("forward dispatch")
            .as_u64()
            .expect("usize as u64") as usize;
        assert_eq!(via_forward, 2);
        assert_eq!(hits.load(Ordering::SeqCst), 2);

        // Args round-trip through the same path.
        let echoed = dispatch(&handle, "ping_forward", serde_json::json!({"value": "desk"}))
            .expect("ping_forward");
        assert_eq!(echoed, serde_json::json!("pong:desk"));
    }

    /// `emit` offers the event on the forwarding channel, which the
    /// connection thread then writes as `OfferDesktopEvent`.
    #[test]
    fn an_emitted_event_reaches_the_forwarding_connection() {
        let hits = Arc::new(AtomicUsize::new(0));
        let (app, _webview) = mock_app_with(hits);
        let handle = app.handle().clone();

        let (tx, rx) = mpsc::channel();
        *handle.state::<Forwarding>().offer.lock().unwrap() = Some(tx);

        emit(
            &handle,
            "status-changed",
            serde_json::json!({"id": "s1", "status": "idle"}),
        )
        .unwrap();

        let (event, payload) = rx.recv_timeout(Duration::from_secs(1)).expect("offer");
        assert_eq!(event, "status-changed");
        assert_eq!(payload, serde_json::json!({"id": "s1", "status": "idle"}));
    }

    #[test]
    fn forward_hello_names_the_forward_connection_kind() {
        let hello = forward_hello_for_test("t", "n");
        match hello {
            Request::Hello { connection: Some(ConnectionKind::Forward), auth, .. } => {
                assert!(matches!(auth, HelloAuth::DaemonToken { .. }));
            }
            other => panic!("expected Forward Hello, got {other:?}"),
        }
    }
}
