//! A headless browser per agent session (v65).
//!
//! An agent's `browser_*` tools come from the pinned `@playwright/mcp`,
//! which `gavin-mcp playwright` starts against this session's endpoint
//! on the daemon's CDP proxy (`proxy.rs`). The proxy launches the
//! session's headless shell on the MCP's first connection (`launch.rs`),
//! and launches it again on the next connection after it dies. The
//! screencaster (`screencast.rs`) casts the tab the agent is on to every
//! `WatchBrowser`. The browser ends with the session (`end_session`, from
//! `forget_session`), with the daemon (`close_all`, from `Shutdown`), and
//! -- if the daemon crashed instead -- when the next daemon starts
//! (`open` sweeps the run record).
//!
//! Design and evidence:
//! `docs/superpowers/specs/2026-10-08-playwright-integration-design.md`.

mod install;
mod launch;
mod proxy;
mod screencast;
mod ws;

use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::process::Child;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::Sender;
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use protocol::{BrowserInfo, BrowserViewSize, LiveBrowser, Response};

use crate::proc::ProcessHandle;
use launch::{RecordedBrowser, RunRecord};
use screencast::{Event, Shared, Watcher};

/// How the module tells the apps a session's browser changed: the
/// manager's `push_to_apps_speaking`, handed in so this module needs no
/// manager of its own.
pub type Announce = Arc<dyn Fn(Response) + Send + Sync>;

/// Where a session's headless shell comes from: `launch::find_executable`
/// over the daemon's environment, or a test's own answer.
pub type Find = Box<dyn Fn() -> Result<PathBuf, String> + Send + Sync>;

/// Every session's browser, on one daemon.
pub struct Browsers {
    inner: Arc<Inner>,
}

struct Inner {
    /// `<state>/playwright[-dev]`: one folder per session, holding its
    /// browser profile, its log and the MCP's output.
    base: PathBuf,
    /// `<state>/playwright-browsers[-dev].json`: the running browsers.
    record_path: PathBuf,
    record: Mutex<RunRecord>,
    sessions: Mutex<HashMap<String, Arc<SessionBrowser>>>,
    /// The proxy's address, once something has asked for an endpoint.
    proxy: Mutex<Option<SocketAddr>>,
    announce: Announce,
    find: Find,
    /// The headless shell's install on this machine (v66).
    installer: install::Installer,
}

struct SessionBrowser {
    session_id: String,
    /// The endpoint's path secret. Stable for the session's life, so an
    /// MCP that outlives a browser crash reaches the next browser.
    secret: String,
    dir: PathBuf,
    shared: Arc<Shared>,
    running: Mutex<Option<Running>>,
    /// The running screencaster's wake-up, kept apart from `running` so a
    /// follow never waits behind a launch.
    wake: Mutex<Option<Sender<Event>>>,
    ended: AtomicBool,
}

struct Running {
    child: Child,
    handle: ProcessHandle,
    ws_url: String,
}

impl SessionBrowser {
    fn wake(&self) {
        if let Some(wake) = self.wake.lock().unwrap().as_ref() {
            let _ = wake.send(Event::Wake);
        }
    }
}

/// Keeps one `WatchBrowser` alive. Dropped with the connection that
/// asked, which is the only unwatch there is.
pub struct WatchGuard {
    watcher: Arc<Watcher>,
    session: Weak<SessionBrowser>,
}

impl Drop for WatchGuard {
    fn drop(&mut self) {
        self.watcher.close();
        if let Some(session) = self.session.upgrade() {
            session.wake();
        }
    }
}

impl Browsers {
    /// This daemon's browsers, under its state directory. Stops any
    /// browser an earlier daemon of this build left running and clears
    /// its folders first.
    pub fn open(state_dir: &Path, announce: Announce) -> Self {
        Self::with_finder(
            state_dir,
            announce,
            Box::new(|| launch::find_executable(|key| std::env::var(key).ok())),
        )
    }

