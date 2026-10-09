//! The desk's live view of an agent session's browser (v65,
//! `playwright-live-pane.md`; the design is
//! `docs/superpowers/specs/2026-10-08-playwright-integration-design.md`).
//!
//! The daemon screencasts the tab a session's agent acts on to whoever
//! sends it `WatchBrowser`, and only while someone does. The pane is the
//! someone: `watch_browser` when one comes on screen, `unwatch_browser`
//! when it goes, and the stream stops once no window wants it -- which is
//! what keeps a hidden pane from costing the daemon a screencast.
//!
//! - **A local session** gets a connection of its own. Closing it is the
//!   only unwatch the protocol has, and a socket of its own keeps a stream
//!   of up to 1 MiB/s off the push connection every terminal's output
//!   shares.
//! - **An ssh session** rides its host's streaming connection
//!   (`RemoteLink::watch_browser`), as the git watch does: another
//!   connection there is another ssh process. The relay hands its frames
//!   here (`relay_frame`). A shared connection has no unwatch, so the
//!   request goes out once per session per link, and frames no window
//!   wants are dropped here rather than crossing to a webview.
//!
//! Frames go only to the windows showing that session's pane, as
//! `browser-desk-frame`. Never through `forwarding::emit`: a phone asks
//! for its own small stream (spec Q4, `playwright-companion-view.md`),
//! and a desk frame offered to the forwarding connection would cross the
//! machine for nobody.
//!
//! **A Device's view** is that small stream. A Device never sends the
//! daemon a request of its own (ADR 0003), so it asks the desk:
//! `watch_browser_for_device` opens `WatchBrowser { size: phone, max_fps:
//! 2 }` on a connection of the desk's, and every frame is offered to the
//! Devices as `browser-frame`, which the daemon relays to those listening
//! for it. Nothing tells the desk a phone has gone -- locked, out of
//! range, its page closed -- so a Device's watch is a LEASE, renewed
//! while its view is on screen and let go when nobody has renewed it for
//! `DEVICE_LEASE`.
//!
//! **A Device's view of an ssh session** cannot ride the host's streaming
//! connection the desk's does: a `BrowserFrame` does not say its size, so
//! the phone's frames would be indistinguishable there from the desk's,
//! and that connection has no unwatch, so a lease running out could not
//! stop the host's screencast. So it gets a connection of its own to the
//! host's daemon (`RemoteLink::own_connection`) -- one more ssh process,
//! only while a lease holds -- which is the local view's own connection
//! with ssh in front: frames on it are the phone's, and closing it is the
//! unwatch. ssh takes a moment to connect, and forwarded commands run one
//! at a time, so the dial happens off the watch: the watch is answered
//! at once and the first frame arrives like the rest; a dial that failed
//! is said to every watch until one succeeds.
//!
//! Also the app-wide half of the pane's open setting, read and written
//! straight to config.json (`AppConfig::playwright_pane_open`).

use std::collections::{HashMap, HashSet};
use std::io::BufReader;
use std::net::Shutdown;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use protocol::transport::Stream;
use protocol::{read_message, write_message, BrowserViewSize, ConnectionKind, LiveBrowser, Request, Response};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::remote::{BridgeProcess, RemoteLink, Route};
use crate::session::{current_compat, CommandConnection, DaemonCompat, DaemonCompatState};

/// The rate the desk asks of the daemon it runs beside: the desk size's
/// cap (`BrowserViewSize::max_fps_cap`).
pub const LOCAL_FPS: u32 = 8;
/// What it asks across ssh: half, because the frames share the host's one
/// streaming connection with every terminal's output there (spec Q4).
pub const REMOTE_FPS: u32 = 4;

/// The event a window's pane reads its frames from.
pub const FRAME_EVENT: &str = "browser-desk-frame";

/// The rate a Device's view asks for: the phone size's cap, which keeps a
/// view under 75 KiB/s across the Relay (spec Q4).
pub const DEVICE_FPS: u32 = 2;

/// The event a Device's view reads its frames from (spec Q6).
pub const DEVICE_FRAME_EVENT: &str = "browser-frame";

/// How long a Device's watch holds without being renewed. The bundle
/// renews at a third of it (it is told this in every answer), so one
/// renewal lost to a slow link costs nothing, and a phone that went away
/// costs the daemon a screencast for half a minute at most.
pub const DEVICE_LEASE: Duration = Duration::from_secs(30);

/// How often a Device watch's keeper checks its leases.
const LEASE_CHECK: Duration = Duration::from_secs(1);

/// One frame, as the frontend reads it (`browserView.ts::BrowserFrame`):
/// `Response::BrowserFrame` in camelCase. `data` is the JPEG, base64, as
/// Chromium sent it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserFrame {
    pub session_id: String,
    pub seq: u64,
    pub data: String,
    pub width: u32,
    pub height: u32,
    pub url: String,
    pub title: String,
}

/// What a Device's watch answers (`browserView.ts::DeviceBrowserWatch`):
/// the newest phone-size frame the desk holds, and how long the watch
/// holds unless it is asked again.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceBrowserWatch {
    pub frame: Option<BrowserFrame>,
    pub lease_ms: u64,
}

/// Every session a window is watching, and how.
#[derive(Default)]
pub struct BrowserWatches(Mutex<Registry>);

static NEXT_WATCH: AtomicU64 = AtomicU64::new(1);

#[derive(Default)]
struct Registry {
    watches: HashMap<String, Watch>,
    /// Sessions whose `WatchBrowser` has gone out on a host's link, by the
    /// link's id. Outlives an unwatch on purpose: a shared connection has
    /// no unwatch, and asking again on the same link would put a second
    /// watcher on it and every frame across ssh twice. A new link has a
    /// new id, so a reconnect asks again.
    told: HashMap<String, u64>,
    /// The phone-size streams Devices are watching, by session. Apart from
    /// `watches`: a session can be on a desk's screen and a phone's at
    /// once, at two sizes, on two connections.
    devices: HashMap<String, DeviceStream>,
}

/// One session's phone-size stream, and who holds it.
#[derive(Default)]
struct DeviceStream {
    /// Until when each watcher's lease holds, by the id its view minted.
    leases: HashMap<String, Instant>,
    /// The newest frame, for a view that joins a stream already running.
    last: Option<BrowserFrame>,
    /// Always the stream's own connection: `Shared` only until it dials.
    conn: Conn,
    /// Why a host's stream could not be dialled, until a dial succeeds.
    /// The dial happens off the watch, so this is how its failure reaches
    /// the views: every watch meanwhile is answered with it.
    problem: Option<String>,
}

impl DeviceStream {
    fn held(&self, now: Instant) -> bool {
        self.leases.values().any(|until| *until > now)
    }
}

/// What a Device stream's keeper finds.
enum Lease {
    /// Someone renewed it in time.
    Held,
    /// Nobody did, or the stream is no longer the keeper's: its connection,
    /// if there was one, to close.
    Over(Option<Stream>),
}

#[derive(Default)]
struct Watch {
    /// The windows showing this session's pane, by label.
    windows: HashSet<String>,
    /// The newest frame, for a window that starts watching a stream that
    /// already runs: a screencast sends nothing new until the page
    /// changes.
    last: Option<BrowserFrame>,
    conn: Conn,
}

/// A local watch's own connection.
#[derive(Default)]
enum Conn {
    /// None of its own: a remote watch.
    #[default]
    Shared,
    Dialing(u64),
    Live { id: u64, stream: Stream },
}

impl Conn {
    fn id(&self) -> Option<u64> {
        match self {
            Conn::Shared => None,
            Conn::Dialing(id) | Conn::Live { id, .. } => Some(*id),
        }
    }
}

/// What a watch has to do once the registry has it.
#[derive(Debug, PartialEq)]
enum Start {
    /// The stream is already there, or on its way.
    Nothing,
    /// Dial a connection of its own; the id names that attempt.
    Dial(u64),
    /// Send `WatchBrowser` on the host's link.
    Tell,
}

impl Registry {
    fn watch_local(&mut self, session_id: &str, window: &str) -> (Start, Option<BrowserFrame>) {
        let watch = self.watches.entry(session_id.to_string()).or_default();
        watch.windows.insert(window.to_string());
        let start = match watch.conn {
            Conn::Dialing(_) | Conn::Live { .. } => Start::Nothing,
            Conn::Shared => {
                let id = NEXT_WATCH.fetch_add(1, Ordering::Relaxed);
                watch.conn = Conn::Dialing(id);
                Start::Dial(id)
            }
        };
        (start, watch.last.clone())
    }

