//! Keeping one Headroom alive for one daemon.
//!
//! The daemon's first long-lived child that is not a PTY (ADR 0007). One
//! thread owns the process: it starts it with the fixed flags, polls
//! `/readyz`, restarts it on the same port when it dies, and stops it
//! when nobody wants it any more.
//!
//! It also has to survive the daemon's own death. Agents can outlive
//! their daemon -- orphan recovery relies on it -- and a standalone
//! `headroom proxy` does not exit when its parent does, so a restarted
//! daemon finds a Headroom still serving agents it no longer hosts. It
//! takes that proxy back rather than starting a second one, but only
//! when every recorded fact still holds. And it never stops a Headroom
//! it did not start: the only process this module ever signals is the
//! one whose pid AND start time it wrote down itself.
//!
//! Headroom's own orphan watchdog is not used. It runs only for proxies
//! `wrap` started (`HEADROOM_WRAP_OWNED=1`), and it would stop the proxy
//! when the daemon died -- exactly the moment the surviving agents need
//! it.

use super::http::{self, Health};
use super::launch::{self, HOST};
use super::store::{self, InstallRecord, ProcessRecord, RunRecord};
use super::{detect, version};
use crate::proc::{self, ProcessHandle};
use protocol::BuildProfile;
use std::net::TcpListener;
use std::path::PathBuf;
use std::process::{Child, Stdio};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

/// How often a starting Headroom is asked whether it is ready.
const STARTING_TICK: Duration = Duration::from_millis(250);
/// How often a ready one is looked at: whether it is still alive, and
/// still ready.
const READY_TICK: Duration = Duration::from_secs(1);
/// How long a stopping Headroom is given before it is killed. uvicorn
/// drains its connections on SIGTERM.
const STOP_GRACE: Duration = Duration::from_secs(5);
/// How long after the grace a killed one is waited on.
const KILL_GRACE: Duration = Duration::from_secs(2);
/// How long a recorded, living process is given to answer `/health`
/// before the restarted daemon decides it is not the proxy it recorded.
/// A Headroom the daemon spawned moments before crashing is still
/// importing Python.
const ADOPT_PATIENCE: Duration = Duration::from_secs(10);
/// How long the daemon's own port is retried before it is given up for
/// another. A process that just died can hold its listener for a
/// moment, and every compressed agent is pointed at that number.
const PORT_PATIENCE: Duration = Duration::from_secs(2);
/// The longest wait between two attempts to start a Headroom that keeps
/// failing.
const MAX_BACKOFF: Duration = Duration::from_secs(30);
/// How long `stop` and `close` wait for the thread to finish stopping.
const STOP_WAIT: Duration = Duration::from_secs(10);
/// How long a lifetime total is served before `/stats` is asked again.
/// `/stats` carries request history and grows with the proxy's uptime.
const SAVINGS_FRESH: Duration = Duration::from_secs(10);

/// What a restarted daemon does about the Headroom it recorded.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Recovery {
    /// Every recorded fact still holds: take it back as it is.
    Adopt,
    /// The recorded process is alive and is not the proxy that was
    /// recorded -- it answers as something else, or not at all. It is
    /// this daemon's own, so it is stopped and a fresh one started on
    /// the same port.
    Replace,
    /// The recorded process is gone. Start a fresh one; stop nothing.
    Fresh,
}

/// The re-adoption rule, as one decision over the facts.
///
/// A Headroom is re-adopted when ALL of these match: the recorded pid
/// is alive with the recorded start time (`alive`, the reuse guard
/// orphan recovery uses), `/health` says `service: "headroom-proxy"` at
/// the recorded `version`, and the port it was started on is still this
/// daemon's port. Anything less and the proxy answering may be running
/// flags gavin did not choose.
pub fn recovery_for(
    record: &ProcessRecord,
    alive: bool,
    port: Option<u16>,
    health: Option<&Health>,
) -> Recovery {
    if !alive {
        return Recovery::Fresh;
    }
    let matches = health.is_some_and(|health| {
        health.service == http::SERVICE && health.version == record.version
    }) && port == Some(record.port);
    if matches {
        Recovery::Adopt
    } else {
        Recovery::Replace
    }
}

