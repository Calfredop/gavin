//! The daemon's remote transport: the dial to the Relay.
//!
//! `docs/security/05-remote-access.md` §5 settles the shape. The daemon
//! dials OUT to a Relay and holds the connection; a Device dials the same
//! Relay; the Relay matches the two by a rendezvous id and copies bytes.
//! Nothing here listens, so nothing is port-forwarded, and what travels
//! through the Relay is a Noise channel it holds no key for.
//!
//! **The daemon dials, not the app** (§5): the daemon outlives the window,
//! and a Device's whole use is reaching a Workstation whose window is
//! closed.
//!
//! **Only while remote access is on.** One thread, started by `serve`,
//! reads the trust store and does what it says. With the switch off, or
//! with no Relay URL, it opens no socket and resolves no name: it sleeps
//! on `Wake` until something changes what it should be doing, and looks
//! at the store again every couple of seconds in case the daemon that
//! changed it was not this one. That the
//! off state dials nothing is asserted against the real binary
//! (`tests/device_wire.rs`), and the way it is kept true is that the only
//! call to `client::dial` for the Relay connection is behind `desired`
//! returning something.
//!
//! **What it serves.** Two kinds of stream, told apart by the purpose
//! the Relay announces them for.
//!
//! - A **pairing** stream is handed to the pairing responder phase 2
//!   built (`pair_over`), and held open until the desk has ruled.
//! - A **connection** is a paired Device's: Noise `IK`, then the
//!   Device's hardware signature over the handshake (`connect.rs`, ADR
//!   0001). Once that verifies the connection is the manager's
//!   (`SessionManager::adopt_device`), which serves it as the Remote
//!   role with the loop the local socket's connections run. What is left
//!   for this module is to carry bytes: frames opened and handed to that
//!   loop, its replies sealed and sent back.
//!
//! A stream announced for any other purpose is left where it is.
//!
//! **What ends a Device's connection.** The Device hanging up; the Relay
//! going; a frame that does not open; remote access being turned off or
//! pointed elsewhere; and the manager letting go of its end -- which is
//! what a revocation, "Revoke all" and a Device removing itself all come
//! to. Each of them ends both halves.

use crate::connect;
use crate::pairing;
use crate::server::{AwaitedPairing, PairingDecision, SessionManager};
use gavin_relay::client::{self, DialError, DialOptions, RelayConnection, RelayStream};
use protocol::device_wire::{ConnectVerdict, PairingVerdict, MAX_PAYLOAD};
use protocol::relay::{self, RefusalReason, RelayHello, RelayReply};
use protocol::RelayState;
use protocol::transport::Stream;
use std::io::{Read, Write};
use std::net::Shutdown;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::collections::VecDeque;
use std::sync::mpsc::{sync_channel, Receiver, SyncSender, TryRecvError, TrySendError};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant, SystemTime};

/// How often the held connection is looked at: whether the Relay said
/// anything, whether the settings changed, whether the machine slept.
/// Also the longest the daemon takes to let go of the Relay once the
/// switch is turned off.
const POLL: Duration = Duration::from_secs(1);

/// How often the Relay is asked whether it is still there.
const KEEPALIVE: Duration = Duration::from_secs(15);

/// How long the Relay may say nothing at all before the connection is
/// taken for dead. Three keepalives: one lost pong is not an outage.
const SILENCE: Duration = Duration::from_secs(45);

/// Wall-clock time that passed with nothing observing it, above which the
/// machine is taken to have slept. The threshold `server.rs`'s suspend
/// watchdog uses, for its reason: a poll that was merely late is not a
/// suspend.
const SLEPT: Duration = Duration::from_secs(10);

/// The first wait after a failed dial, doubling to `BACKOFF_CEILING`.
const BACKOFF_FLOOR: Duration = Duration::from_secs(1);
const BACKOFF_CEILING: Duration = Duration::from_secs(60);

/// How long a connection has to have been held for the next failure to
/// start the backoff over. A Relay that accepts and drops at once is
/// still a Relay that is failing.
const SETTLED: Duration = Duration::from_secs(30);

/// How long a stream that has been picked up has to become what it is
/// for: a pairing the desk can be asked about, or a connection whose
/// proof has verified. The handshake and the proof together, not each
/// read of them -- a peer that sends a byte inside every timeout would
/// otherwise never run out of time (`Within`).
///
/// A Device that has been picked up says its first message at once and
/// each one after as soon as it has read ours; ten seconds is a slow
/// network. What it bounds is how long a peer that is not a Device holds
/// one of the places there are.
const HANDSHAKE: Duration = Duration::from_secs(10);

/// How often the trust store is re-read while nothing has said it
/// changed.
///
/// `Wake` is this process's. The store is not: the dev build's daemon and
/// the release build's share one `devices.sqlite`, so the switch can be
/// turned off, the Relay changed or the key rotated by a daemon that has
/// no way to poke this one. What the human is told -- by either app --
/// is what the store says, so what each daemon does has to follow the
/// store within moments and not at its next restart.
const STORE_POLL: Duration = Duration::from_secs(2);

/// How long the desk has to rule once the handshake is done. The offer's
/// own two minutes gate when a handshake may START; this is the second
/// window, in which the human is comparing six digits.
const DECISION: Duration = Duration::from_secs(2 * 60);

/// How many streams are being let in at once: pairing streams, for as
/// long as a handshake and a human's answer take, and connections until
/// the Device has proved itself. Each is a thread and a socket, and what
/// asks for one is anything the Relay admitted -- so there is a ceiling,
/// and an announcement that arrives above it is left unanswered
/// (`05-remote-access.md` §8, "the remote channel gets its own caps").
/// One desk pairs one Device at a time; the rest is room for a retry.
///
/// This is the ceiling on PAIRINGS. Connections being let in have one
/// of their own, `MAX_CONNECTING`.
const MAX_STREAMS: usize = 4;

/// How many connections are being let in at once: picked up, and not
/// yet proved.
///
/// Apart from the pairings', because what asks for a connection can ask
/// at any time -- anything the Relay admits, with the desk showing
/// nothing -- and must not be able to take the places the owner needs to
/// pair a Device. A connection that has proved itself gives its place
/// back: from then on what bounds it is how many Devices there are and
/// how many connections each may hold
/// (`server::MAX_CONNECTIONS_PER_DEVICE`).
const MAX_CONNECTING: usize = 8;

/// How long what a Device sent may wait on the connection loop before
/// the connection is given up on. The loop reads as fast as requests
/// arrive; one that has not taken what it was handed in this long is
/// one whose replies the Device is not reading.
const UNREAD: Duration = Duration::from_secs(30);