    fn watch_remote(&mut self, session_id: &str, window: &str, link_id: u64) -> (Start, Option<BrowserFrame>) {
        let watch = self.watches.entry(session_id.to_string()).or_default();
        watch.windows.insert(window.to_string());
        let held = watch.last.clone();
        if self.told.get(session_id) == Some(&link_id) {
            return (Start::Nothing, held);
        }
        self.told.insert(session_id.to_string(), link_id);
        (Start::Tell, held)
    }

    /// The `WatchBrowser` could not be sent; the next watch tries again.
    fn tell_failed(&mut self, session_id: &str, link_id: u64) {
        if self.told.get(session_id) == Some(&link_id) {
            self.told.remove(session_id);
        }
    }

    /// The dial `id` connected. Hands the stream back when the watch it was
    /// for is gone or was replaced meanwhile, for the caller to close.
    fn dialed(&mut self, session_id: &str, id: u64, stream: Stream) -> Result<(), Stream> {
        match self.watches.get_mut(session_id) {
            Some(watch) if matches!(watch.conn, Conn::Dialing(d) if d == id) => {
                watch.conn = Conn::Live { id, stream };
                Ok(())
            }
            _ => Err(stream),
        }
    }

    /// The dial `id` failed: the watch is left with no connection, so the
    /// next watch dials again.
    fn dial_failed(&mut self, session_id: &str, id: u64) {
        if let Some(watch) = self.watches.get_mut(session_id) {
            if matches!(watch.conn, Conn::Dialing(d) if d == id) {
                watch.conn = Conn::Shared;
            }
        }
    }

    /// `window` no longer shows the pane. Answers the connection to close
    /// when it was the last.
    fn unwatch(&mut self, session_id: &str, window: &str) -> Option<Stream> {
        let watch = self.watches.get_mut(session_id)?;
        watch.windows.remove(window);
        if !watch.windows.is_empty() {
            return None;
        }
        match self.watches.remove(session_id)?.conn {
            Conn::Live { stream, .. } => Some(stream),
            _ => None,
        }
    }

    /// A frame from the local connection `local` (or, `None`, from a
    /// host's relay). Answers the windows to show it in -- `None` when no
    /// watch wants it, which tells a local reader its watch is over.
    fn frame(&mut self, frame: &BrowserFrame, local: Option<u64>) -> Option<Vec<String>> {
        let watch = self.watches.get_mut(&frame.session_id)?;
        if watch.conn.id() != local {
            return None;
        }
        watch.last = Some(frame.clone());
        Some(watch.windows.iter().cloned().collect())
    }

    /// The session ended. Answers its connection, if it had one, to close.
    fn gone(&mut self, session_id: &str) -> Option<Stream> {
        self.told.remove(session_id);
        match self.watches.remove(session_id)?.conn {
            Conn::Live { stream, .. } => Some(stream),
            _ => None,
        }
    }

    /// The local connection `id` ended without the session ending -- the
    /// daemon restarted, or the watch was let go. Forgets the watch only
    /// if it is still that connection's, so the next watch dials afresh.
    fn ended(&mut self, session_id: &str, id: u64) {
        if self.watches.get(session_id).and_then(|w| w.conn.id()) == Some(id) {
            self.watches.remove(session_id);
        }
    }

    // -- a Device's watches --------------------------------------------

    /// `watcher` takes, or renews, its lease on the session's phone-size
    /// stream.
    fn watch_device(&mut self, session_id: &str, watcher: &str, now: Instant) -> (Start, Option<BrowserFrame>) {
        let stream = self.devices.entry(session_id.to_string()).or_default();
        // A view back after every lease ran out -- a phone that went away
        // without letting go -- is not told what failed for the last one.
        if !stream.held(now) {
            stream.problem = None;
        }
        stream.leases.insert(watcher.to_string(), now + DEVICE_LEASE);
        let start = match stream.conn {
            Conn::Dialing(_) | Conn::Live { .. } => Start::Nothing,
            Conn::Shared => {
                let id = NEXT_WATCH.fetch_add(1, Ordering::Relaxed);
                stream.conn = Conn::Dialing(id);
                Start::Dial(id)
            }
        };
        (start, stream.last.clone())
    }

    /// The dial `id` connected. Hands the stream back when it was let go
    /// of meanwhile, for the caller to close.
    fn device_dialed(&mut self, session_id: &str, id: u64, stream: Stream) -> Result<(), Stream> {
        match self.devices.get_mut(session_id) {
            Some(device) if matches!(device.conn, Conn::Dialing(d) if d == id) => {
                device.conn = Conn::Live { id, stream };
                device.problem = None;
                Ok(())
            }
            _ => Err(stream),
        }
    }

    /// A host's dial `id` failed, off the watch that started it. Unlike a
    /// local dial's failure the leases stay: the views are still asking,
    /// and the next watch both dials again and is told why the last one
    /// could not.
    fn device_dial_refused(&mut self, session_id: &str, id: u64, problem: String) {
        if let Some(device) = self.devices.get_mut(session_id) {
            if matches!(device.conn, Conn::Dialing(d) if d == id) {
                device.conn = Conn::Shared;
                device.problem = Some(problem);
            }
        }
    }

    /// What a watch of the session's stream is answered with instead of
    /// its frame: why the last dial failed, while no stream is up.
    fn device_problem(&self, session_id: &str) -> Option<String> {
        let device = self.devices.get(session_id)?;
        match device.conn {
            Conn::Live { .. } => None,
            _ => device.problem.clone(),
        }
    }

    /// The dial `id` failed: the lease taken for it goes too, so the
    /// view's next renewal dials again rather than holding nothing.
    fn device_dial_failed(&mut self, session_id: &str, id: u64) {
        if matches!(self.devices.get(session_id).map(|d| &d.conn), Some(Conn::Dialing(d)) if *d == id) {
            self.devices.remove(session_id);
        }
    }

    /// `watcher`'s view left the screen. Answers the connection to close
    /// when it held the last lease.
    fn unwatch_device(&mut self, session_id: &str, watcher: &str) -> Option<Stream> {
        let stream = self.devices.get_mut(session_id)?;
        stream.leases.remove(watcher);
        if !stream.leases.is_empty() {
            return None;
        }
        match self.devices.remove(session_id)?.conn {
            Conn::Live { stream, .. } => Some(stream),
            _ => None,
        }
    }

    /// A frame from the Device connection `id`. `None` when that
    /// connection is no longer the session's stream, which tells its
    /// reader to stop; otherwise whether to offer it -- a stream whose
    /// leases have all run out is not shown to anybody while its keeper
    /// comes round to close it.
    fn device_frame(&mut self, frame: &BrowserFrame, id: u64, now: Instant) -> Option<bool> {
        let stream = self.devices.get_mut(&frame.session_id)?;
        if stream.conn.id() != Some(id) {
            return None;
        }
        stream.last = Some(frame.clone());
        Some(stream.held(now))
    }

    /// The keeper of the Device connection `id` checks its leases.
    fn expire_device(&mut self, session_id: &str, id: u64, now: Instant) -> Lease {
        let Some(stream) = self.devices.get_mut(session_id) else { return Lease::Over(None) };
        if stream.conn.id() != Some(id) {
            return Lease::Over(None);
        }
        stream.leases.retain(|_, until| *until > now);
        if !stream.leases.is_empty() {
            return Lease::Held;
        }
        match self.devices.remove(session_id).map(|s| s.conn) {
            Some(Conn::Live { stream, .. }) => Lease::Over(Some(stream)),
            _ => Lease::Over(None),
        }
    }

    /// The Device connection `id` ended without the session ending. The
    /// leases go with it: the views' next renewal dials afresh.
    fn device_ended(&mut self, session_id: &str, id: u64) {
        if self.devices.get(session_id).and_then(|d| d.conn.id()) == Some(id) {
            self.devices.remove(session_id);
        }
    }

    /// The session ended. Answers its Device connection, if any, to close.
    fn device_gone(&mut self, session_id: &str) -> Option<Stream> {
        match self.devices.remove(session_id)?.conn {
            Conn::Live { stream, .. } => Some(stream),
            _ => None,
        }
    }
}

