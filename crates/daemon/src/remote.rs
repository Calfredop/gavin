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
//! **What it serves.** This is the first slice of the Device wire: the
//! one kind of stream a Device can open is a pairing stream, which is
//! handed to the pairing responder phase 2 built (`pair_over`) unchanged.
//! The connection handshake -- Noise `IK`, and the hardware signature
//! that is the Unlock's enforcement -- is the next slice, and a stream
//! announced for any purpose but pairing is left where it is.

use crate::pairing;
use crate::server::{AwaitedPairing, PairingDecision, SessionManager};
use gavin_relay::client::{self, DialError, DialOptions, RelayConnection};
use protocol::device_wire::PairingVerdict;
use protocol::relay::{self, RelayHello, RelayReply};
use std::sync::atomic::{AtomicUsize, Ordering};
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

/// How long each read of the pairing handshake may take. A Device that
/// has been picked up says its first message at once and its last as soon
/// as it has read ours; ten seconds is a slow network, and what it bounds
/// is how long a peer that says nothing holds one of `MAX_STREAMS`.
const HANDSHAKE_READ: Duration = Duration::from_secs(10);

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

/// How many streams are served at once. Each is a thread and a socket,
/// held for as long as a handshake and a human's answer take, and what
/// asks for one is anything the Relay admitted -- so there is a ceiling,
/// and an announcement that arrives above it is left unanswered
/// (`05-remote-access.md` §8, "the remote channel gets its own caps").
/// One desk pairs one Device at a time; the rest is room for a retry.
const MAX_STREAMS: usize = 4;

/// Streams being served right now, across every connection to the Relay
/// this daemon has held.
static STREAMS: AtomicUsize = AtomicUsize::new(0);

/// One of the `MAX_STREAMS`, given back however the serving ends.
struct Serving;

impl Serving {
    fn begin() -> Option<Self> {
        STREAMS
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| (n < MAX_STREAMS).then_some(n + 1))
            .ok()
            .map(|_| Serving)
    }
}

impl Drop for Serving {
    fn drop(&mut self) {
        STREAMS.fetch_sub(1, Ordering::SeqCst);
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
            wake.wait_past(seen, Some(STORE_POLL));
            backoff.reset();
            said.forget();
            continue;
        };
        match hold(manager, &dial, &mut seen, &mut said) {
            Ended::Changed | Ended::Slept => backoff.reset(),
            Ended::Undiallable(why) => {
                said.say(format!("the Relay is not being dialled: {why}"));
                wait_while_wanted(manager, &dial, None);
                backoff.reset();
            }
            Ended::Lost(why, held) => {
                if held >= SETTLED {
                    backoff.reset();
                }
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
    let hello = RelayHello::workstation(&dial.token, &dial.rendezvous);
    let mut connection = match client::dial(&dial.url, &hello, &DialOptions::default()) {
        Ok(connection) => connection,
        Err(DialError::Url(e)) => return Ended::Undiallable(e.to_string()),
        Err(e) => return Ended::Lost(e.to_string(), Duration::ZERO),
    };
    said.forget();
    said.say("connected to the Relay".to_string());
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
                if wanted(manager, &purpose) {
                    if let Some(serving) = Serving::begin() {
                        let manager = Arc::clone(manager);
                        let dial = dial.clone();
                        let started = std::thread::Builder::new()
                            .name("relay-stream".into())
                            .spawn(move || {
                                let _serving = serving;
                                if let Err(e) = pair_through(&manager, &dial, &stream) {
                                    eprintln!(
                                        "gavin-daemon: a pairing through the Relay did not complete: {e}"
                                    );
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

/// Whether this daemon picks up a stream announced for `purpose`.
fn wanted(manager: &SessionManager, purpose: &str) -> bool {
    // The one purpose this build serves. A stream for any other is left
    // for the Relay to time out: refusing it would take a connection, and
    // there is nothing to say on it.
    if purpose != relay::PURPOSE_PAIR {
        return false;
    }
    // The Relay announces a stream to every daemon registered under this
    // Workstation's key, and the dev build and the release build share
    // one. The daemon whose desk is showing the QR is the one holding the
    // offer; any other leaves the stream to it.
    manager.has_pairing_offer()
}

fn pair_through(manager: &Arc<SessionManager>, dial: &Dial, stream: &str) -> anyhow::Result<()> {
    let hello = RelayHello::stream(&dial.token, &dial.rendezvous, stream);
    let mut stream = client::dial(&dial.url, &hello, &DialOptions::default())?.into_stream();
    stream.set_read_timeout(Some(HANDSHAKE_READ))?;

    // Phase 2's responder, over the Relay's pipe. A handshake that fails
    // -- a wrong secret, an expired offer, no desk to ask -- ends here,
    // and dropping the stream is what tells the Device.
    let mut pairing = match manager.pair_over_awaited(&mut stream) {
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
    use std::sync::mpsc::TryRecvError;

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
        PairingDecision::Confirmed { device_id } => PairingVerdict::Paired { device_id },
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
    /// pairing, and by no other; a stream for anything else is picked up
    /// by nobody, yet.
    #[test]
    fn only_a_pairing_stream_is_wanted_and_only_while_a_pairing_is_offered() {
        let dir = tempfile::tempdir().unwrap();
        let manager = manager(&dir);
        assert!(!wanted(&manager, relay::PURPOSE_PAIR), "no offer was made");

        manager.begin_pairing().unwrap();
        assert!(wanted(&manager, relay::PURPOSE_PAIR));
        assert!(!wanted(&manager, "connect"));
        assert!(!wanted(&manager, ""));
    }

    #[test]
    fn no_more_streams_are_served_at_once_than_the_ceiling() {
        let held: Vec<Serving> = std::iter::from_fn(Serving::begin).take(MAX_STREAMS + 3).collect();
        assert_eq!(held.len(), MAX_STREAMS);
        assert!(Serving::begin().is_none(), "a stream above the ceiling was served");

        drop(held);
        assert!(Serving::begin().is_some(), "the ceiling did not come back down");
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
