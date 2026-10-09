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
//! Relay adds -- matching, registering, the admission token -- a Device
//! that already holds this daemon's key has no use for.
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
//! - `OPEN` sockets at once, of every kind; one over is closed on.
//! - TLS, the WebSocket handshake and the hello inside `HELLO` together.
//! - A hello that is not a Device's for THIS Workstation's key is refused
//!   by name, as a Relay refuses it. From there the Relay's own ceilings
//!   apply: `remote::Serving`'s places for pairings and for connections
//!   being let in, which the Relay's streams draw on as well.

use crate::remote::{self, Purpose, Serving};
use crate::server::SessionManager;
use crate::trust::DirectIdentity;
use gavin_relay::direct::{self as answering, AnswerError, Answered, ServerTls};
use protocol::relay::{self, RefusalReason, RelayHello, RELAY_WIRE_VERSION};
use protocol::DirectState;
use std::net::{IpAddr, SocketAddr, TcpListener, TcpStream, UdpSocket};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// The port a release build's daemon listens on.
const PORT_RELEASE: u16 = 8445;
/// The port a dev build's daemon listens on. Its own, because the two
/// daemons share one trust store and therefore one switch: with it on,
/// both listen.
const PORT_DEV: u16 = 8446;

/// Overrides the port; `0` lets the system choose. What lets seam 1 run
/// many isolated daemons at once, each reading its port back from
/// `GetDirectState` -- and a human whose port is taken a way out until
/// the port is a setting.
const PORT_ENV: &str = "GAVIN_DIRECT_PORT";

/// From accepting a socket to reading a hello off it: the Relay's
/// `hello_deadline`.
const HELLO: Duration = Duration::from_secs(5);

/// Sockets open at once, of every kind: being answered, being let in,
/// and carried. A Workstation holds five Devices with two connections
/// each, and a pairing or two; this is room for those and a few
/// strangers, and no more threads than that.
pub(crate) const OPEN: usize = 16;

/// How long the listener sleeps when nobody is knocking. What a Device
/// waits on at most before its connection is accepted.
const ACCEPT_POLL: Duration = Duration::from_millis(50);

/// How often the store is re-read while listening, and the addresses
/// worked out again. `remote.rs`'s `STORE_POLL`, for its reason.
const STORE_POLL: Duration = Duration::from_secs(2);

/// The first wait after a failed bind, doubling to the ceiling.
const BACKOFF_FLOOR: Duration = Duration::from_secs(1);
const BACKOFF_CEILING: Duration = Duration::from_secs(60);

/// Sockets the listener holds open right now.
static OPEN_NOW: AtomicUsize = AtomicUsize::new(0);

/// One of the `OPEN` places, given back however the socket ends.
struct Open;

impl Open {
    fn begin() -> Option<Self> {
        OPEN_NOW
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| (n < OPEN).then_some(n + 1))
            .ok()
            .map(|_| Open)
    }
}

impl Drop for Open {
    fn drop(&mut self) {
        OPEN_NOW.fetch_sub(1, Ordering::SeqCst);
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
    let Some(open) = Open::begin() else {
        remote::note("a direct connection was closed on: the listener holds as many as it will".into());
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
        let _open = open;
        if let Err(e) = serve(&manager, &want, tls, socket) {
            remote::note(format!("a direct connection was not made: {e}"));
        }
    });
    if let Err(e) = started {
        eprintln!("gavin-daemon: could not serve a direct connection: {e}");
    }
}

/// What a connection is let in as, or the refusal it is told.
fn verdict(manager: &SessionManager, want: &Want, hello: &RelayHello) -> Result<Purpose, RefusalReason> {
    let RelayHello::Device { v, rendezvous, purpose, .. } = hello else {
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
    // A pairing with no offer on screen, or a purpose this build does
    // not serve: a Relay would leave it to lapse unclaimed.
    remote::wanted(manager, purpose).ok_or(RefusalReason::Unclaimed)
}

fn serve(
    manager: &Arc<SessionManager>,
    want: &Want,
    tls: ServerTls,
    socket: TcpStream,
) -> anyhow::Result<()> {
    let answered: Answered = answering::answer(socket, tls, HELLO).map_err(|e| match e {
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
    let Some(serving) = Serving::begin(purpose) else {
        answered.refuse(RefusalReason::Busy);
        anyhow::bail!("{}", RefusalReason::Busy);
    };
    let stream = answered.ready()?;
    let still_wanted = || desired(manager).as_ref() == Some(want);
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
        assert_ne!(PORT_RELEASE, 8443);
        assert_ne!(PORT_DEV, 8443);
    }

    #[test]
    fn no_more_sockets_are_held_open_than_the_ceiling() {
        let held: Vec<Open> = std::iter::from_fn(Open::begin).take(OPEN + 3).collect();
        assert_eq!(held.len(), OPEN);
        assert!(Open::begin().is_none());
        drop(held);
        assert!(Open::begin().is_some());
    }
}