/// How many lines the streams the Relay hands over may write to the
/// log in a minute. Anything the Relay admits can ask for a connection,
/// as often as it likes, and each one that fails is a line.
const LOG_LINES: usize = 12;
const LOG_WINDOW: Duration = Duration::from_secs(60);

/// How long a daemon with no desktop app in front of it waits before it
/// picks a connection up.
///
/// The dev build's daemon and the release build's share one trust store,
/// so both register with the Relay under one key, and the Relay
/// announces a Device's stream to both. Either can serve it -- they hold
/// the same Devices -- but the one the Device came for is the one whose
/// desktop app is running, since that app is what answers it (ADR 0003).
/// So that one goes first. A daemon on its own picks the stream up a
/// moment later all the same: "desktop app not running" is an answer,
/// and a Device is owed it.
const DEFERENCE: Duration = Duration::from_millis(400);

/// How often a connection that is carrying something is looked at, and
/// how often one that is not. The dial is blocking I/O on one socket, so
/// what a reply from the daemon waits on, at the most, is one of these.
const TICK_BUSY: Duration = Duration::from_millis(5);
const TICK_IDLE: Duration = Duration::from_millis(50);

/// How long after it last carried something a connection is still busy.
const RECENT: Duration = Duration::from_secs(2);

/// How much of the daemon's reply is read at a time, and so how much one
/// frame carries: a quarter of what a frame could, so that one large
/// reply does not make every frame after it wait.
const CHUNK: usize = 16 * 1024;

/// How many chunks wait to be carried, each way, before whoever is
/// writing them is made to wait.
const WAITING: usize = 16;

/// Pairings being served right now, and connections being let in,
/// across every connection to the Relay this daemon has held.
static PAIRING: AtomicUsize = AtomicUsize::new(0);
static CONNECTING: AtomicUsize = AtomicUsize::new(0);

/// One of the places there are for what a stream is for, given back
/// however the serving ends.
struct Serving(&'static AtomicUsize);

impl Serving {
    fn begin(purpose: Purpose) -> Option<Self> {
        let (held, ceiling) = match purpose {
            Purpose::Pair => (&PAIRING, MAX_STREAMS),
            Purpose::Connect => (&CONNECTING, MAX_CONNECTING),
        };
        held.fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| (n < ceiling).then_some(n + 1))
            .ok()
            .map(|_| Serving(held))
    }
}

impl Drop for Serving {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

/// A stream whose reads can be bounded.
pub(crate) trait Timed: Read + Write {
    fn set_read_timeout(&mut self, timeout: Option<Duration>) -> std::io::Result<()>;
}

impl Timed for RelayStream {
    fn set_read_timeout(&mut self, timeout: Option<Duration>) -> std::io::Result<()> {
        RelayStream::set_read_timeout(self, timeout)
    }
}

/// A stream, until a deadline: everything read through it has to arrive
/// by then.
///
/// A timeout on each read bounds a peer that says nothing. It does not
/// bound one that says a byte at a time, each inside the timeout, and a
/// frame may claim sixty-five thousand of them.
struct Within<'a, S: Timed> {
    stream: &'a mut S,
    until: Instant,
}

impl<'a, S: Timed> Within<'a, S> {
    fn new(stream: &'a mut S, within: Duration) -> Self {
        Self { stream, until: Instant::now() + within }
    }
}

impl<S: Timed> Read for Within<'_, S> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let left = self.until.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::TimedOut,
                "the handshake did not finish in time",
            ));
        }
        self.stream.set_read_timeout(Some(left))?;
        self.stream.read(buf)
    }
}

impl<S: Timed> Write for Within<'_, S> {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.stream.write(buf)
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.stream.flush()
    }
}

/// What the streams the Relay hands over may write to the log.
#[derive(Default)]
struct LogBudget {
    window: Option<Instant>,
    said: usize,
    unsaid: usize,
}

/// What became of a line.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Logged {
    Line,
    /// Written, after this many that were not.
    LineAfter(usize),
    Nothing,
}

impl LogBudget {
    fn spend(&mut self, now: Instant) -> Logged {
        let fresh = self.window.is_none_or(|began| now.duration_since(began) >= LOG_WINDOW);
        if fresh {
            let unsaid = std::mem::take(&mut self.unsaid);
            self.window = Some(now);
            self.said = 1;
            return if unsaid == 0 { Logged::Line } else { Logged::LineAfter(unsaid) };
        }
        if self.said < LOG_LINES {
            self.said += 1;
            Logged::Line
        } else {
            self.unsaid += 1;
            Logged::Nothing
        }
    }
}

static LOGGED: Mutex<LogBudget> = Mutex::new(LogBudget { window: None, said: 0, unsaid: 0 });

/// Says something about a stream the Relay handed over, if there is
/// still room in the log for it.
fn note(line: String) {
    let spent = LOGGED.lock().map(|mut budget| budget.spend(Instant::now()));
    match spent {
        Ok(Logged::Line) => eprintln!("gavin-daemon: {line}"),
        Ok(Logged::LineAfter(unsaid)) => {
            eprintln!(
                "gavin-daemon: {unsaid} more streams from the Relay failed or were refused, \
                 and went unsaid"
            );
            eprintln!("gavin-daemon: {line}");
        }
        Ok(Logged::Nothing) | Err(_) => {}
    }
}

/// What the dial sleeps on.
///
/// A counter and a condition variable. Whatever changes what the daemon
/// should be dialling bumps the counter; the dial remembers the value it
/// last acted on, and sleeps only while the counter still reads that. A
/// poke that lands between the dial reading the store and the dial going
/// to sleep is therefore not lost -- the counter has already moved on.
#[derive(Default)]
pub struct Wake {
    generation: Mutex<u64>,
    changed: Condvar,
}

impl Wake {
    /// Something the dial reads has changed.
    pub fn poke(&self) {
        *self.generation.lock().unwrap() += 1;
        self.changed.notify_all();
    }

    pub fn generation(&self) -> u64 {
        *self.generation.lock().unwrap()
    }

    /// Sleeps until the generation is no longer `seen`, or until `at
    /// most` has passed; `None` sleeps until poked.
    pub fn wait_past(&self, seen: u64, at_most: Option<Duration>) {
        let mut generation = self.generation.lock().unwrap();
        let deadline = at_most.map(|d| Instant::now() + d);
        while *generation == seen {
            match deadline {
                None => generation = self.changed.wait(generation).unwrap(),
                Some(deadline) => {
                    let left = deadline.saturating_duration_since(Instant::now());
                    if left.is_zero() {
                        return;
                    }
                    generation = self.changed.wait_timeout(generation, left).unwrap().0;
                }
            }
        }
    }
}

/// What the trust store says the daemon should be connected to.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Dial {
    url: String,
    token: String,
    rendezvous: String,
}

