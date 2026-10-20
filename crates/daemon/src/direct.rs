//! The daemon's direct listener (ADR 0009): a Device on the same network
//! or tailnet reaches this Workstation with no Relay in between.
//!
//! `docs/security/05-remote-access.md` §5 chose the shape: "direct
//! connection (LAN, Tailscale) as the same code path minus the relay".
//! So a Device dials this exactly as it dials a Relay -- a WebSocket over
//! TLS, opening with `RelayHello::Device` -- and once the listener has
//! said `ready` the stream is served by the code that serves a Relay's:
//! `remote::serve_pairing` for a pairing, `remote::serve_device` for a
//! connection, which runs `IK` and the hardware proof and hands the
//! connection to `adopt_device` with `ClientIdentity::remote`. What a
//! Relay adds -- matching, registering -- a Device that already holds
//! this daemon's key has no use for. The admission token it keeps: while
//! the desk holds one, a direct hello must present it too.
//!
//! **TLS, pinned.** The listener serves a self-signed certificate the
//! trust store keeps (`trust::DirectIdentity`), and the pairing QR carries
//! its hash. Noise authenticates the Workstation whatever carries it; the
//! TLS is for the phones' cleartext rules, and the pin keeps what a Device
//! trusts to one certificate.
//!
//! **Only while wanted.** One thread, started by `serve`, reads the store
//! and does what it says, as `remote.rs`'s dial does: with remote access
//! or direct connection off it binds nothing and sleeps on the same
//! `Wake`, looking at the store again every couple of seconds for the
//! daemon that shares it. Turning either off closes the port, and every
//! connection the listener carried lets go at its next look.
//!
//! **Who gets in, and how far, before anything is touched.**
//!
//! - A peer that is not on this machine or this network
//!   (`relay::address_is_local`) is closed on, unread.
//! - Sockets not yet past `verdict` draw on `ANSWERING`, capped per
//!   source address; a full budget drops the oldest silent socket
//!   rather than refusing a newcomer. After `verdict` says yes the
//!   connection takes a `CARRIED` place no unauthenticated peer can
//!   touch -- the same split `remote.rs` keeps between
//!   `MAX_CONNECTING` and a proved connection.
//! - TLS, the WebSocket handshake and the hello inside `HELLO`
//!   together, with `FIRST_BYTE` for a peer that has sent nothing.
//! - A hello that is not a Device's for THIS Workstation's key is refused
//!   by name, as a Relay refuses it, and so is one whose token is not the
//!   desk's while the desk holds one. From there the Relay's own ceilings
//!   apply: `remote::Serving`'s places for pairings and for connections
//!   being let in, which the Relay's streams draw on as well.

use crate::remote::{self, Purpose, Serving};
use crate::server::SessionManager;
use crate::trust::DirectIdentity;
use gavin_relay::direct::{self as answering, AnswerError, Answered, ServerTls};
use protocol::relay::{self, RefusalReason, RelayHello, RELAY_WIRE_VERSION};
use protocol::DirectState;
use std::collections::{HashMap, VecDeque};
use std::net::{IpAddr, Shutdown, SocketAddr, TcpListener, TcpStream, UdpSocket};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// The port a release build's daemon listens on, and the one a dev
/// build's does: `protocol::relay`'s, because a Relay URL naming either
/// on this machine is refused there (`RelayUrl::refuse_direct_listener`).
const PORT_RELEASE: u16 = relay::DIRECT_PORT_RELEASE;
const PORT_DEV: u16 = relay::DIRECT_PORT_DEV;

/// Overrides the port; `0` lets the system choose. What lets seam 1 run
/// many isolated daemons at once, each reading its port back from
/// `GetDirectState` -- and a human whose port is taken a way out until
/// the port is a setting.
const PORT_ENV: &str = "GAVIN_DIRECT_PORT";

/// From accepting a socket to reading a hello off it: the Relay's
/// `hello_deadline`.
const HELLO: Duration = Duration::from_secs(5);

/// How long a peer may take to send its first TLS byte. A silent
/// socket holds an answering place only this long, not the whole of
/// `HELLO`.
const FIRST_BYTE: Duration = Duration::from_secs(1);

/// Sockets not yet past `verdict`: TLS, the WebSocket handshake and
/// the hello. Apart from `CARRIED`, so a stranger that says nothing
/// cannot take the places a paired Device needs.
pub(crate) const ANSWERING: usize = 8;