/// Starts (or joins) the session's stream for the calling window, and
/// answers the newest frame the desk already holds for it.
///
/// Off the main thread: a local watch dials and handshakes a connection.
#[tauri::command]
pub async fn watch_browser(
    session_id: String,
    app_handle: AppHandle,
    window: tauri::Window,
) -> Result<Option<BrowserFrame>, String> {
    let label = window.label().to_string();
    tauri::async_runtime::spawn_blocking(move || watch(&app_handle, &session_id, &label))
        .await
        .map_err(|e| e.to_string())?
}

fn watch(app: &AppHandle, session_id: &str, window: &str) -> Result<Option<BrowserFrame>, String> {
    let watches = app.state::<BrowserWatches>();
    match crate::remote::route_for_session(app, session_id)? {
        Route::Local => {
            let (start, held) = watches.0.lock().unwrap().watch_local(session_id, window);
            let Start::Dial(id) = start else {
                return Ok(held);
            };
            let compat = current_compat(&app.state::<DaemonCompatState>());
            let dialled = dial(session_id, &compat, BrowserViewSize::Desk, LOCAL_FPS).and_then(|stream| {
                let reader = stream.try_clone()?;
                Ok((stream, reader))
            });
            match dialled {
                Ok((stream, reader)) => match watches.0.lock().unwrap().dialed(session_id, id, stream) {
                    Ok(()) => {
                        let (app, session_id) = (app.clone(), session_id.to_string());
                        std::thread::Builder::new()
                            .name("browser-view".into())
                            .spawn(move || read_watch(&app, &session_id, id, reader))
                            .map_err(|e| e.to_string())?;
                    }
                    // Let go of while it dialled.
                    Err(stream) => {
                        let _ = stream.shutdown(Shutdown::Both);
                    }
                },
                Err(e) => {
                    watches.0.lock().unwrap().dial_failed(session_id, id);
                    return Err(e.to_string());
                }
            }
            Ok(held)
        }
        Route::Remote(link) => {
            let (start, held) = watches.0.lock().unwrap().watch_remote(session_id, window, link.id);
            if start == Start::Tell {
                if let Err(e) = link.watch_browser(session_id) {
                    watches.0.lock().unwrap().tell_failed(session_id, link.id);
                    return Err(e.to_string());
                }
            }
            Ok(held)
        }
    }
}

/// The calling window no longer shows the session's pane. A plain `fn`:
/// it only closes a socket.
#[tauri::command]
pub fn unwatch_browser(session_id: String, app_handle: AppHandle, window: tauri::Window) {
    let stream = app_handle.state::<BrowserWatches>().0.lock().unwrap().unwatch(&session_id, window.label());
    if let Some(stream) = stream {
        let _ = stream.shutdown(Shutdown::Both);
    }
}

/// A connection of the watch's own to the local daemon, presented as the
/// app and with its `WatchBrowser` sent.
///
/// Introduced as a COMMAND connection although it sends one request and
/// then only reads: the daemon sends its broadcast pushes to an app's
/// push connections (`ConnectionKind::takes_device_pushes`), and none of
/// them belong on this one.
fn dial(session_id: &str, compat: &DaemonCompat, size: BrowserViewSize, max_fps: u32) -> anyhow::Result<Stream> {
    let request = Request::WatchBrowser { session_id: session_id.to_string(), size, max_fps };
    crate::session::gate(&request, compat).map_err(anyhow::Error::msg)?;
    let socket = protocol::socket_path()?;
    let mut stream = crate::session::connect_local(&socket)?;
    if let Some(token) = crate::session::read_daemon_token() {
        let nonce = protocol::random_hex(16)?;
        write_message(&mut stream, &crate::session::app_hello(&token, &nonce, ConnectionKind::Command))?;
        // One byte at a time, so nothing after the ack is swallowed.
        let mut reader = BufReader::with_capacity(1, &mut stream);
        let ack = read_message(&mut reader)?
            .ok_or_else(|| anyhow::anyhow!("the daemon closed the connection during the browser view's Hello"))?;
        crate::session::verify_app_ack(ack, &token, &nonce)?;
    }
    send_watch(stream, &request)
}

/// Sends the watch on a connection already presented as the app. The
/// connect's handshake deadline is lifted: an idle page sends nothing for
/// as long as it stays idle.
fn send_watch(mut stream: Stream, request: &Request) -> anyhow::Result<Stream> {
    write_message(&mut stream, request)?;
    let _ = stream.set_read_timeout(None);
    Ok(stream)
}

/// The watch a Device's stream sends: the phone's size, at its rate.
fn phone_watch(session_id: &str) -> Request {
    Request::WatchBrowser { session_id: session_id.to_string(), size: BrowserViewSize::Phone, max_fps: DEVICE_FPS }
}

/// What a local watch's connection carries, until it ends.
enum Read {
    Frame(BrowserFrame),
    Gone(String),
    /// The daemon refused the watch -- a session it does not host.
    Refused(String),
    Other,
}

fn next(reader: &mut BufReader<Stream>) -> Option<Read> {
    match read_message(reader) {
        Ok(Some(Response::BrowserFrame { session_id, seq, data, width, height, url, title })) => {
            Some(Read::Frame(BrowserFrame { session_id, seq, data, width, height, url, title }))
        }
        Ok(Some(Response::BrowserGone { session_id })) => Some(Read::Gone(session_id)),
        Ok(Some(Response::Error { message })) => Some(Read::Refused(message)),
        Ok(Some(_)) => Some(Read::Other),
        Ok(None) | Err(_) => None,
    }
}

fn read_watch(app: &AppHandle, session_id: &str, id: u64, stream: Stream) {
    let mut reader = BufReader::new(stream);
    while let Some(read) = next(&mut reader) {
        match read {
            Read::Frame(frame) => {
                let windows = app.state::<BrowserWatches>().0.lock().unwrap().frame(&frame, Some(id));
                match windows {
                    Some(windows) => emit_frame(app, &windows, &frame),
                    None => break,
                }
            }
            Read::Gone(gone_id) => {
                gone(app, &gone_id);
                return;
            }
            Read::Refused(message) => {
                eprintln!("gavin browser view: the daemon refused to watch {session_id}: {message}");
                break;
            }
            Read::Other => {}
        }
    }
    app.state::<BrowserWatches>().0.lock().unwrap().ended(session_id, id);
}

fn emit_frame(app: &AppHandle, windows: &[String], frame: &BrowserFrame) {
    for label in windows {
        let _ = app.emit_to(label.as_str(), FRAME_EVENT, frame);
    }
}

/// The session ended: its watches go -- a desk's and a Device's -- and
/// every window and every Device hears it.
fn gone(app: &AppHandle, session_id: &str) {
    let watches = app.state::<BrowserWatches>();
    let streams = {
        let mut registry = watches.0.lock().unwrap();
        [registry.gone(session_id), registry.device_gone(session_id)]
    };
    for stream in streams.into_iter().flatten() {
        let _ = stream.shutdown(Shutdown::Both);
    }
    let _ = crate::forwarding::emit(app, "browser-gone", session_id.to_string());
}

/// A `BrowserFrame` the relay read off a host's link.
pub(crate) fn relay_frame(app: &AppHandle, frame: BrowserFrame) {
    let windows = app.state::<BrowserWatches>().0.lock().unwrap().frame(&frame, None);
    if let Some(windows) = windows {
        emit_frame(app, &windows, &frame);
    }
}

/// A `BrowserGone` the relay read off a host's link.
pub(crate) fn relay_gone(app: &AppHandle, session_id: &str) {
    gone(app, session_id);
}

// -- a Device's view -------------------------------------------------------

/// A Device's view of the session's browser, on screen: takes or renews
/// `watcher`'s lease on the session's phone-size stream, starting the
/// stream if it is the first, and answers the newest frame the desk holds
/// with how long the lease lasts. Frames go to the Devices as
/// `browser-frame`.
///
/// Off the main thread: the first watch of a session here dials and
/// handshakes a connection. A host's is dialled on a thread of its own.
#[tauri::command]
pub async fn watch_browser_for_device(
    session_id: String,
    watcher: String,
    app_handle: AppHandle,
) -> Result<DeviceBrowserWatch, String> {
    tauri::async_runtime::spawn_blocking(move || watch_for_device(&app_handle, &session_id, &watcher))
        .await
        .map_err(|e| e.to_string())?
}