/// How long to wait before the next attempt, after this many starts in
/// a row that never became ready.
///
/// Zero for the first: a Headroom that was serving and died is
/// restarted at once, because agents are mid-turn against it. Doubling
/// after that, so one that cannot start -- a broken install, a model
/// that will not load -- is not respawned in a tight loop.
pub fn backoff(failures: u32) -> Duration {
    if failures == 0 {
        return Duration::ZERO;
    }
    let seconds = 1u64.checked_shl(failures - 1).unwrap_or(u64::MAX);
    Duration::from_secs(seconds).min(MAX_BACKOFF)
}

/// A ready Headroom: the port every compressed agent is pointed at, and
/// the process answering on it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Serving {
    pub port: u16,
    pub pid: u32,
}

/// What the supervisor knows, for the status.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Snapshot {
    pub wanted: bool,
    pub running: bool,
    pub ready: bool,
    pub port: Option<u16>,
    pub pid: Option<u32>,
    pub restarts: u32,
    pub last_error: Option<String>,
    pub lifetime_tokens_saved: Option<u64>,
}

#[derive(Default)]
struct Shared {
    wanted: bool,
    /// The daemon is exiting: stop the process, keep `wanted`.
    closing: bool,
    /// A supervisor thread is alive.
    thread: bool,
    pid: Option<u32>,
    ready: bool,
    port: Option<u16>,
    restarts: u32,
    last_error: Option<String>,
    lifetime_tokens_saved: Option<u64>,
    savings_read_at: Option<Instant>,
    /// Bumped by anything that changes what a start would do -- a
    /// detection, an install -- so a supervisor waiting out a backoff
    /// tries again now rather than in thirty seconds.
    nudges: u64,
    /// The process serving is to be swapped for a fresh start: an
    /// install changed the file every start runs, and a proxy that
    /// imported the old version goes on serving it until it is.
    replace: bool,
}

struct Inner {
    state_dir: PathBuf,
    profile: BuildProfile,
    /// Why Headroom cannot run here, when it cannot.
    unavailable: Option<&'static str>,
    shared: Mutex<Shared>,
    wake: Condvar,
    /// Held across every read-change-write of the run record. See
    /// `save_run`.
    record: Mutex<()>,
}

/// The process the thread is supervising.
struct Owned {
    handle: ProcessHandle,
    /// `None` for one that was re-adopted: it is not this process's
    /// child, so there is nothing to wait on and its death is read from
    /// the process table instead.
    child: Option<Child>,
    port: u16,
    /// Whether it has ever answered `/readyz`. A process that dies
    /// without having done so counts towards the backoff.
    was_ready: bool,
}

impl Owned {
    fn alive(&mut self) -> bool {
        match self.child.as_mut() {
            // `try_wait` reaps, which is what stops a dead child
            // lingering as a zombie for the daemon's whole lifetime.
            Some(child) => matches!(child.try_wait(), Ok(None)),
            None => proc::still_running(self.handle),
        }
    }
}

#[derive(Clone)]
pub struct Supervisor {
    inner: Arc<Inner>,
}

impl Supervisor {
    /// Reads what the last lifetime recorded. Starts nothing.
    pub fn open(
        state_dir: PathBuf,
        profile: BuildProfile,
        unavailable: Option<&'static str>,
    ) -> Supervisor {
        let record: RunRecord = store::load(&store::run_path(&state_dir, profile));
        let shared = Shared {
            wanted: record.wanted,
            port: record.port,
            lifetime_tokens_saved: record.lifetime_tokens_saved,
            ..Shared::default()
        };
        Supervisor {
            inner: Arc::new(Inner {
                state_dir,
                profile,
                unavailable,
                shared: Mutex::new(shared),
                wake: Condvar::new(),
                record: Mutex::new(()),
            }),
        }
    }