/// Of the answering places, how many one source address may hold.
/// A third from the same peer is refused; the drop-oldest rule is for
/// the total, not for crowding out one address's own slots.
pub(crate) const ANSWERING_PER_PEER: usize = 2;

/// Sockets let in or carried, after `verdict` said yes. A Workstation
/// holds five Devices with two connections each, and a pairing or two.
pub(crate) const CARRIED: usize = 16;

/// How long the listener sleeps when nobody is knocking. What a Device
/// waits on at most before its connection is accepted.
const ACCEPT_POLL: Duration = Duration::from_millis(50);

/// How often the store is re-read while listening, and the addresses
/// worked out again. `remote.rs`'s `STORE_POLL`, for its reason.
const STORE_POLL: Duration = Duration::from_secs(2);

/// The first wait after a failed bind, doubling to the ceiling.
const BACKOFF_FLOOR: Duration = Duration::from_secs(1);
const BACKOFF_CEILING: Duration = Duration::from_secs(60);

/// Sockets being answered, by source address, oldest first. Each holds
/// a clone that `shutdown`s when the place is preempted so its thread
/// can reclaim the slot.
struct Answering {
    by_peer: HashMap<IpAddr, usize>,
    queue: VecDeque<(u64, IpAddr, TcpStream)>,
    next_id: u64,
}

impl Answering {
    fn new() -> Self {
        Self { by_peer: HashMap::new(), queue: VecDeque::new(), next_id: 0 }
    }

    /// Takes a pre-authentication place for `peer`, or `None` when that
    /// address already holds `ANSWERING_PER_PEER`. When the total is
    /// full, drops the oldest silent socket to make room.
    fn begin(&mut self, peer: IpAddr, socket: &TcpStream) -> Option<AnsweringPlace> {
        let held = self.by_peer.get(&peer).copied().unwrap_or(0);
        if held >= ANSWERING_PER_PEER {
            return None;
        }
        if self.queue.len() >= ANSWERING {
            self.drop_oldest();
        }
        let handle = socket.try_clone().ok()?;
        let id = self.next_id;
        self.next_id = self.next_id.wrapping_add(1);
        self.queue.push_back((id, peer, handle));
        *self.by_peer.entry(peer).or_insert(0) += 1;
        Some(AnsweringPlace { id, peer })
    }

    fn drop_oldest(&mut self) {
        let Some((_id, peer, stream)) = self.queue.pop_front() else {
            return;
        };
        let _ = stream.shutdown(Shutdown::Both);
        if let Some(n) = self.by_peer.get_mut(&peer) {
            *n -= 1;
            if *n == 0 {
                self.by_peer.remove(&peer);
            }
        }
    }

    /// Gives back the place `id` held, if it is still in the queue
    /// (preemption already removed it).
    fn release(&mut self, id: u64, peer: IpAddr) {
        let Some(pos) = self.queue.iter().position(|(held, _, _)| *held == id) else {
            return;
        };
        let _ = self.queue.remove(pos);
        if let Some(n) = self.by_peer.get_mut(&peer) {
            *n -= 1;
            if *n == 0 {
                self.by_peer.remove(&peer);
            }
        }
    }
}

static ANSWERING_NOW: std::sync::OnceLock<Mutex<Answering>> = std::sync::OnceLock::new();

fn answering_now() -> &'static Mutex<Answering> {
    ANSWERING_NOW.get_or_init(|| Mutex::new(Answering::new()))
}

/// One of the `ANSWERING` places, given back however the socket ends.
struct AnsweringPlace {
    id: u64,
    peer: IpAddr,
}

impl Drop for AnsweringPlace {
    fn drop(&mut self) {
        if let Ok(mut answering) = answering_now().lock() {
            answering.release(self.id, self.peer);
        }
    }
}

/// Sockets past `verdict`, being proved or carried.
static CARRIED_NOW: AtomicUsize = AtomicUsize::new(0);

/// One of the `CARRIED` places, given back when the connection ends.
struct Carried;

impl Carried {
    fn begin() -> Option<Self> {
        CARRIED_NOW
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| {
                (n < CARRIED).then_some(n + 1)
            })
            .ok()
            .map(|_| Carried)
    }
}

impl Drop for Carried {
    fn drop(&mut self) {
        CARRIED_NOW.fetch_sub(1, Ordering::SeqCst);
    }
}