fn watch_for_device(app: &AppHandle, session_id: &str, watcher: &str) -> Result<DeviceBrowserWatch, String> {
    match crate::remote::route_for_session(app, session_id)? {
        Route::Local => watch_local_for_device(app, session_id, watcher),
        Route::Remote(link) => watch_host_for_device(app, link, session_id, watcher),
    }
}

fn lease_answer(frame: Option<BrowserFrame>) -> DeviceBrowserWatch {
    DeviceBrowserWatch { frame, lease_ms: DEVICE_LEASE.as_millis() as u64 }
}

/// A session on this machine: the stream is a connection of its own to
/// the daemon here, dialled before answering -- a local connect takes no
/// time worth keeping a Device's other commands waiting for.
fn watch_local_for_device(app: &AppHandle, session_id: &str, watcher: &str) -> Result<DeviceBrowserWatch, String> {
    let watches = app.state::<BrowserWatches>();
    let (start, held) = watches.0.lock().unwrap().watch_device(session_id, watcher, Instant::now());
    if let Start::Dial(id) = start {
        let compat = current_compat(&app.state::<DaemonCompatState>());
        let started = dial(session_id, &compat, BrowserViewSize::Phone, DEVICE_FPS)
            .map_err(|e| e.to_string())
            .and_then(|stream| start_device_stream(app, session_id, id, stream, None));
        if let Err(e) = started {
            watches.0.lock().unwrap().device_dial_failed(session_id, id);
            return Err(e);
        }
    }
    Ok(lease_answer(held))
}

/// An ssh session: the stream is a connection of its own to the HOST's
/// daemon, one more ssh process (see the module's note). Dialled on a
/// thread of its own, so the answer does not wait on ssh: until the dial
/// is up the view hears nothing, and once it failed every watch is told
/// why -- and dials again.
fn watch_host_for_device(
    app: &AppHandle,
    link: std::sync::Arc<RemoteLink>,
    session_id: &str,
    watcher: &str,
) -> Result<DeviceBrowserWatch, String> {
    // Refused here, before anything is held or dialled: the host's own
    // version is the one that counts, never this machine's.
    if let Err(gated) = protocol::gate_request(&phone_watch(session_id), link.compat.daemon_version) {
        return Err(format!(
            "Needs gavin-daemon v{} on {}; the daemon there is v{}. Update it on the host and reconnect.",
            gated.needed, link.host, gated.daemon
        ));
    }
    let watches = app.state::<BrowserWatches>();
    let (start, held, problem) = {
        let mut registry = watches.0.lock().unwrap();
        let (start, held) = registry.watch_device(session_id, watcher, Instant::now());
        (start, held, registry.device_problem(session_id))
    };
    if let Start::Dial(id) = start {
        let (dialing, session) = (app.clone(), session_id.to_string());
        let spawned = std::thread::Builder::new().name("browser-view-device-dial".into()).spawn(move || {
            let started = dial_host(&link, &session)
                .map_err(|e| e.to_string())
                .and_then(|(stream, process)| start_device_stream(&dialing, &session, id, stream, Some(process)));
            if let Err(e) = started {
                let problem = format!("Could not reach {} for this view: {e}", link.host);
                dialing.state::<BrowserWatches>().0.lock().unwrap().device_dial_refused(&session, id, problem);
            }
        });
        if let Err(e) = spawned {
            watches.0.lock().unwrap().device_dial_failed(session_id, id);
            return Err(e.to_string());
        }
    }
    match problem {
        Some(problem) => Err(problem),
        None => Ok(lease_answer(held)),
    }
}

/// A connection of the stream's own to a host's daemon, its watch sent.
fn dial_host(link: &RemoteLink, session_id: &str) -> anyhow::Result<(Stream, BridgeProcess)> {
    let (stream, process) = link.own_connection(ConnectionKind::Command)?;
    Ok((send_watch(stream, &phone_watch(session_id))?, process))
}

