//! The daemon's request/reply connections, each owned by one worker
//! thread and fed through a FIFO.
//!
//! Every request/response command reaches a daemon through here. Before
//! this module the command connection was a `Mutex<Stream>` held across
//! the whole round trip, and every command that used it was a plain `fn`:
//! Tauri runs those on the main thread, so a slow or wedged handler froze
//! the window for as long as it took, with no read timeout to end it.
//!
//! Moving those commands off the main thread one at a time would not have
//! fixed that. The mutex becomes the queue: a command still on the main
//! thread waits there behind whichever off-thread request holds it, so
//! the freeze moves rather than going away. And a pthread mutex is not
//! FIFO, so racing tasks could reorder writes whose order is their
//! meaning -- a `set_step_run` "done" overtaken by an earlier "running"
//! re-runs finished work.
//!
//! So each connection belongs to ONE thread. A command computes its
//! route, enqueues `(Request, reply)` -- which never blocks -- and awaits
//! the reply. The worker writes one request, reads its one reply, and only
//! then takes the next: request/reply correlation stays what it was with
//! no request id on the wire, and requests reach the daemon in exactly
//! the order they were enqueued.
//!
//! Enqueue order is the order the COMMANDS reach `submit`, which is not
//! always the order the frontend invoked them: Tauri spawns every async
//! command onto a multi-threaded runtime, and two invoked within the same
//! instant can race to the queue. A caller whose second write must land
//! after its first issues the second once the first resolves -- which the
//! whole-state writers already do: the rail scheduler awaits every
//! run-state write before its next, and a board or plan edit is one save
//! per human action.
//!
//! Answers can also come back in a different order than they were asked
//! for, across lanes and across daemons, and a read can be answered after
//! a push that is newer than it. The stores that apply a read guard it
//! with a supersession token (`refreshBoard`, `refreshOrchestration`,
//! `refreshGavinTree`).
//!
//! An ssh link's lane has one connection and nothing to redial, so a
//! host that stops answering cannot be routed around the way a wedged
//! local handler is. What keeps it from costing more than one deadline:
//! a request whose caller already gave up is never sent
//! (`ask_each`'s bound), and while the host still owes a late answer the
//! lane refuses new requests at once instead of queuing each for a whole
//! deadline of its own behind it (`Worker::settle`).

use protocol::transport::Stream;
use protocol::{write_message, Request, Response, MAX_LINE_BYTES};
use std::future::Future;
use std::io::{BufRead, BufReader, ErrorKind, Read};
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{mpsc, Arc};
use std::task::{Context, Poll};
use std::time::Duration;
use tokio::sync::oneshot;

use crate::session::DaemonCompat;

/// How long a request waits for its reply before the lane gives up on
/// it. Every handler the app calls answers in milliseconds; this only
/// bounds the one that never does, which used to hold the main thread
/// with no end at all.
const DEFAULT_DEADLINE: Duration = Duration::from_secs(30);

/// The version probe and the `Hello` a redial sends.
const HANDSHAKE_DEADLINE: Duration = Duration::from_secs(10);

/// How long a request on a link that owes a late answer waits for it
/// before the lane refuses the request unsent (`Worker::settle`). Per
/// read, so an answer that is still arriving -- a large one, over a slow
/// link -- keeps being read for as long as its bytes keep coming.
const OWED_GRACE: Duration = Duration::from_millis(250);

/// How long `req` may take to answer.
///
/// A timeout is not free: the reply may still be coming, and a reply
/// read later would be taken for the NEXT request's -- so a lane that
/// times out drops its connection, and the daemon finishes the handler
/// into a closed socket. Each figure here therefore sits above the
/// longest the handler can legitimately take, not near its usual time.
pub(crate) fn deadline_for(req: &Request) -> Duration {
    match req {
        // A git subcommand on an ssh host runs its hooks and its commit
        // signing there, and the daemon puts no ceiling on it
        // (`gavin::run_git`). Ten minutes is the ceiling the daemon gives
        // the streaming ops (`GIT_OP_TIMEOUT`).
        Request::RunGit { .. } | Request::RunGitEnv { .. } => Duration::from_secs(600),
        // A tree read can wait on a rescan the watcher runs under its
        // lock; on a large repo that has taken tens of seconds.
        Request::GetGavinTree { .. } | Request::ScanGavinRoot { .. } => Duration::from_secs(120),
        // SIGTERM, then up to ORPHAN_EXIT_GRACE (2 s) of polling for the
        // exit -- and a process that refuses is the case this request
        // exists for.
        Request::EndOrphan { .. } => Duration::from_secs(60),
        // The host's Trash, which on macOS can be a Finder round trip.
        Request::TrashWorkspacePath { .. } => Duration::from_secs(120),
        _ => DEFAULT_DEADLINE,
    }
}

/// The reads that go on the local daemon's second connection.
///
/// The daemon serves each connection on its own thread, strictly in
/// order (`server::handle_connection`), so one slow handler delays every
/// later request on the same connection. These are the reads that can
/// take seconds -- a tree rescan, a process sample of every session, a
/// scan of a root -- and nothing ordered depends on them: a write never
/// has to land after one, and a caller that needs a read to see its
/// write awaits the write first.
///
/// The three Headroom requests are here for the same reason: a `/stats`
/// read (megabytes on a long-lived proxy, 3 s timeout) or a
/// `headroom --version` (about 2 s, up to 20 s) is served inline on the
/// connection thread. `DetectHeadroom` also stores the path it located,
/// but its only callers (`checkHeadroomAgain`, `locateHeadroom`) await
/// the reply before acting on it.
pub(crate) fn is_slow_read(req: &Request) -> bool {
    matches!(
        req,
        Request::GetGavinTree { .. }
            | Request::SessionProcesses
            | Request::ScanGavinRoot { .. }
            | Request::GetHeadroomStatus
            | Request::DetectHeadroom { .. }
            | Request::HeadroomReach { .. }
    )
}

/// The requests that go out on a connection of their own
/// (`CommandLane::submit_apart`).
///
/// `EndOrphan`'s handler waits out `ORPHAN_EXIT_GRACE` on the thread
/// serving its connection, and the orphan it is sent for already ignored
/// SIGHUP -- so the full 2 s is the usual case, not the edge. On a lane,
/// every request queued behind it waited that out too, and the close
/// sweep's N orphans waited one after another: N × 2 s. On connections of
/// their own the daemon waits them out side by side.
///
/// Nothing ordered depends on where it rides: its callers await it
/// before the `KillSession` that must follow, and a second one for the
/// same session is a harmless no-op on the daemon.
pub(crate) fn runs_apart(req: &Request) -> bool {
    matches!(req, Request::EndOrphan { .. })
}

/// Pushes the daemon writes to `app` connections whether they asked or not
/// (`SessionManager::push_to_apps`). A daemon from v51 on sends them only
/// to a connection whose `Hello` says it reads pushes, and every lane's
/// says it is a command connection -- but the app may run against an older
/// daemon, which sends them to both, and there one can arrive where a reply
/// is expected: read as the reply, it would desync every request after it.
/// The streaming connection is `app` too and relays each of them, so
/// dropping them here loses nothing.
fn is_unsolicited(resp: &Response) -> bool {
    matches!(
        resp,
        Response::DevicePairingRequested { .. }
            | Response::DeviceConnected { .. }
            | Response::DeviceDisconnected { .. }
            | Response::RelayStateChanged { .. }
    )
}

/// One connection's queue. Cheap to clone: every clone feeds the same
/// worker, which runs until the last clone is dropped.
#[derive(Clone)]
pub struct CommandLane {
    jobs: mpsc::Sender<Job>,
    shared: Arc<Shared>,
}

struct Shared {
    /// Who answers on this lane, as every error from it names them: "the
    /// gavin daemon", or an ssh host.
    peer: String,
    /// Set while a restart swaps the connection underneath the lane. A
    /// request then fails at once rather than riding a socket to a daemon
    /// that is being killed, or reaching the new one before its version
    /// verdict is published.
    swapping: AtomicBool,
    /// The version of the daemon the lane is connected to. A request
    /// gated against any other verdict is refused: a command that read
    /// the compat state just before a restart republished it would
    /// otherwise put a request the old daemon allowed onto the new one.
    version: AtomicU32,
    /// The pid serving the connection the lane was last put on, as the
    /// kernel names it (`Stream::server_pid`); 0 when it would not say.
    /// Kept here because the worker owns the stream: the task manager's
    /// line for the daemon itself has no other way to ask which process
    /// this app is talking to.
    server_pid: AtomicU32,
    /// How the lane reopens its connection, and dials one for a request
    /// that goes apart. `None` on an ssh link.
    redial: Option<Redial>,
    deadline: fn(&Request) -> Duration,
}