/// What the store says the listener should be.
#[derive(Clone, PartialEq, Eq)]
struct Want {
    port: u16,
    identity: DirectIdentity,
    /// This Workstation's rendezvous id: the one a Device's hello must
    /// name. Changes when "Revoke all" rotates the key.
    rendezvous: String,
}

/// The port this daemon listens on: the override if there is one, and
/// otherwise its build's own.
fn port(manager: &SessionManager) -> u16 {
    if let Some(port) = std::env::var(PORT_ENV).ok().and_then(|p| p.trim().parse().ok()) {
        return port;
    }
    match manager.build_profile() {
        protocol::BuildProfile::Dev => PORT_DEV,
        protocol::BuildProfile::Release => PORT_RELEASE,
    }
}

/// The ports a Relay URL must not name on this machine: both builds'
/// direct listeners', and this daemon's own when `GAVIN_DIRECT_PORT`
/// moved it (read back from the bound socket when it chose `0`).
pub(crate) fn direct_ports(manager: &SessionManager) -> Vec<u16> {
    let mut ports = vec![PORT_RELEASE, PORT_DEV];
    let own = match manager.direct_state() {
        DirectState::Listening { port, .. } => port,
        _ => port(manager),
    };
    if own != 0 && !ports.contains(&own) {
        ports.push(own);
    }
    ports
}

/// Why `url` may not be dialled as a Relay, if it is one of this
/// machine's direct listeners: a Relay URL of `ws://<this Mac>:8445` had
/// the daemon dial itself (2026-10-14), and the QR offer the port twice.
///
/// What this machine is, it is asked: an address the URL's host resolves
/// to is this machine's if a socket can be bound to it. Asked only for a
/// URL on a direct port whose host is on this machine or network by its
/// text (`RelayUrl::local`): an address, or `localhost` / a `.local`
/// name, which this machine answers for itself. A public name is never
/// looked up, so a request thread never waits on DNS.
pub(crate) fn names_a_direct_listener_here(
    manager: &SessionManager,
    url: &str,
) -> Option<relay::RelayUrlError> {
    let parsed = relay::RelayUrl::parse(url).ok()?;
    let ports = direct_ports(manager);
    if !ports.contains(&parsed.port) {
        return None;
    }
    let here =
        if parsed.local && held_here(&parsed.host) { vec![parsed.host.clone()] } else { Vec::new() };
    parsed.refuse_direct_listener(&here, &ports).err()
}

/// Whether `host` resolves to an address this machine holds.
fn held_here(host: &str) -> bool {
    use std::net::ToSocketAddrs;
    let Ok(resolved) = (host, 0).to_socket_addrs() else { return false };
    resolved.into_iter().any(|a| UdpSocket::bind(SocketAddr::new(a.ip(), 0)).is_ok())
}

/// What the listener should be, or `None` for no listener at all.
///
/// Nothing when remote access or direct connection is off, and when the
/// store cannot be read: a daemon that cannot tell whether it was told
/// yes was not told yes.
fn desired(manager: &SessionManager) -> Option<Want> {
    let trust = manager.trust()?;
    if !trust.remote_access().ok()?.enabled || !trust.direct_enabled().ok()? {
        return None;
    }
    let identity = trust.direct_identity().ok()?;
    let key = trust.static_public_key().ok()?;
    Some(Want { port: port(manager), identity, rendezvous: relay::rendezvous_id(&key) })
}

/// Starts the listener's supervisor. Called once, by `serve`, after the
/// trust store is open.
pub fn spawn(manager: &Arc<SessionManager>) {
    let manager = Arc::clone(manager);
    let started =
        std::thread::Builder::new().name("direct-listen".into()).spawn(move || supervise(&manager));
    if let Err(e) = started {
        eprintln!("gavin-daemon: could not start the direct listener: {e}");
    }
}