/// Hands a dialled Device stream to the registry, then reads it and keeps
/// its leases on threads of their own. A host's ssh process goes with the
/// reading. A stream let go of while it dialled is closed here.
fn start_device_stream(
    app: &AppHandle,
    session_id: &str,
    id: u64,
    stream: Stream,
    process: Option<BridgeProcess>,
) -> Result<(), String> {
    let watches = app.state::<BrowserWatches>();
    let reader = stream.try_clone().map_err(|e| e.to_string())?;
    if let Err(stream) = watches.0.lock().unwrap().device_dialed(session_id, id, stream) {
        let _ = stream.shutdown(Shutdown::Both);
        return Ok(());
    }
    let (reading, session) = (app.clone(), session_id.to_string());
    std::thread::Builder::new()
        .name("browser-view-device".into())
        .spawn(move || {
            let watches = reading.state::<BrowserWatches>();
            let offer = |frame: &BrowserFrame| {
                let payload = serde_json::to_value(frame).unwrap_or(serde_json::Value::Null);
                crate::forwarding::offer(&reading, DEVICE_FRAME_EVENT, payload);
            };
            let gone_id = read_device_watch(&watches, &session, id, reader, &offer);
            drop(process);
            if let Some(gone_id) = gone_id {
                gone(&reading, &gone_id);
            }
        })
        .map_err(|e| e.to_string())?;
    let (keeping, session) = (app.clone(), session_id.to_string());
    std::thread::Builder::new()
        .name("browser-view-lease".into())
        .spawn(move || keep_device_watch(&keeping.state::<BrowserWatches>(), &session, id))
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// `watcher`'s view left the screen. Closes the stream when it held the
/// last lease; another Device's view keeps it. A plain `fn`: it only
/// closes a socket.
#[tauri::command]
pub fn unwatch_browser_for_device(session_id: String, watcher: String, app_handle: AppHandle) {
    let stream = app_handle.state::<BrowserWatches>().0.lock().unwrap().unwatch_device(&session_id, &watcher);
    if let Some(stream) = stream {
        let _ = stream.shutdown(Shutdown::Both);
    }
}

/// Reads a Device stream's connection until it ends, offering each frame
/// while a lease holds it. Answers the session when the daemon said its
/// browser is gone, for the caller to tell everyone.
///
/// Reads to the end whatever is offered: a frame nobody holds is dropped
/// here, never left in the socket, so the daemon's writer for this
/// watcher never waits on it.
fn read_device_watch(
    watches: &BrowserWatches,
    session_id: &str,
    id: u64,
    stream: Stream,
    offer: &dyn Fn(&BrowserFrame),
) -> Option<String> {
    let mut reader = BufReader::new(stream);
    while let Some(read) = next(&mut reader) {
        match read {
            Read::Frame(frame) => {
                let shown = watches.0.lock().unwrap().device_frame(&frame, id, Instant::now());
                match shown {
                    Some(true) => offer(&frame),
                    Some(false) => {}
                    None => break,
                }
            }
            Read::Gone(gone_id) => return Some(gone_id),
            Read::Refused(message) => {
                eprintln!("gavin browser view: the daemon refused a Device's watch of {session_id}: {message}");
                break;
            }
            Read::Other => {}
        }
    }
    watches.0.lock().unwrap().device_ended(session_id, id);
    None
}

/// Closes a Device stream once nobody has renewed it for `DEVICE_LEASE`,
/// and ends with it -- or as soon as the stream is no longer its own.
fn keep_device_watch(watches: &BrowserWatches, session_id: &str, id: u64) {
    loop {
        std::thread::sleep(LEASE_CHECK);
        let lease = watches.0.lock().unwrap().expire_device(session_id, id, Instant::now());
        if let Lease::Over(stream) = lease {
            if let Some(stream) = stream {
                let _ = stream.shutdown(Shutdown::Both);
            }
            return;
        }
    }
}

/// Every running browser on every daemon the app talks to (v65): the
/// read-back for `browser-changed`, so a reload does not hide a live
/// browser's chip until its next navigation.
///
/// A daemon that cannot answer -- too old, or a host out of its budget --
/// is left out rather than failing the read for the rest: the lane
/// refuses `ListBrowsers` to a daemon below v65 before it is sent.
#[tauri::command]
pub async fn list_browsers(
    app_handle: AppHandle,
    state: State<'_, CommandConnection>,
    compat: State<'_, DaemonCompatState>,
) -> Result<Vec<LiveBrowser>, String> {
    let local = state.lanes(current_compat(&compat)).submit(Request::ListBrowsers);
    let links = crate::remote::ask_every_link(&app_handle, |link| {
        let lanes = link.lanes();
        async move { browsers_of(lanes.request(Request::ListBrowsers).await) }
    });
    let mut browsers = match local {
        Ok(reply) => browsers_of(reply.await).unwrap_or_default(),
        Err(_) => Vec::new(),
    };
    for more in links.answers().await {
        browsers.extend(more);
    }
    Ok(browsers)
}

fn browsers_of(reply: anyhow::Result<Response>) -> Result<Vec<LiveBrowser>, String> {
    match reply.map_err(|e| e.to_string())? {
        Response::Browsers { browsers } => Ok(browsers),
        Response::Error { message } => Err(message),
        other => Err(format!("expected Browsers, got {other:?}")),
    }
}

/// The app-wide pane setting: `auto`, `chip`, or `None` when nobody chose.
#[tauri::command]
pub fn get_playwright_pane_open(app_handle: AppHandle) -> Option<String> {
    let dir = app_handle.path().app_config_dir().ok()?;
    crate::config::load(&dir).ok()?.playwright_pane_open
}

/// Sets the app-wide pane setting, or (`None`) clears it back to gavin's
/// default, and tells every window to re-read it.
#[tauri::command]
pub fn set_playwright_pane_open(
    value: Option<String>,
    app_handle: AppHandle,
    window: tauri::Window,
    request: tauri::ipc::Request<'_>,
) -> Result<(), String> {
    let value = checked_pane_open(value)?;
    let dir = app_handle.path().app_config_dir().map_err(|e| e.to_string())?;
    write_pane_open(&dir, value)?;
    crate::session::announce_app_settings(&app_handle, &window, &request);
    Ok(())
}

/// Only the two words the frontend reads; anything else would be stored
/// and then read back as "no setting".
fn checked_pane_open(value: Option<String>) -> Result<Option<String>, String> {
    match value.as_deref() {
        None | Some("auto") | Some("chip") => Ok(value),
        Some(other) => Err(format!("`{other}` is not a browser pane setting (auto or chip)")),
    }
}

fn write_pane_open(dir: &std::path::Path, value: Option<String>) -> Result<(), String> {
    let mut config = crate::config::load(dir).map_err(|e| e.to_string())?;
    config.playwright_pane_open = value;
    crate::config::save(dir, &config).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(session_id: &str, seq: u64) -> BrowserFrame {
        BrowserFrame {
            session_id: session_id.to_string(),
            seq,
            data: format!("jpeg-{seq}"),
            width: 1280,
            height: 800,
            url: "https://example.test/".to_string(),
            title: "Example".to_string(),
        }
    }

    fn live(registry: &mut Registry, session_id: &str, window: &str) -> (u64, Stream) {
        let (start, _) = registry.watch_local(session_id, window);
        let Start::Dial(id) = start else { panic!("expected a dial, got {start:?}") };
        let (ours, theirs) = Stream::pair().unwrap();
        assert!(registry.dialed(session_id, id, ours).is_ok());
        (id, theirs)
    }

    #[test]
    fn a_local_session_dials_once_however_many_windows_watch_it() {
        let mut registry = Registry::default();
        let (id, _far) = live(&mut registry, "s1", "main");
        let (start, _) = registry.watch_local("s1", "ws-window");
        assert_eq!(start, Start::Nothing);

        let mut windows = registry.frame(&frame("s1", 1), Some(id)).unwrap();
        windows.sort();
        assert_eq!(windows, vec!["main".to_string(), "ws-window".to_string()]);
    }

    #[test]
    fn the_connection_closes_with_the_last_window_and_not_before() {
        let mut registry = Registry::default();
        let (_, _far) = live(&mut registry, "s1", "main");
        registry.watch_local("s1", "other");

        assert!(registry.unwatch("s1", "other").is_none());
        assert!(registry.unwatch("s1", "main").is_some());
        // Gone with it: the next watch dials a fresh connection.
        assert!(matches!(registry.watch_local("s1", "main").0, Start::Dial(_)));
    }

    #[test]
    fn a_window_joining_a_running_stream_is_handed_the_newest_frame() {
        let mut registry = Registry::default();
        let (id, _far) = live(&mut registry, "s1", "main");
        registry.frame(&frame("s1", 1), Some(id));
        registry.frame(&frame("s1", 2), Some(id));

        let (_, held) = registry.watch_local("s1", "other");
        assert_eq!(held.map(|f| f.seq), Some(2));
    }

    #[test]
    fn a_dial_let_go_of_meanwhile_hands_its_stream_back_to_be_closed() {
        let mut registry = Registry::default();
        let Start::Dial(id) = registry.watch_local("s1", "main").0 else { panic!("no dial") };
        assert!(registry.unwatch("s1", "main").is_none());

        let (ours, _theirs) = Stream::pair().unwrap();
        assert!(registry.dialed("s1", id, ours).is_err());
    }

    #[test]
    fn a_failed_dial_is_tried_again_by_the_next_watch() {
        let mut registry = Registry::default();
        let Start::Dial(id) = registry.watch_local("s1", "main").0 else { panic!("no dial") };
        registry.dial_failed("s1", id);
        assert!(matches!(registry.watch_local("s1", "main").0, Start::Dial(_)));
    }

    #[test]
    fn a_reader_whose_watch_was_replaced_stops_and_leaves_the_new_one_alone() {
        let mut registry = Registry::default();
        let (old, _far) = live(&mut registry, "s1", "main");
        registry.unwatch("s1", "main");
        let (new, _far2) = live(&mut registry, "s1", "main");

        // The old connection's last frame finds no watch of its own...
        assert!(registry.frame(&frame("s1", 9), Some(old)).is_none());
        // ...and its end does not take the new watch with it.
        registry.ended("s1", old);
        assert!(registry.frame(&frame("s1", 10), Some(new)).is_some());
    }

    #[test]
    fn a_host_is_told_once_per_link_and_again_after_a_reconnect() {
        let mut registry = Registry::default();
        assert_eq!(registry.watch_remote("s1", "main", 7).0, Start::Tell);
        assert_eq!(registry.watch_remote("s1", "other", 7).0, Start::Nothing);

        // A shared connection has no unwatch: letting go and coming back on
        // the same link must not put a second watcher on it.
        registry.unwatch("s1", "main");
        registry.unwatch("s1", "other");
        assert_eq!(registry.watch_remote("s1", "main", 7).0, Start::Nothing);

        // A new link is a new connection, whose host knows nothing of it.
        assert_eq!(registry.watch_remote("s1", "main", 8).0, Start::Tell);
    }

    #[test]
    fn a_hosts_frames_reach_only_the_windows_watching_and_are_dropped_after() {
        let mut registry = Registry::default();
        registry.watch_remote("s1", "main", 7);
        assert_eq!(registry.frame(&frame("s1", 1), None), Some(vec!["main".to_string()]));

        registry.unwatch("s1", "main");
        assert_eq!(registry.frame(&frame("s1", 2), None), None);
        // A relayed frame never lands on a local watch's session either.
        let (_, _far) = live(&mut registry, "s2", "main");
        assert_eq!(registry.frame(&frame("s2", 1), None), None);
    }

    #[test]
    fn a_tell_that_failed_is_sent_again() {
        let mut registry = Registry::default();
        registry.watch_remote("s1", "main", 7);
        registry.tell_failed("s1", 7);
        assert_eq!(registry.watch_remote("s1", "main", 7).0, Start::Tell);
    }

    #[test]
    fn the_session_ending_forgets_its_watch_and_what_the_host_was_told() {
        let mut registry = Registry::default();
        let (_, _far) = live(&mut registry, "s1", "main");
        assert!(registry.gone("s1").is_some());
        assert!(registry.frame(&frame("s1", 1), None).is_none());

        registry.watch_remote("s2", "main", 7);
        registry.gone("s2");
        assert_eq!(registry.watch_remote("s2", "main", 7).0, Start::Tell);
    }

    #[test]
    fn a_local_watch_reads_frames_until_the_session_is_gone() {
        let (ours, mut theirs) = Stream::pair().unwrap();
        write_message(&mut theirs, &Response::BrowserFrame {
            session_id: "s1".into(),
            seq: 1,
            data: "jpeg".into(),
            width: 1280,
            height: 800,
            url: "https://example.test/".into(),
            title: "Example".into(),
        })
        .unwrap();
        write_message(&mut theirs, &Response::BrowserGone { session_id: "s1".into() }).unwrap();
        drop(theirs);

        let mut reader = BufReader::new(ours);
        assert!(matches!(next(&mut reader), Some(Read::Frame(f)) if f.seq == 1 && f.data == "jpeg"));
        assert!(matches!(next(&mut reader), Some(Read::Gone(id)) if id == "s1"));
        assert!(next(&mut reader).is_none());
    }

    // -- a Device's view ---------------------------------------------------

    fn device_live(registry: &mut Registry, session_id: &str, watcher: &str, now: Instant) -> (u64, Stream) {
        let (start, _) = registry.watch_device(session_id, watcher, now);
        let Start::Dial(id) = start else { panic!("expected a dial, got {start:?}") };
        let (ours, theirs) = Stream::pair().unwrap();
        assert!(registry.device_dialed(session_id, id, ours).is_ok());
        (id, theirs)
    }

    fn ago(by: Duration) -> Instant {
        Instant::now().checked_sub(by).expect("a clock that has run that long")
    }

    #[test]
    fn a_devices_stream_dials_once_however_many_views_hold_it() {
        let mut registry = Registry::default();
        let now = Instant::now();
        let (id, _far) = device_live(&mut registry, "s1", "phone-a", now);
        assert_eq!(registry.watch_device("s1", "phone-b", now).0, Start::Nothing);
        // A renewal is a watch like any other, and dials nothing.
        assert_eq!(registry.watch_device("s1", "phone-a", now).0, Start::Nothing);
        assert_eq!(registry.device_frame(&frame("s1", 1), id, now), Some(true));
    }

    #[test]
    fn a_device_stream_is_not_the_desks_and_the_desks_is_not_a_devices() {
        let mut registry = Registry::default();
        let now = Instant::now();
        let (desk, _far) = live(&mut registry, "s1", "main");
        let (device, _far2) = device_live(&mut registry, "s1", "phone", now);
        assert_ne!(desk, device);

        // Each connection's frames reach only its own audience: a desk frame
        // is never offered to a phone, nor a phone frame drawn at the desk.
        assert_eq!(registry.device_frame(&frame("s1", 1), desk, now), None);
        assert!(registry.frame(&frame("s1", 1), Some(device)).is_none());
        // And a desk joining later does not take the phone's newest frame.
        registry.device_frame(&frame("s1", 2), device, now);
        let (_, held) = registry.watch_local("s1", "other");
        assert_eq!(held, None);
    }

    #[test]
    fn a_view_joining_a_device_stream_is_handed_its_newest_frame() {
        let mut registry = Registry::default();
        let now = Instant::now();
        let (id, _far) = device_live(&mut registry, "s1", "phone-a", now);
        registry.device_frame(&frame("s1", 1), id, now);
        registry.device_frame(&frame("s1", 2), id, now);

        let (_, held) = registry.watch_device("s1", "phone-b", now);
        assert_eq!(held.map(|f| f.seq), Some(2));
    }

    #[test]
    fn a_device_stream_closes_when_its_last_view_lets_go_and_not_before() {
        let mut registry = Registry::default();
        let now = Instant::now();
        let (_, _far) = device_live(&mut registry, "s1", "phone-a", now);
        registry.watch_device("s1", "phone-b", now);

        assert!(registry.unwatch_device("s1", "phone-a").is_none());
        assert!(registry.unwatch_device("s1", "phone-b").is_some());
        assert!(matches!(registry.watch_device("s1", "phone-a", now).0, Start::Dial(_)));
    }

    #[test]
    fn a_lease_nobody_renews_runs_out_and_closes_the_stream() {
        let mut registry = Registry::default();
        let taken = ago(DEVICE_LEASE + Duration::from_secs(5));
        let (id, _far) = device_live(&mut registry, "s1", "phone", taken);

        // Still held a moment before it runs out...
        assert!(matches!(registry.expire_device("s1", id, taken + DEVICE_LEASE / 2), Lease::Held));
        // ...not shown to anybody once it has, while the keeper comes round...
        assert_eq!(registry.device_frame(&frame("s1", 1), id, Instant::now()), Some(false));
        // ...and closed when it does.
        assert!(matches!(registry.expire_device("s1", id, Instant::now()), Lease::Over(Some(_))));
        assert!(matches!(registry.watch_device("s1", "phone", Instant::now()).0, Start::Dial(_)));
    }

    #[test]
    fn a_renewal_keeps_the_stream_and_one_phones_silence_does_not_end_anothers() {
        let mut registry = Registry::default();
        let taken = ago(DEVICE_LEASE + Duration::from_secs(5));
        let (id, _far) = device_live(&mut registry, "s1", "gone-phone", taken);
        registry.watch_device("s1", "here-phone", Instant::now());

        assert!(matches!(registry.expire_device("s1", id, Instant::now()), Lease::Held));
        // The phone that went quiet is let go of; the one renewing keeps it.
        assert!(registry.unwatch_device("s1", "here-phone").is_some());
    }

    #[test]
    fn a_keeper_whose_stream_was_replaced_stops_and_leaves_the_new_one_alone() {
        let mut registry = Registry::default();
        let now = Instant::now();
        let (old, _far) = device_live(&mut registry, "s1", "phone", now);
        registry.unwatch_device("s1", "phone");
        let (new, _far2) = device_live(&mut registry, "s1", "phone", now);

        assert!(matches!(registry.expire_device("s1", old, now), Lease::Over(None)));
        assert_eq!(registry.device_frame(&frame("s1", 3), old, now), None);
        registry.device_ended("s1", old);
        assert_eq!(registry.device_frame(&frame("s1", 4), new, now), Some(true));
    }

    #[test]
    fn a_failed_device_dial_takes_its_lease_with_it_and_the_next_watch_dials() {
        let mut registry = Registry::default();
        let Start::Dial(id) = registry.watch_device("s1", "phone", Instant::now()).0 else { panic!("no dial") };
        registry.device_dial_failed("s1", id);
        assert!(matches!(registry.watch_device("s1", "phone", Instant::now()).0, Start::Dial(_)));
    }

    #[test]
    fn a_hosts_dial_that_failed_is_told_to_every_watch_until_one_succeeds() {
        let mut registry = Registry::default();
        let now = Instant::now();
        let Start::Dial(first) = registry.watch_device("s1", "phone", now).0 else { panic!("no dial") };
        // Answered at once, before the dial is anywhere: nothing to say yet.
        assert_eq!(registry.device_problem("s1"), None);
        registry.device_dial_refused("s1", first, "ssh: no route to host".to_string());
        assert_eq!(registry.device_problem("s1").as_deref(), Some("ssh: no route to host"));

        // The next watch dials again and is still told why the last failed.
        let Start::Dial(second) = registry.watch_device("s1", "phone", now).0 else { panic!("no redial") };
        assert_eq!(registry.device_problem("s1").as_deref(), Some("ssh: no route to host"));
        // One dial at a time, however many watches arrive meanwhile.
        assert_eq!(registry.watch_device("s1", "phone", now).0, Start::Nothing);

        let (stream, _far) = Stream::pair().unwrap();
        assert!(registry.device_dialed("s1", second, stream).is_ok());
        assert_eq!(registry.device_problem("s1"), None);
    }

    #[test]
    fn a_view_back_after_every_lease_ran_out_is_not_told_an_old_failure() {
        let mut registry = Registry::default();
        let then = ago(DEVICE_LEASE + Duration::from_secs(1));
        let Start::Dial(id) = registry.watch_device("s1", "phone", then).0 else { panic!("no dial") };
        registry.device_dial_refused("s1", id, "old".to_string());
        assert!(matches!(registry.watch_device("s1", "phone", Instant::now()).0, Start::Dial(_)));
        assert_eq!(registry.device_problem("s1"), None);
    }

    #[test]
    fn a_hosts_failed_dial_keeps_the_views_leases_and_a_late_one_changes_nothing() {
        let mut registry = Registry::default();
        let now = Instant::now();
        let Start::Dial(first) = registry.watch_device("s1", "phone", now).0 else { panic!("no dial") };
        registry.device_dial_refused("s1", first, "first".to_string());
        let Start::Dial(second) = registry.watch_device("s1", "phone", now).0 else { panic!("no redial") };
        let (stream, _far) = Stream::pair().unwrap();
        assert!(registry.device_dialed("s1", second, stream).is_ok());
        // The first dial's failure, landing after the second is up.
        registry.device_dial_refused("s1", first, "late".to_string());
        assert_eq!(registry.device_problem("s1"), None);
        // Still the view's lease that holds it: letting go closes it.
        assert!(registry.unwatch_device("s1", "phone").is_some());
        assert!(registry.devices.is_empty());
    }

    #[test]
    fn the_session_ending_closes_its_device_stream() {
        let mut registry = Registry::default();
        let now = Instant::now();
        let (id, _far) = device_live(&mut registry, "s1", "phone", now);
        assert!(registry.device_gone("s1").is_some());
        assert_eq!(registry.device_frame(&frame("s1", 1), id, now), None);
    }

    fn phone_frame(seq: u64) -> Response {
        Response::BrowserFrame {
            session_id: "s1".into(),
            seq,
            data: format!("jpeg-{seq}"),
            width: 1280,
            height: 800,
            url: "https://example.test/".into(),
            title: "Example".into(),
        }
    }

    #[test]
    fn a_device_streams_frames_are_offered_while_held_and_its_end_is_told() {
        let watches = BrowserWatches::default();
        let (id, theirs) = device_live(&mut watches.0.lock().unwrap(), "s1", "phone", Instant::now());
        let (ours, mut daemon) = Stream::pair().unwrap();
        write_message(&mut daemon, &phone_frame(1)).unwrap();
        write_message(&mut daemon, &phone_frame(2)).unwrap();
        write_message(&mut daemon, &Response::BrowserGone { session_id: "s1".into() }).unwrap();
        drop(daemon);
        drop(theirs);

        let offered = Mutex::new(Vec::new());
        let gone = read_device_watch(&watches, "s1", id, ours, &|f| offered.lock().unwrap().push(f.seq));
        assert_eq!(*offered.lock().unwrap(), vec![1, 2]);
        assert_eq!(gone.as_deref(), Some("s1"));
    }

    #[test]
    fn a_device_stream_nobody_holds_is_read_to_the_end_and_offered_to_nobody() {
        let watches = BrowserWatches::default();
        let taken = ago(DEVICE_LEASE + Duration::from_secs(5));
        let (id, _theirs) = device_live(&mut watches.0.lock().unwrap(), "s1", "phone", taken);
        let (ours, mut daemon) = Stream::pair().unwrap();
        for seq in 1..=3 {
            write_message(&mut daemon, &phone_frame(seq)).unwrap();
        }
        drop(daemon);

        let offered = Mutex::new(Vec::new());
        assert_eq!(read_device_watch(&watches, "s1", id, ours, &|f| offered.lock().unwrap().push(f.seq)), None);
        assert!(offered.lock().unwrap().is_empty());
        // Its end forgets it, so the next renewal dials a fresh stream.
        assert!(matches!(watches.0.lock().unwrap().watch_device("s1", "phone", Instant::now()).0, Start::Dial(_)));
    }

    #[test]
    fn a_devices_watch_is_answered_in_camel_case_with_its_lease() {
        let json = serde_json::to_value(DeviceBrowserWatch { frame: Some(frame("s1", 3)), lease_ms: 30_000 }).unwrap();
        assert_eq!(json["leaseMs"], 30_000);
        assert_eq!(json["frame"]["sessionId"], "s1");
        // The phone asks for what the daemon allows it, no less.
        assert_eq!(DEVICE_FPS, BrowserViewSize::Phone.max_fps_cap());
    }

    #[test]
    fn the_frame_crosses_to_the_frontend_in_camel_case() {
        let json = serde_json::to_value(frame("s1", 3)).unwrap();
        assert_eq!(json["sessionId"], "s1");
        assert_eq!(json["seq"], 3);
        assert_eq!(json["width"], 1280);
    }

    #[test]
    fn the_app_wide_setting_takes_only_its_two_words_and_survives_a_workspace_save() {
        assert!(checked_pane_open(Some("chip".into())).is_ok());
        assert!(checked_pane_open(None).is_ok());
        assert!(checked_pane_open(Some("always".into())).is_err());

        let dir = tempfile::tempdir().unwrap();
        write_pane_open(dir.path(), Some("chip".into())).unwrap();
        // Every other save goes through persist_workspaces, which does not
        // take this field as an argument: it must carry it over from disk.
        let data = crate::session::WorkspacesData {
            workspaces: Vec::new(),
            active_workspace_id: None,
            removed_workspaces: Vec::new(),
        };
        crate::session::persist_workspaces(
            dir.path(),
            &data,
            HashMap::new(),
            HashMap::new(),
            HashMap::new(),
            HashMap::new(),
            None,
            HashMap::new(),
            None,
            None,
            None,
            HashMap::new(),
            Default::default(),
            Default::default(),
            Default::default(),
            Default::default(),
            None,
            None,
        )
        .unwrap();
        assert_eq!(crate::config::load(dir.path()).unwrap().playwright_pane_open.as_deref(), Some("chip"));

        write_pane_open(dir.path(), None).unwrap();
        assert_eq!(crate::config::load(dir.path()).unwrap().playwright_pane_open, None);
    }

    // -- a host's stream, through a real bridge -----------------------------

    /// The `gavin-daemon` this workspace built, beside this test binary.
    fn built_daemon() -> Option<std::path::PathBuf> {
        let exe = std::env::current_exe().ok()?;
        let daemon = exe.parent()?.parent()?.join(format!("gavin-daemon{}", std::env::consts::EXE_SUFFIX));
        daemon.is_file().then_some(daemon)
    }

    /// Where this machine's Playwright headless shell is, if one is whole.
    fn installed_browsers() -> Option<std::path::PathBuf> {
        let home_var = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
        let home = std::path::PathBuf::from(std::env::var_os(home_var)?);
        let dir = protocol::playwright::browsers_dir(protocol::HostOs::current(), &home, |k| std::env::var(k).ok());
        let complete: Vec<String> = std::fs::read_dir(&dir)
            .ok()?
            .filter_map(|e| e.ok())
            .filter(|e| e.path().join(protocol::playwright::INSTALLATION_COMPLETE).is_file())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        protocol::playwright::pick_revision(complete.iter().map(String::as_str))?;
        Some(dir)
    }

    /// The width and height a JPEG says it is, from its base64.
    fn jpeg_size(base64: &str) -> Option<(u16, u16)> {
        const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let mut bytes = Vec::new();
        let (mut acc, mut bits) = (0u32, 0u32);
        for c in base64.bytes().take(16 * 1024).take_while(|c| *c != b'=') {
            acc = ((acc << 6) | ALPHABET.iter().position(|a| *a == c)? as u32) & 0xFFFF;
            bits += 6;
            if bits >= 8 {
                bits -= 8;
                bytes.push((acc >> bits) as u8);
            }
        }
        let mut at = 2;
        while at + 9 < bytes.len() {
            if bytes[at] != 0xFF {
                return None;
            }
            let length = u16::from_be_bytes([bytes[at + 2], bytes[at + 3]]) as usize;
            if matches!(bytes[at + 1], 0xC0..=0xC3) {
                let height = u16::from_be_bytes([bytes[at + 5], bytes[at + 6]]);
                let width = u16::from_be_bytes([bytes[at + 7], bytes[at + 8]]);
                return Some((width, height));
            }
            at += 2 + length;
        }
        None
    }

    /// One request on a presented command connection, read to its reply.
    fn ask(stream: &mut Stream, request: &Request) -> Response {
        write_message(&mut *stream, request).unwrap();
        let mut reader = BufReader::with_capacity(1, &mut *stream);
        read_message(&mut reader).unwrap().expect("a reply from the host's daemon")
    }

    /// One CDP command through the host daemon's proxy, the way the
    /// Playwright MCP drives the browser, read until its reply.
    fn cdp_call(
        ws: &mut tungstenite::WebSocket<std::net::TcpStream>,
        id: u64,
        method: &str,
        params: serde_json::Value,
        session: Option<&str>,
    ) -> serde_json::Value {
        let mut message = serde_json::json!({ "id": id, "method": method, "params": params });
        if let Some(session) = session {
            message["sessionId"] = session.into();
        }
        ws.send(tungstenite::Message::Text(message.to_string().into())).unwrap();
        loop {
            let tungstenite::Message::Text(text) = ws.read().expect("a CDP reply") else { continue };
            let reply: serde_json::Value = serde_json::from_str(text.as_str()).unwrap();
            if reply["id"].as_u64() == Some(id) {
                assert!(reply.get("error").is_none(), "{method}: {reply}");
                return reply["result"].clone();
            }
        }
    }

    /// A Device's stream of an ssh session's browser, end to end: a host
    /// daemon behind `gavin-daemon bridge` (what ssh runs on a host), a
    /// real headless shell there, and the desk's own half -- the bridge
    /// presented as the app, the phone's watch sent on it, the registry
    /// and the reader that offers each frame. The frames are the phone's
    /// size, a lease let go ends the reading (and with it the ssh
    /// process), and the session's end crosses the phone's own bridge.
    #[test]
    fn a_hosts_browser_reaches_a_device_at_the_phones_size_over_a_bridge_of_its_own() {
        let required = std::env::var_os("GAVIN_REQUIRE_PLAYWRIGHT").is_some();
        let (Some(daemon), Some(browsers)) = (built_daemon(), installed_browsers()) else {
            assert!(!required, "GAVIN_REQUIRE_PLAYWRIGHT is set, and there is no built gavin-daemon or no headless shell");
            eprintln!("SKIPPED: needs target/debug/gavin-daemon (cargo build -p gavin-daemon) and a Playwright headless shell");
            return;
        };
        let temp_root = if cfg!(windows) { std::env::temp_dir() } else { std::path::PathBuf::from("/tmp") };
        let home = tempfile::Builder::new().prefix("gavin-bv-host-").tempdir_in(&temp_root).unwrap();
        let fake = Some(home.path().as_os_str().to_os_string());
        let state_dir =
            protocol::resolve_app_support_dir(fake.clone(), None, fake.clone(), fake, protocol::HostOs::current())
                .unwrap();
        // The daemon the first bridge starts outlives it, as on a host;
        // this stops it at the end.
        struct Stop(std::path::PathBuf);
        impl Drop for Stop {
            fn drop(&mut self) {
                if let Ok(mut stream) = Stream::connect(&self.0) {
                    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
                    let _ = write_message(&mut stream, &Request::Shutdown);
                    let mut reader = BufReader::new(stream);
                    let _ = read_message::<_, Response>(&mut reader);
                }
            }
        }
        let _stop = Stop(state_dir.join(protocol::profile_file_name("daemon", "sock", protocol::BuildProfile::current())));
        let bridge = || {
            let mut command = crate::program::command(&daemon);
            command
                .arg("bridge")
                .env("HOME", home.path())
                .env("LOCALAPPDATA", home.path())
                .env("USERPROFILE", home.path())
                .env_remove("XDG_DATA_HOME")
                .env("PLAYWRIGHT_BROWSERS_PATH", &browsers);
            command
        };
        let speaking = DaemonCompat {
            daemon_version: protocol::PROTOCOL_VERSION,
            app_version: protocol::PROTOCOL_VERSION,
            degraded: false,
        };

        // The host: a session there, and the endpoint its agent's MCP dials.
        let (commands, _commands_process) =
            crate::remote::own_connection_from(bridge(), &speaking, ConnectionKind::Command).unwrap();
        let commands = Mutex::new(commands);
        let host = crate::session::verify_daemon_protocol(&commands).unwrap();
        if host.daemon_version < protocol::min_version_for(&phone_watch("")) {
            assert!(!required, "the built gavin-daemon is v{}", host.daemon_version);
            eprintln!("SKIPPED: target/debug/gavin-daemon is v{}; rebuild it", host.daemon_version);
            return;
        }
        let mut commands = commands.into_inner().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let root = workspace.path().to_string_lossy().into_owned();
        let session_id = match ask(
            &mut commands,
            &Request::CreateSession {
                workspace_path: root.clone(),
                cwd: root,
                command: None,
                profile_id: None,
                api_family: None,
                without_headroom: true,
            },
        ) {
            Response::SessionCreated { id, .. } => id,
            other => panic!("CreateSession on the host: {other:?}"),
        };
        let endpoint = match ask(&mut commands, &Request::PlaywrightEndpoint { session_id: session_id.clone() }) {
            Response::PlaywrightEndpoint { endpoint, .. } => endpoint,
            other => panic!("PlaywrightEndpoint on the host: {other:?}"),
        };

        // The desk's half, as `watch_host_for_device` and
        // `start_device_stream` make it, with the bridge for ssh.
        let watches = std::sync::Arc::new(BrowserWatches::default());
        let read_on = |id: u64, process: BridgeProcess, reader: Stream| {
            let (offered, frames) = std::sync::mpsc::channel::<BrowserFrame>();
            let (watches, session) = (watches.clone(), session_id.clone());
            let reading = std::thread::spawn(move || {
                let offer = move |frame: &BrowserFrame| {
                    let _ = offered.send(frame.clone());
                };
                let gone = read_device_watch(&watches, &session, id, reader, &offer);
                drop(process);
                gone
            });
            (frames, reading)
        };
        let dial = |watcher: &str| {
            let Start::Dial(id) = watches.0.lock().unwrap().watch_device(&session_id, watcher, Instant::now()).0 else {
                panic!("the first watch dials")
            };
            let (stream, process) = crate::remote::own_connection_from(bridge(), &host, ConnectionKind::Command).unwrap();
            let stream = send_watch(stream, &phone_watch(&session_id)).unwrap();
            let reader = stream.try_clone().unwrap();
            assert!(watches.0.lock().unwrap().device_dialed(&session_id, id, stream).is_ok());
            read_on(id, process, reader)
        };
        let (frames, reading) = dial("phone");

        // The agent's first call launches the browser on the host, and it
        // opens a page.
        let authority = endpoint.strip_prefix("ws://").unwrap().split('/').next().unwrap().to_string();
        let tcp = std::net::TcpStream::connect(&authority).unwrap();
        tcp.set_read_timeout(Some(Duration::from_secs(20))).unwrap();
        let (mut cdp, _) = tungstenite::client::client(endpoint.as_str(), tcp).expect("the proxy's handshake");
        let targets = cdp_call(&mut cdp, 1, "Target.getTargets", serde_json::json!({}), None);
        let page = targets["targetInfos"].as_array().unwrap().iter().find(|t| t["type"] == "page").unwrap()["targetId"]
            .as_str()
            .unwrap()
            .to_string();
        let attached = cdp_call(&mut cdp, 2, "Target.attachToTarget", serde_json::json!({ "targetId": page, "flatten": true }), None);
        let cdp_session = attached["sessionId"].as_str().unwrap().to_string();
        let url = "data:text/html,<body style='background:%23264'><h1 style='color:white'>on a host, seen on the phone</h1></body>";
        cdp_call(&mut cdp, 3, "Page.navigate", serde_json::json!({ "url": url }), Some(&cdp_session));

        let deadline = Instant::now() + Duration::from_secs(20);
        loop {
            let frame = frames
                .recv_timeout(deadline.saturating_duration_since(Instant::now()))
                .expect("no frame of the host's page was offered within 20s");
            assert_eq!(frame.session_id, session_id);
            if !frame.url.starts_with("data:text/html") {
                continue;
            }
            assert_eq!(jpeg_size(&frame.data), Some((640, 400)), "the phone's size, not the desk's");
            break;
        }

        // The view lets go: the connection closes, and the reading ends.
        let closing = watches.0.lock().unwrap().unwatch_device(&session_id, "phone").expect("the stream to close");
        let _ = closing.shutdown(Shutdown::Both);
        let (ended, done) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let _ = ended.send(reading.join().unwrap());
        });
        assert_eq!(done.recv_timeout(Duration::from_secs(10)).expect("the reading ended"), None);

        // A view again, and then the session ends on the host: its end
        // crosses the phone's own bridge, for the desk to tell everyone.
        let (_frames, reading) = dial("phone-again");
        drop(cdp);
        assert!(matches!(ask(&mut commands, &Request::KillSession { id: session_id.clone() }), Response::Ok));
        let (ended, done) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let _ = ended.send(reading.join().unwrap());
        });
        assert_eq!(done.recv_timeout(Duration::from_secs(15)).expect("the reading ended"), Some(session_id.clone()));
    }
}