    pub fn with_finder(state_dir: &Path, announce: Announce, find: Find) -> Self {
        let profile = protocol::BuildProfile::current();
        let base = state_dir.join(format!("playwright{}", profile.suffix()));
        let record_path = state_dir.join(protocol::profile_file_name("playwright-browsers", "json", profile));
        launch::sweep(&record_path, &base);
        Self {
            inner: Arc::new(Inner {
                base,
                record_path,
                record: Mutex::new(RunRecord::default()),
                sessions: Mutex::new(HashMap::new()),
                proxy: Mutex::new(None),
                announce,
                find,
                installer: install::Installer::default(),
            }),
        }
    }

    /// Playwright on this daemon's machine (v66).
    pub fn machine_status(&self) -> protocol::PlaywrightMachineStatus {
        self.inner.installer.status()
    }

    /// Starts the pinned headless shell's install here (v66).
    pub fn install_browser(&self) -> protocol::PlaywrightMachineStatus {
        self.inner.installer.start()
    }

    /// The endpoint `gavin-mcp playwright` points the MCP at, and the
    /// folder the MCP writes its output to. Refused when no headless
    /// shell is installed: better said now, by the shim, than by every
    /// `browser_*` call the agent makes.
    pub fn endpoint(&self, session_id: &str) -> Result<(String, PathBuf), String> {
        (self.inner.find)()?;
        let session = self.inner.session(session_id)?;
        let addr = self.inner.proxy_addr()?;
        let output = session.dir.join("output");
        std::fs::create_dir_all(&output).map_err(|e| format!("could not create {}: {e}", output.display()))?;
        Ok((format!("ws://{addr}{}{}", proxy::PATH_PREFIX, session.secret), output))
    }

    /// Starts a watch. Frames go to `write` on a thread of the watch's
    /// own until the session ends -- then `BrowserGone` -- or the guard
    /// is dropped.
    pub fn watch(
        &self,
        session_id: &str,
        size: BrowserViewSize,
        max_fps: u32,
        mut write: Box<dyn FnMut(&Response) -> bool + Send>,
    ) -> Result<WatchGuard, String> {
        let session = self.inner.session(session_id)?;
        let watcher = Watcher::new(size, max_fps);
        session.shared.watchers.lock().unwrap().push(Arc::clone(&watcher));
        session.wake();
        {
            let watcher = Arc::clone(&watcher);
            let session_id = session_id.to_string();
            std::thread::Builder::new()
                .name("browser-watch".into())
                .spawn(move || watcher.run_writer(&session_id, |r| write(r)))
                .map_err(|e| format!("could not start a watch: {e}"))?;
        }
        Ok(WatchGuard { watcher, session: Arc::downgrade(&session) })
    }

    /// Every session whose browser is running.
    pub fn list(&self) -> Vec<LiveBrowser> {
        let sessions: Vec<Arc<SessionBrowser>> = self.inner.sessions.lock().unwrap().values().cloned().collect();
        let mut live: Vec<LiveBrowser> = sessions
            .iter()
            .filter_map(|s| {
                let browser = s.shared.info.lock().unwrap().clone()?;
                Some(LiveBrowser { session_id: s.session_id.clone(), browser })
            })
            .collect();
        live.sort_by(|a, b| a.session_id.cmp(&b.session_id));
        live
    }

    /// The session ended: its watches are told, and its browser is
    /// stopped and its folder removed off this thread -- the kill path
    /// a closing tab waits on must not wait out a browser's grace.
    pub fn end_session(&self, session_id: &str) {
        let Some(session) = self.inner.sessions.lock().unwrap().remove(session_id) else {
            return;
        };
        session.ended.store(true, Ordering::SeqCst);
        for watcher in session.shared.watchers.lock().unwrap().drain(..) {
            watcher.end();
        }
        let inner = Arc::clone(&self.inner);
        let _ = std::thread::Builder::new().name("browser-end".into()).spawn(move || {
            inner.stop(&session);
            let _ = std::fs::remove_dir_all(&session.dir);
        });
    }