// `Swap` is a few bytes and `Ask` a whole request, but a swap happens once
// per daemon restart: boxing every request to shrink it would buy an
// allocation per request and nothing else.
#[allow(clippy::large_enum_variant)]
enum Job {
    /// `deadline` is the caller's, when it chose one (`submit_within`);
    /// otherwise the lane's own for the request.
    Ask { req: Request, reply: oneshot::Sender<anyhow::Result<Response>>, deadline: Option<Duration> },
    Swap { stream: Stream, version: u32 },
}

/// How a lane reopens a connection it had to drop -- after a timeout, or
/// after the daemon closed it. Only the local daemon has one: an ssh
/// link's connection is a bridge process, and a lost link is
/// `remote::link_lost`'s to report and Reconnect's to rebuild.
pub struct Redial {
    pub endpoint: PathBuf,
    /// The daemon token to present, read at each redial: a daemon that
    /// restarted underneath the app minted a new one.
    pub token: fn() -> Option<String>,
}

impl CommandLane {
    /// A lane over `stream`, which has already been probed (at `version`)
    /// and, where the daemon takes one, handed its `Hello`.
    pub fn spawn(peer: impl Into<String>, stream: Stream, version: u32, redial: Option<Redial>) -> CommandLane {
        Self::spawn_with(peer, stream, version, redial, deadline_for)
    }

    /// `spawn` with the deadlines chosen by the caller -- a test's, which
    /// cannot wait out the production figures.
    fn spawn_with(
        peer: impl Into<String>,
        stream: Stream,
        version: u32,
        redial: Option<Redial>,
        deadline: fn(&Request) -> Duration,
    ) -> CommandLane {
        let (jobs, queue) = mpsc::channel();
        let shared = Arc::new(Shared {
            peer: peer.into(),
            swapping: AtomicBool::new(false),
            version: AtomicU32::new(version),
            server_pid: AtomicU32::new(stream.server_pid().unwrap_or(0)),
            redial,
            deadline,
        });
        let worker = Worker { shared: Arc::clone(&shared), conn: Some(Conn::new(stream)), owed: 0, version };
        std::thread::Builder::new()
            .name(format!("command lane: {}", shared.peer))
            .spawn(move || worker.run(queue))
            .expect("spawn a command lane thread");
        CommandLane { jobs, shared }
    }

    /// Queues `req` and returns its reply, to await or to wait on.
    ///
    /// Gated first (`admit`). Never blocks -- the queue is unbounded, and
    /// the worker does the waiting.
    ///
    /// Dropping the reply before the worker reaches the request withdraws
    /// it: a request nobody is waiting for is never sent.
    pub fn submit(&self, compat: &DaemonCompat, req: Request) -> anyhow::Result<Reply> {
        self.submit_within(compat, req, None)
    }

    /// `submit`, with the reply waited for for `deadline` rather than the
    /// lane's own figure for the request. For a caller that knows more
    /// about the request than its type says -- a `RunGit` that is a read,
    /// not a commit running hooks (`remote::run_git_over_link`).
    pub fn submit_within(
        &self,
        compat: &DaemonCompat,
        req: Request,
        deadline: Option<Duration>,
    ) -> anyhow::Result<Reply> {
        self.admit(compat, &req)?;
        let (reply, answer) = oneshot::channel();
        self.jobs
            .send(Job::Ask { req, reply, deadline })
            .map_err(|_| anyhow::anyhow!("the command worker for {} has stopped", self.shared.peer))?;
        Ok(Reply(answer))
    }

    /// `submit`, on a connection of the request's own: dialled for it and
    /// presented the way a redial presents the lane's, then closed after
    /// its one reply. For `runs_apart`'s requests, whose handler holds the
    /// connection it arrives on. Never blocks either: the dial and the
    /// wait are a thread's of their own.
    ///
    /// A lane with nothing to dial -- an ssh link, whose one connection is
    /// its bridge -- queues the request like any other instead.
    pub fn submit_apart(&self, compat: &DaemonCompat, req: Request) -> anyhow::Result<Reply> {
        if self.shared.redial.is_none() {
            return self.submit(compat, req);
        }
        self.admit(compat, &req)?;
        let (reply, answer) = oneshot::channel();
        let mut worker = Worker {
            shared: Arc::clone(&self.shared),
            conn: None,
            owed: 0,
            version: compat.daemon_version,
        };
        std::thread::Builder::new()
            .name(format!("command apart: {}", self.shared.peer))
            .spawn(move || {
                let answer = if worker.shared.swapping.load(Ordering::SeqCst) {
                    Err(restarting(&worker.shared.peer))
                } else {
                    let deadline = (worker.shared.deadline)(&req);
                    worker.round_trip(&req, deadline)
                };
                let _ = reply.send(answer);
            })
            .map_err(|e| anyhow::anyhow!("could not start a connection to {}: {e}", self.shared.peer))?;
        Ok(Reply(answer))
    }

    /// Whether `req` may leave for this lane's daemon at all.
    ///
    /// Gated here, before the bytes leave: a daemon older than the request
    /// cannot PARSE it, and that parse error closes the whole connection.
    /// And refused while a restart swaps the daemon, or once it has
    /// swapped to a version other than the one `compat` describes.
    fn admit(&self, compat: &DaemonCompat, req: &Request) -> anyhow::Result<()> {
        crate::session::gate(req, compat).map_err(|e| anyhow::anyhow!(e))?;
        if self.shared.swapping.load(Ordering::SeqCst) {
            return Err(restarting(&self.shared.peer));
        }
        if compat.daemon_version != self.shared.version.load(Ordering::SeqCst) {
            return Err(restarting(&self.shared.peer));
        }
        Ok(())
    }

    /// `submit`, then wait for the reply on this thread. For the callers
    /// that are already off the main thread and synchronous: bootstrap,
    /// a link's setup, the blocking pool.
    pub fn ask(&self, compat: &DaemonCompat, req: Request) -> anyhow::Result<Response> {
        self.submit(compat, req)?.wait()
    }

    /// A restart is about to kill the daemon this lane talks to: refuse
    /// every request until `finish_swap` or `abort_swap`.
    pub fn begin_swap(&self) {
        self.shared.swapping.store(true, Ordering::SeqCst);
    }

    /// Puts the lane on `stream`, a connection to the restarted daemon
    /// that is already probed and handshaken. Queued behind whatever was
    /// already in the queue, so nothing enqueued before the restart can
    /// reach the new daemon.
    pub fn finish_swap(&self, stream: Stream, version: u32) {
        self.shared.version.store(version, Ordering::SeqCst);
        let _ = self.jobs.send(Job::Swap { stream, version });
        self.shared.swapping.store(false, Ordering::SeqCst);
    }

    /// The restart failed: take requests again, on whatever the lane can
    /// reach.
    pub fn abort_swap(&self) {
        self.shared.swapping.store(false, Ordering::SeqCst);
    }

    /// The pid serving the connection the lane was last put on -- at
    /// spawn, by a restart's swap, or by a redial. `None` when the kernel
    /// would not say, which callers treat as "no process", never as a
    /// cue to guess one. A connection that has since dropped still names
    /// its old pid, so a caller measuring it checks the pid is still the
    /// process it expects.
    pub fn server_pid(&self) -> Option<u32> {
        match self.shared.server_pid.load(Ordering::SeqCst) {
            0 => None,
            pid => Some(pid),
        }
    }
}

fn restarting(peer: &str) -> anyhow::Error {
    anyhow::anyhow!("{peer} is restarting — try again in a moment")
}

fn stopped() -> anyhow::Error {
    anyhow::anyhow!("the command worker stopped before it answered")
}

/// A queued request's answer.
pub struct Reply(oneshot::Receiver<anyhow::Result<Response>>);