/// What the daemon should be dialling, or `None` for nothing at all.
///
/// Nothing when the switch is off, when there is no Relay URL, and when
/// the store cannot be read -- a daemon that cannot tell whether it was
/// told yes was not told yes.
fn desired(manager: &SessionManager) -> Option<Dial> {
    let trust = manager.trust()?;
    let settings = trust.remote_access().ok()?;
    if !settings.enabled {
        return None;
    }
    let url = settings.relay_url?;
    // The store is shared with the release build, which may have saved a
    // public Relay; a dev build's daemon does not dial it.
    // (Any other fault in the URL is the dial's to name in the log.)
    if let Err(relay::RelayUrlError::PublicHostInDevBuild) =
        relay::RelayUrl::parse_for(&url, manager.build_profile())
    {
        return None;
    }
    let key = trust.static_public_key().ok()?;
    Some(Dial {
        url,
        // A Relay with no token set is dialled all the same, and refuses
        // by name: "the Relay did not accept the admission token" is a
        // better thing to find in the log than nothing.
        token: settings.relay_admission.unwrap_or_default(),
        rendezvous: relay::rendezvous_id(&key),
    })
}

/// Waits that double from `BACKOFF_FLOOR` to `BACKOFF_CEILING`.
struct Backoff(Duration);

impl Backoff {
    fn new() -> Self {
        Self(BACKOFF_FLOOR)
    }

    fn next(&mut self) -> Duration {
        let wait = self.0;
        self.0 = (self.0 * 2).min(BACKOFF_CEILING);
        wait
    }

    fn reset(&mut self) {
        self.0 = BACKOFF_FLOOR;
    }
}

/// How holding the connection ended.
enum Ended {
    /// What should be dialled is no longer what was: re-read, at once.
    Changed,
    /// The machine slept. Whatever the socket says, the connection is
    /// gone, and the Relay is dialled again at once.
    Slept,
    /// The URL may not be dialled, and will not become diallable by
    /// waiting: sleep until the settings change.
    Undiallable(String),
    /// The connection failed or was refused, after being held this long.
    Lost(String, Duration),
}

pub(crate) fn epoch_seconds() -> i64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Starts the dial. Called once, by `serve`, after the trust store is
/// open and before the socket accepts anything.
pub fn spawn(manager: &Arc<SessionManager>) {
    let manager = Arc::clone(manager);
    let started = std::thread::Builder::new()
        .name("relay-dial".into())
        .spawn(move || supervise(&manager));
    if let Err(e) = started {
        eprintln!("gavin-daemon: could not start the Relay dial: {e}");
    }
}

/// Says a thing once. A Relay that stays unreachable is dialled again
/// every minute for as long as remote access is on, and a log that said
/// so every minute would be a log with nothing else in it.
#[derive(Default)]
struct Said(Option<String>);

impl Said {
    fn say(&mut self, line: String) {
        if self.0.as_deref() != Some(line.as_str()) {
            eprintln!("gavin-daemon: {line}");
            self.0 = Some(line);
        }
    }

    fn forget(&mut self) {
        self.0 = None;
    }
}

fn supervise(manager: &Arc<SessionManager>) {
    let wake = manager.remote_wake();
    let mut backoff = Backoff::new();
    let mut said = Said::default();
    loop {
        // Read BEFORE the store is: a change that lands after this line
        // moves the generation past `seen`, and the sleep below returns
        // at once instead of sleeping through it.
        let mut seen = wake.generation();
        let Some(dial) = desired(manager) else {
            // Until poked, or until it is time to look at the store
            // again on nobody's say-so.
            manager.set_relay_state(RelayState::NotWanted);
            wake.wait_past(seen, Some(STORE_POLL));
            backoff.reset();
            said.forget();
            continue;
        };
        match hold(manager, &dial, &mut seen, &mut said) {
            Ended::Changed | Ended::Slept => {
                // Dialled again at once, so what was said about the last
                // dial -- a failure against a URL since changed -- is
                // not said about the next.
                manager.set_relay_state(RelayState::Dialling);
                backoff.reset();
            }
            Ended::Undiallable(why) => {
                manager.set_relay_state(RelayState::Failed { why: why.clone() });
                said.say(format!("the Relay is not being dialled: {why}"));
                wait_while_wanted(manager, &dial, None);
                backoff.reset();
            }
            Ended::Lost(why, held) => {
                if held >= SETTLED {
                    backoff.reset();
                }
                manager.set_relay_state(RelayState::Failed { why: why.clone() });
                said.say(format!(
                    "the connection to the Relay ended ({why}); dialling again until it holds"
                ));
                wait_while_wanted(manager, &dial, Some(backoff.next()));
            }
        }
    }
}

/// Sleeps for as long as `dial` is still what should be dialled, and for
/// `at_most` at the longest; `None` is until it changes.
///
/// Wakes when poked, and looks at the store every `STORE_POLL`
/// regardless.
fn wait_while_wanted(manager: &SessionManager, dial: &Dial, at_most: Option<Duration>) {
    let wake = manager.remote_wake();
    let deadline = at_most.map(|d| Instant::now() + d);
    loop {
        let seen = wake.generation();
        if desired(manager).as_ref() != Some(dial) {
            return;
        }
        let step = match deadline {
            None => STORE_POLL,
            Some(deadline) => {
                let left = deadline.saturating_duration_since(Instant::now());
                if left.is_zero() {
                    return;
                }
                left.min(STORE_POLL)
            }
        };
        wake.wait_past(seen, Some(step));
    }
}

/// Dials the Relay, registers this Workstation, and holds the connection
/// until it ends or stops being wanted.
fn hold(manager: &Arc<SessionManager>, dial: &Dial, seen: &mut u64, said: &mut Said) -> Ended {
    // A retry after a failure keeps saying it failed: "dialling" again
    // every backoff would flap the desk between the two, and the reason
    // is what the human needs until a dial holds.
    if !matches!(manager.relay_state(), RelayState::Failed { .. }) {
        manager.set_relay_state(RelayState::Dialling);
    }
    let hello = RelayHello::workstation(&dial.token, &dial.rendezvous);
    let mut connection = match client::dial(&dial.url, &hello, &DialOptions::default()) {
        Ok(connection) => connection,
        Err(DialError::Url(e)) => return Ended::Undiallable(e.to_string()),
        Err(e) => return Ended::Lost(e.to_string(), Duration::ZERO),
    };
    said.forget();
    said.say("connected to the Relay".to_string());
    manager.set_relay_state(RelayState::Connected { since: epoch_seconds() });
    let since = Instant::now();
    let ended = attend(manager, dial, seen, &mut connection, since);
    connection.close();
    ended
}

