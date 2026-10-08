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
//! Also the app-wide half of the pane's open setting, read and written
//! straight to config.json (`AppConfig::playwright_pane_open`).

use std::collections::{HashMap, HashSet};
use std::io::BufReader;
use std::net::Shutdown;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use protocol::transport::Stream;
use protocol::{read_message, write_message, BrowserViewSize, ConnectionKind, LiveBrowser, Request, Response};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::remote::Route;
use crate::session::{current_compat, CommandConnection, DaemonCompat, DaemonCompatState};

/// The rate the desk asks of the daemon it runs beside: the desk size's
/// cap (`BrowserViewSize::max_fps_cap`).
pub const LOCAL_FPS: u32 = 8;
/// What it asks across ssh: half, because the frames share the host's one
/// streaming connection with every terminal's output there (spec Q4).
pub const REMOTE_FPS: u32 = 4;

/// The event a window's pane reads its frames from.
pub const FRAME_EVENT: &str = "browser-desk-frame";

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
            let dialled = dial(session_id, &compat).and_then(|stream| {
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
fn dial(session_id: &str, compat: &DaemonCompat) -> anyhow::Result<Stream> {
    let request = Request::WatchBrowser {
        session_id: session_id.to_string(),
        size: BrowserViewSize::Desk,
        max_fps: LOCAL_FPS,
    };
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
    write_message(&mut stream, &request)?;
    // The connect's handshake deadline is lifted: an idle page sends
    // nothing for as long as it stays idle.
    let _ = stream.set_read_timeout(None);
    Ok(stream)
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

/// The session ended: its watch goes, and every window hears it.
fn gone(app: &AppHandle, session_id: &str) {
    if let Some(stream) = app.state::<BrowserWatches>().0.lock().unwrap().gone(session_id) {
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
}