impl Reply {
    /// Waits for the answer on this thread.
    pub fn wait(self) -> anyhow::Result<Response> {
        let answer = self.0;
        let recv = move || answer.blocking_recv();
        // `blocking_recv` panics on a thread that is running async tasks.
        // Every caller today is a plain thread, the blocking pool or a
        // sync command, but one inside an async fn would otherwise take
        // its whole task down instead of merely occupying the worker.
        let got = if tokio::runtime::Handle::try_current().is_ok() {
            tokio::task::block_in_place(recv)
        } else {
            recv()
        };
        got.unwrap_or_else(|_| Err(stopped()))
    }
}

impl Future for Reply {
    type Output = anyhow::Result<Response>;

    fn poll(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        Pin::new(&mut self.0).poll(cx).map(|got| got.unwrap_or_else(|_| Err(stopped())))
    }
}

/// One daemon as a command sees it: the lane each request rides and the
/// verdict every request is gated against.
#[derive(Clone)]
pub struct DaemonLanes {
    main: CommandLane,
    /// Where the slow reads go (`is_slow_read`). The main lane itself on
    /// a daemon with only one connection.
    reads: CommandLane,
    compat: DaemonCompat,
}

impl DaemonLanes {
    pub fn new(main: CommandLane, reads: CommandLane, compat: DaemonCompat) -> DaemonLanes {
        DaemonLanes { main, reads, compat }
    }

    /// A daemon reached over one connection: an ssh link.
    pub fn single(lane: CommandLane, compat: DaemonCompat) -> DaemonLanes {
        DaemonLanes { reads: lane.clone(), main: lane, compat }
    }

    pub fn compat(&self) -> &DaemonCompat {
        &self.compat
    }

    pub fn submit(&self, req: Request) -> anyhow::Result<Reply> {
        if runs_apart(&req) {
            return self.main.submit_apart(&self.compat, req);
        }
        let lane = if is_slow_read(&req) { &self.reads } else { &self.main };
        lane.submit(&self.compat, req)
    }

    /// Enqueues `req` and awaits its reply. The whole of a command's
    /// daemon round trip, off the main thread: the enqueue happens on the
    /// first poll, and the wait is the worker's.
    pub async fn request(&self, req: Request) -> anyhow::Result<Response> {
        self.submit(req)?.await
    }

    /// `request` for a synchronous caller that is already off the main
    /// thread.
    pub fn ask(&self, req: Request) -> anyhow::Result<Response> {
        self.submit(req)?.wait()
    }
}

/// The same question put to several daemons at once, each answer waited
/// for for at most `budget`: what `remote::ask_every_link` runs for the
/// reads that span every ssh host.
///
/// Every ask starts here, before the caller awaits anything -- so the
/// hosts are asked side by side, and alongside whatever the caller asks
/// the local daemon meanwhile. An ask that misses its budget is dropped,
/// and with it any request it still had queued: withdrawn, never sent
/// (`CommandLane::submit`).
pub fn ask_each<D, T, Fut>(daemons: Vec<D>, budget: Duration, ask: impl Fn(D) -> Fut) -> Asked<T>
where
    Fut: Future<Output = Result<T, String>> + Send + 'static,
    T: Send + 'static,
{
    let asks = daemons
        .into_iter()
        .map(|daemon| {
            let answer = ask(daemon);
            // The timer is made inside the task: it needs the runtime,
            // which the caller -- a test, a plain thread -- may not be on.
            tauri::async_runtime::spawn(async move { tokio::time::timeout(budget, answer).await })
        })
        .collect();
    Asked(asks)
}

/// `ask_each`'s asks, under way.
pub struct Asked<T>(Vec<tauri::async_runtime::JoinHandle<Result<Result<T, String>, tokio::time::error::Elapsed>>>);

impl<T> Asked<T> {
    /// The answers that came back in time, in the order the daemons were
    /// given. A daemon that failed or missed its budget is left out.
    pub async fn answers(self) -> Vec<T> {
        let mut answers = Vec::with_capacity(self.0.len());
        for asked in self.0 {
            if let Ok(Ok(Ok(answer))) = asked.await {
                answers.push(answer);
            }
        }
        answers
    }
}

struct Worker {
    shared: Arc<Shared>,
    /// `None` once the connection has failed; the next request redials.
    conn: Option<Conn>,
    /// Replies still due on `conn` for requests the lane stopped waiting
    /// for. Only a lane with no redial keeps a connection past a timeout:
    /// the daemon answers every request exactly once and in order, so the
    /// late answers arrive first, and are read off and dropped before
    /// anything else goes out (`settle`).
    owed: usize,
    /// The daemon version the app's compat verdict describes. A redial
    /// that finds a different daemon on the endpoint refuses to send
    /// anything: every request in the queue was gated for this one.
    version: u32,
}

/// A connection as the worker reads it.
struct Conn {
    /// Kept for the connection's life, never rebuilt per request: a
    /// per-request `BufReader` can buffer bytes past the reply it was
    /// made for, and drop them with it.
    reader: BufReader<Stream>,
    /// The start of a reply whose read ran out of time part-way through
    /// the line. The rest of that line is still coming, and only a link's
    /// lane keeps a connection past a timeout -- read on its own, the
    /// rest would not parse, and the link would lose its connection over
    /// an answer that did arrive.
    partial: Vec<u8>,
}

impl Conn {
    fn new(stream: Stream) -> Conn {
        Conn { reader: BufReader::new(stream), partial: Vec::new() }
    }
}

impl Worker {
    fn run(mut self, queue: mpsc::Receiver<Job>) {
        for job in queue {
            match job {
                Job::Swap { stream, version } => {
                    self.shared.server_pid.store(stream.server_pid().unwrap_or(0), Ordering::SeqCst);
                    self.conn = Some(Conn::new(stream));
                    self.owed = 0;
                    self.version = version;
                }
                Job::Ask { req, reply, deadline } => {
                    // Its caller stopped waiting -- a read that spans every
                    // host gave up on this one. Sending it anyway would
                    // only queue more for a host that has stopped
                    // answering, one poll after another.
                    if reply.is_closed() {
                        continue;
                    }
                    let answer = if self.shared.swapping.load(Ordering::SeqCst) {
                        Err(restarting(&self.shared.peer))
                    } else {
                        let deadline = deadline.unwrap_or_else(|| (self.shared.deadline)(&req));
                        self.round_trip(&req, deadline)
                    };
                    let _ = reply.send(answer);
                }
            }
        }
    }

    fn round_trip(&mut self, req: &Request, deadline: Duration) -> anyhow::Result<Response> {
        self.settle()?;
        self.send(req)?;
        let conn = self.conn.as_mut().expect("send leaves a connection behind");
        match read_reply(conn, deadline, &self.shared.peer, req) {
            Ok(resp) => Ok(resp),
            Err(e) if e.is::<TimedOut>() && self.shared.redial.is_none() => {
                // Nothing to redial: an ssh link's connection is its
                // bridge. Keep it, and owe what did not arrive.
                self.owed += 1;
                Err(e)
            }
            Err(e) => {
                // Closed, unparseable, or timed out where a fresh
                // connection is to be had -- a new daemon thread, not
                // one stuck behind the wedged handler. Whatever this
                // connection says next can no longer be matched.
                self.conn = None;
                self.owed = 0;
                Err(e)
            }
        }
    }

    /// Reads off the answers a link still owes before anything else goes
    /// out on it, and refuses the request unsent when they do not come.
    ///
    /// A host that ran past one deadline is busy or stuck, and it serves
    /// its connection strictly in order: a request sent now would wait
    /// behind the late one, for a whole deadline of its own, and every
    /// request queued behind it another -- a Git tab's refresh alone is a
    /// dozen of them. So until the owed answers arrive, each request gets
    /// `OWED_GRACE` for them and is then refused, never written. The lane
    /// recovers by itself: the first request after the host catches up
    /// reads the late answers off and goes out.
    fn settle(&mut self) -> anyhow::Result<()> {
        if self.owed == 0 {
            return Ok(());
        }
        let peer = &self.shared.peer;
        let Some(conn) = self.conn.as_mut() else {
            self.owed = 0;
            return Ok(());
        };
        let _ = conn.reader.get_ref().set_read_timeout(Some(OWED_GRACE));
        while self.owed > 0 {
            match next_reply(conn) {
                Ok(Some(_late)) => self.owed -= 1,
                Ok(None) => {
                    self.conn = None;
                    self.owed = 0;
                    anyhow::bail!("{peer} closed the command connection");
                }
                Err(e) if timed_out(&e) => anyhow::bail!(
                    "{peer} has not yet answered an earlier request that ran out of time, so this one was \
                     not sent"
                ),
                Err(e) => {
                    self.conn = None;
                    self.owed = 0;
                    return Err(e);
                }
            }
        }
        Ok(())
    }