fn supervise(manager: &Arc<SessionManager>) {
    let wake = manager.remote_wake();
    let mut backoff = BACKOFF_FLOOR;
    let mut said: Option<String> = None;
    loop {
        // Read BEFORE the store is, for the reason `remote::supervise`
        // gives.
        let mut seen = wake.generation();
        let Some(want) = desired(manager) else {
            manager.set_direct_state(DirectState::NotWanted);
            wake.wait_past(seen, Some(STORE_POLL));
            backoff = BACKOFF_FLOOR;
            said = None;
            continue;
        };
        match TcpListener::bind(("0.0.0.0", want.port)).and_then(|l| {
            l.set_nonblocking(true)?;
            Ok(l)
        }) {
            Ok(listener) => {
                backoff = BACKOFF_FLOOR;
                said = None;
                listen(manager, &want, listener, &mut seen);
                // Dropped: the port is closed before anything else is
                // decided.
            }
            Err(e) => {
                let why = format!("could not listen on port {}: {e}", want.port);
                if said.as_deref() != Some(why.as_str()) {
                    eprintln!("gavin-daemon: the direct listener {why}");
                    said = Some(why.clone());
                }
                manager.set_direct_state(DirectState::Failed { why });
                wait_while_wanted(manager, &want, backoff);
                backoff = (backoff * 2).min(BACKOFF_CEILING);
            }
        }
    }
}

/// Sleeps for `at_most`, or until what is wanted is no longer `want`.
fn wait_while_wanted(manager: &SessionManager, want: &Want, at_most: Duration) {
    let wake = manager.remote_wake();
    let deadline = Instant::now() + at_most;
    loop {
        let seen = wake.generation();
        if desired(manager).as_ref() != Some(want) {
            return;
        }
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return;
        }
        wake.wait_past(seen, Some(left.min(STORE_POLL)));
    }
}

/// Accepts Devices on `listener` for as long as it is still what is
/// wanted.
fn listen(manager: &Arc<SessionManager>, want: &Want, listener: TcpListener, seen: &mut u64) {
    let tls = match answering::server_config(&want.identity.certificate, &want.identity.private_key)
    {
        Ok(tls) => tls,
        Err(e) => {
            let why = format!("its certificate could not be used: {e}");
            eprintln!("gavin-daemon: the direct listener {why}");
            manager.set_direct_state(DirectState::Failed { why });
            wait_while_wanted(manager, want, BACKOFF_CEILING);
            return;
        }
    };
    let port = listener.local_addr().map(|a| a.port()).unwrap_or(want.port);
    eprintln!("gavin-daemon: listening for Devices directly on port {port}");
    manager.set_direct_state(DirectState::Listening { port, addresses: addresses(port) });

    let wake = manager.remote_wake();
    let mut looked = Instant::now();
    loop {
        match listener.accept() {
            Ok((socket, peer)) => admit(manager, want, &tls, socket, peer),
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => std::thread::sleep(ACCEPT_POLL),
            Err(e) => {
                remote::note(format!("the direct listener could not accept a connection: {e}"));
                std::thread::sleep(ACCEPT_POLL);
            }
        }
        let generation = wake.generation();
        if generation != *seen || looked.elapsed() >= STORE_POLL {
            looked = Instant::now();
            if desired(manager).as_ref() != Some(want) {
                eprintln!("gavin-daemon: no longer listening for Devices directly");
                return;
            }
            *seen = generation;
            // A LAN address changes under a listener that stays bound.
            manager.set_direct_state(DirectState::Listening { port, addresses: addresses(port) });
        }
    }
}

/// Takes one socket on, or closes on it.
fn admit(
    manager: &Arc<SessionManager>,
    want: &Want,
    tls: &ServerTls,
    socket: TcpStream,
    peer: SocketAddr,
) {
    if !relay::address_is_local(peer.ip()) {
        remote::note(format!("a direct connection from {} was closed on: not on this network", peer.ip()));
        return;
    }
    let Some(answering) = begin_answering(peer.ip(), &socket) else {
        remote::note(format!(
            "a direct connection from {} was closed on: that address holds as many answering places as it may",
            peer.ip()
        ));
        return;
    };
    // An accepted socket inherits the listener's non-blocking mode on
    // some systems and not on others; everything after this is blocking.
    if let Err(e) = socket.set_nonblocking(false) {
        remote::note(format!("a direct connection could not be served: {e}"));
        return;
    }
    let manager = Arc::clone(manager);
    let want = want.clone();
    let tls = Arc::clone(tls);
    let started = std::thread::Builder::new().name("direct-device".into()).spawn(move || {
        if let Err(e) = serve(&manager, &want, tls, socket, answering) {
            remote::note(format!("a direct connection was not made: {e}"));
        }
    });
    if let Err(e) = started {
        eprintln!("gavin-daemon: could not serve a direct connection: {e}");
    }
}