fn attend(
    manager: &Arc<SessionManager>,
    dial: &Dial,
    seen: &mut u64,
    connection: &mut RelayConnection,
    since: Instant,
) -> Ended {
    let wake = manager.remote_wake();
    let mut pinged = Instant::now();
    let mut read_store = Instant::now();
    let mut observed = (Instant::now(), SystemTime::now());
    loop {
        match connection.next_reply(POLL) {
            Ok(Some(RelayReply::Incoming { stream, purpose })) => {
                // Decided here, on the one thread that reads
                // announcements, so that what a flood of them costs is
                // this comparison and not a thread apiece.
                if let Some(purpose) = wanted(manager, &purpose) {
                    if let Some(serving) = Serving::begin(purpose) {
                        let manager = Arc::clone(manager);
                        let dial = dial.clone();
                        let started = std::thread::Builder::new()
                            .name("relay-stream".into())
                            .spawn(move || match purpose {
                                Purpose::Pair => {
                                    let _serving = serving;
                                    if let Err(e) = pair_through(&manager, &dial, &stream) {
                                        note(format!(
                                            "a pairing through the Relay did not complete: {e}"
                                        ));
                                    }
                                }
                                Purpose::Connect => {
                                    if let Err(e) =
                                        connect_through(&manager, &dial, &stream, serving)
                                    {
                                        note(format!(
                                            "a connection through the Relay was not made: {e}"
                                        ));
                                    }
                                }
                            });
                        if let Err(e) = started {
                            eprintln!("gavin-daemon: could not serve a stream from the Relay: {e}");
                        }
                    }
                }
            }
            // Anything else the Relay says on this connection is for a
            // daemon newer than this one.
            Ok(Some(_)) | Ok(None) => {}
            Err(e) => return Ended::Lost(e.to_string(), since.elapsed()),
        }

        // The generation first and the store second, for the reason
        // `supervise` reads them in that order. A poke that changed
        // nothing this connection depends on -- the token re-saved as it
        // was -- is noted and the connection is kept.
        //
        // And every `STORE_POLL` whether poked or not: the store is
        // shared with a daemon that cannot poke this one.
        let generation = wake.generation();
        if generation != *seen || read_store.elapsed() >= STORE_POLL {
            read_store = Instant::now();
            if desired(manager).as_ref() != Some(dial) {
                return Ended::Changed;
            }
            *seen = generation;
        }

        // The suspend watchdog's measurement, for its reason: on wake the
        // monotonic clock has not moved and the wall clock has, and a
        // socket that was open when the lid closed is not one the Relay
        // still holds.
        let now = (Instant::now(), SystemTime::now());
        let wall = now.1.duration_since(observed.1).unwrap_or(Duration::ZERO);
        let unobserved = wall.saturating_sub(now.0.duration_since(observed.0));
        observed = now;
        if unobserved >= SLEPT {
            eprintln!(
                "gavin-daemon: {}s of unobserved time -- dialling the Relay again",
                unobserved.as_secs()
            );
            return Ended::Slept;
        }

        if connection.silence() >= SILENCE {
            return Ended::Lost("the Relay went quiet".into(), since.elapsed());
        }
        if pinged.elapsed() >= KEEPALIVE {
            pinged = Instant::now();
            if let Err(e) = connection.ping() {
                return Ended::Lost(e.to_string(), since.elapsed());
            }
        }
    }
}

/// What a stream this daemon picks up is for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Purpose {
    Pair,
    Connect,
}

/// What this daemon picks a stream announced for `purpose` up as, or
/// `None` if it leaves it where it is.
fn wanted(manager: &SessionManager, purpose: &str) -> Option<Purpose> {
    match purpose {
        // The Relay announces a stream to every daemon registered under
        // this Workstation's key, and the dev build and the release
        // build share one. The daemon whose desk is showing the QR is
        // the one holding the offer; any other leaves the stream to it.
        relay::PURPOSE_PAIR => manager.has_pairing_offer().then_some(Purpose::Pair),
        // Any daemon that holds the Device's row can serve it, and both
        // do. Which goes first is `deference`'s.
        relay::PURPOSE_CONNECT => Some(Purpose::Connect),
        // A stream for anything else is left for the Relay to time out:
        // refusing it would take a connection, and there is nothing to
        // say on it.
        _ => None,
    }
}

/// How long this daemon waits before it picks a connection up. See
/// `DEFERENCE`.
pub(crate) fn deference(manager: &SessionManager) -> Duration {
    if manager.an_app_is_live() {
        Duration::ZERO
    } else {
        DEFERENCE
    }
}

/// Serves a paired Device's connection: the handshake, the proof, and
/// then its requests, for as long as it stays.
fn connect_through(
    manager: &Arc<SessionManager>,
    dial: &Dial,
    stream: &str,
    serving: Serving,
) -> anyhow::Result<()> {
    let wait = deference(manager);
    if !wait.is_zero() {
        std::thread::sleep(wait);
    }
    let hello = RelayHello::stream(&dial.token, &dial.rendezvous, stream);
    let mut stream = match client::dial(&dial.url, &hello, &DialOptions::default()) {
        Ok(connection) => connection.into_stream(),
        // Another daemon registered under this key picked it up.
        Err(DialError::Refused(RefusalReason::Gone)) => return Ok(()),
        Err(e) => return Err(e.into()),
    };

    // Lifted out of the store so that neither the handshake nor the
    // Device's proof is waited for with the trust lock held: see
    // `pairing::ResponderKeys`.
    let keys = {
        let trust = no_store(manager.trust())?;
        pairing::ResponderKeys::from_store(&trust)?
    };
    let accepted = connect::run_responder(&mut Within::new(&mut stream, HANDSHAKE), &keys, |key| {
        no_store(manager.trust())?.admit(key)
    });
    let mut accepted = match accepted {
        Ok(Ok(accepted)) => accepted,
        // Refused, and told so.
        Ok(Err(refused)) => {
            stream.close();
            refused_at_the_door(manager, &refused);
            return Ok(());
        }
        Err(e) => {
            stream.close();
            return Err(e);
        }
    };

    // Registered before the Device is told it is connected, so that
    // "connected" is true when it is said: from here a revocation finds
    // this connection. The manager judges the Device again as it takes
    // the connection on, for the revocation that came a moment ago.
    let device_id = accepted.device.device_id.clone();
    let near = match manager.adopt_device(&device_id)? {
        Ok(near) => near,
        Err(reason) => {
            let verdict = ConnectVerdict::Refused { reason };
            let _ = connect::send_verdict(&mut stream, &mut accepted.transport, &verdict);
            stream.close();
            refused_at_the_door(
                manager,
                &connect::Refused { reason, device_id: Some(device_id), why: None },
            );
            return Ok(());
        }
    };
    // Seen. §3's ninety days are counted from a connection that was
    // made, which is this -- never from one that was only asked for.
    if let Some(trust) = manager.trust() {
        let _ = trust.touch(&device_id);
    }
    let connected = ConnectVerdict::Connected { device_id: device_id.clone() };
    if let Err(e) = connect::send_verdict(&mut stream, &mut accepted.transport, &connected) {
        let _ = near.shutdown(Shutdown::Both);
        stream.close();
        return Err(e);
    }
    // No longer one of the streams being let in.
    drop(serving);

    let ended = carry(&mut stream, &mut accepted.transport, &near, || {
        // The dial this connection came in by is still the one wanted,
        // and the Device is still one to serve. Both are read from the
        // store, which a daemon that cannot poke this one also writes:
        // a revocation pressed at ITS desk marks the row and shuts the
        // connections IT holds, and this one is not among them.
        desired(manager).as_ref() == Some(dial) && manager.device_refusal(&device_id).is_none()
    });
    // Both halves, however it ended: the manager's end, so that its loop
    // stops reading and the desk is told the Device has gone; and the
    // Device's.
    let _ = near.shutdown(Shutdown::Both);
    stream.close();
    if let Carried::Broken(why) = ended {
        note(format!("{device_id}'s connection was dropped: {why}"));
    }
    Ok(())
}