    /// Writes `req`, dialling first if the connection is gone and once
    /// more if the write fails.
    ///
    /// A failed WRITE is the one failure safe to retry: nothing reached
    /// the daemon that it will act on -- a write to a closed Unix socket
    /// fails whole with EPIPE, and the daemon drops a half line at EOF.
    /// A failure after the write is not retried. The daemon may already
    /// have acted, and sending the request again is how a CreateSession
    /// used to become two sessions and an orphaned PTY.
    fn send(&mut self, req: &Request) -> anyhow::Result<()> {
        let fresh = self.conn.is_none();
        if fresh {
            self.redial()?;
        }
        let Err(first) = self.write(req) else { return Ok(()) };
        self.conn = None;
        if fresh {
            return Err(first);
        }
        // The redial's own failure is the one worth reading: a closed
        // socket is only what sent the lane to look.
        self.redial()?;
        let written = self.write(req);
        if written.is_err() {
            self.conn = None;
        }
        written
    }

    fn write(&mut self, req: &Request) -> anyhow::Result<()> {
        let conn = self.conn.as_mut().expect("dialled before writing");
        write_message(conn.reader.get_mut(), req)
    }

    /// Reopens the connection and presents the app again: the version
    /// probe, then a `Hello` with the daemon token. Without the `Hello`
    /// a redialled connection ran as `local`, which loses CreateSession
    /// and EndOrphan the moment `require_local_token` is on.
    fn redial(&mut self) -> anyhow::Result<()> {
        let Some(redial) = &self.shared.redial else {
            anyhow::bail!("the connection to {} is closed — reconnect to it", self.shared.peer);
        };
        let peer = &self.shared.peer;
        let stream = Stream::connect(redial.endpoint.as_path())?;
        let server_pid = stream.server_pid().unwrap_or(0);
        let mut conn = Conn::new(stream);
        write_message(conn.reader.get_mut(), &Request::GetProtocolVersion)?;
        let version = match read_reply(&mut conn, HANDSHAKE_DEADLINE, peer, &Request::GetProtocolVersion)? {
            Response::ProtocolVersion { version } => version,
            other => anyhow::bail!("{peer} answered the version probe with {other:?}"),
        };
        if version != self.version {
            anyhow::bail!(
                "{peer} was restarted as v{version}, and this app connected to v{} — restart the \
                 daemon to reconnect",
                self.version
            );
        }
        if version >= crate::session::HELLO_MIN_VERSION {
            if let Some(token) = (redial.token)() {
                let nonce = protocol::random_hex(16)?;
                let hello = crate::session::app_hello(&token, &nonce, protocol::ConnectionKind::Command);
                write_message(conn.reader.get_mut(), &hello)?;
                let ack = read_reply(&mut conn, HANDSHAKE_DEADLINE, peer, &hello)?;
                crate::session::verify_app_ack(ack, &token, &nonce)?;
            }
        }
        self.shared.server_pid.store(server_pid, Ordering::SeqCst);
        self.conn = Some(conn);
        self.owed = 0;
        Ok(())
    }
}

/// A read that ran out its deadline, as distinct from one that failed.
#[derive(Debug)]
struct TimedOut(String);

impl std::fmt::Display for TimedOut {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for TimedOut {}

/// Reads the reply to `req`, skipping unsolicited pushes, for at most
/// `deadline` per read.
fn read_reply(conn: &mut Conn, deadline: Duration, peer: &str, req: &Request) -> anyhow::Result<Response> {
    // Ignored on failure, deliberately. The one way it fails is macOS
    // refusing SO_RCVTIMEO on a socket whose peer has already closed
    // (EINVAL) -- and the answer may still be sitting unread in the
    // buffer: a daemon that replies and then exits did answer. A read on
    // such a socket cannot block either way; it returns what is there,
    // then EOF.
    let _ = conn.reader.get_ref().set_read_timeout(Some(deadline));
    match next_reply(conn) {
        Ok(Some(resp)) => Ok(resp),
        Ok(None) => anyhow::bail!("{peer} closed the command connection before answering {}", name_of(req)),
        Err(e) if timed_out(&e) => {
            Err(TimedOut(format!("{peer} did not answer {} within {deadline:?}", name_of(req))).into())
        }
        Err(e) => Err(e),
    }
}

/// The next reply on `conn`, skipping unsolicited pushes; `None` at end
/// of stream.
///
/// `protocol::read_message`, except that a read failing part-way through
/// a line -- a timeout, most often -- leaves what it read in
/// `conn.partial`, where the next call picks the line up again.
/// `read_until` appends what it consumed before an error, so nothing
/// read is lost.
fn next_reply(conn: &mut Conn) -> anyhow::Result<Option<Response>> {
    loop {
        let room = MAX_LINE_BYTES.saturating_sub(conn.partial.len() as u64);
        (&mut conn.reader).take(room).read_until(b'\n', &mut conn.partial)?;
        if !conn.partial.ends_with(b"\n") {
            if conn.partial.len() as u64 >= MAX_LINE_BYTES {
                anyhow::bail!("protocol line exceeded {MAX_LINE_BYTES} bytes without a newline");
            }
            // End of stream, before a line or part-way through one.
            return Ok(None);
        }
        let line = std::mem::take(&mut conn.partial);
        let resp: Response = serde_json::from_slice(&line)?;
        if !is_unsolicited(&resp) {
            return Ok(Some(resp));
        }
    }
}

/// A read that hit its deadline: EAGAIN from a socket's SO_RCVTIMEO, and
/// the transport's pipe poll reports the same.
pub(crate) fn timed_out(e: &anyhow::Error) -> bool {
    e.downcast_ref::<std::io::Error>()
        .is_some_and(|e| matches!(e.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut))
}

/// The request's variant name, for an error message. Debug-formatted
/// only on the way to an error, never per request.
fn name_of(req: &Request) -> String {
    let debug = format!("{req:?}");
    debug.split(|c: char| !c.is_alphanumeric()).next().unwrap_or_default().to_string()
}


#[cfg(test)]
mod tests {
    use super::*;
    use protocol::read_message;
    use protocol::transport::Listener;
    use std::io::Write;
    use std::sync::Mutex;
    use std::time::Instant;

    fn compat(version: u32) -> DaemonCompat {
        DaemonCompat { daemon_version: version, app_version: protocol::PROTOCOL_VERSION, degraded: false }
    }

    fn parity() -> DaemonCompat {
        compat(protocol::PROTOCOL_VERSION)
    }

    /// Long enough for any test daemon that DOES answer, short enough to
    /// wait out the one that does not.
    fn short(_: &Request) -> Duration {
        Duration::from_millis(300)
    }

    /// A lane over a pair whose far end the test plays the daemon on.
    fn lane_and_daemon() -> (CommandLane, Stream) {
        let (app, daemon) = Stream::pair().unwrap();
        (CommandLane::spawn_with("the test daemon", app, protocol::PROTOCOL_VERSION, None, short), daemon)
    }

    fn kill(id: usize) -> Request {
        Request::KillSession { id: format!("s-{id}") }
    }

    fn id_of(req: &Request) -> String {
        match req {
            Request::KillSession { id } => id.clone(),
            other => panic!("expected KillSession, got {other:?}"),
        }
    }

    fn message(resp: Response) -> String {
        match resp {
            Response::Error { message } => message,
            other => panic!("expected Error, got {other:?}"),
        }
    }

    fn next(reader: &mut BufReader<Stream>) -> Option<Request> {
        read_message(reader).unwrap()
    }

    /// Answers each request with an Error naming the id it carried -- so
    /// a reply that crossed to the wrong caller shows -- and records the
    /// order the requests arrived in.
    fn echo_daemon(daemon: Stream, count: usize) -> std::thread::JoinHandle<Vec<String>> {
        std::thread::spawn(move || {
            let mut reader = BufReader::new(daemon.try_clone().unwrap());
            let mut seen = Vec::new();
            for _ in 0..count {
                let id = id_of(&next(&mut reader).unwrap());
                write_message(&mut &daemon, &Response::Error { message: id.clone() }).unwrap();
                seen.push(id);
            }
            seen
        })
    }

