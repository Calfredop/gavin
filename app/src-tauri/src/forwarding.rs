//! The desktop's forwarding connection (ADR 0003, companion-13).
//!
//! While the daemon is new enough (v54), the app opens a third connection
//! Hello'd as `ConnectionKind::Forward`. Over it the daemon hands gated
//! Tauri commands (`ForwardCommand`); this module dispatches each through
//! the **same** invoke handler the webview's `invoke` reaches, and writes
//! `ForwardResult` back. Events the host emits to its webview are offered
//! on the same connection as `OfferDesktopEvent`, so subscribed Devices
//! hear them. Attention asks (`ForwardAttention`, v55) are answered from
//! the snapshot the webview keeps filled via `set_companion_attention`,
//! and bundle asks (`ForwardBundle`, v57) from the signed Companion
//! bundle this build embeds (`companion_bundle`).
//!
//! One thread writes the connection and one reads it. The daemon's
//! replies and its pushes share the read side in no fixed order, so each
//! message is acted on by kind and no reply is ever waited for (`serve`).
//! Forwarded commands run in order on a thread of their own; an Attention
//! or bundle ask never queues behind one. When the connection ends while
//! the app is up, it is dialled again (`keep_connected`).

use protocol::transport::Stream;
use protocol::{
    read_message, write_message, AttentionItem, ConnectionKind, Request, Response,
};
use serde::Serialize;
use std::io::BufReader;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::ipc::{CallbackFn, InvokeBody, InvokeError, InvokeResponse, InvokeResponseBody};
use tauri::webview::InvokeRequest;
use tauri::{AppHandle, Emitter, Manager, Runtime};

/// Protocol version that introduced the Forward connection and the five
/// forwarding request types (`PROTOCOL_VERSION` v54 / companion-12).
pub const FORWARDING_MIN_VERSION: u32 = 54;

/// How long a single forwarded command may take before we answer the
/// daemon with an error. Matches the daemon's own wait in
/// `SessionManager::invoke_desktop`.
const DISPATCH_BUDGET: Duration = Duration::from_secs(60);

/// Process-wide epoch: bumped on every start so a dying loop from a
/// previous daemon cannot register itself over the live one.
static FORWARDING_EPOCH: AtomicU64 = AtomicU64::new(0);

/// The header `dispatch` puts on every forwarded call, so a command can
/// tell a Device's call from its own window's.
const FORWARDED_HEADER: &str = "gavin-forwarded";

/// The origin a Device's write is announced under. A forwarded call runs
/// through a desk window's webview (`dispatch`), so the window a command
/// is handed is that desk window -- and announcing the write under its
/// label would make it ignore the write as its own echo, and never show
/// what the phone did. No desk window has this label; the bundle's
/// window shim reports it (`app/companion/src/companion/remote/window.ts`).
pub const FORWARDED_ORIGIN: &str = "companion";

/// Who made a write, for the `*-synced` events every window adopts from:
/// the window's label, or `FORWARDED_ORIGIN` for a Device's call.
pub fn origin<R: Runtime>(window: &tauri::Window<R>, request: &tauri::ipc::Request<'_>) -> String {
    if request.headers().contains_key(FORWARDED_HEADER) {
        FORWARDED_ORIGIN.to_string()
    } else {
        window.label().to_string()
    }
}

/// Managed state: the live forwarding writer, the channel that offers
/// events to its owning thread, and the attention snapshot a Device's
/// GetAttention reads (ADR 0005).
#[derive(Default)]
pub struct Forwarding {
    /// Sender into the forwarding thread's offer queue. `None` until the
    /// first connection comes up, and again while a reconnect is between
    /// daemons.
    offer: Mutex<Option<Sender<(String, serde_json::Value)>>>,
    /// Last attention answer the webview published. Empty until the
    /// first `set_companion_attention`, which is also the honest answer
    /// when nothing is waiting.
    attention: Mutex<Vec<AttentionItem>>,
}

/// Replace the attention snapshot the Forward connection answers with.
#[tauri::command]
pub fn set_companion_attention(
    state: tauri::State<'_, Forwarding>,
    items: Vec<AttentionItem>,
) -> Result<(), String> {
    *state.attention.lock().unwrap() = items;
    Ok(())
}