    /// The daemon is stopping: every browser is stopped before it does.
    pub fn close_all(&self) {
        let sessions: Vec<Arc<SessionBrowser>> =
            self.inner.sessions.lock().unwrap().drain().map(|(_, s)| s).collect();
        let stopping: Vec<_> = sessions
            .into_iter()
            .map(|session| {
                session.ended.store(true, Ordering::SeqCst);
                let inner = Arc::clone(&self.inner);
                std::thread::spawn(move || inner.stop(&session))
            })
            .collect();
        for stop in stopping {
            let _ = stop.join();
        }
        let _ = std::fs::remove_file(&self.inner.record_path);
        let _ = std::fs::remove_dir_all(&self.inner.base);
    }
}

impl Inner {
    /// The session's entry, made on first use. The id names a folder, so
    /// anything but a plain id is refused.
    fn session(&self, session_id: &str) -> Result<Arc<SessionBrowser>, String> {
        if session_id.is_empty()
            || session_id.len() > 64
            || !session_id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
        {
            return Err(format!("not a session id: {session_id:?}"));
        }
        let mut sessions = self.sessions.lock().unwrap();
        if let Some(session) = sessions.get(session_id) {
            return Ok(Arc::clone(session));
        }
        let secret = protocol::random_hex(32).map_err(|e| format!("could not draw a secret: {e}"))?;
        let session = Arc::new(SessionBrowser {
            session_id: session_id.to_string(),
            secret,
            dir: self.base.join(session_id),
            shared: Arc::new(Shared::default()),
            running: Mutex::new(None),
            wake: Mutex::new(None),
            ended: AtomicBool::new(false),
        });
        sessions.insert(session_id.to_string(), Arc::clone(&session));
        Ok(session)
    }

    fn proxy_addr(self: &Arc<Self>) -> Result<SocketAddr, String> {
        let mut proxy = self.proxy.lock().unwrap();
        if let Some(addr) = *proxy {
            return Ok(addr);
        }
        let addr = proxy::start(Arc::clone(self)).map_err(|e| format!("could not start the browser proxy: {e}"))?;
        *proxy = Some(addr);
        Ok(addr)
    }

    fn remember(&self, session_id: &str, handle: Option<ProcessHandle>) {
        let mut record = self.record.lock().unwrap();
        record.browsers.retain(|b| b.session_id != session_id);
        if let Some(process) = handle {
            record.browsers.push(RecordedBrowser { session_id: session_id.to_string(), process });
        }
        if record.browsers.is_empty() {
            let _ = std::fs::remove_file(&self.record_path);
        } else {
            launch::save_record(&self.record_path, &record);
        }
    }

    /// Stops the session's browser, if one runs, and forgets it.
    fn stop(&self, session: &SessionBrowser) {
        let running = session.running.lock().unwrap().take();
        if let Some(mut running) = running {
            launch::stop(running.handle, Some(&mut running.child));
        }
        *session.wake.lock().unwrap() = None;
        self.remember(&session.session_id, None);
    }
}