/// A Device was refused a connection: the log says so, and if the key that
/// handshook is one the store holds, so does the desk (v57). A key the
/// store has never seen names no Device and stays in the log.
fn refused_at_the_door(manager: &SessionManager, refused: &connect::Refused) {
    note(refusal(refused));
    if let Some(device_id) = &refused.device_id {
        manager.note_device_refusal(device_id, refused.reason);
    }
}

/// What the log says of a Device that was refused.
fn refusal(refused: &connect::Refused) -> String {
    let who = refused.device_id.as_deref().unwrap_or("a device that is not paired");
    match (&refused.reason, &refused.why) {
        (protocol::device_wire::ConnectRefusal::Unlock, Some(why)) => {
            format!("{who} did not prove it is unlocked, and was refused: {why}")
        }
        (reason, _) => format!("{who} was refused a connection: {reason}"),
    }
}

fn no_store<T>(store: Option<T>) -> anyhow::Result<T> {
    store.ok_or_else(|| anyhow::anyhow!("gavin-daemon: this daemon has no trust store"))
}

/// How carrying a Device's connection ended.
enum Carried {
    /// One end or the other let go, or the dial stopped being wanted.
    Over,
    /// Something on the way was not as it should be.
    Broken(String),
}

/// The next whole frame in `arrived`, without its length prefix, if one
/// has arrived.
fn next_frame(arrived: &mut Vec<u8>) -> Option<Vec<u8>> {
    if arrived.len() < pairing::FRAME_PREFIX {
        return None;
    }
    let len = u16::from_be_bytes([arrived[0], arrived[1]]) as usize;
    if arrived.len() < pairing::FRAME_PREFIX + len {
        return None;
    }
    let frame = arrived[pairing::FRAME_PREFIX..pairing::FRAME_PREFIX + len].to_vec();
    arrived.drain(..pairing::FRAME_PREFIX + len);
    Some(frame)
}

/// How long to wait on the Device, `since` its connection last carried
/// anything.
fn tick(since: Duration) -> Duration {
    if since < RECENT {
        TICK_BUSY
    } else {
        TICK_IDLE
    }
}

/// What the connection loop wrote, as it wrote it, for as long as it
/// holds its end open.
fn replies(near: &Stream) -> std::io::Result<Receiver<Vec<u8>>> {
    let mut reading = near.try_clone()?;
    let (send, replies) = sync_channel::<Vec<u8>>(WAITING);
    std::thread::Builder::new().name("device-replies".into()).spawn(move || {
        let mut buf = vec![0u8; CHUNK];
        loop {
            match reading.read(&mut buf) {
                // The loop let go of its end, or whoever was carrying
                // its replies has stopped.
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if send.send(buf[..n].to_vec()).is_err() {
                        break;
                    }
                }
            }
        }
    })?;
    Ok(replies)
}

/// Where what the Device sent is handed to the connection loop, as the
/// loop has room for it.
///
/// A thread of its own, because a write to the loop can wait: the loop
/// answers each request before it reads the next, and an answer nobody
/// has room for holds it. Whoever is carrying the connection must be
/// able to go on taking those answers away meanwhile, which a write of
/// its own would stop it doing.
fn requests(near: &Stream) -> std::io::Result<SyncSender<Vec<u8>>> {
    let mut writing = near.try_clone()?;
    let (requests, handed) = sync_channel::<Vec<u8>>(WAITING);
    std::thread::Builder::new().name("device-requests".into()).spawn(move || {
        for payload in handed {
            if writing.write_all(&payload).is_err() {
                break;
            }
        }
    })?;
    Ok(requests)
}