    /// Holds a connection open, reading and never answering, until the
    /// app side goes away. Returns how many requests it swallowed.
    fn never_answer(daemon: Stream) -> std::thread::JoinHandle<usize> {
        std::thread::spawn(move || {
            let mut reader = BufReader::new(daemon);
            let mut swallowed = 0;
            while let Ok(Some(_)) = read_message::<_, Request>(&mut reader) {
                swallowed += 1;
            }
            swallowed
        })
    }

    /// The property the card rests on: requests from many threads reach
    /// the daemon in the order they were enqueued, and each caller gets
    /// its own reply. The enqueue order is recorded under the lock the
    /// enqueue happens in, so it is known exactly although the threads
    /// race for it.
    #[test]
    fn requests_from_many_threads_reach_the_daemon_in_enqueue_order() {
        const N: usize = 64;
        let (lane, daemon) = lane_and_daemon();
        let arrived = echo_daemon(daemon, N);
        let enqueued = Arc::new(Mutex::new(Vec::new()));
        let callers: Vec<_> = (0..N)
            .map(|i| {
                let lane = lane.clone();
                let enqueued = Arc::clone(&enqueued);
                std::thread::spawn(move || {
                    let reply = {
                        let mut order = enqueued.lock().unwrap();
                        let reply = lane.submit(&parity(), kill(i)).unwrap();
                        order.push(format!("s-{i}"));
                        reply
                    };
                    assert_eq!(message(reply.wait().unwrap()), format!("s-{i}"), "a reply crossed callers");
                })
            })
            .collect();
        for caller in callers {
            caller.join().unwrap();
        }
        assert_eq!(arrived.join().unwrap(), *enqueued.lock().unwrap());
    }

    /// The async half, which is how every command waits: replies awaited
    /// on the runtime, polled in whatever order it likes, still leave in
    /// enqueue order and still reach their own callers.
    #[test]
    fn awaited_requests_keep_enqueue_order() {
        const N: usize = 16;
        let (lane, daemon) = lane_and_daemon();
        let arrived = echo_daemon(daemon, N);
        let lanes = DaemonLanes::single(lane, parity());
        let replies: Vec<Reply> = (0..N).map(|i| lanes.submit(kill(i)).unwrap()).collect();
        let answers = tauri::async_runtime::block_on(async move {
            let tasks: Vec<_> = replies.into_iter().map(tauri::async_runtime::spawn).collect();
            let mut answers = Vec::new();
            for task in tasks {
                answers.push(message(task.await.unwrap().unwrap()));
            }
            answers
        });
        let expected: Vec<String> = (0..N).map(|i| format!("s-{i}")).collect();
        assert_eq!(answers, expected);
        assert_eq!(arrived.join().unwrap(), expected);
    }

    /// A handler that never answers costs its caller the deadline and
    /// nothing more: the request fails, and the one behind it is not
    /// stuck behind it -- on a link, which cannot redial, it is refused
    /// at once and never sent to the host that is not answering.
    #[test]
    fn a_wedged_daemon_times_out_instead_of_blocking() {
        let (lane, daemon) = lane_and_daemon();
        let wedged = never_answer(daemon);

        let start = Instant::now();
        let err = lane.ask(&parity(), kill(1)).unwrap_err().to_string();
        assert!(err.contains("did not answer KillSession"), "{err}");
        assert!(start.elapsed() < Duration::from_secs(5), "the deadline did not end the wait");

        let start = Instant::now();
        let err = lane.ask(&parity(), kill(2)).unwrap_err().to_string();
        assert!(err.contains("not sent"), "{err}");
        assert!(start.elapsed() < short(&kill(2)) * 3, "the second request waited a deadline of its own");
        drop(lane);
        assert_eq!(wedged.join().unwrap(), 1, "the request behind the wedged one was sent");
    }

    /// The fake daemon for the owed-answer tests: reads a request, holds
    /// its answer until the test says `go`, and says when the answer is
    /// out -- whole, or split around the hold so the lane's read times out
    /// part-way through the line. Answers everything after that at once.
    /// Returns the ids it was sent, once the app side goes away.
    struct LateDaemon {
        go: mpsc::Sender<()>,
        answered: mpsc::Receiver<()>,
        seen: std::thread::JoinHandle<Vec<String>>,
    }

    impl LateDaemon {
        fn start(daemon: Stream, split: bool) -> LateDaemon {
            let (go, hold) = mpsc::channel();
            let (out, answered) = mpsc::channel();
            let seen = std::thread::spawn(move || {
                let mut reader = BufReader::new(daemon.try_clone().unwrap());
                let first = id_of(&next(&mut reader).unwrap());
                let mut line = serde_json::to_vec(&Response::Error { message: first.clone() }).unwrap();
                line.push(b'\n');
                let cut = if split { line.len() / 2 } else { 0 };
                (&daemon).write_all(&line[..cut]).unwrap();
                hold.recv().unwrap();
                (&daemon).write_all(&line[cut..]).unwrap();
                out.send(()).unwrap();
                let mut seen = vec![first];
                while let Ok(Some(req)) = read_message::<_, Request>(&mut reader) {
                    let id = id_of(&req);
                    write_message(&mut &daemon, &Response::Error { message: id.clone() }).unwrap();
                    seen.push(id);
                }
                seen
            });
            LateDaemon { go, answered, seen }
        }

        /// Lets the held answer go, and returns once it is on the wire.
        fn release(&self) {
            self.go.send(()).unwrap();
            self.answered.recv().unwrap();
        }
    }

    fn ids(ids: &[usize]) -> Vec<String> {
        ids.iter().map(|i| format!("s-{i}")).collect()
    }

    /// While a link owes a late answer, a new request is refused unsent;
    /// once the answer arrives the lane reads it off and carries on,
    /// with nobody handed an answer meant for someone else.
    #[test]
    fn a_link_that_owes_an_answer_refuses_new_requests_until_it_arrives() {
        let (lane, daemon) = lane_and_daemon();
        let daemon = LateDaemon::start(daemon, false);

        assert!(lane.ask(&parity(), kill(1)).unwrap_err().is::<TimedOut>());
        let err = lane.ask(&parity(), kill(2)).unwrap_err().to_string();
        assert!(err.contains("not sent"), "{err}");

        daemon.release();
        assert_eq!(message(lane.ask(&parity(), kill(3)).unwrap()), "s-3");
        drop(lane);
        assert_eq!(daemon.seen.join().unwrap(), ids(&[1, 3]));
    }

    /// A read that times out part-way through a reply keeps what it read.
    /// The late answer is still one line when the rest arrives -- read on
    /// its own, the rest would not parse, and the link would lose its
    /// connection over an answer that did come.
    #[test]
    fn a_reply_cut_by_a_timeout_is_finished_by_the_next_read() {
        let (lane, daemon) = lane_and_daemon();
        let daemon = LateDaemon::start(daemon, true);

        assert!(lane.ask(&parity(), kill(1)).unwrap_err().is::<TimedOut>());
        daemon.release();
        assert_eq!(message(lane.ask(&parity(), kill(2)).unwrap()), "s-2");
        drop(lane);
        assert_eq!(daemon.seen.join().unwrap(), ids(&[1, 2]));
    }

    /// Room for a test daemon that answers only when told to.
    fn roomy_lane() -> (CommandLane, Stream) {
        let (app, daemon) = Stream::pair().unwrap();
        (CommandLane::spawn_with("the test daemon", app, protocol::PROTOCOL_VERSION, None, roomy), daemon)
    }

    /// A caller that stopped waiting withdraws its request: the worker
    /// skips it rather than send it to a daemon nobody is listening to.
    #[test]
    fn a_request_whose_caller_gave_up_is_never_sent() {
        let (lane, daemon) = roomy_lane();
        let daemon = LateDaemon::start(daemon, false);

        let first = lane.submit(&parity(), kill(1)).unwrap();
        drop(lane.submit(&parity(), kill(2)).unwrap());
        let third = lane.submit(&parity(), kill(3)).unwrap();
        daemon.release();
        assert_eq!(message(first.wait().unwrap()), "s-1");
        assert_eq!(message(third.wait().unwrap()), "s-3");
        drop(lane);
        assert_eq!(daemon.seen.join().unwrap(), ids(&[1, 3]));
    }