/// Takes a pre-authentication place for `peer`, dropping the oldest
/// silent socket when the total is full. `None` when this address
/// already holds `ANSWERING_PER_PEER`, or the socket could not be
/// cloned for preemption.
fn begin_answering(peer: IpAddr, socket: &TcpStream) -> Option<AnsweringPlace> {
    let mut answering = answering_now().lock().ok()?;
    answering.begin(peer, socket)
}

/// What a connection is let in as, or the refusal it is told.
fn verdict(manager: &SessionManager, want: &Want, hello: &RelayHello) -> Result<Purpose, RefusalReason> {
    let RelayHello::Device { v, token, rendezvous, purpose } = hello else {
        // A Workstation registering, a stream being picked up: roles a
        // Relay has and this listener does not.
        return Err(RefusalReason::Version);
    };
    if *v != RELAY_WIRE_VERSION {
        return Err(RefusalReason::Version);
    }
    // A Device looking for another Workstation, or for this one under a
    // key "Revoke all" has since rotated.
    if *rendezvous != want.rendezvous {
        return Err(RefusalReason::Offline);
    }
    // While the desk holds an admission token, the direct path asks for
    // it as the Relay does (ADR 0009, amended 2026-10-15): rotating it
    // keeps off a phone that knows the key but was not given the new
    // one. Read now rather than kept in `want`, so a new token takes
    // effect at the next hello without dropping what is carried. A
    // store that cannot be read admits nothing. Inside a Refresh's grace
    // window the token it replaced is still one (`admissions_at`).
    let now = (crate::trust::now_us() / 1_000_000).max(0) as u64;
    let held = manager
        .trust()
        .and_then(|trust| trust.admissions_at(now).ok())
        .ok_or(RefusalReason::Offline)?;
    // Every one compared, for `admission_matches`'s reason.
    let admitted = held.iter().fold(false, |found, h| found | relay::admission_matches(h, token));
    if !held.is_empty() && !admitted {
        return Err(RefusalReason::Admission);
    }
    // A pairing with no offer on screen, or a purpose this build does
    // not serve: a Relay would leave it to lapse unclaimed.
    remote::wanted(manager, purpose).ok_or(RefusalReason::Unclaimed)
}

fn serve(
    manager: &Arc<SessionManager>,
    want: &Want,
    tls: ServerTls,
    socket: TcpStream,
    answering: AnsweringPlace,
) -> anyhow::Result<()> {
    let answered: Answered =
        answering::answer_with_first_byte(socket, tls, HELLO, FIRST_BYTE).map_err(|e| match e {
            AnswerError::Io(e) => anyhow::anyhow!(e),
            other => anyhow::anyhow!("{other}"),
        })?;
    let purpose = match verdict(manager, want, &answered.hello) {
        Ok(purpose) => purpose,
        Err(reason) => {
            answered.refuse(reason);
            anyhow::bail!("{reason}");
        }
    };
    // Take a carried place before giving the answering place back, so
    // an unauthenticated peer cannot fill the gap between verdict and
    // carry. A full carried budget is Busy, not a dropped stranger.
    let Some(carried) = Carried::begin() else {
        answered.refuse(RefusalReason::Busy);
        anyhow::bail!("{}", RefusalReason::Busy);
    };
    drop(answering);
    let Some(serving) = Serving::begin(purpose) else {
        answered.refuse(RefusalReason::Busy);
        anyhow::bail!("{}", RefusalReason::Busy);
    };
    let stream = answered.ready()?;
    let still_wanted = || desired(manager).as_ref() == Some(want);
    let _carried = carried;
    match purpose {
        Purpose::Pair => {
            let _serving = serving;
            remote::serve_pairing(manager, stream, still_wanted)
        }
        Purpose::Connect => remote::serve_device(manager, stream, serving, still_wanted),
    }
}

