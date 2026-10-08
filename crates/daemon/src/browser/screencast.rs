//! The screencaster: the daemon's own CDP connection to one session's
//! browser. It casts the tab that session's agent is acting on to
//! whoever is watching.
//!
//! **Followed tab.**
//! - The tab comes from the proxy's tap.
//! - When the tap has named nothing, or names a tab that has closed, it
//!   is the newest tab still open.
//!
//! **One screencast per size.**
//! - There is one screencast per watched size, and each is its own CDP
//!   session on the same target.
//! - A screencast runs only while someone watches that size.
//!
//! **Pacing.**
//! - Chromium sends the next frame only once the last is acked.
//! - The ack is held until the fastest watcher of that size is due its
//!   next frame. An animated page therefore renders no faster than
//!   somebody is looking.
//!
//! **Delivery.**
//! - Each watcher holds one frame, and a newer one replaces it.
//! - A slow connection loses frames rather than queueing them, and never
//!   holds up anyone else.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use protocol::{BrowserInfo, BrowserViewSize, Response};
use tungstenite::Message;

use super::ws;

/// A frame bigger than this, as base64, is dropped rather than risk
/// `MAX_LINE_BYTES` (1 MiB) once it is wrapped in a push. The largest the
/// spike saw at the desk size was 172 KiB; the next visual change sends
/// another.
pub const MAX_FRAME_BASE64: usize = 768 * 1024;

/// The screencast parameters for each size (spec, Q4).
pub fn cast_params(size: BrowserViewSize) -> serde_json::Value {
    match size {
        BrowserViewSize::Desk => {
            serde_json::json!({ "format": "jpeg", "quality": 60, "maxWidth": 1280, "maxHeight": 800, "everyNthFrame": 1 })
        }
        BrowserViewSize::Phone => {
            serde_json::json!({ "format": "jpeg", "quality": 50, "maxWidth": 640, "maxHeight": 400, "everyNthFrame": 1 })
        }
    }
}

/// One `WatchBrowser`, on one connection.
pub struct Watcher {
    pub size: BrowserViewSize,
    pub max_fps: u32,
    slot: Mutex<Slot>,
    ready: Condvar,
}

#[derive(Default)]
struct Slot {
    next: Option<Response>,
    /// The session ended: write `BrowserGone`, then stop.
    gone: bool,
    /// The connection went away, or a write to it failed: stop.
    closed: bool,
}

impl Watcher {
    pub fn new(size: BrowserViewSize, max_fps: u32) -> Arc<Self> {
        Arc::new(Self {
            size,
            max_fps: max_fps.clamp(1, size.max_fps_cap()),
            slot: Mutex::new(Slot::default()),
            ready: Condvar::new(),
        })
    }

    /// Hands the watcher a frame, replacing one it has not written yet.
    pub fn offer(&self, frame: Response) {
        let mut slot = self.slot.lock().unwrap();
        if slot.closed || slot.gone {
            return;
        }
        slot.next = Some(frame);
        self.ready.notify_one();
    }

    /// The session ended. Whatever frame is waiting is dropped.
    pub fn end(&self) {
        let mut slot = self.slot.lock().unwrap();
        slot.next = None;
        slot.gone = true;
        self.ready.notify_one();
    }

    /// The connection is gone; nothing more is written.
    pub fn close(&self) {
        let mut slot = self.slot.lock().unwrap();
        slot.closed = true;
        slot.next = None;
        self.ready.notify_one();
    }

    pub fn is_closed(&self) -> bool {
        let slot = self.slot.lock().unwrap();
        slot.closed || slot.gone
    }

    /// Writes frames as they come, then `BrowserGone` if the session
    /// ended. Returns when there is nothing left to write. `write`
    /// answers whether the write went through; one that did not closes
    /// the watcher.
    pub fn run_writer(&self, session_id: &str, mut write: impl FnMut(&Response) -> bool) {
        loop {
            let next = {
                let mut slot = self.slot.lock().unwrap();
                loop {
                    if slot.closed {
                        return;
                    }
                    if let Some(frame) = slot.next.take() {
                        break Some(frame);
                    }
                    if slot.gone {
                        break None;
                    }
                    slot = self.ready.wait(slot).unwrap();
                }
            };
            match next {
                Some(frame) => {
                    if !write(&frame) {
                        self.close();
                        return;
                    }
                }
                None => {
                    write(&Response::BrowserGone { session_id: session_id.to_string() });
                    self.close();
                    return;
                }
            }
        }
    }
}

/// When a frame that arrived `now` may be acked so the next one comes no
/// sooner than `fps` allows.
#[derive(Default)]
pub struct Pacer {
    last_ack: Option<Instant>,
}

impl Pacer {
    pub fn due(&self, now: Instant, fps: u32) -> Instant {
        let interval = Duration::from_secs(1) / fps.max(1);
        match self.last_ack {
            Some(last) => (last + interval).max(now),
            None => now,
        }
    }