    /// Answers every request with `name`, so a test can tell which daemon
    /// an answer came from.
    fn answer_as(daemon: Stream, name: &'static str) {
        std::thread::spawn(move || {
            let mut reader = BufReader::new(daemon.try_clone().unwrap());
            while let Ok(Some(_)) = read_message::<_, Request>(&mut reader) {
                if write_message(&mut &daemon, &Response::Error { message: name.to_string() }).is_err() {
                    break;
                }
            }
        });
    }

    /// The reads that span every host ask them side by side, and one host
    /// that does not answer costs the read its budget, not the lane's
    /// deadline -- and not its place in the answer for the hosts that did.
    /// What the stuck host was still to be sent is withdrawn with the ask.
    #[test]
    fn ask_each_keeps_the_answers_that_came_within_the_budget() {
        const BUDGET: Duration = Duration::from_millis(500);
        fn two_seconds(_: &Request) -> Duration {
            Duration::from_secs(2)
        }
        let lane = |name: Option<&'static str>| {
            let (app, daemon) = Stream::pair().unwrap();
            let wedged = match name {
                Some(name) => {
                    answer_as(daemon, name);
                    None
                }
                None => Some(never_answer(daemon)),
            };
            let lane = CommandLane::spawn_with("the test daemon", app, protocol::PROTOCOL_VERSION, None, two_seconds);
            (DaemonLanes::single(lane, parity()), wedged)
        };
        let (a, _) = lane(Some("a"));
        let (stuck, wedged) = lane(None);
        let (c, _) = lane(Some("c"));
        let ask = |lanes: DaemonLanes| async move {
            // Two requests, one after the other, like `managed_sessions_on`:
            // the stuck host is never sent the second.
            lanes.request(kill(1)).await.map_err(|e| e.to_string())?;
            lanes.request(kill(2)).await.map(message).map_err(|e| e.to_string())
        };

        let start = Instant::now();
        let answers =
            tauri::async_runtime::block_on(ask_each(vec![a, stuck.clone(), c], BUDGET, ask).answers());
        let took = start.elapsed();
        assert_eq!(answers, vec!["a".to_string(), "c".to_string()]);
        assert!(took >= BUDGET && took < two_seconds(&kill(1)), "the read took {took:?}");

        // A second round, while the stuck host's lane is still waiting out
        // the first: its ask is withdrawn before it is sent.
        let answers = tauri::async_runtime::block_on(ask_each(vec![stuck], BUDGET, ask).answers());
        assert!(answers.is_empty());
        assert_eq!(wedged.unwrap().join().unwrap(), 1, "a withdrawn ask reached the stuck host");
    }

    /// An ssh link's lane cannot redial -- its connection is the bridge --
    /// so a timeout keeps the connection and owes the answer. When the
    /// late answer arrives it is dropped, and the next caller gets its
    /// own, not the one meant for the caller before it.
    #[test]
    fn a_lane_with_no_redial_drops_a_late_answer_and_stays_usable() {
        let (lane, daemon) = lane_and_daemon();
        let (late_sent, late) = mpsc::channel::<()>();
        let slow = std::thread::spawn(move || {
            let mut reader = BufReader::new(daemon.try_clone().unwrap());
            let first = id_of(&next(&mut reader).unwrap());
            // Past the lane's deadline, then the first answer after all.
            late.recv().unwrap();
            write_message(&mut &daemon, &Response::Error { message: first }).unwrap();
            let second = id_of(&next(&mut reader).unwrap());
            write_message(&mut &daemon, &Response::Error { message: second }).unwrap();
        });

        assert!(lane.ask(&parity(), kill(1)).unwrap_err().is::<TimedOut>());
        late_sent.send(()).unwrap();
        assert_eq!(message(lane.ask(&parity(), kill(2)).unwrap()), "s-2", "the late answer was taken for the next");
        slow.join().unwrap();
    }

    /// The fake daemon's side of a redial: accept, answer the version
    /// probe with `version`, then take a `Hello` if one comes and answer
    /// it with a proof for `token`. Returns the connection and the Hello.
    fn accept_redial(
        listener: &Listener,
        version: u32,
        token: Option<&str>,
    ) -> (Stream, BufReader<Stream>, Option<Request>) {
        let conn = listener.accept().unwrap();
        let mut reader = BufReader::new(conn.try_clone().unwrap());
        let probe = next(&mut reader).unwrap();
        assert!(matches!(probe, Request::GetProtocolVersion), "{probe:?}");
        write_message(&mut &conn, &Response::ProtocolVersion { version }).unwrap();
        let Some(token) = token else { return (conn, reader, None) };
        let hello = next(&mut reader).unwrap();
        let Request::Hello { nonce, .. } = &hello else { panic!("expected Hello, got {hello:?}") };
        write_message(
            &mut &conn,
            &Response::HelloAck {
                role: "app".to_string(),
                daemon_version: version,
                session_id: None,
                server_proof: Some(protocol::server_proof(token, nonce)),
                workspace_root: None,
            },
        )
        .unwrap();
        (conn, reader, Some(hello))
    }

    fn redial_to(sock: &std::path::Path, token: fn() -> Option<String>) -> Option<Redial> {
        Some(Redial { endpoint: sock.to_path_buf(), token })
    }

    /// The task manager's daemon line reads which process serves the
    /// app off the lane: the kernel's answer for the socket the lane
    /// dialled, and none for a stream that dialled nothing.
    #[test]
    fn a_lane_names_the_process_serving_its_connection() {
        let dir = tempfile::tempdir().unwrap();
        let sock = dir.path().join("pid.sock");
        let listener = Listener::bind(&sock).unwrap();
        let dialled = Stream::connect(&sock).unwrap();
        let _served = listener.accept().unwrap();
        let lane = CommandLane::spawn_with("the test daemon", dialled, 12, None, short);
        assert_eq!(lane.server_pid(), Some(std::process::id()));

        let (paired, _daemon) = lane_and_daemon();
        assert_eq!(paired.server_pid(), None);
    }

    /// After a timeout the next request goes out on a fresh connection --
    /// the wedged one is left to the daemon, not re-read.
    #[test]
    fn the_request_after_a_timeout_goes_out_on_a_redialled_connection() {
        let dir = tempfile::tempdir().unwrap();
        let sock = dir.path().join("wedge.sock");
        let listener = Listener::bind(&sock).unwrap();
        let first = Stream::connect(&sock).unwrap();
        let wedged = never_answer(listener.accept().unwrap());

        let daemon = std::thread::spawn(move || {
            let (conn, mut reader, _) = accept_redial(&listener, 12, None);
            let req = next(&mut reader).unwrap();
            write_message(&mut &conn, &Response::Error { message: id_of(&req) }).unwrap();
        });

        let lane = CommandLane::spawn_with("the test daemon", first, 12, redial_to(&sock, || None), short);
        assert!(lane.ask(&compat(12), kill(1)).is_err());
        assert_eq!(message(lane.ask(&compat(12), kill(2)).unwrap()), "s-2");
        daemon.join().unwrap();
        drop(lane);
        assert_eq!(wedged.join().unwrap(), 1);
    }

    /// A redialled connection presents the app again. It used to come
    /// back without a `Hello`, as `local` -- which loses CreateSession and
    /// EndOrphan the moment `require_local_token` is on.
    #[test]
    fn a_redial_says_hello_with_the_daemon_token() {
        let dir = tempfile::tempdir().unwrap();
        let sock = dir.path().join("hello.sock");
        let listener = Listener::bind(&sock).unwrap();
        let first = Stream::connect(&sock).unwrap();
        // The daemon restarts before the app's first request: the first
        // connection is simply gone.
        drop(listener.accept().unwrap());

        let daemon = std::thread::spawn(move || {
            let (conn, mut reader, hello) = accept_redial(&listener, protocol::PROTOCOL_VERSION, Some("t0k3n"));
            let req = next(&mut reader).unwrap();
            write_message(&mut &conn, &Response::Error { message: id_of(&req) }).unwrap();
            hello
        });

        let lane = CommandLane::spawn_with(
            "the test daemon",
            first,
            protocol::PROTOCOL_VERSION,
            redial_to(&sock, || Some("t0k3n".to_string())),
            short,
        );
        assert_eq!(message(lane.ask(&parity(), kill(7)).unwrap()), "s-7");
        match daemon.join().unwrap() {
            Some(Request::Hello { client, auth, connection, .. }) => {
                assert_eq!(client, "app");
                // A lane is a command connection, and says so: the daemon
                // sends the device pushes only to one that reads them.
                assert_eq!(connection, Some(protocol::ConnectionKind::Command));
                assert!(
                    matches!(&auth, protocol::HelloAuth::DaemonToken { token } if token == "t0k3n"),
                    "{auth:?}"
                );
            }
            other => panic!("the redial sent no Hello: {other:?}"),
        }
    }