/// The items currently published for GetAttention. Public so tests can
/// read what the webview wrote without opening a forwarding socket.
pub fn attention_items<R: Runtime>(app: &AppHandle<R>) -> Vec<AttentionItem> {
    let Some(state) = app.try_state::<Forwarding>() else {
        return Vec::new();
    };
    let items = state.attention.lock().unwrap().clone();
    items
}

/// Opens (or re-opens) the forwarding connection against the local
/// daemon, and keeps it open (`keep_connected`). No-op when the daemon is
/// older than v54.
///
/// Called from `bootstrap` and `reconnect` once the command and push
/// connections are live. The epoch is bumped before anything can return,
/// so the previous loop -- which may be redialling a daemon that is gone
/// -- stops however this call ends.
pub fn start<R: Runtime>(app: &AppHandle<R>, daemon_version: u32) {
    let epoch = FORWARDING_EPOCH.fetch_add(1, Ordering::SeqCst) + 1;
    // Drop any prior offer sender: the old loop is about to die, and a
    // stale send would only wake a thread that can no longer write.
    if let Some(state) = app.try_state::<Forwarding>() {
        *state.offer.lock().unwrap() = None;
    }
    if daemon_version < FORWARDING_MIN_VERSION {
        return;
    }
    let Ok(socket) = protocol::socket_path() else {
        return;
    };
    let app = app.clone();
    std::thread::Builder::new()
        .name("gavin-forwarding".into())
        .spawn(move || {
            keep_connected(&app, &|| FORWARDING_EPOCH.load(Ordering::SeqCst) == epoch, || dial(&socket));
        })
        .expect("spawn forwarding thread");
}

/// The first redial after the forwarding connection ends waits this long,
/// doubling to `REDIAL_CEILING`; a connection held for `REDIAL_SETTLED`
/// starts the count over. The daemon paces its dial to the Relay the
/// same way (`remote.rs`).
const REDIAL_FLOOR: Duration = Duration::from_secs(1);
const REDIAL_CEILING: Duration = Duration::from_secs(30);
const REDIAL_SETTLED: Duration = Duration::from_secs(30);

/// How long to wait before the `failures`-th redial in a row (1 is the
/// first).
fn redial_delay(failures: u32) -> Duration {
    let doublings = failures.saturating_sub(1).min(16);
    REDIAL_FLOOR.saturating_mul(1 << doublings).min(REDIAL_CEILING)
}

/// Serves the forwarding connection for as long as `wanted` holds,
/// dialling it again whenever it ends.
///
/// `start` runs only on bootstrap and reconnect, and both wait for the
/// COMMAND connection to fail. A forwarding connection that ended on its
/// own while the app stayed up was gone until the app restarted, and in
/// the meantime the daemon told every Device "desktop app not running"
/// with the window open at the desk.
fn keep_connected<R: Runtime>(
    app: &AppHandle<R>,
    wanted: &dyn Fn() -> bool,
    mut dial: impl FnMut() -> anyhow::Result<Stream>,
) {
    let mut failures = 0u32;
    while wanted() {
        let began = Instant::now();
        let ended = dial().and_then(|stream| {
            eprintln!("gavin forwarding: connected; {}", crate::companion_bundle::describe());
            serve(app, stream, wanted)
        });
        if !wanted() {
            return;
        }
        match ended {
            Ok(()) => eprintln!("gavin forwarding: the daemon closed the connection; dialling again"),
            Err(e) => eprintln!("gavin forwarding connection ended: {e:#}; dialling again"),
        }
        if began.elapsed() >= REDIAL_SETTLED {
            failures = 0;
        }
        failures = failures.saturating_add(1);
        let until = Instant::now() + redial_delay(failures);
        while wanted() && Instant::now() < until {
            std::thread::sleep(Duration::from_millis(50));
        }
    }
}

/// Connects and proves this app to the daemon as its forwarding
/// connection. The token is read afresh on every dial: a daemon that
/// restarted wrote a new one.
fn dial(socket: &Path) -> anyhow::Result<Stream> {
    let token = crate::session::read_daemon_token()
        .ok_or_else(|| anyhow::anyhow!("no daemon token to present"))?;
    let stream = connect_forward(socket)?;
    handshake_forward(&stream, &token)?;
    Ok(stream)
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

/// What the desk's windows tell each other after writing a workspace's
/// orchestration (`orchestrationState.ts`), and the shape they tell it in.
pub const ORCHESTRATION_WRITTEN: &str = "orchestration-written";

#[derive(Clone, Serialize)]
struct OrchestrationWritten<'a> {
    origin: &'a str,
    payload: &'a str,
}