/// Carries a connection: what the Device sends is opened and handed to
/// the connection loop at the other end of `near`, and what the loop
/// writes is sealed and sent to the Device.
///
/// Bytes both ways, and nothing here reads them as anything else. The
/// connection loop is what takes a request out of them, and refuses it.
///
/// **Nothing here waits on the connection loop.** Its replies are read
/// by one thread and what it is handed is written by another, so that
/// this one is always free to look at the Device, at the replies and at
/// whether the connection is still wanted. The one write it makes is to
/// the Relay, which has a timeout.
fn carry(
    stream: &mut RelayStream,
    transport: &mut snow::TransportState,
    near: &Stream,
    still_wanted: impl Fn() -> bool,
) -> Carried {
    let (replies, requests) = match (replies(near), requests(near)) {
        (Ok(replies), Ok(requests)) => (replies, requests),
        (Err(e), _) | (_, Err(e)) => return Carried::Broken(e.to_string()),
    };

    let mut arrived = Vec::new();
    // What the Device sent, opened, and not yet taken by the loop.
    let mut held: VecDeque<Vec<u8>> = VecDeque::new();
    let mut held_since: Option<Instant> = None;
    let mut buf = vec![0u8; 64 * 1024];
    let mut sealed = vec![0u8; pairing::MAX_NOISE_MESSAGE];
    let mut carried = Instant::now();
    let mut asked = Instant::now();
    loop {
        // The loop's replies first: whatever it has written since.
        loop {
            match replies.try_recv() {
                Ok(reply) => {
                    for piece in reply.chunks(MAX_PAYLOAD) {
                        let sent = pairing::seal(transport, piece, &mut sealed)
                            .and_then(|n| pairing::write_frame(stream, &sealed[..n]));
                        if let Err(e) = sent {
                            return Carried::Broken(e.to_string());
                        }
                    }
                    carried = Instant::now();
                }
                Err(TryRecvError::Empty) => break,
                // The loop let go of its end, having said everything it
                // had to say: the Device was revoked, or removed itself.
                Err(TryRecvError::Disconnected) => return Carried::Over,
            }
        }

        // Then what the Device sent, for as much of it as there is room.
        while let Some(payload) = held.pop_front() {
            match requests.try_send(payload) {
                Ok(()) => carried = Instant::now(),
                Err(TrySendError::Full(payload)) => {
                    held.push_front(payload);
                    break;
                }
                Err(TrySendError::Disconnected(_)) => return Carried::Over,
            }
        }

        // Remote access turned off or pointed at another Relay, or the
        // Device revoked: the daemon lets go of what it is carrying.
        if asked.elapsed() >= POLL {
            asked = Instant::now();
            if !still_wanted() {
                return Carried::Over;
            }
        }

        // Nothing more is read from the Device while the loop has not
        // taken what it already sent. What is waiting is then never more
        // than one read of the stream, and a Device that sends without
        // reading is held to the pace it reads at.
        if !held.is_empty() {
            let since = *held_since.get_or_insert_with(Instant::now);
            if since.elapsed() >= UNREAD {
                return Carried::Broken(
                    "what the device sent went unread: it is sending faster than it reads".into(),
                );
            }
            std::thread::sleep(TICK_BUSY);
            continue;
        }
        held_since = None;

        // Then the Device. The wait IS the read, as it is while a
        // pairing waits on the desk: it is what answers the Relay's
        // keepalives.
        let _ = stream.set_read_timeout(Some(tick(carried.elapsed())));
        match stream.read(&mut buf) {
            Ok(0) => return Carried::Over,
            Ok(n) => {
                carried = Instant::now();
                arrived.extend_from_slice(&buf[..n]);
                while let Some(frame) = next_frame(&mut arrived) {
                    // A frame that does not open was altered, repeated
                    // or moved on its way. It is not read, and nor is
                    // anything after it: the channel counts its frames,
                    // and the count is now wrong for good.
                    match pairing::open(transport, &frame) {
                        Ok(payload) => held.push_back(payload),
                        Err(e) => return Carried::Broken(e.to_string()),
                    }
                }
            }
            Err(e) if matches!(
                e.kind(),
                std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
            ) => {}
            Err(e) => return Carried::Broken(e.to_string()),
        }
    }
}

fn pair_through(manager: &Arc<SessionManager>, dial: &Dial, stream: &str) -> anyhow::Result<()> {
    let hello = RelayHello::stream(&dial.token, &dial.rendezvous, stream);
    let mut stream = client::dial(&dial.url, &hello, &DialOptions::default())?.into_stream();

    // Phase 2's responder, over the Relay's pipe. A handshake that fails
    // -- a wrong secret, an expired offer, no desk to ask -- ends here,
    // and dropping the stream is what tells the Device.
    let awaited = manager.pair_over_awaited(&mut Within::new(&mut stream, HANDSHAKE));
    let mut pairing = match awaited {
        Ok(pairing) => pairing,
        Err(e) => {
            stream.close();
            return Err(e);
        }
    };

    let verdict = await_decision(manager, &pairing, &mut stream, DECISION, || {
        desired(manager).as_ref() == Some(dial)
    });
    let sent = pairing::send_verdict(&mut stream, &mut pairing.handshake.transport, &verdict);
    stream.close();
    sent
}

/// A Device's stream, to whoever is holding it open without reading it.
pub(crate) trait Held {
    /// See `RelayStream::stay_alive`.
    fn stay_alive(&mut self, wait: Duration) -> std::io::Result<bool>;
}

impl Held for client::RelayStream {
    fn stay_alive(&mut self, wait: Duration) -> std::io::Result<bool> {
        client::RelayStream::stay_alive(self, wait)
    }
}

/// Waits for the desk to rule, keeping the Device's stream alive
/// meanwhile, and says what the Device is to be told.
///
/// What the Device is told is what is true. "Paired" means the row is
/// written; "expired" means no Confirm can write one -- every way of
/// giving up withdraws the handshake first, and a withdrawal that finds
/// the desk got there first waits for the desk's answer instead.
pub(crate) fn await_decision(
    manager: &SessionManager,
    pairing: &AwaitedPairing,
    stream: &mut impl Held,
    within: Duration,
    still_wanted: impl Fn() -> bool,
) -> PairingVerdict {
    let deadline = Instant::now() + within;
    let mut asked = Instant::now();
    loop {
        match pairing.decision.try_recv() {
            Ok(decision) => return said(decision),
            // The desk started a new pairing, or revoked everything, and
            // this one went with the dialog that was showing it.
            Err(TryRecvError::Disconnected) => return PairingVerdict::Expired,
            Err(TryRecvError::Empty) => {}
        }
        if Instant::now() >= deadline {
            return give_up(manager, pairing);
        }
        // Remote access turned off, or pointed at another Relay: the
        // daemon lets go of this one, and a Device half-way through
        // pairing is part of what it lets go of.
        if asked.elapsed() >= POLL {
            asked = Instant::now();
            if !still_wanted() {
                return give_up(manager, pairing);
            }
        }
        // The wait IS the read: it is what answers the Relay's
        // keepalives, and what notices a Device that hung up.
        match stream.stay_alive(POLL / 4) {
            Ok(true) => {}
            Ok(false) | Err(_) => return give_up(manager, pairing),
        }
    }
}

fn said(decision: PairingDecision) -> PairingVerdict {
    match decision {
        PairingDecision::Confirmed { device_id, notification_key } => PairingVerdict::Paired {
            device_id,
            notification_key: protocol::hex_encode(&notification_key),
        },
        PairingDecision::Rejected => PairingVerdict::Rejected,
    }
}