    /// Picks up where the last lifetime left off: once, when the daemon
    /// starts. A Headroom that was wanted is re-adopted or started; one
    /// that was recorded and is no longer wanted is stopped.
    pub fn resume(&self) {
        let record: RunRecord = self.inner.load_run();
        if record.wanted || record.process.is_some() {
            self.inner.ensure_thread();
        }
    }

    pub fn start(&self) {
        {
            let mut shared = self.inner.lock();
            shared.wanted = true;
            shared.closing = false;
            shared.last_error = None;
        }
        self.inner.save_run(|record| record.wanted = true);
        self.inner.ensure_thread();
        self.inner.wake.notify_all();
    }

    /// Stops this daemon's Headroom and waits for it to be gone.
    pub fn stop(&self) {
        self.inner.lock().wanted = false;
        self.inner.save_run(|record| record.wanted = false);
        self.inner.wait_until_stopped();
    }

    /// The daemon is exiting on request. Its sessions end with it, so
    /// nothing is left to serve, and a proxy left behind holds the
    /// compression model in memory with no owner. `wanted` is kept: the
    /// next daemon starts it again.
    ///
    /// A daemon that CRASHES never gets here, which is the case
    /// re-adoption exists for.
    pub fn close(&self) {
        self.inner.lock().closing = true;
        self.inner.wait_until_stopped();
    }

    /// Something changed what a start would find. Try again now.
    pub fn nudge(&self) {
        self.inner.lock().nudges += 1;
        self.inner.wake.notify_all();
    }

    /// The install changed the file every start runs. The Headroom
    /// serving is stopped and the new one started on the same port, as
    /// after a death -- which is what every compressed agent's next
    /// request meets: one connection error, one retry. Deliberate, so it
    /// is not counted as a restart and does not feed the backoff.
    ///
    /// Nothing is asked of a supervisor that is not running: there is no
    /// process to replace, and the next start reads the new file anyway.
    pub fn replace(&self) {
        {
            let mut shared = self.inner.lock();
            if !shared.thread {
                return;
            }
            shared.replace = true;
            shared.nudges += 1;
        }
        self.inner.wake.notify_all();
    }

    /// The port Headroom is answering on, or `None` while it is not
    /// ready: what a session about to be spawned needs to know, and
    /// nothing else.
    ///
    /// Apart from `snapshot` because that one asks Headroom for its
    /// savings, which is an HTTP call, and this is read on the way to
    /// every spawn in a compressed workspace. It reads what the
    /// supervisor's last tick found. A proxy that died since then is
    /// still reported ready for up to a tick, and the session launched
    /// in that window is no worse off than one whose proxy died a tick
    /// AFTER it launched: the restart is on the same port.
    pub fn ready_port(&self) -> Option<u16> {
        self.serving().map(|serving| serving.port)
    }

    /// The process that is ready, and its port: `ready_port` with the
    /// pid beside it, read under one lock so the two describe the same
    /// process. A compressed session keeps the pid it was pointed at, and
    /// a later answer about what Headroom has seen of it is only as good
    /// as that process still being the one serving (`reach.rs`).
    pub fn serving(&self) -> Option<Serving> {
        let shared = self.inner.lock();
        if !shared.ready {
            return None;
        }
        Some(Serving { port: shared.port?, pid: shared.pid? })
    }

    /// This daemon's port, whether or not anything is answering on it:
    /// where every compressed agent is pointed, so where a health check
    /// asks.
    pub fn port(&self) -> Option<u16> {
        self.inner.lock().port
    }