/// A workspace's orchestration was written -- its plan, a rail's run or a
/// step's -- by `origin`.
///
/// The daemon pushes a plan only when an agent writes it over MCP; a write
/// through these commands is announced by the window that made it, to the
/// other windows, from the webview. Neither reaches anybody else, so this
/// fills the two gaps a Device leaves:
///
/// - A Device's write reaches the desk's windows, which re-read -- and the
///   one that runs the workspace's rails ticks. A Device never runs a
///   rail (ADR 0003): Start from a phone only arms one, and without this
///   the desk would not learn it was armed until something unrelated
///   ticked it.
/// - Every write reaches the Devices, whoever made it, so a phone watching
///   a rail sees the desk's scheduler move it.
///
/// A desk window's own write is not emitted to the webviews again: they
/// have already told each other.
pub fn announce_orchestration_written<R: Runtime>(app: &AppHandle<R>, origin: &str, workspace_id: &str) {
    let written = OrchestrationWritten { origin, payload: workspace_id };
    if origin == FORWARDED_ORIGIN {
        let _ = emit(app, ORCHESTRATION_WRITTEN, written);
    } else {
        offer(app, ORCHESTRATION_WRITTEN, serde_json::to_value(written).unwrap_or(serde_json::Value::Null));
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
    let mut headers = tauri::http::HeaderMap::new();
    headers.insert(FORWARDED_HEADER, tauri::http::HeaderValue::from_static("1"));
    let request = InvokeRequest {
        cmd: command.to_string(),
        callback: CallbackFn(0),
        error: CallbackFn(1),
        url,
        body: InvokeBody::Json(args),
        headers,
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

/// What the forwarding thread acts on next.
enum Inbound {
    /// A message from the daemon: a push to answer, or its reply to a
    /// request of ours.
    Daemon(Response),
    /// A forwarded command's result, from the thread that dispatches them.
    Answered(Request),
    /// The daemon's end closed (`None`) or could not be read.
    Ended(Option<anyhow::Error>),
}

/// Serves one forwarding connection until it ends or `wanted` turns
/// false.
///
/// The daemon writes to this connection from more than one thread: its
/// reply to each request this end sends, and every push a Device's ask
/// makes, the moment the Device asks. A push can therefore land between
/// any request and its reply, so nothing here waits for a reply: one
/// reader thread reads every message and this loop acts on each by kind.
/// Taking "the next message" as the reply to the request just written is
/// what ended this connection for good -- an Attention ask arriving
/// between an offered event and its `Ok` was read as a malformed ack.
///
/// Forwarded commands run in order on a thread of their own, so a slow
/// one never holds up an Attention or bundle ask, which are answered from
/// what this host already holds.
pub(crate) fn serve<R: Runtime>(app: &AppHandle<R>, stream: Stream, wanted: &dyn Fn() -> bool) -> anyhow::Result<()> {
    let (offer_tx, offers) = mpsc::channel::<(String, serde_json::Value)>();
    if let Some(state) = app.try_state::<Forwarding>() {
        // Only publish while still wanted -- a faster reconnect would
        // otherwise be overwritten by this stale loop.
        if !wanted() {
            return Ok(());
        }
        *state.offer.lock().unwrap() = Some(offer_tx);
    }

    // The reader blocks for as long as the daemon is quiet; the deadline
    // the handshake read under is not this connection's.
    stream.set_read_timeout(None)?;
    let (inbound_tx, inbound) = mpsc::channel::<Inbound>();
    let mut reader = BufReader::new(stream.try_clone()?);
    let from_daemon = inbound_tx.clone();
    std::thread::Builder::new().name("gavin-forwarding-reader".into()).spawn(move || loop {
        let ended = match read_message::<_, Response>(&mut reader) {
            Ok(Some(message)) => {
                if from_daemon.send(Inbound::Daemon(message)).is_err() {
                    return;
                }
                continue;
            }
            Ok(None) => Inbound::Ended(None),
            Err(e) => Inbound::Ended(Some(e)),
        };
        let _ = from_daemon.send(ended);
        return;
    })?;

    let (commands_tx, commands) = mpsc::channel::<(u64, String, serde_json::Value)>();
    let dispatcher = app.clone();
    std::thread::Builder::new().name("gavin-forwarding-dispatch".into()).spawn(move || {
        for (call_id, command, args) in commands {
            let (value, error) = match dispatch(&dispatcher, &command, args) {
                Ok(v) => (Some(v), None),
                Err(e) => (None, Some(e)),
            };
            if inbound_tx.send(Inbound::Answered(Request::ForwardResult { call_id, value, error })).is_err() {
                return;
            }
        }
    })?;

    let mut writer = stream.try_clone()?;
    let served = (|| -> anyhow::Result<()> {
        while wanted() {
            while let Ok((event, payload)) = offers.try_recv() {
                write_message(&mut writer, &Request::OfferDesktopEvent { event, payload })?;
            }
            // Bounded so offers are drained promptly and a change of
            // `wanted` is noticed without waiting for the daemon.
            match inbound.recv_timeout(Duration::from_millis(50)) {
                Ok(Inbound::Daemon(Response::ForwardCommand { call_id, command, args })) => {
                    let _ = commands_tx.send((call_id, command, args));
                }
                Ok(Inbound::Daemon(Response::ForwardAttention { call_id, version: _ })) => {
                    let items = attention_items(app);
                    write_message(&mut writer, &Request::AttentionResult { call_id, items })?;
                }
                Ok(Inbound::Daemon(Response::ForwardBundle { call_id, version: _, offset, length })) => {
                    // The Companion bundle this build carries (ADR 0005):
                    // the manifest and the slice the daemon asked for,
                    // which it already cut to the wire's chunk cap.
                    let (manifest, offset, data) = crate::companion_bundle::answer(offset, length);
                    write_message(&mut writer, &Request::BundleResult { call_id, manifest, offset, data })?;
                }
                // The daemon's reply to a request of ours. Nothing waits
                // for it: see above.
                Ok(Inbound::Daemon(Response::Ok)) => {}
                Ok(Inbound::Daemon(Response::Error { message })) => {
                    eprintln!("gavin forwarding: the daemon refused a request: {message}");
                }
                Ok(Inbound::Daemon(other)) => eprintln!("gavin forwarding: unexpected push {other:?}"),
                Ok(Inbound::Answered(result)) => write_message(&mut writer, &result)?,
                Ok(Inbound::Ended(None)) => return Ok(()),
                Ok(Inbound::Ended(Some(e))) => return Err(e),
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => return Ok(()),
            }
        }
        Ok(())
    })();
    // Unblocks the reader, so it does not outlive the connection; the
    // dispatcher ends with the command it is running, if any.
    let _ = stream.shutdown(std::net::Shutdown::Both);
    served
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
    use std::sync::Arc;
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

    #[tauri::command]
    fn ping_origin(window: tauri::Window<tauri::test::MockRuntime>, request: tauri::ipc::Request<'_>) -> String {
        origin(&window, &request)
    }

    fn mock_app_with(hits: Arc<AtomicUsize>) -> (tauri::App<tauri::test::MockRuntime>, tauri::WebviewWindow<tauri::test::MockRuntime>) {
        let app = mock_builder()
            .manage(hits)
            .manage(Forwarding::default())
            .invoke_handler(tauri::generate_handler![ping_forward, ping_counter, ping_origin])
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

    /// A Device's write is announced under an origin no desk window has.
    /// Under the dispatching window's own label, that window would drop
    /// the announcement as its own echo and never show what the phone did.
    #[test]
    fn a_forwarded_call_has_an_origin_no_desk_window_has() {
        let hits = Arc::new(AtomicUsize::new(0));
        let (app, webview) = mock_app_with(hits);
        let handle = app.handle().clone();

        let from_the_desk = get_ipc_response(
            &webview,
            InvokeRequest {
                cmd: "ping_origin".into(),
                callback: CallbackFn(0),
                error: CallbackFn(1),
                url: invoke_url(),
                body: InvokeBody::default(),
                headers: Default::default(),
                invoke_key: INVOKE_KEY.to_string(),
            },
        )
        .expect("webview invoke")
        .deserialize::<String>()
        .unwrap();
        assert_eq!(from_the_desk, "main");

        let from_a_device = dispatch(&handle, "ping_origin", serde_json::json!({})).expect("forward dispatch");
        assert_eq!(from_a_device, serde_json::json!(FORWARDED_ORIGIN));
        assert_ne!(FORWARDED_ORIGIN, "main");
    }

    /// Stands in for `set_rail_run` and the other orchestration writes.
    #[tauri::command]
    fn write_orchestration(
        workspace_id: String,
        app_handle: tauri::AppHandle<tauri::test::MockRuntime>,
        window: tauri::Window<tauri::test::MockRuntime>,
        request: tauri::ipc::Request<'_>,
    ) {
        announce_orchestration_written(&app_handle, &origin(&window, &request), &workspace_id);
    }

    /// A Device's orchestration write reaches the desk's windows, whose
    /// scheduler runs the rail it armed; every write reaches the Devices.
    #[test]
    fn an_orchestration_write_reaches_the_desk_only_when_a_device_made_it() {
        use tauri::Listener;
        let app = mock_builder()
            .manage(Forwarding::default())
            .invoke_handler(tauri::generate_handler![write_orchestration])
            .build(mock_context(noop_assets()))
            .expect("mock app");
        let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .expect("mock webview");
        let handle = app.handle().clone();
        let (offers_tx, offers) = mpsc::channel();
        *handle.state::<Forwarding>().offer.lock().unwrap() = Some(offers_tx);
        let (heard_tx, heard) = mpsc::channel::<String>();
        handle.listen_any(ORCHESTRATION_WRITTEN, move |event| {
            let _ = heard_tx.send(event.payload().to_string());
        });

        get_ipc_response(
            &webview,
            InvokeRequest {
                cmd: "write_orchestration".into(),
                callback: CallbackFn(0),
                error: CallbackFn(1),
                url: invoke_url(),
                body: InvokeBody::Json(serde_json::json!({"workspaceId": "ws-desk"})),
                headers: Default::default(),
                invoke_key: INVOKE_KEY.to_string(),
            },
        )
        .expect("webview invoke");
        let (event, payload) = offers.recv_timeout(Duration::from_secs(1)).expect("offered to Devices");
        assert_eq!(event, ORCHESTRATION_WRITTEN);
        assert_eq!(payload, serde_json::json!({"origin": "main", "payload": "ws-desk"}));
        assert!(heard.try_recv().is_err(), "the desk's windows told each other already");

        dispatch(&handle, "write_orchestration", serde_json::json!({"workspaceId": "ws-phone"}))
            .expect("forward dispatch");
        let told = heard.recv_timeout(Duration::from_secs(1)).expect("the desk hears a Device's write");
        let told: serde_json::Value = serde_json::from_str(&told).unwrap();
        assert_eq!(told, serde_json::json!({"origin": FORWARDED_ORIGIN, "payload": "ws-phone"}));
        let (_, payload) = offers.recv_timeout(Duration::from_secs(1)).expect("offered to Devices");
        assert_eq!(payload, told);
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

    fn waiting(id: &str) -> AttentionItem {
        AttentionItem {
            id: id.into(),
            workspace: "ws-1".into(),
            kind: protocol::AttentionKind::Waiting,
            text: "agent is asking".into(),
            target: protocol::AttentionTarget::Session { id: "s1".into() },
        }
    }

    /// The daemon's end of a forwarding connection `serve` is serving.
    struct Daemon {
        from_desk: BufReader<Stream>,
        to_desk: Stream,
    }

    impl Daemon {
        fn over(daemon: Stream) -> Self {
            daemon.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
            Daemon { from_desk: BufReader::new(daemon.try_clone().unwrap()), to_desk: daemon }
        }

        fn next(&mut self) -> Request {
            read_message::<_, Request>(&mut self.from_desk)
                .expect("the desk wrote something readable")
                .expect("the desk kept the connection open")
        }

        fn send(&mut self, push: &Response) {
            write_message(&mut self.to_desk, push).unwrap();
        }
    }

    /// Serves one forwarding connection on a thread, as `run_loop` does
    /// after its handshake, until `wanted` turns false or the daemon's end
    /// goes away.
    fn serving(
        handle: &AppHandle<tauri::test::MockRuntime>,
        wanted: Arc<std::sync::atomic::AtomicBool>,
    ) -> (Daemon, std::thread::JoinHandle<anyhow::Result<()>>) {
        let (desk, daemon) = Stream::pair().unwrap();
        let handle = handle.clone();
        let join = std::thread::spawn(move || serve(&handle, desk, &|| wanted.load(Ordering::SeqCst)));
        (Daemon::over(daemon), join)
    }

    fn until(what: &str, check: impl Fn() -> bool) {
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while !check() {
            assert!(std::time::Instant::now() < deadline, "timed out waiting for {what}");
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    /// The daemon writes a Device's ask the moment the Device asks, from
    /// the Device's own thread, so an ask can land between an event the
    /// desk offered and the daemon's `Ok` for it. The desk answers it and
    /// carries on. Read as a malformed ack, it ended the connection for
    /// good, and every Device was told the desktop app was not running
    /// with its window open in front of the human.
    #[test]
    fn an_ask_that_lands_between_an_offer_and_its_ok_is_answered_and_the_connection_lives() {
        let (app, _webview) = mock_app_with(Arc::new(AtomicUsize::new(0)));
        let handle = app.handle().clone();
        *handle.state::<Forwarding>().attention.lock().unwrap() = vec![waiting("waiting:s1")];
        let wanted = Arc::new(std::sync::atomic::AtomicBool::new(true));
        let (mut daemon, join) = serving(&handle, Arc::clone(&wanted));
        until("the connection to take offers", || handle.state::<Forwarding>().offer.lock().unwrap().is_some());

        offer(&handle, "session-status-changed", serde_json::json!(["s1", "idle"]));
        assert!(matches!(daemon.next(), Request::OfferDesktopEvent { .. }));
        daemon.send(&Response::ForwardAttention { call_id: 7, version: 1 });
        daemon.send(&Response::Ok);
        match daemon.next() {
            Request::AttentionResult { call_id, items } => {
                assert_eq!(call_id, 7);
                assert_eq!(items, vec![waiting("waiting:s1")]);
            }
            other => panic!("expected the ask answered, got {other:?}"),
        }
        daemon.send(&Response::Ok);

        // Still serving: the next ask is answered as well.
        daemon.send(&Response::ForwardAttention { call_id: 8, version: 1 });
        assert!(matches!(daemon.next(), Request::AttentionResult { call_id: 8, .. }));
        daemon.send(&Response::Ok);

        wanted.store(false, Ordering::SeqCst);
        join.join().unwrap().expect("ends cleanly once no longer wanted");
    }

    /// A forwarding connection that ends while the app is up is dialled
    /// again, and the new one is served -- the daemon gets its desk back
    /// without anyone restarting the app.
    #[test]
    fn a_connection_that_ends_is_dialled_again_and_served() {
        let (app, _webview) = mock_app_with(Arc::new(AtomicUsize::new(0)));
        let handle = app.handle().clone();
        *handle.state::<Forwarding>().attention.lock().unwrap() = vec![waiting("waiting:s1")];
        let wanted = Arc::new(std::sync::atomic::AtomicBool::new(true));
        let (dialled_tx, dialled) = mpsc::channel::<Stream>();
        let keeper = {
            let handle = handle.clone();
            let wanted = Arc::clone(&wanted);
            std::thread::spawn(move || {
                keep_connected(&handle, &|| wanted.load(Ordering::SeqCst), || {
                    let (desk, daemon) = Stream::pair()?;
                    dialled_tx.send(daemon).map_err(|_| anyhow::anyhow!("the test is over"))?;
                    Ok(desk)
                })
            })
        };

        let first = dialled.recv_timeout(Duration::from_secs(5)).expect("dialled");
        drop(first);
        let second = dialled
            .recv_timeout(REDIAL_FLOOR + Duration::from_secs(5))
            .expect("dialled again once the first connection ended");
        let mut daemon = Daemon::over(second);
        daemon.send(&Response::ForwardAttention { call_id: 1, version: 1 });
        assert!(matches!(daemon.next(), Request::AttentionResult { call_id: 1, .. }));

        wanted.store(false, Ordering::SeqCst);
        keeper.join().unwrap();
    }

    #[test]
    fn the_redial_backs_off_to_a_ceiling() {
        assert_eq!(redial_delay(1), REDIAL_FLOOR);
        assert_eq!(redial_delay(2), REDIAL_FLOOR * 2);
        assert_eq!(redial_delay(40), REDIAL_CEILING);
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