/// Where a Device can reach this listener, as the URLs a pairing QR
/// carries: this machine's Tailscale address, then the address of its
/// default route -- each only if it is one a Device on this network or
/// tailnet could dial.
///
/// Found by asking the system which address it would send from, which
/// opens a UDP socket and sends nothing: `100.100.100.100` is Tailscale's
/// own resolver, reached only through the tailnet's interface, and
/// `192.0.2.1` (TEST-NET-1) is an address that only the default route
/// reaches. One address a route, which misses a second LAN a Mac is on;
/// a Device that cannot use either falls back to the Relay.
pub fn addresses(port: u16) -> Vec<String> {
    let mut found: Vec<IpAddr> = Vec::new();
    for probe in ["100.100.100.100:53", "192.0.2.1:9"] {
        if let Some(address) = sending_address(probe) {
            if dialable(address) && !found.contains(&address) {
                found.push(address);
            }
        }
    }
    found.into_iter().map(|address| url(address, port)).collect()
}

/// The address of this machine's default route, if it is one a Device on
/// this network could dial: what the desk's own Relay puts in its URL
/// (`desk_relay.rs`). Not the Tailscale address, for the reason ADR 0009
/// gives: a phone's cleartext exception covers the LAN, and `ws://` to a
/// tailnet address never connected.
pub(crate) fn lan_address() -> Option<IpAddr> {
    sending_address("192.0.2.1:9").filter(|address| dialable(*address))
}

fn sending_address(probe: &str) -> Option<IpAddr> {
    let socket = UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect(probe).ok()?;
    Some(socket.local_addr().ok()?.ip())
}

/// An address worth putting in a QR: on this network or tailnet, and
/// reachable from another machine. IPv4, because the listener binds
/// `0.0.0.0`.
fn dialable(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(v4) => {
            !v4.is_loopback()
                && !v4.is_link_local()
                && !v4.is_unspecified()
                && relay::address_is_local(address)
        }
        IpAddr::V6(_) => false,
    }
}