    /// A daemon that answers with the wrong proof is not the daemon: the
    /// request is refused rather than sent (DP-06, on the redial path).
    #[test]
    fn a_redial_refuses_a_daemon_whose_proof_does_not_match() {
        let dir = tempfile::tempdir().unwrap();
        let sock = dir.path().join("proof.sock");
        let listener = Listener::bind(&sock).unwrap();
        let first = Stream::connect(&sock).unwrap();
        drop(listener.accept().unwrap());

        let daemon = std::thread::spawn(move || {
            let (_conn, mut reader, _) = accept_redial(&listener, protocol::PROTOCOL_VERSION, Some("other"));
            next(&mut reader)
        });
        let lane = CommandLane::spawn_with(
            "the test daemon",
            first,
            protocol::PROTOCOL_VERSION,
            redial_to(&sock, || Some("t0k3n".to_string())),
            short,
        );
        let err = lane.ask(&parity(), kill(1)).unwrap_err().to_string();
        assert!(err.contains("proof"), "{err}");
        drop(lane);
        assert!(daemon.join().unwrap().is_none(), "the request reached a daemon that failed the proof");
    }

    /// Every request in the queue was gated against one daemon version.
    /// A redial that finds another sends nothing but the probe.
    #[test]
    fn a_redial_to_a_different_daemon_version_sends_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let sock = dir.path().join("version.sock");
        let listener = Listener::bind(&sock).unwrap();
        let first = Stream::connect(&sock).unwrap();
        drop(listener.accept().unwrap());