    pub fn snapshot(&self) -> Snapshot {
        let (port, ready, stale) = {
            let shared = self.inner.lock();
            let stale = shared.savings_read_at.is_none_or(|at| at.elapsed() >= SAVINGS_FRESH);
            (shared.port, shared.ready, stale)
        };
        if let (Some(port), true, true) = (port, ready, stale) {
            // Asked outside the lock: it is an HTTP call.
            let total = http::lifetime_tokens_saved(port);
            let changed = {
                let mut shared = self.inner.lock();
                shared.savings_read_at = Some(Instant::now());
                match total {
                    Some(total) if shared.lifetime_tokens_saved != Some(total) => {
                        shared.lifetime_tokens_saved = Some(total);
                        true
                    }
                    _ => false,
                }
            };
            if changed {
                self.inner.save_run(|record| record.lifetime_tokens_saved = total);
            }
        }
        let shared = self.inner.lock();
        Snapshot {
            wanted: shared.wanted,
            running: shared.pid.is_some(),
            ready: shared.ready,
            port: shared.port,
            pid: shared.pid,
            restarts: shared.restarts,
            last_error: shared.last_error.clone(),
            lifetime_tokens_saved: shared.lifetime_tokens_saved,
        }
    }
}

impl Inner {
    fn lock(&self) -> MutexGuard<'_, Shared> {
        self.shared.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn run_path(&self) -> PathBuf {
        store::run_path(&self.state_dir, self.profile)
    }

    fn load_run(&self) -> RunRecord {
        store::load(&self.run_path())
    }

    /// Read, change, write -- as one step.
    ///
    /// The record has two writers, the supervisor's thread and the
    /// request threads, and each changes a field of its own. Writing
    /// the file whole is what keeps a reader from seeing half a record;
    /// it is also what lets a writer that read before the other wrote
    /// put the other's field back. A `wanted` undone that way is a
    /// Headroom the next daemon does not start, and a process undone
    /// that way is one it can never re-adopt.
    fn save_run(&self, change: impl FnOnce(&mut RunRecord)) {
        let _writing = self.record.lock().unwrap_or_else(PoisonError::into_inner);
        let mut record = self.load_run();
        change(&mut record);
        if let Err(e) = store::save(&self.run_path(), &record) {
            eprintln!("headroom: could not write {}: {e}", self.run_path().display());
        }
    }

    fn ensure_thread(self: &Arc<Self>) {
        {
            let mut shared = self.lock();
            if shared.thread {
                return;
            }
            shared.thread = true;
        }
        let inner = Arc::clone(self);
        let spawned = std::thread::Builder::new()
            .name("headroom-supervisor".to_string())
            .spawn(move || inner.supervise());
        if let Err(e) = spawned {
            let mut shared = self.lock();
            shared.thread = false;
            shared.last_error = Some(format!("could not start the Headroom supervisor: {e}"));
        }
    }

    fn wait_until_stopped(&self) {
        self.wake.notify_all();
        let deadline = Instant::now() + STOP_WAIT;
        let mut shared = self.lock();
        while shared.thread {
            let Some(left) = deadline.checked_duration_since(Instant::now()) else { break };
            shared = self
                .wake
                .wait_timeout(shared, left)
                .unwrap_or_else(PoisonError::into_inner)
                .0;
        }
    }

    /// Sleeps, unless something happens that the loop should look at.
    fn pause(&self, how_long: Duration) {
        let shared = self.lock();
        let before = (shared.wanted, shared.closing, shared.nudges);
        let _ = self
            .wake
            .wait_timeout_while(shared, how_long, |s| (s.wanted, s.closing, s.nudges) == before)
            .unwrap_or_else(PoisonError::into_inner);
    }

    fn wanted(&self) -> bool {
        let shared = self.lock();
        shared.wanted && !shared.closing
    }

    /// Whether a replacement was asked for since the last look, clearing
    /// the ask: one install is one replacement.
    fn take_replace(&self) -> bool {
        std::mem::take(&mut self.lock().replace)
    }