/// Ends the wait without an answer -- unless there is one after all.
fn give_up(manager: &SessionManager, pairing: &AwaitedPairing) -> PairingVerdict {
    use std::sync::mpsc::RecvTimeoutError;

    // A few of the desk's moments, and no more: what is being waited for
    // is a write to the store that has already begun.
    for _ in 0..20 {
        if manager.withdraw_pairing(&pairing.handshake.device_id, pairing.ticket) {
            return PairingVerdict::Expired;
        }
        // Not there to withdraw, so the desk has it: a Confirm or a
        // Reject took the entry and its answer is on its way. (A Confirm
        // the store refused puts the entry back, and the next turn
        // withdraws it.)
        match pairing.decision.recv_timeout(POLL / 4) {
            Ok(decision) => return said(decision),
            Err(RecvTimeoutError::Disconnected) => return PairingVerdict::Expired,
            Err(RecvTimeoutError::Timeout) => {}
        }
    }
    PairingVerdict::Expired
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::kanban::KanbanStore;
    use crate::registry::Registry;
    use crate::trust::{RemoteAccess, TrustStore};

    fn manager(dir: &tempfile::TempDir) -> SessionManager {
        let manager = SessionManager::new(
            Registry::open(&dir.path().join("registry.sqlite")).unwrap(),
            KanbanStore::open(&dir.path().join("kanban.sqlite")).unwrap(),
            crate::orchestration::OrchestrationStore::open(
                &dir.path().join("orchestration.sqlite"),
            )
            .unwrap(),
        );
        manager.set_trust_store(TrustStore::open(&dir.path().join("devices.sqlite")).unwrap());
        // The tests below use example hosts; the dev guard has its own.
        manager.set_build_profile(protocol::BuildProfile::Release);
        manager
    }

    fn tell(manager: &SessionManager, enabled: bool, url: Option<&str>, token: Option<&str>) {
        manager
            .trust()
            .unwrap()
            .set_remote_access(&RemoteAccess {
                enabled,
                relay_url: url.map(str::to_string),
                relay_admission: token.map(str::to_string),
            })
            .unwrap();
    }

    /// The dev build shares its trust store with the release build, so a
    /// public Relay the release build saved must not be dialled by it.
    #[test]
    fn a_dev_build_does_not_dial_a_public_relay_the_store_holds() {
        let dir = tempfile::tempdir().unwrap();
        let manager = manager(&dir);
        tell(&manager, true, Some("wss://relay.example"), Some("let-me-in"));
        assert!(desired(&manager).is_some(), "a release build dials it");

        manager.set_build_profile(protocol::BuildProfile::Dev);
        assert_eq!(desired(&manager), None, "a dev build does not");

        tell(&manager, true, Some("ws://192.168.1.20:9000"), Some("let-me-in"));
        assert!(desired(&manager).is_some(), "a Relay on the LAN is fine");
    }

    /// The rule the whole module hangs on: there is something to dial
    /// only when the human turned remote access on AND named a Relay.
    #[test]
    fn nothing_is_dialled_unless_remote_access_is_on_and_a_relay_is_named() {
        let dir = tempfile::tempdir().unwrap();
        let manager = manager(&dir);
        assert_eq!(desired(&manager), None, "a daemon that was never told");

        tell(&manager, false, Some("wss://relay.example"), Some("let-me-in"));
        assert_eq!(desired(&manager), None, "off, with a Relay and a token stored");

        tell(&manager, true, None, Some("let-me-in"));
        assert_eq!(desired(&manager), None, "on, with no Relay to dial");

        tell(&manager, true, Some("wss://relay.example"), Some("let-me-in"));
        let key = manager.trust().unwrap().static_public_key().unwrap();
        assert_eq!(
            desired(&manager),
            Some(Dial {
                url: "wss://relay.example".into(),
                token: "let-me-in".into(),
                rendezvous: relay::rendezvous_id(&key),
            })
        );
    }

    #[test]
    fn a_daemon_with_no_trust_store_dials_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let bare = SessionManager::new(
            Registry::open(&dir.path().join("registry.sqlite")).unwrap(),
            KanbanStore::open(&dir.path().join("kanban.sqlite")).unwrap(),
            crate::orchestration::OrchestrationStore::open(
                &dir.path().join("orchestration.sqlite"),
            )
            .unwrap(),
        );
        assert_eq!(desired(&bare), None);
    }

    /// "Revoke all" rotates the key, so the Workstation has to meet its
    /// Devices somewhere else: the id every old Device would ask for is
    /// one nobody is registered under any more.
    #[test]
    fn a_rotated_key_is_a_different_rendezvous() {
        let dir = tempfile::tempdir().unwrap();
        let manager = manager(&dir);
        tell(&manager, true, Some("wss://relay.example"), Some("let-me-in"));
        let before = desired(&manager).unwrap();

        manager.revoke_all_devices().unwrap();

        let after = desired(&manager).unwrap();
        assert_ne!(after.rendezvous, before.rendezvous);
        assert_eq!(after.url, before.url);
        assert_eq!(after.token, before.token);
    }

    #[test]
    fn a_poke_ends_a_wait_and_a_wait_with_nothing_to_wait_for_returns() {
        let wake = Arc::new(Wake::default());
        let seen = wake.generation();

        // Poked BEFORE the wait: the change is not slept through.
        wake.poke();
        let started = Instant::now();
        wake.wait_past(seen, None);
        assert!(started.elapsed() < Duration::from_secs(1));

        // Poked DURING the wait.
        let seen = wake.generation();
        let poker = Arc::clone(&wake);
        let poking = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(50));
            poker.poke();
        });
        let started = Instant::now();
        wake.wait_past(seen, Some(Duration::from_secs(30)));
        assert!(started.elapsed() < Duration::from_secs(5), "{:?}", started.elapsed());
        poking.join().unwrap();

        // Never poked: the wait is as long as it was told to be.
        let seen = wake.generation();
        let started = Instant::now();
        wake.wait_past(seen, Some(Duration::from_millis(60)));
        assert!(started.elapsed() >= Duration::from_millis(60));
    }

    /// A pairing stream is picked up by the daemon that is offering a
    /// pairing, and by no other. A connection is picked up whether or
    /// not one is: a Device that has paired needs nobody at the desk to
    /// let it in. A stream for anything else is picked up by nobody.
    #[test]
    fn a_stream_is_picked_up_for_what_it_is_for() {
        let dir = tempfile::tempdir().unwrap();
        let manager = manager(&dir);
        assert_eq!(wanted(&manager, relay::PURPOSE_PAIR), None, "no offer was made");
        assert_eq!(wanted(&manager, relay::PURPOSE_CONNECT), Some(Purpose::Connect));

        manager.begin_pairing().unwrap();
        assert_eq!(wanted(&manager, relay::PURPOSE_PAIR), Some(Purpose::Pair));
        assert_eq!(wanted(&manager, relay::PURPOSE_CONNECT), Some(Purpose::Connect));
        for purpose in ["", "forward", "Connect", "pair "] {
            assert_eq!(wanted(&manager, purpose), None, "{purpose:?}");
        }
    }

    /// What the daemon carries between a Device and the connection loop
    /// is bytes, and a frame ends wherever the Device's write did.
    #[test]
    fn frames_are_taken_out_of_what_arrived_as_they_become_whole() {
        let mut arrived = Vec::new();
        assert_eq!(next_frame(&mut arrived), None);

        arrived.extend_from_slice(&[0x00, 0x03, b'a', b'b']);
        assert_eq!(next_frame(&mut arrived), None, "a frame that is one byte short");
        arrived.extend_from_slice(&[b'c', 0x00, 0x00, 0x00]);
        assert_eq!(next_frame(&mut arrived).as_deref(), Some(&b"abc"[..]));
        assert_eq!(next_frame(&mut arrived).as_deref(), Some(&b""[..]), "an empty frame");
        assert_eq!(next_frame(&mut arrived), None, "half a length");
        assert_eq!(arrived, vec![0x00]);
    }

    /// The daemon looks at a connection that is carrying something far
    /// more often than at one that is not.
    #[test]
    fn a_quiet_connection_is_looked_at_less_often() {
        assert_eq!(tick(Duration::ZERO), TICK_BUSY);
        assert_eq!(tick(RECENT - Duration::from_millis(1)), TICK_BUSY);
        assert_eq!(tick(RECENT), TICK_IDLE);
        assert_eq!(tick(Duration::from_secs(3600)), TICK_IDLE);
        assert!(TICK_BUSY < TICK_IDLE);
    }

    #[test]
    fn no_more_streams_are_served_at_once_than_the_ceiling() {
        let pairing = || Serving::begin(Purpose::Pair);
        let held: Vec<Serving> = std::iter::from_fn(pairing).take(MAX_STREAMS + 3).collect();
        assert_eq!(held.len(), MAX_STREAMS);
        assert!(pairing().is_none(), "a stream above the ceiling was served");

        drop(held);
        assert!(pairing().is_some(), "the ceiling did not come back down");
    }

    /// A connection can be asked for at any time by anything the Relay
    /// admits; a pairing only while the desk is showing a QR. However
    /// many of the first there are, they are not what keeps the owner
    /// from the second.
    #[test]
    fn connections_being_let_in_do_not_take_the_places_pairing_needs() {
        let connecting = || Serving::begin(Purpose::Connect);
        let held: Vec<Serving> = std::iter::from_fn(connecting).take(MAX_CONNECTING + 3).collect();
        assert_eq!(held.len(), MAX_CONNECTING);
        assert!(connecting().is_none(), "a connection above the ceiling was let in");

        let pairing: Vec<Serving> =
            std::iter::from_fn(|| Serving::begin(Purpose::Pair)).take(MAX_STREAMS).collect();
        assert_eq!(pairing.len(), MAX_STREAMS, "the connections took the pairings' places");

        drop(held);
        assert!(connecting().is_some(), "the ceiling did not come back down");
    }

    /// A stream that gives up a byte whenever it is asked, after making
    /// the asker wait.
    struct Trickle {
        every: Duration,
        timeout: Option<Duration>,
        read: usize,
    }

    impl std::io::Read for Trickle {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            if self.timeout.is_some_and(|timeout| timeout < self.every) {
                std::thread::sleep(self.timeout.unwrap());
                return Err(std::io::ErrorKind::TimedOut.into());
            }
            std::thread::sleep(self.every);
            buf[0] = 0xff;
            self.read += 1;
            Ok(1)
        }
    }

    impl std::io::Write for Trickle {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    impl Timed for Trickle {
        fn set_read_timeout(&mut self, timeout: Option<Duration>) -> std::io::Result<()> {
            self.timeout = timeout;
            Ok(())
        }
    }

    /// The handshake has a deadline, not each read of it. A peer that
    /// sends a byte inside every timeout would otherwise never run out
    /// of time, and four of them are every place there is.
    #[test]
    fn a_handshake_has_one_deadline_however_slowly_it_arrives() {
        let mut trickle = Trickle { every: Duration::from_millis(20), timeout: None, read: 0 };
        let started = Instant::now();
        let mut within = Within::new(&mut trickle, Duration::from_millis(300));

        // A frame that claims more than will ever arrive in time.
        let mut frame = vec![0u8; 4096];
        let err = std::io::Read::read_exact(&mut within, &mut frame).unwrap_err();

        assert_eq!(err.kind(), std::io::ErrorKind::TimedOut, "{err}");
        let took = started.elapsed();
        assert!(took >= Duration::from_millis(300), "gave up early: {took:?}");
        assert!(took < Duration::from_secs(2), "every byte renewed the wait: {took:?}");
        assert!(trickle.read > 3 && trickle.read < 30, "{} bytes were read", trickle.read);
    }

    #[test]
    fn a_handshake_that_arrives_in_time_is_read_whole() {
        let mut trickle = Trickle { every: Duration::from_millis(1), timeout: None, read: 0 };
        let mut within = Within::new(&mut trickle, Duration::from_secs(20));
        let mut frame = vec![0u8; 64];
        std::io::Read::read_exact(&mut within, &mut frame).unwrap();
        assert_eq!(frame, vec![0xff; 64]);
    }

    /// What a peer can make the daemon write to its log is bounded.
    /// Anything the Relay admits can ask for a connection, as often as
    /// it likes, and each one that fails is a line.
    #[test]
    fn what_refused_connections_write_to_the_log_is_bounded() {
        let mut budget = LogBudget::default();
        let start = Instant::now();

        let said: Vec<Logged> = (0..LOG_LINES + 5).map(|_| budget.spend(start)).collect();
        assert!(said[..LOG_LINES].iter().all(|s| *s == Logged::Line), "{said:?}");
        assert!(said[LOG_LINES..].iter().all(|s| *s == Logged::Nothing), "{said:?}");

        // Still inside the window.
        assert_eq!(budget.spend(start + LOG_WINDOW - Duration::from_secs(1)), Logged::Nothing);
        // The next window says how much went unsaid, once.
        assert_eq!(budget.spend(start + LOG_WINDOW), Logged::LineAfter(6));
        assert_eq!(budget.spend(start + LOG_WINDOW), Logged::Line);
    }

    #[test]
    fn a_line_is_said_once_until_something_else_is_said() {
        let mut said = Said::default();
        said.say("the Relay is not there".into());
        assert_eq!(said.0.as_deref(), Some("the Relay is not there"));
        said.say("the Relay is not there".into());
        assert_eq!(said.0.as_deref(), Some("the Relay is not there"));
        said.say("connected".into());
        assert_eq!(said.0.as_deref(), Some("connected"));
        said.forget();
        assert_eq!(said.0, None);
    }

    #[test]
    fn the_wait_between_dials_doubles_to_a_minute_and_starts_over() {
        let mut backoff = Backoff::new();
        let waits: Vec<u64> = (0..9).map(|_| backoff.next().as_secs()).collect();
        assert_eq!(waits, vec![1, 2, 4, 8, 16, 32, 60, 60, 60]);
        backoff.reset();
        assert_eq!(backoff.next().as_secs(), 1);
    }
}