    pub fn acked(&mut self, at: Instant) {
        self.last_ack = Some(at);
    }
}

/// What the screencaster shares with the rest of the session.
#[derive(Default)]
pub struct Shared {
    /// The tab the proxy last saw the agent act on.
    pub followed: Mutex<Option<String>>,
    pub watchers: Mutex<Vec<Arc<Watcher>>>,
    /// Rises per frame across every browser the session launches.
    pub seq: AtomicU64,
    /// What `BrowserChanged` last said, for `ListBrowsers`. `None` while
    /// no browser runs.
    pub info: Mutex<Option<BrowserInfo>>,
}

pub enum Event {
    Cdp(serde_json::Value),
    /// Something the loop reads changed: the follow, or the watchers.
    Wake,
    Closed,
}

/// A page target, in the order the browser opened them.
#[derive(Clone, Debug, PartialEq)]
struct Tab {
    id: String,
    url: String,
    title: String,
}

/// The tab to cast: the followed one while it is open, else the newest.
fn effective_follow<'a>(followed: Option<&str>, tabs: &'a [Tab]) -> Option<&'a Tab> {
    followed
        .and_then(|id| tabs.iter().find(|t| t.id == id))
        .or_else(|| tabs.last())
}

struct Cast {
    target: String,
    session: Option<String>,
    attach_id: u64,
    pacer: Pacer,
    /// Frames received and not acked yet, each by the id Chromium gave it.
    pending: Vec<i64>,
    due: Option<Instant>,
}

/// Reads the browser's messages into `events` until the socket ends.
pub fn spawn_reader(mut read: tungstenite::WebSocket<ws::ReadHalf>, events: Sender<Event>) {
    let _ = std::thread::Builder::new().name("browser-cast-read".into()).spawn(move || {
        loop {
            match read.read() {
                Ok(Message::Text(text)) => {
                    if let Ok(value) = serde_json::from_str(text.as_str()) {
                        if events.send(Event::Cdp(value)).is_err() {
                            return;
                        }
                    }
                }
                Ok(Message::Close(_)) | Err(_) => {
                    let _ = events.send(Event::Closed);
                    return;
                }
                Ok(_) => {}
            }
        }
    });
}

/// Commands to the browser, numbered.
struct Commands {
    write: tungstenite::WebSocket<std::net::TcpStream>,
    next_id: u64,
}

impl Commands {
    /// Sends one command and returns its id. A send that fails means the
    /// browser is gone, which the reader reports as `Closed`.
    fn send(&mut self, method: &str, params: serde_json::Value, session: Option<&str>) -> u64 {
        self.next_id += 1;
        let mut message = serde_json::json!({ "id": self.next_id, "method": method, "params": params });
        if let Some(session) = session {
            message["sessionId"] = session.into();
        }
        let _ = self.write.send(Message::Text(message.to_string().into()));
        self.next_id
    }
}

/// The screencaster's state between messages.
struct Caster<'a> {
    session_id: &'a str,
    shared: &'a Shared,
    commands: Commands,
    tabs: Vec<Tab>,
    casts: HashMap<BrowserViewSize, Cast>,
    /// Who is watching each size, at the fastest rate any of them asked.
    wanted: HashMap<BrowserViewSize, u32>,
}