    fn supervise(self: Arc<Self>) {
        let mut owned = self.recover();
        let mut failures: u32 = 0;
        loop {
            if !self.wanted() {
                if let Some(process) = owned.take() {
                    self.stop_process(process);
                }
                self.forget_process();
                let mut shared = self.lock();
                // `start` can have been pressed while the process was
                // being stopped. The thread that read "not wanted" is
                // the one that must notice, or nothing will.
                if shared.wanted && !shared.closing {
                    continue;
                }
                shared.thread = false;
                // Asked of a process that is gone now. Left set, it
                // would replace whatever the next thread re-adopts.
                shared.replace = false;
                drop(shared);
                self.wake.notify_all();
                return;
            }
            if self.take_replace() {
                if let Some(process) = owned.take() {
                    self.stop_process(process);
                    self.forget_process();
                }
                failures = 0;
                continue;
            }
            let Some(process) = owned.as_mut() else {
                self.pause(backoff(failures));
                if !self.wanted() {
                    continue;
                }
                match self.launch() {
                    Ok(process) => {
                        let mut shared = self.lock();
                        shared.pid = Some(process.handle.pid);
                        shared.port = Some(process.port);
                        shared.ready = false;
                        shared.last_error = None;
                        drop(shared);
                        owned = Some(process);
                    }
                    Err(why) => {
                        failures = failures.saturating_add(1);
                        self.lock().last_error = Some(why);
                    }
                }
                continue;
            };
            if !process.alive() {
                failures = if process.was_ready { 0 } else { failures.saturating_add(1) };
                owned = None;
                self.forget_process();
                let mut shared = self.lock();
                shared.restarts = shared.restarts.saturating_add(1);
                shared.last_error = Some("Headroom exited and is being restarted.".to_string());
                continue;
            }
            let ready = http::ready(process.port);
            if ready {
                process.was_ready = true;
                failures = 0;
            }
            {
                let mut shared = self.lock();
                shared.ready = ready;
                if ready {
                    shared.last_error = None;
                }
            }
            self.pause(if ready { READY_TICK } else { STARTING_TICK });
        }
    }

    /// Clears the process from the status and from the record. The port
    /// stays: it is the daemon's, not the process's.
    fn forget_process(&self) {
        {
            let mut shared = self.lock();
            shared.pid = None;
            shared.ready = false;
        }
        self.save_run(|record| record.process = None);
    }

    /// What to do about the process the last lifetime recorded.
    fn recover(&self) -> Option<Owned> {
        let record = self.load_run();
        let process = record.process?;
        let handle = process.handle();
        if !proc::still_running(handle) {
            // Gone, or its pid now names something else. Either way
            // there is nothing of this daemon's left to stop.
            self.forget_process();
            return None;
        }
        let mut adopted = Owned { handle, child: None, port: process.port, was_ready: false };
        if !self.wanted() {
            self.stop_process(adopted);
            self.forget_process();
            return None;
        }
        let port = self.lock().port;
        let health = wait_for_health(&mut adopted, ADOPT_PATIENCE);
        match recovery_for(&process, true, port, health.as_ref()) {
            Recovery::Adopt => {
                let mut shared = self.lock();
                shared.pid = Some(handle.pid);
                shared.port = Some(process.port);
                shared.last_error = None;
                Some(adopted)
            }
            Recovery::Replace | Recovery::Fresh => {
                self.stop_process(adopted);
                self.forget_process();
                None
            }
        }
    }