/// Constant-time, so how much of a guess matched is not on the clock.
fn same_secret(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

impl proxy::Sessions for Inner {
    type Session = SessionBrowser;

    fn by_secret(&self, secret: &str) -> Option<Arc<SessionBrowser>> {
        self.sessions.lock().unwrap().values().find(|s| same_secret(&s.secret, secret)).cloned()
    }

    fn ensure_running(&self, session: &Arc<SessionBrowser>) -> Result<String, String> {
        let mut running = session.running.lock().unwrap();
        if session.ended.load(Ordering::SeqCst) {
            return Err("gavin: this agent session has ended".into());
        }
        if let Some(live) = running.as_mut() {
            if matches!(live.child.try_wait(), Ok(None)) {
                return Ok(live.ws_url.clone());
            }
            // It died. Reaped here; the screencaster already said so.
            *running = None;
            self.remember(&session.session_id, None);
        }

        let exe = (self.find)()?;
        std::fs::create_dir_all(&session.dir)
            .map_err(|e| format!("could not create {}: {e}", session.dir.display()))?;
        let mut launched = launch::launch(&exe, &session.dir.join("profile"), &session.dir.join("browser.log"))?;
        let split = match ws::connect(&launched.ws_url, Duration::from_secs(5)) {
            Ok(split) => split,
            Err(e) => {
                launch::stop(launched.handle, Some(&mut launched.child));
                return Err(format!("the browser started but its debugging port did not answer: {e}"));
            }
        };
        self.remember(&session.session_id, Some(launched.handle));

        let (wake, events) = std::sync::mpsc::channel();
        screencast::spawn_reader(split.read, wake.clone());
        *session.wake.lock().unwrap() = Some(wake);
        let shared = Arc::clone(&session.shared);
        let announce = Arc::clone(&self.announce);
        let session_id = session.session_id.clone();
        let write = split.write;
        std::thread::Builder::new()
            .name("browser-cast".into())
            .spawn(move || {
                let tell = |browser: Option<BrowserInfo>| {
                    announce(Response::BrowserChanged { session_id: session_id.clone(), browser })
                };
                screencast::run(&session_id, write, events, &shared, &tell);
            })
            .map_err(|e| format!("could not start the screencaster: {e}"))?;

        let url = launched.ws_url.clone();
        *running = Some(Running { child: launched.child, handle: launched.handle, ws_url: launched.ws_url });
        Ok(url)
    }

    fn follow(&self, session: &Arc<SessionBrowser>, target: String) {
        let changed = {
            let mut followed = session.shared.followed.lock().unwrap();
            let changed = followed.as_deref() != Some(target.as_str());
            *followed = Some(target);
            changed
        };
        if changed {
            session.wake();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn browsers(state: &Path) -> Browsers {
        Browsers::with_finder(state, Arc::new(|_| {}), Box::new(|| Ok(PathBuf::from("/bin/false"))))
    }

    #[test]
    fn an_endpoint_is_stable_per_session_and_secret_per_session() {
        let state = tempfile::tempdir().unwrap();
        let b = browsers(state.path());
        let (one, out) = b.endpoint("s-1").unwrap();
        let (again, _) = b.endpoint("s-1").unwrap();
        let (other, _) = b.endpoint("s-2").unwrap();
        assert_eq!(one, again);
        assert_ne!(one, other);
        assert!(one.starts_with("ws://127.0.0.1:"), "{one}");
        assert!(out.is_dir());
        let path = &one[one.find("/devtools").unwrap()..];
        let secret = proxy::secret_of(path).unwrap();
        assert_eq!(secret.len(), 64);
        use proxy::Sessions;
        assert_eq!(b.inner.by_secret(secret).unwrap().session_id, "s-1");
        assert!(b.inner.by_secret(&"0".repeat(64)).is_none());
    }

    #[test]
    fn a_session_id_that_is_not_a_plain_id_is_refused() {
        let state = tempfile::tempdir().unwrap();
        let b = browsers(state.path());
        for bad in ["", "../x", "a/b", "s 1"] {
            assert!(b.endpoint(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn no_installed_browser_refuses_the_endpoint_with_the_reason() {
        let state = tempfile::tempdir().unwrap();
        let b = Browsers::with_finder(state.path(), Arc::new(|_| {}), Box::new(|| Err("not installed".into())));
        assert_eq!(b.endpoint("s").unwrap_err(), "not installed");
    }

    #[test]
    fn ending_a_session_ends_its_watches_with_browser_gone() {
        let state = tempfile::tempdir().unwrap();
        let b = browsers(state.path());
        let (tx, rx) = std::sync::mpsc::channel();
        let _guard = b
            .watch(
                "s",
                BrowserViewSize::Desk,
                8,
                Box::new(move |r| {
                    let _ = tx.send(r.clone());
                    true
                }),
            )
            .unwrap();
        b.end_session("s");
        match rx.recv_timeout(Duration::from_secs(5)).unwrap() {
            Response::BrowserGone { session_id } => assert_eq!(session_id, "s"),
            other => panic!("{other:?}"),
        }
        assert!(b.list().is_empty());
    }

    #[test]
    fn a_dropped_guard_closes_its_watch() {
        let state = tempfile::tempdir().unwrap();
        let b = browsers(state.path());
        let guard = b.watch("s", BrowserViewSize::Phone, 2, Box::new(|_| true)).unwrap();
        let watcher = Arc::clone(&guard.watcher);
        drop(guard);
        assert!(watcher.is_closed());
    }
}