impl Caster<'_> {
    /// Brings the casts in line with the watchers and the follow, and
    /// answers what the session's browser is showing.
    fn reconcile(&mut self) -> Option<BrowserInfo> {
        self.wanted.clear();
        {
            let mut watchers = self.shared.watchers.lock().unwrap();
            watchers.retain(|w| !w.is_closed());
            for watcher in watchers.iter() {
                let fps = self.wanted.entry(watcher.size).or_insert(0);
                *fps = (*fps).max(watcher.max_fps);
            }
        }
        let followed = self.shared.followed.lock().unwrap().clone();
        let follow = effective_follow(followed.as_deref(), &self.tabs).cloned();

        for size in [BrowserViewSize::Desk, BrowserViewSize::Phone] {
            let want = follow.as_ref().filter(|_| self.wanted.contains_key(&size)).map(|t| t.id.clone());
            let keep = matches!((self.casts.get(&size), &want), (Some(cast), Some(target)) if &cast.target == target);
            if keep {
                continue;
            }
            if let Some(session) = self.casts.remove(&size).and_then(|old| old.session) {
                self.commands.send("Target.detachFromTarget", serde_json::json!({ "sessionId": session }), None);
            }
            if let Some(target) = want {
                let attach_id = self.commands.send(
                    "Target.attachToTarget",
                    serde_json::json!({ "targetId": target, "flatten": true }),
                    None,
                );
                self.casts.insert(
                    size,
                    Cast { target, session: None, attach_id, pacer: Pacer::default(), pending: Vec::new(), due: None },
                );
            }
        }

        follow.map(|t| BrowserInfo { url: t.url, title: t.title, tabs: self.tabs.len() as u32 })
    }

    fn handle(&mut self, message: &serde_json::Value) {
        if let Some(id) = message.get("id").and_then(|id| id.as_u64()) {
            let Some(size) = self.casts.iter().find(|(_, c)| c.attach_id == id).map(|(size, _)| *size) else {
                return;
            };
            match message.pointer("/result/sessionId").and_then(|s| s.as_str()) {
                Some(session) => {
                    if let Some(cast) = self.casts.get_mut(&size) {
                        cast.session = Some(session.to_string());
                    }
                    self.commands.send("Page.startScreencast", cast_params(size), Some(session));
                }
                // The tab closed between the follow and the attach; the
                // next reconcile follows another.
                None => {
                    self.casts.remove(&size);
                }
            }
            return;
        }
        let method = message.get("method").and_then(|m| m.as_str()).unwrap_or("");
        let params = &message["params"];
        match method {
            "Target.targetCreated" | "Target.targetInfoChanged" => {
                let info = &params["targetInfo"];
                if info["type"] != "page" {
                    return;
                }
                let tab = Tab {
                    id: info["targetId"].as_str().unwrap_or("").to_string(),
                    url: info["url"].as_str().unwrap_or("").to_string(),
                    title: info["title"].as_str().unwrap_or("").to_string(),
                };
                match self.tabs.iter_mut().find(|t| t.id == tab.id) {
                    Some(known) => *known = tab,
                    None => self.tabs.push(tab),
                }
            }
            "Target.targetDestroyed" => {
                let id = params["targetId"].as_str().unwrap_or("");
                self.tabs.retain(|t| t.id != id);
            }
            "Target.detachedFromTarget" => {
                let session = params["sessionId"].as_str().unwrap_or("");
                self.casts.retain(|_, c| c.session.as_deref() != Some(session));
            }
            "Page.screencastFrame" => self.frame(message, params),
            _ => {}
        }
    }

    fn frame(&mut self, message: &serde_json::Value, params: &serde_json::Value) {
        let session = message.get("sessionId").and_then(|s| s.as_str()).unwrap_or("");
        let Some((size, cast)) = self.casts.iter_mut().find(|(_, c)| c.session.as_deref() == Some(session)) else {
            return;
        };
        if let Some(frame_id) = params["sessionId"].as_i64() {
            cast.pending.push(frame_id);
        }
        let fps = self.wanted.get(size).copied().unwrap_or(1);
        cast.due = Some(cast.pacer.due(Instant::now(), fps));
        let data = params["data"].as_str().unwrap_or("");
        if data.is_empty() || data.len() > MAX_FRAME_BASE64 {
            return;
        }
        let tab = self.tabs.iter().find(|t| t.id == cast.target);
        let frame = Response::BrowserFrame {
            session_id: self.session_id.to_string(),
            seq: self.shared.seq.fetch_add(1, Ordering::SeqCst) + 1,
            data: data.to_string(),
            width: params["metadata"]["deviceWidth"].as_f64().unwrap_or(0.0).round() as u32,
            height: params["metadata"]["deviceHeight"].as_f64().unwrap_or(0.0).round() as u32,
            url: tab.map(|t| t.url.clone()).unwrap_or_default(),
            title: tab.map(|t| t.title.clone()).unwrap_or_default(),
        };
        for watcher in self.shared.watchers.lock().unwrap().iter().filter(|w| w.size == *size) {
            watcher.offer(frame.clone());
        }
    }

    /// When the next held ack is due, if one is held.
    fn next_due(&self) -> Option<Instant> {
        self.casts.values().filter_map(|c| c.due).min()
    }

    fn ack_due(&mut self) {
        let now = Instant::now();
        for cast in self.casts.values_mut() {
            if !cast.due.is_some_and(|due| due <= now) {
                continue;
            }
            if let Some(session) = cast.session.as_deref() {
                for frame_id in cast.pending.drain(..) {
                    self.commands.send(
                        "Page.screencastFrameAck",
                        serde_json::json!({ "sessionId": frame_id }),
                        Some(session),
                    );
                }
            }
            cast.pacer.acked(now);
            cast.due = None;
        }
    }
}