    /// One start, with the fixed flags, from the stored path.
    fn launch(&self) -> Result<Owned, String> {
        if let Some(reason) = self.unavailable {
            return Err(reason.to_string());
        }
        let install: InstallRecord = store::load(&store::install_path(&self.state_dir));
        // The stored path, and only that. `PATH` was searched when
        // Headroom was detected and is not searched again here: a start
        // must run the file the human was shown, not whichever
        // `headroom` the daemon's environment happens to put first.
        let program = install
            .path
            .ok_or_else(|| "Headroom has not been found on this machine.".to_string())?;
        if !program.is_file() {
            return Err(format!(
                "Headroom is no longer at {}. Check again in Settings.",
                program.display()
            ));
        }
        // Asked at every start, because the file can have changed since
        // it was detected: an upgrade, or a downgrade below the floor.
        let found = detect::read_version(&program)
            .map_err(|why| format!("{}: {why}", program.display()))?;
        if !version::state_for(None, Some(found)).startable() {
            return Err(format!(
                "Headroom {found} is older than {}, the oldest version gavin will start.",
                version::FLOOR
            ));
        }

        let port = self.claim_port()?;
        let launch = launch::launch(&program, port, &self.state_dir, self.profile);
        std::fs::create_dir_all(&launch.workspace_dir)
            .map_err(|e| format!("could not create {}: {e}", launch.workspace_dir.display()))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            // The CCR store keeps the originals of what agents sent.
            let _ = std::fs::set_permissions(
                &launch.workspace_dir,
                std::fs::Permissions::from_mode(0o700),
            );
        }
        let (out, err) = stdio_log(&launch.workspace_dir)?;