        let daemon = std::thread::spawn(move || {
            let (_conn, mut reader, _) = accept_redial(&listener, 11, None);
            next(&mut reader)
        });
        let lane = CommandLane::spawn_with("the test daemon", first, 12, redial_to(&sock, || None), short);
        let err = lane.ask(&compat(12), kill(1)).unwrap_err().to_string();
        assert!(err.contains("v11") && err.contains("v12"), "{err}");
        drop(lane);
        assert!(daemon.join().unwrap().is_none(), "a request reached the other daemon");
    }

    /// Once the request is written, a failure is NOT retried: the daemon
    /// may already have acted on it. This is what used to turn one
    /// CreateSession into two sessions and an orphaned PTY.
    #[test]
    fn a_request_the_daemon_read_is_never_sent_twice() {
        let dir = tempfile::tempdir().unwrap();
        let sock = dir.path().join("once.sock");
        let listener = Listener::bind(&sock).unwrap();
        let first = Stream::connect(&sock).unwrap();

        let daemon = std::thread::spawn(move || {
            // Reads the request, then dies before answering.
            let conn = listener.accept().unwrap();
            let mut reader = BufReader::new(conn.try_clone().unwrap());
            let got = next(&mut reader).unwrap();
            drop(reader);
            drop(conn);
            // Whatever comes next is a new connection; count its requests.
            let (conn, mut reader, _) = accept_redial(&listener, 12, None);
            let after = next(&mut reader).unwrap();
            write_message(&mut &conn, &Response::Error { message: id_of(&after) }).unwrap();
            (got, after)
        });
        let lane = CommandLane::spawn_with("the test daemon", first, 12, redial_to(&sock, || None), short);
        let err = lane.ask(&compat(12), kill(1)).unwrap_err().to_string();
        assert!(err.contains("closed the command connection"), "{err}");
        assert_eq!(message(lane.ask(&compat(12), kill(2)).unwrap()), "s-2");
        let (got, after) = daemon.join().unwrap();
        assert_eq!(id_of(&got), "s-1");
        assert_eq!(id_of(&after), "s-2", "the first request was sent again");
    }

    /// While a restart swaps the connection, a request fails at once
    /// instead of riding a socket to a daemon that is being killed. After
    /// the swap, requests go to the new connection.
    #[test]
    fn a_lane_fails_fast_while_swapping_and_moves_to_the_new_connection() {
        let (lane, old) = lane_and_daemon();
        let old = never_answer(old);
        lane.begin_swap();
        let err = lane.submit(&parity(), kill(1)).err().expect("a request was queued mid-restart");
        assert!(err.to_string().contains("restarting"), "{err}");

        let (app, daemon) = Stream::pair().unwrap();
        let arrived = echo_daemon(daemon, 1);
        lane.finish_swap(app, protocol::PROTOCOL_VERSION);
        assert_eq!(message(lane.ask(&parity(), kill(2)).unwrap()), "s-2");
        assert_eq!(arrived.join().unwrap(), vec!["s-2".to_string()]);
        drop(lane);
        assert_eq!(old.join().unwrap(), 0, "the dying daemon was sent a request");
    }

    /// A request already queued when the restart began is refused by the
    /// worker too, not sent to the dying daemon.
    #[test]
    fn a_request_queued_before_the_swap_is_refused_rather_than_sent() {
        let (lane, old) = lane_and_daemon();
        let old = never_answer(old);
        // The first occupies the worker for its whole deadline -- the
        // daemon never answers -- so the second waits in the queue.
        let first = lane.submit(&parity(), kill(1)).unwrap();
        let queued = lane.submit(&parity(), kill(2)).unwrap();
        lane.begin_swap();
        // The first was on the wire already or is refused; either way it
        // fails. The second must be refused without being sent.
        assert!(first.wait().is_err());
        let err = queued.wait().unwrap_err().to_string();
        assert!(err.contains("restarting"), "{err}");
        lane.abort_swap();
        drop(lane);
        assert!(old.join().unwrap() <= 1, "a request queued before the restart reached the daemon");
    }

    /// A device push arriving where a reply is expected is skipped, not
    /// taken for the reply -- which would hand every later caller the
    /// answer meant for the one before it.
    #[test]
    fn an_unsolicited_device_push_is_not_taken_for_the_reply() {
        let (lane, daemon) = lane_and_daemon();
        let fake = std::thread::spawn(move || {
            let mut reader = BufReader::new(daemon.try_clone().unwrap());
            for _ in 0..2 {
                let id = id_of(&next(&mut reader).unwrap());
                write_message(&mut &daemon, &Response::DeviceConnected { device_id: "phone".into() }).unwrap();
                write_message(&mut &daemon, &Response::Error { message: id }).unwrap();
            }
        });
        assert_eq!(message(lane.ask(&parity(), kill(1)).unwrap()), "s-1");
        assert_eq!(message(lane.ask(&parity(), kill(2)).unwrap()), "s-2");
        fake.join().unwrap();
    }

    /// Every push the daemon broadcasts to `app` connections must be one
    /// `is_unsolicited` knows, or a new broadcast would desync the lane.
    /// Read from the daemon's own source, since the list lives there.
    #[test]
    fn every_push_the_daemon_sends_to_apps_is_skipped() {
        const SERVER: &str = include_str!("../../../crates/daemon/src/server.rs");
        let mut pushed = 0;
        for (at, _) in SERVER.match_indices("push_to_apps(&Response::") {
            let name: String = SERVER[at + "push_to_apps(&Response::".len()..]
                .chars()
                .take_while(|c| c.is_alphanumeric())
                .collect();
            let skipped = matches!(
                name.as_str(),
                "DevicePairingRequested"
                    | "DeviceConnected"
                    | "DeviceDisconnected"
                    | "RelayStateChanged"
            );
            assert!(skipped, "the daemon pushes {name} to app connections; is_unsolicited must skip it");
            pushed += 1;
        }
        assert!(pushed >= 3, "found only {pushed} push_to_apps calls -- did the daemon's spelling change?");
    }

    /// A request routed by `is_slow_read` goes to the reads lane, and
    /// nothing else does -- so a tree rescan cannot hold a write.
    #[test]
    fn slow_reads_ride_their_own_lane() {
        let (main, main_daemon) = lane_and_daemon();
        let (reads, reads_daemon) = lane_and_daemon();
        let lanes = DaemonLanes::new(main, reads, parity());
        let wedged_reads = never_answer(reads_daemon);
        let main_arrived = echo_daemon(main_daemon, 1);

        let tree = lanes.submit(Request::GetGavinTree { workspace_id: "w".into() }).unwrap();
        // The tree read is wedged on its own connection; the write behind
        // it on the main lane is answered regardless.
        assert_eq!(message(lanes.ask(kill(3)).unwrap()), "s-3");
        assert!(tree.wait().is_err());
        assert_eq!(main_arrived.join().unwrap(), vec!["s-3".to_string()]);
        drop(lanes);
        assert_eq!(wedged_reads.join().unwrap(), 1);
    }

    /// The Headroom requests that block on HTTP or a child process ride
    /// the reads lane; a write does not.
    #[test]
    fn headroom_reads_are_slow_reads() {
        assert!(is_slow_read(&Request::GetHeadroomStatus));
        assert!(is_slow_read(&Request::DetectHeadroom { located_path: None }));
        assert!(is_slow_read(&Request::HeadroomReach { session_id: "s".into() }));
        assert!(!is_slow_read(&Request::StartHeadroom));
        assert!(!is_slow_read(&kill(1)));
    }

    /// Room for a test daemon that holds its answer on purpose.
    fn roomy(_: &Request) -> Duration {
        Duration::from_secs(5)
    }

    /// A daemon on `listener` that serves every connection on a thread of
    /// its own, as `server::serve` does: it answers a version probe, holds
    /// an EndOrphan for `hold` -- an orphan refusing SIGTERM, waited out --
    /// and answers anything else at once. Counts the connections dialled
    /// for a request -- the ones that open with the probe -- which leaves
    /// out the lane's own, handed over already probed.
    fn holding_daemon(listener: Listener, hold: Duration) -> Arc<AtomicU32> {
        let dialled = Arc::new(AtomicU32::new(0));
        let counted = Arc::clone(&dialled);
        std::thread::spawn(move || {
            for conn in listener.incoming() {
                let Ok(conn) = conn else { continue };
                let counted = Arc::clone(&counted);
                std::thread::spawn(move || {
                    let mut reader = BufReader::new(conn.try_clone().unwrap());
                    while let Ok(Some(req)) = read_message::<_, Request>(&mut reader) {
                        let resp = match req {
                            Request::GetProtocolVersion => {
                                counted.fetch_add(1, Ordering::SeqCst);
                                Response::ProtocolVersion { version: protocol::PROTOCOL_VERSION }
                            }
                            Request::EndOrphan { id } => {
                                std::thread::sleep(hold);
                                Response::OrphanEnded { id, ended: false, still_running: true }
                            }
                            other => Response::Error { message: id_of(&other) },
                        };
                        if write_message(&mut &conn, &resp).is_err() {
                            break;
                        }
                    }
                });
            }
        });
        dialled
    }

    /// EndOrphan holds the connection that carries it for the daemon's
    /// whole grace -- 2 s for an orphan that refuses SIGTERM, which is the
    /// usual orphan. On the lane, the close sweep's N of them waited one
    /// after another and every request behind them waited too. Each goes
    /// out on a connection of its own instead.
    #[test]
    fn end_orphans_wait_together_on_connections_of_their_own() {
        const N: u32 = 4;
        const HOLD: Duration = Duration::from_secs(1);
        let dir = tempfile::tempdir().unwrap();
        let sock = dir.path().join("apart.sock");
        let listener = Listener::bind(&sock).unwrap();
        let first = Stream::connect(&sock).unwrap();
        let dialled = holding_daemon(listener, HOLD);
        let lane = CommandLane::spawn_with(
            "the test daemon",
            first,
            protocol::PROTOCOL_VERSION,
            redial_to(&sock, || None),
            roomy,
        );
        let lanes = DaemonLanes::new(lane.clone(), lane, parity());

        let start = Instant::now();
        let ends: Vec<Reply> =
            (0..N).map(|i| lanes.submit(Request::EndOrphan { id: format!("o-{i}") }).unwrap()).collect();
        assert_eq!(message(lanes.ask(kill(1)).unwrap()), "s-1");
        assert!(start.elapsed() < HOLD, "a request on the lane waited behind the EndOrphans");

        for (i, end) in ends.into_iter().enumerate() {
            match end.wait().unwrap() {
                Response::OrphanEnded { id, .. } => assert_eq!(id, format!("o-{i}"), "a reply crossed callers"),
                other => panic!("expected OrphanEnded, got {other:?}"),
            }
        }
        let took = start.elapsed();
        assert!(took < HOLD * 2, "{N} EndOrphans took {took:?}: they waited one after another");
        assert_eq!(dialled.load(Ordering::SeqCst), N, "one connection per EndOrphan");
    }

    /// A connection of its own is still the app's connection: refused
    /// while a restart swaps the daemon, like every request on the lane,
    /// rather than dialled to whichever daemon holds the socket.
    #[test]
    fn an_end_orphan_is_refused_mid_restart_rather_than_dialled() {
        let dir = tempfile::tempdir().unwrap();
        let sock = dir.path().join("swap.sock");
        let listener = Listener::bind(&sock).unwrap();
        let first = Stream::connect(&sock).unwrap();
        let dialled = holding_daemon(listener, Duration::ZERO);
        let lane = CommandLane::spawn_with(
            "the test daemon",
            first,
            protocol::PROTOCOL_VERSION,
            redial_to(&sock, || None),
            roomy,
        );
        lane.begin_swap();
        let lanes = DaemonLanes::new(lane.clone(), lane, parity());
        let err = lanes.submit(Request::EndOrphan { id: "o".into() }).err().expect("dialled mid-restart");
        assert!(err.to_string().contains("restarting"), "{err}");
        assert_eq!(dialled.load(Ordering::SeqCst), 0, "a connection was dialled mid-restart");
    }

    /// An ssh link has one connection, its bridge, and nothing to dial: an
    /// EndOrphan rides it like any other request.
    #[test]
    fn a_lane_with_nothing_to_dial_sends_end_orphan_on_its_own_connection() {
        let (lane, daemon) = lane_and_daemon();
        let fake = std::thread::spawn(move || {
            let mut reader = BufReader::new(daemon.try_clone().unwrap());
            let req = next(&mut reader).unwrap();
            let Request::EndOrphan { id } = req else { panic!("expected EndOrphan, got {req:?}") };
            write_message(&mut &daemon, &Response::OrphanEnded { id, ended: true, still_running: false }).unwrap();
        });
        let lanes = DaemonLanes::single(lane, parity());
        let resp = lanes.ask(Request::EndOrphan { id: "o".into() }).unwrap();
        assert!(matches!(resp, Response::OrphanEnded { ended: true, .. }), "{resp:?}");
        fake.join().unwrap();
    }

    #[test]
    fn a_request_the_daemon_predates_never_reaches_the_wire() {
        let (lane, daemon) = lane_and_daemon();
        let seen = never_answer(daemon);
        let old = DaemonCompat { daemon_version: 9, app_version: 12, degraded: true };
        let too_new = Request::NameSession { session_id: "s-1".into(), name: "x".into(), agent_conversation_id: None };
        let err = lane.submit(&old, too_new).err().expect("a gated request was queued").to_string();
        assert!(err.contains("v10") && err.contains("v9"), "{err}");
        drop(lane);
        assert_eq!(seen.join().unwrap(), 0, "a gated request reached the daemon");
    }

    #[test]
    fn deadlines_sit_above_what_the_slow_handlers_take() {
        assert!(deadline_for(&Request::RunGit {
            root_path: "/r".into(),
            cwd: "/r".into(),
            args: vec![],
            stdin: None
        }) >= Duration::from_secs(600));
        assert!(deadline_for(&Request::EndOrphan { id: "s".into() }) > DEFAULT_DEADLINE);
        assert_eq!(deadline_for(&kill(1)), DEFAULT_DEADLINE);
        assert_eq!(name_of(&kill(1)), "KillSession");
        assert_eq!(name_of(&Request::SessionProcesses), "SessionProcesses");
    }
}