/// The screencaster's loop, until the browser's socket closes.
/// `announce` is told the session's browser info whenever it changes, and
/// `None` as the loop ends.
pub fn run(
    session_id: &str,
    write: tungstenite::WebSocket<std::net::TcpStream>,
    events: Receiver<Event>,
    shared: &Shared,
    announce: &dyn Fn(Option<BrowserInfo>),
) {
    let mut caster = Caster {
        session_id,
        shared,
        commands: Commands { write, next_id: 0 },
        tabs: Vec::new(),
        casts: HashMap::new(),
        wanted: HashMap::new(),
    };
    caster.commands.send("Target.setDiscoverTargets", serde_json::json!({ "discover": true }), None);
    let mut announced: Option<BrowserInfo> = None;
    loop {
        let info = caster.reconcile();
        if info.is_some() && info != announced {
            *shared.info.lock().unwrap() = info.clone();
            announce(info.clone());
            announced = info;
        }
        let wait = caster
            .next_due()
            .map(|due| due.saturating_duration_since(Instant::now()))
            .unwrap_or(Duration::from_secs(1));
        match events.recv_timeout(wait) {
            Ok(Event::Cdp(message)) => caster.handle(&message),
            Ok(Event::Wake) | Err(RecvTimeoutError::Timeout) => {}
            Ok(Event::Closed) | Err(RecvTimeoutError::Disconnected) => break,
        }
        caster.ack_due();
    }
    *shared.info.lock().unwrap() = None;
    announce(None);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(seq: u64) -> Response {
        Response::BrowserFrame {
            session_id: "s".into(),
            seq,
            data: "AAAA".into(),
            width: 1,
            height: 1,
            url: String::new(),
            title: String::new(),
        }
    }

    fn seqs(written: &[Response]) -> Vec<String> {
        written
            .iter()
            .map(|r| match r {
                Response::BrowserFrame { seq, .. } => seq.to_string(),
                Response::BrowserGone { .. } => "gone".into(),
                other => format!("{other:?}"),
            })
            .collect()
    }

    #[test]
    fn a_watcher_holds_only_the_newest_frame() {
        let watcher = Watcher::new(BrowserViewSize::Desk, 8);
        watcher.offer(frame(1));
        watcher.offer(frame(2));
        watcher.offer(frame(3));
        watcher.end();
        let mut written = Vec::new();
        watcher.run_writer("s", |r| {
            written.push(r.clone());
            true
        });
        // `end` drops the frame still waiting: the session is over.
        assert_eq!(seqs(&written), ["gone"]);

        let watcher = Watcher::new(BrowserViewSize::Desk, 8);
        let writer = {
            let watcher = Arc::clone(&watcher);
            std::thread::spawn(move || {
                let mut written = Vec::new();
                watcher.run_writer("s", |r| {
                    written.push(r.clone());
                    true
                });
                written
            })
        };
        watcher.offer(frame(1));
        std::thread::sleep(Duration::from_millis(50));
        watcher.offer(frame(2));
        watcher.offer(frame(3));
        std::thread::sleep(Duration::from_millis(50));
        watcher.end();
        let written = writer.join().unwrap();
        assert_eq!(seqs(&written), ["1", "3", "gone"]);
    }

    #[test]
    fn a_failed_write_closes_the_watcher_and_a_closed_one_takes_nothing() {
        let watcher = Watcher::new(BrowserViewSize::Phone, 2);
        watcher.offer(frame(1));
        watcher.run_writer("s", |_| false);
        assert!(watcher.is_closed());
        watcher.offer(frame(2));
        let mut written = 0;
        watcher.run_writer("s", |_| {
            written += 1;
            true
        });
        assert_eq!(written, 0);
    }

    #[test]
    fn max_fps_is_clamped_to_the_sizes_cap() {
        assert_eq!(Watcher::new(BrowserViewSize::Desk, 60).max_fps, 8);
        assert_eq!(Watcher::new(BrowserViewSize::Phone, 8).max_fps, 2);
        assert_eq!(Watcher::new(BrowserViewSize::Desk, 0).max_fps, 1);
    }

    #[test]
    fn the_pacer_holds_an_ack_until_the_interval_has_passed() {
        let mut pacer = Pacer::default();
        let t0 = Instant::now();
        assert_eq!(pacer.due(t0, 8), t0);
        pacer.acked(t0);
        assert_eq!(pacer.due(t0 + Duration::from_millis(10), 8), t0 + Duration::from_millis(125));
        assert_eq!(pacer.due(t0 + Duration::from_millis(400), 8), t0 + Duration::from_millis(400));
        assert_eq!(pacer.due(t0 + Duration::from_millis(10), 2), t0 + Duration::from_millis(500));
    }

    #[test]
    fn the_followed_tab_wins_while_open_else_the_newest() {
        let tab = |id: &str| Tab { id: id.into(), url: String::new(), title: String::new() };
        let tabs = vec![tab("a"), tab("b"), tab("c")];
        assert_eq!(effective_follow(Some("a"), &tabs).unwrap().id, "a");
        assert_eq!(effective_follow(Some("gone"), &tabs).unwrap().id, "c");
        assert_eq!(effective_follow(None, &tabs).unwrap().id, "c");
        assert_eq!(effective_follow(Some("a"), &[]), None);
    }
}