        let mut command = launch::command(&launch, std::env::vars_os().map(|(key, _)| key));
        command.stdin(Stdio::null()).stdout(out).stderr(err);
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            // A group of its own, so a signal aimed at the daemon's
            // group -- Ctrl-C in the terminal `tauri dev` runs in --
            // does not take the proxy with it, and so that stopping it
            // reaches a wrapper's child as well as the wrapper.
            command.process_group(0);
        }
        let mut child = command
            .spawn()
            .map_err(|e| format!("could not start {}: {e}", program.display()))?;
        let Some(handle) = proc::identify(child.id()) else {
            // Already gone, or already a zombie: it failed as it
            // started. Reaped here so it does not linger.
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!(
                "Headroom exited as it started. See {}.",
                launch.workspace_dir.join(STDIO_LOG).display()
            ));
        };
        self.save_run(|record| {
            record.port = Some(port);
            record.process = Some(ProcessRecord {
                pid: handle.pid,
                started_at_us: handle.started_at_us,
                version: found.to_string(),
                port,
            });
        });
        Ok(Owned { handle, child: Some(child), port, was_ready: false })
    }

    /// The daemon's port: the one it already has, or a free one the OS
    /// picks the first time. Never Headroom's default 8787, which the
    /// human may be using for a proxy of their own.
    fn claim_port(&self) -> Result<u16, String> {
        let kept = self.lock().port;
        if let Some(port) = kept {
            let deadline = Instant::now() + PORT_PATIENCE;
            loop {
                if port_is_free(port) {
                    return Ok(port);
                }
                if Instant::now() >= deadline {
                    break;
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            // Something that is not this daemon's holds it. It is not
            // stopped; the daemon moves.
        }
        let port = free_port().map_err(|e| format!("could not find a free port: {e}"))?;
        self.lock().port = Some(port);
        self.save_run(|record| record.port = Some(port));
        Ok(port)
    }

    /// Stops a process this daemon started. Asked first, then made to.
    fn stop_process(&self, mut process: Owned) {
        signal(process.handle, Signal::Terminate);
        if !wait_for_exit(&mut process, STOP_GRACE) {
            if let Some(child) = process.child.as_mut() {
                let _ = child.kill();
            }
            signal(process.handle, Signal::Kill);
            wait_for_exit(&mut process, KILL_GRACE);
        }
    }
}

const STDIO_LOG: &str = "gavin-stdio.log";
const STDIO_LOG_PREVIOUS: &str = "gavin-stdio.previous.log";

/// Where Headroom's own stdout and stderr go: a file, because a pipe
/// nobody reads blocks the proxy once it fills. The last run's is kept
/// beside it -- after a restart, the reason the previous one died is in
/// that file and nowhere else.
fn stdio_log(workspace_dir: &std::path::Path) -> Result<(Stdio, Stdio), String> {
    let path = workspace_dir.join(STDIO_LOG);
    let _ = std::fs::rename(&path, workspace_dir.join(STDIO_LOG_PREVIOUS));
    let file = std::fs::File::create(&path)
        .map_err(|e| format!("could not create {}: {e}", path.display()))?;
    let twin = file.try_clone().map_err(|e| format!("could not open {}: {e}", path.display()))?;
    Ok((Stdio::from(file), Stdio::from(twin)))
}

fn port_is_free(port: u16) -> bool {
    TcpListener::bind((HOST, port)).is_ok()
}

fn free_port() -> std::io::Result<u16> {
    Ok(TcpListener::bind((HOST, 0))?.local_addr()?.port())
}

fn wait_for_exit(process: &mut Owned, how_long: Duration) -> bool {
    let deadline = Instant::now() + how_long;
    loop {
        if !process.alive() {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// Asks a living process for its `/health` until it answers, it dies,
/// or the patience runs out.
fn wait_for_health(process: &mut Owned, how_long: Duration) -> Option<Health> {
    let deadline = Instant::now() + how_long;
    loop {
        if let Some(health) = http::health(process.port) {
            return Some(health);
        }
        if !process.alive() || Instant::now() >= deadline {
            return None;
        }
        std::thread::sleep(Duration::from_millis(250));
    }
}

#[derive(Clone, Copy)]
enum Signal {
    Terminate,
    Kill,
}

/// Signals a process this daemon started, and its whole group.
///
/// The identity is checked here, against the process table, every time:
/// the pid must still be alive AND still have the recorded start time.
/// That check is what "never stops a Headroom it did not start" rests
/// on -- a recycled pid fails it, and nothing is signalled.
///
/// The group, because the file the human located can be a wrapper that
/// starts Python as a child. The process was put in a group of its own
/// when it was spawned, so the group is the wrapper and what it started
/// and nothing else.
#[cfg(unix)]
fn signal(handle: ProcessHandle, signal: Signal) -> bool {
    if !proc::still_running(handle) {
        return false;
    }
    let number = match signal {
        Signal::Terminate => libc::SIGTERM,
        Signal::Kill => libc::SIGKILL,
    };
    let pid = handle.pid as i32;
    // SAFETY: `kill` with plain integers and no pointers. The negative
    // pid addresses the process group the daemon created for this
    // process; if that group is gone (ESRCH) the process itself is
    // signalled instead.
    unsafe { libc::kill(-pid, number) == 0 || libc::kill(pid, number) == 0 }
}

/// Windows has one way to stop a process, and it is the abrupt one. See
/// `proc::terminate`.
#[cfg(not(unix))]
fn signal(handle: ProcessHandle, _signal: Signal) -> bool {
    proc::terminate(handle)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record() -> ProcessRecord {
        ProcessRecord { pid: 4172, started_at_us: 1_790_000_000_000_000, version: "0.39.1".into(), port: 51234 }
    }

    fn health(service: &str, version: &str) -> Health {
        Health { service: service.into(), version: version.into() }
    }

    #[test]
    fn a_headroom_is_re_adopted_only_when_every_recorded_fact_still_holds() {
        let ours = health("headroom-proxy", "0.39.1");
        assert_eq!(recovery_for(&record(), true, Some(51234), Some(&ours)), Recovery::Adopt);
    }

    #[test]
    fn a_recorded_process_that_is_gone_is_replaced_by_a_fresh_one() {
        let ours = health("headroom-proxy", "0.39.1");
        // Whatever answers on the port, the process that was recorded
        // is not it.
        assert_eq!(recovery_for(&record(), false, Some(51234), Some(&ours)), Recovery::Fresh);
        assert_eq!(recovery_for(&record(), false, Some(51234), None), Recovery::Fresh);
    }

    #[test]
    fn a_living_process_that_does_not_answer_as_recorded_is_not_adopted() {
        let rows: [(&str, Option<u16>, Option<Health>); 5] = [
            ("another version", Some(51234), Some(health("headroom-proxy", "0.40.0"))),
            ("another service", Some(51234), Some(health("something-else", "0.39.1"))),
            ("no answer", Some(51234), None),
            ("another port", Some(50000), Some(health("headroom-proxy", "0.39.1"))),
            ("no port", None, Some(health("headroom-proxy", "0.39.1"))),
        ];
        for (what, port, health) in rows {
            assert_eq!(
                recovery_for(&record(), true, port, health.as_ref()),
                Recovery::Replace,
                "{what}"
            );
        }
    }

    #[test]
    fn a_headroom_that_was_serving_is_restarted_at_once() {
        assert_eq!(backoff(0), Duration::ZERO);
    }

    #[test]
    fn one_that_keeps_failing_is_retried_less_and_less_often() {
        let waits: Vec<u64> = (1..=8).map(|n| backoff(n).as_secs()).collect();
        assert_eq!(waits, [1, 2, 4, 8, 16, 30, 30, 30]);
        assert_eq!(backoff(u32::MAX), MAX_BACKOFF);
    }

    #[test]
    fn a_port_in_use_is_not_free_and_a_released_one_is() {
        let listener = TcpListener::bind((HOST, 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        assert!(!port_is_free(port));
        drop(listener);
        assert!(port_is_free(port));
    }

    #[test]
    fn a_free_port_is_never_headrooms_default() {
        // The OS hands out ephemeral ports; 8787 is below every
        // platform's range. Asserted because the default is where the
        // human's own proxy lives.
        for _ in 0..20 {
            assert_ne!(free_port().unwrap(), 8787);
        }
    }

    /// The run record has two writers: the supervisor's thread (the
    /// process, the port) and the request threads (`wanted`, the
    /// lifetime total). Each reads the record, changes its own field
    /// and writes the record back whole -- so without one lock around
    /// all three steps, a writer that read before the other wrote puts
    /// the other's field back to what it was.
    #[test]
    fn two_writers_of_the_run_record_never_undo_each_others_fields() {
        let dir = tempfile::tempdir().unwrap();
        let supervisor = Supervisor::open(dir.path().to_path_buf(), BuildProfile::Dev, None);
        let inner = &supervisor.inner;

        std::thread::scope(|scope| {
            scope.spawn(|| {
                for port in 1..=300u16 {
                    inner.save_run(|record| record.port = Some(port));
                    assert_eq!(inner.load_run().port, Some(port), "the port was put back");
                }
            });
            scope.spawn(|| {
                for total in 1..=300u64 {
                    inner.save_run(|record| record.lifetime_tokens_saved = Some(total));
                    assert_eq!(
                        inner.load_run().lifetime_tokens_saved,
                        Some(total),
                        "the lifetime total was put back"
                    );
                }
            });
        });

        let record = inner.load_run();
        assert_eq!(record.port, Some(300));
        assert_eq!(record.lifetime_tokens_saved, Some(300));
    }

    #[test]
    fn opening_reads_what_the_last_lifetime_recorded_and_starts_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let path = store::run_path(dir.path(), BuildProfile::Dev);
        store::save(
            &path,
            &RunRecord {
                wanted: true,
                port: Some(51234),
                process: None,
                lifetime_tokens_saved: Some(77),
            },
        )
        .unwrap();

        let supervisor = Supervisor::open(dir.path().to_path_buf(), BuildProfile::Dev, None);
        let snapshot = supervisor.snapshot();

        assert!(snapshot.wanted);
        assert!(!snapshot.running);
        assert_eq!(snapshot.port, Some(51234));
        assert_eq!(snapshot.lifetime_tokens_saved, Some(77));
        // The other build's record is another daemon's.
        let release = Supervisor::open(dir.path().to_path_buf(), BuildProfile::Release, None);
        assert_eq!(release.snapshot(), Snapshot::default());
    }
}