fn url(address: IpAddr, port: u16) -> String {
    match address {
        IpAddr::V4(v4) => format!("wss://{v4}:{port}"),
        IpAddr::V6(v6) => format!("wss://[{v6}]:{port}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    /// The answering and carried budgets are process-wide; tests that
    /// fill them must not run over each other.
    static BUDGET_TEST: Mutex<()> = Mutex::new(());

    /// A QR names only addresses a Device could dial from another
    /// machine on this network or tailnet.
    #[test]
    fn only_addresses_another_machine_could_dial_are_listed() {
        for listed in ["192.168.1.20", "10.0.0.4", "172.20.1.1", "100.79.93.51"] {
            assert!(dialable(listed.parse().unwrap()), "{listed}");
        }
        for unlisted in ["127.0.0.1", "169.254.3.4", "0.0.0.0", "8.8.8.8", "100.128.0.1", "fd7a:115c:a1e0::1"] {
            assert!(!dialable(unlisted.parse().unwrap()), "{unlisted}");
        }
    }

    /// The URLs are ones `RelayUrl` takes, and calls local: what a Device
    /// dials them with.
    #[test]
    fn a_listed_address_is_a_secure_url_relay_url_reads_as_local() {
        let url = url("100.79.93.51".parse().unwrap(), PORT_RELEASE);
        assert_eq!(url, "wss://100.79.93.51:8445");
        let parsed = relay::RelayUrl::parse(&url).unwrap();
        assert!(parsed.secure && parsed.local);
        assert_eq!(parsed.port, PORT_RELEASE);
        for address in addresses(PORT_DEV) {
            let parsed = relay::RelayUrl::parse(&address).unwrap();
            assert!(parsed.local, "{address}");
            assert_eq!(parsed.port, PORT_DEV);
        }
    }

    #[test]
    fn the_dev_and_release_daemons_listen_on_ports_of_their_own() {
        assert_ne!(PORT_DEV, PORT_RELEASE);
        // Neither is the Relay's.
        assert_ne!(PORT_RELEASE, relay::RELAY_DEFAULT_PORT);
        assert_ne!(PORT_DEV, relay::RELAY_DEFAULT_PORT);
    }

    /// The address this machine is known by on its LAN or tailnet is
    /// found by binding to it, as loopback and `localhost` are; an
    /// address it does not hold, and any other port, are left alone.
    #[test]
    fn a_relay_url_naming_a_direct_port_here_is_one_of_this_machines_listeners() {
        let dir = tempfile::tempdir().unwrap();
        let manager = SessionManager::new(
            crate::registry::Registry::open(&dir.path().join("registry.sqlite")).unwrap(),
            crate::kanban::KanbanStore::open(&dir.path().join("kanban.sqlite")).unwrap(),
            crate::orchestration::OrchestrationStore::open(&dir.path().join("orchestration.sqlite"))
                .unwrap(),
        );
        let mut here = vec!["ws://127.0.0.1:8445".to_string(), "ws://localhost:8446/relay".into()];
        // This machine's own addresses, as a QR would list them -- none on
        // a machine with no network, which leaves loopback to prove it.
        here.extend(addresses(PORT_RELEASE).iter().map(|a| a.replacen("wss://", "ws://", 1)));
        for url in &here {
            let refused = names_a_direct_listener_here(&manager, url);
            assert!(matches!(refused, Some(relay::RelayUrlError::DirectListener(_))), "{url}");
        }
        for url in ["ws://127.0.0.1:8443", "ws://192.0.2.1:8445", "wss://relay.example:443"] {
            assert_eq!(names_a_direct_listener_here(&manager, url), None, "{url}");
        }
    }

    /// A third silent socket from one address is refused while that
    /// address's first two still hold answering places.
    #[test]
    fn a_third_silent_socket_from_one_address_is_refused() {
        let _budget = BUDGET_TEST.lock().unwrap();
        let peer: IpAddr = "127.0.0.2".parse().unwrap();
        let mut ends = Vec::new();
        let mut held = Vec::new();
        for _ in 0..ANSWERING_PER_PEER {
            let (server, client) = connected_pair();
            let place = begin_answering(peer, &server).expect("first two from one peer");
            ends.push((server, client));
            held.push(place);
        }
        let (server, _client) = connected_pair();
        assert!(
            begin_answering(peer, &server).is_none(),
            "a third from the same address must be refused"
        );
        // Another address may still take a place.
        let other: IpAddr = "127.0.0.3".parse().unwrap();
        let (other_server, _other_client) = connected_pair();
        let other_place = begin_answering(other, &other_server).expect("a different peer");
        drop(held);
        drop(other_place);
        drop(ends);
    }

    /// Fill the whole pre-authentication cap with silent sockets from
    /// several loopback addresses. A newcomer still gets in: the oldest
    /// silent socket is dropped to make room.
    #[test]
    fn when_answering_is_full_the_oldest_silent_socket_is_dropped() {
        let _budget = BUDGET_TEST.lock().unwrap();
        let mut ends = Vec::new();
        let mut held = Vec::new();
        // Several addresses, two each, until ANSWERING is full.
        let mut octet = 2u8;
        while held.len() < ANSWERING {
            let peer = IpAddr::from([127, 0, 0, octet]);
            octet = octet.wrapping_add(1).max(2);
            let (server, client) = connected_pair();
            let place = begin_answering(peer, &server).expect("room under the cap");
            ends.push((server, client, peer));
            held.push(place);
        }
        assert_eq!(held.len(), ANSWERING);

        ends[0].1.set_read_timeout(Some(Duration::from_millis(200))).unwrap();

        // A newcomer from a fresh address: the oldest is shut down.
        let newcomer = IpAddr::from([127, 0, 0, octet]);
        let (server, client) = connected_pair();
        let place = begin_answering(newcomer, &server).expect("drop-oldest makes room");
        let mut buf = [0u8; 1];
        let closed = match ends[0].1.read(&mut buf) {
            Ok(0) => true,
            Err(e) => matches!(
                e.kind(),
                std::io::ErrorKind::ConnectionReset
                    | std::io::ErrorKind::ConnectionAborted
                    | std::io::ErrorKind::BrokenPipe
                    | std::io::ErrorKind::UnexpectedEof
            ),
            Ok(_) => false,
        };
        assert!(closed, "the oldest silent socket should have been shut down");

        drop(place);
        drop(held);
        drop(ends);
        drop(server);
        drop(client);
    }

    /// Connections past verdict hold places no unauthenticated peer
    /// can take: the carried ceiling is its own counter.
    #[test]
    fn no_more_carried_sockets_than_the_ceiling() {
        let _budget = BUDGET_TEST.lock().unwrap();
        let held: Vec<Carried> = std::iter::from_fn(Carried::begin).take(CARRIED + 3).collect();
        assert_eq!(held.len(), CARRIED);
        assert!(Carried::begin().is_none());
        drop(held);
        assert!(Carried::begin().is_some());
    }

    fn connected_pair() -> (TcpStream, TcpStream) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let client = TcpStream::connect(addr).unwrap();
        let (server, _) = listener.accept().unwrap();
        (server, client)
    }
}
