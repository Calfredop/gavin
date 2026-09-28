//! Seam 1, the Device wire: a test Device, built natively from the
//! Companion core, drives a real daemon through a real local Relay
//! (`docs/superpowers/specs/2026-09-27-companion-design.md`, "Testing
//! Decisions").
//!
//! Nothing here is in-process with the daemon. It is the `gavin-daemon`
//! binary, started under a temporary `$HOME` so it binds its own socket
//! and opens its own stores -- never the developer's, and never found by
//! name. The Relay is a real listener serving TLS with a certificate
//! minted for the run, which the daemon trusts the way it trusts any
//! other: through the machine's certificate store, which `SSL_CERT_FILE`
//! stands in for. This file plays the desk: the two connections the
//! desktop app holds, the push one and the command one.
//!
//! What each test asserts is what one of those three parties would
//! observe -- six digits, a refusal, a row in a list read back later, a
//! socket nobody connected to.

use companion_core::test_device::{TestDevice, TestDeviceError};
use gavin_relay::client::{dial, DialError, DialOptions, RelayConnection};
use gavin_relay::server::{RelayConfig, RunningRelay, Tls};
use protocol::device_wire::PairingVerdict;
use protocol::relay::{rendezvous_id, RefusalReason, RelayHello, PURPOSE_PAIR};
use protocol::transport::{Endpoint, Stream};
use protocol::{
    read_message, write_message, ConnectionKind, DeviceInfo, HelloAuth, PairingQr, Request,
    Response,
};
use std::io::BufReader;
use std::net::TcpListener;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

const TOKEN: &str = "seam-one-admission";

/// How long a test waits for something that should happen at once. Long,
/// because the daemon is a process that was started a moment ago on a
/// machine that may be running the rest of the suite.
const SOON: Duration = Duration::from_secs(20);

/// How long a test watches for something that must NOT happen. The
/// daemon acts on a changed setting the moment it is written, so a dial
/// that was going to happen has happened well inside this.
const QUIET: Duration = Duration::from_millis(2500);

// -- the Relay ----------------------------------------------------------

/// A Relay serving TLS on this machine, and the certificate it serves.
struct LocalRelay {
    relay: RunningRelay,
    /// For the test Device, which is handed it.
    certificate_der: Vec<u8>,
    /// For the daemon, which reads it from a file.
    certificate_pem: String,
}

impl LocalRelay {
    fn start() -> Self {
        let minted = rcgen::generate_simple_self_signed(vec!["localhost".to_string()]).unwrap();
        let mut config = RelayConfig::local(TOKEN);
        config.tls = Some(Tls {
            certificate_chain_pem: minted.cert.pem().into_bytes(),
            private_key_pem: minted.signing_key.serialize_pem().into_bytes(),
        });
        Self {
            relay: RunningRelay::start(config).unwrap(),
            certificate_der: minted.cert.der().to_vec(),
            certificate_pem: minted.cert.pem(),
        }
    }

    /// By the name the certificate carries.
    fn url(&self) -> String {
        let url = self.relay.url_for("localhost");
        assert!(url.starts_with("wss://"), "seam 1 runs over TLS: {url}");
        url
    }
}

// -- the desk -----------------------------------------------------------

/// One of the desktop app's two connections to its daemon.
struct Desk {
    stream: Stream,
    reader: BufReader<Stream>,
}

impl Desk {
    fn connect(endpoint: &Endpoint, daemon_token: &str, kind: ConnectionKind) -> Self {
        let stream = Stream::connect(endpoint.clone()).unwrap();
        stream.set_read_timeout(Some(SOON)).unwrap();
        let reader = BufReader::new(stream.try_clone().unwrap());
        let mut desk = Self { stream, reader };
        match desk.request(&Request::Hello {
            client: "app".into(),
            protocol_version: protocol::PROTOCOL_VERSION,
            auth: HelloAuth::DaemonToken { token: daemon_token.to_string() },
            nonce: "seam-one".into(),
            connection: Some(kind),
        }) {
            Response::HelloAck { role, .. } => assert_eq!(role, "app"),
            other => panic!("expected HelloAck, got {other:?}"),
        }
        desk
    }

    fn request(&mut self, req: &Request) -> Response {
        write_message(&mut self.stream, req).unwrap();
        self.next()
    }

    fn next(&mut self) -> Response {
        read_message(&mut self.reader)
            .expect("the daemon did not answer in time")
            .expect("the daemon closed the connection")
    }

    /// Whether anything arrives within `within`. For the pushes that
    /// must not be sent.
    fn hears_nothing_for(&mut self, within: Duration) -> bool {
        self.stream.set_read_timeout(Some(within)).unwrap();
        let heard = read_message::<_, Response>(&mut self.reader);
        self.stream.set_read_timeout(Some(SOON)).unwrap();
        heard.is_err()
    }
}

/// A Workstation: the daemon, isolated, and the desk in front of it.
struct Workstation {
    home: tempfile::TempDir,
    /// The daemon's data directory, under `home`.
    data: PathBuf,
    daemon: Child,
    push: Desk,
    command: Desk,
}

impl Workstation {
    /// Starts a daemon that trusts `relay`'s certificate.
    fn start(relay: &LocalRelay) -> Self {
        Self::start_trusting(&relay.certificate_pem)
    }

    fn start_trusting(certificate_pem: &str) -> Self {
        // Under /tmp on unix, for the reason `tests/shutdown.rs` gives:
        // the default temporary directory is long enough on macOS to
        // overflow a socket path.
        let temp_root = if cfg!(windows) { std::env::temp_dir() } else { PathBuf::from("/tmp") };
        let home =
            tempfile::Builder::new().prefix("gavin-wire-").tempdir_in(&temp_root).unwrap();
        let fake = Some(home.path().as_os_str().to_os_string());
        let data = protocol::resolve_app_support_dir(
            fake.clone(),
            None,
            fake.clone(),
            fake.clone(),
            protocol::HostOs::current(),
        )
        .unwrap();
        let profile = protocol::BuildProfile::current();
        let endpoint =
            Endpoint::new(data.join(protocol::profile_file_name("daemon", "sock", profile)));
        let token_path = data.join(protocol::profile_file_name("daemon", "token", profile));

        let roots = home.path().join("relay-roots.pem");
        std::fs::write(&roots, certificate_pem).unwrap();
        let log = std::fs::File::create(home.path().join("daemon.log")).unwrap();

        let daemon = Command::new(env!("CARGO_BIN_EXE_gavin-daemon"))
            .env("HOME", home.path())
            .env("LOCALAPPDATA", home.path())
            .env("USERPROFILE", home.path())
            .env_remove("XDG_DATA_HOME")
            // The machine's certificate store, as far as this daemon is
            // concerned. Nothing in the daemon knows it is under test.
            .env("SSL_CERT_FILE", &roots)
            .env_remove("SSL_CERT_DIR")
            .stdout(Stdio::null())
            .stderr(Stdio::from(log))
            .spawn()
            .expect("failed to spawn gavin-daemon");

        let deadline = Instant::now() + SOON;
        while !protocol::transport::is_listening(&endpoint) {
            assert!(Instant::now() < deadline, "the daemon never bound its socket");
            std::thread::sleep(Duration::from_millis(20));
        }
        let daemon_token = std::fs::read_to_string(&token_path).unwrap().trim().to_string();

        let push = Desk::connect(&endpoint, &daemon_token, ConnectionKind::Push);
        let command = Desk::connect(&endpoint, &daemon_token, ConnectionKind::Command);
        Self { home, data, daemon, push, command }
    }

    /// Writes one remote-access setting straight into the trust store,
    /// the way ANOTHER daemon sharing it would: the dev build's and the
    /// release build's open the same `devices.sqlite`, and neither can
    /// tell the other what it wrote.
    fn another_daemon_writes(&self, key: &str, value: &str) {
        let store = rusqlite::Connection::open(self.data.join("devices.sqlite")).unwrap();
        store.busy_timeout(SOON).unwrap();
        store
            .execute(
                "INSERT INTO trust_meta (key, value) VALUES (?1, ?2)
                 ON CONFLICT(key) DO UPDATE SET value = ?2",
                rusqlite::params![key, value.as_bytes()],
            )
            .unwrap();
    }

    /// What the daemon wrote to its log, for a failure to quote.
    fn log(&self) -> String {
        std::fs::read_to_string(self.home.path().join("daemon.log")).unwrap_or_default()
    }

    fn set_remote_access(&mut self, enabled: bool, relay_url: Option<&str>, token: Option<&str>) {
        let resp = self.command.request(&Request::SetRemoteAccess {
            enabled,
            relay_url: relay_url.map(str::to_string),
            relay_admission: token.map(str::to_string),
        });
        assert!(matches!(resp, Response::Ok), "{resp:?}");
    }

    /// Turns remote access on against `relay` and waits until the daemon
    /// is registered with it.
    fn reach(&mut self, relay: &LocalRelay) {
        self.set_remote_access(true, Some(&relay.url()), Some(TOKEN));
        let deadline = Instant::now() + SOON;
        while relay.relay.stats().workstations == 0 {
            assert!(
                Instant::now() < deadline,
                "the daemon never registered with the Relay; its log:\n{}",
                self.log()
            );
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    /// Presses "Pair a device" and hands back what the QR says.
    fn offer(&mut self) -> String {
        match self.command.request(&Request::BeginPairing) {
            Response::PairingOffer { qr, .. } => qr,
            other => panic!("expected PairingOffer, got {other:?}"),
        }
    }

    /// The pairing the desk is being asked about: the Device's id, its
    /// name, and the six digits the desk shows.
    fn asked(&mut self) -> (String, String, String) {
        match self.push.next() {
            Response::DevicePairingRequested { device_id, name, sas } => (device_id, name, sas),
            other => panic!("expected DevicePairingRequested, got {other:?}"),
        }
    }

    /// The trust store, as the desk reads it.
    fn devices(&mut self) -> Vec<DeviceInfo> {
        match self.command.request(&Request::ListDevices) {
            Response::Devices { devices, .. } => devices,
            other => panic!("expected Devices, got {other:?}"),
        }
    }
}

impl Drop for Workstation {
    fn drop(&mut self) {
        // This daemon and no other: the child this test started, by the
        // handle it was started with.
        let _ = self.daemon.kill();
        let _ = self.daemon.wait();
    }
}

fn device(relay: &LocalRelay, name: &str) -> TestDevice {
    TestDevice::new(name).unwrap().trusting(relay.certificate_der.clone())
}

fn eventually(what: &str, check: impl Fn() -> bool) {
    let deadline = Instant::now() + SOON;
    while !check() {
        assert!(Instant::now() < deadline, "{what}");
        std::thread::sleep(Duration::from_millis(20));
    }
}

// -- pairing ------------------------------------------------------------

#[test]
fn a_test_device_pairs_through_the_relay_and_the_row_appears_only_after_the_desk_confirms() {
    let relay = LocalRelay::start();
    let mut workstation = Workstation::start(&relay);
    workstation.reach(&relay);

    // The QR is what sets the Device up: where the Relay is, and the
    // token it asks for.
    let qr = workstation.offer();
    let scanned = PairingQr::parse(&qr).unwrap();
    assert_eq!(scanned.rendezvous, vec![relay.url()]);
    assert_eq!(scanned.relay_admission.as_deref(), Some(TOKEN));

    let device = device(&relay, "Seam one iPhone");
    let pairing = device.pair(&qr).unwrap();

    // Both sides show the same six digits.
    let (device_id, name, desk_code) = workstation.asked();
    assert_eq!(pairing.code, desk_code, "the two screens must show the same code");
    assert_eq!(desk_code.len(), 6);
    assert!(desk_code.chars().all(|c| c.is_ascii_digit()), "{desk_code}");
    assert_eq!(name, "Seam one iPhone");

    // The handshake is complete, the code is on both screens, and there
    // is still no Device: the desk has not confirmed.
    assert_eq!(workstation.devices(), vec![], "a row was written before the desk confirmed");

    let resp = workstation.command.request(&Request::ConfirmPairing { device_id: device_id.clone() });
    assert!(matches!(resp, Response::Ok), "{resp:?}");

    // The Device hears it from the Workstation, through the Relay.
    assert_eq!(
        pairing.verdict(SOON).unwrap(),
        PairingVerdict::Paired { device_id: device_id.clone() }
    );

    // And the row is there, read back the way the desk reads it.
    let devices = workstation.devices();
    assert_eq!(devices.len(), 1, "{devices:?}");
    assert_eq!(devices[0].device_id, device_id);
    assert_eq!(devices[0].name, "Seam one iPhone");
    assert_eq!(devices[0].role, "remote");
    assert_eq!(devices[0].revoked_at, None);

    // It all went through the Relay, and the Relay carried it as bytes.
    let stats = relay.relay.stats();
    assert_eq!(stats.streams, 1);
    assert!(stats.bytes > 0);
}

#[test]
fn a_rejected_pairing_leaves_no_row_and_tells_the_device() {
    let relay = LocalRelay::start();
    let mut workstation = Workstation::start(&relay);
    workstation.reach(&relay);

    let pairing = device(&relay, "not mine").pair(&workstation.offer()).unwrap();
    let (device_id, _, desk_code) = workstation.asked();
    assert_eq!(pairing.code, desk_code);

    let resp = workstation.command.request(&Request::RejectPairing { device_id: device_id.clone() });
    assert!(matches!(resp, Response::Ok), "{resp:?}");

    assert_eq!(pairing.verdict(SOON).unwrap(), PairingVerdict::Rejected);
    assert_eq!(workstation.devices(), vec![]);

    // A yes that arrives after the no finds nothing to confirm.
    match workstation.command.request(&Request::ConfirmPairing { device_id }) {
        Response::Error { message } => assert!(message.contains("no pairing waiting"), "{message}"),
        other => panic!("expected an Error, got {other:?}"),
    }
    assert_eq!(workstation.devices(), vec![]);
}

/// A Device that hangs up while the desk is still comparing digits takes
/// its pairing with it: a Confirm pressed afterwards is for a Device that
/// will never hear it.
#[test]
fn a_device_that_walks_away_cannot_be_confirmed() {
    let relay = LocalRelay::start();
    let mut workstation = Workstation::start(&relay);
    workstation.reach(&relay);

    let pairing = device(&relay, "gone").pair(&workstation.offer()).unwrap();
    let (device_id, _, _) = workstation.asked();

    pairing.abandon();
    eventually("the Relay let the stream go", || relay.relay.stats().streams_open == 0);
    // The daemon reads its end of the stream four times a second while
    // it waits on the desk, and the next read is what tells it. Nothing
    // the desk can observe says that it has, so this waits several of
    // those reads out.
    std::thread::sleep(QUIET);

    match workstation.command.request(&Request::ConfirmPairing { device_id }) {
        Response::Error { message } => assert!(message.contains("no pairing waiting"), "{message}"),
        Response::Ok => panic!("a Device that had gone was paired"),
        other => panic!("expected an Error, got {other:?}"),
    }
    assert_eq!(workstation.devices(), vec![]);
}

// -- admission ----------------------------------------------------------

#[test]
fn a_relay_connection_without_the_admission_token_is_refused() {
    let relay = LocalRelay::start();
    let mut workstation = Workstation::start(&relay);
    workstation.reach(&relay);
    let scanned = PairingQr::parse(&workstation.offer()).unwrap();

    // A Device that scanned everything but the token, and one that holds
    // a token this Relay never issued.
    for presented in [None, Some(""), Some("not-the-token")] {
        let mut offer = scanned.clone();
        offer.relay_admission = presented.map(str::to_string);
        match device(&relay, "uninvited").pair_with(&offer) {
            Err(TestDeviceError::Dial(DialError::Refused(RefusalReason::Admission))) => {}
            Err(other) => panic!("{presented:?}: expected an admission refusal, got {other}"),
            Ok(_) => panic!("{presented:?}: a Device without the token was carried"),
        }
    }
    assert_eq!(relay.relay.stats().refused_admission, 3);

    // Refused by the Relay, so it went no further: the Workstation was
    // handed no stream and the desk was asked nothing.
    assert_eq!(relay.relay.stats().streams, 0);
    assert!(
        workstation.push.hears_nothing_for(QUIET),
        "the desk was asked about a Device the Relay had refused"
    );
    assert_eq!(workstation.devices(), vec![]);

    // The same offer WITH the token pairs, so what was refused above was
    // the token and nothing else about the Device.
    let pairing = device(&relay, "invited").pair_with(&scanned).unwrap();
    let (_, _, desk_code) = workstation.asked();
    assert_eq!(pairing.code, desk_code);
}

/// The daemon is a peer like any other: one that holds no token, or the
/// wrong one, is not registered, and a Device looking for it is told the
/// Workstation is not there.
#[test]
fn a_daemon_without_the_admission_token_is_not_registered() {
    let relay = LocalRelay::start();
    let mut workstation = Workstation::start(&relay);

    workstation.set_remote_access(true, Some(&relay.url()), Some("not-the-token"));
    eventually("the Relay refused the daemon", || relay.relay.stats().refused_admission >= 1);
    assert_eq!(relay.relay.stats().workstations, 0);

    let mut offer = PairingQr::parse(&workstation.offer()).unwrap();
    assert_eq!(offer.relay_admission.as_deref(), Some("not-the-token"));
    // A Device that came by the right token some other way still finds
    // nobody to be carried to.
    offer.relay_admission = Some(TOKEN.to_string());
    match device(&relay, "early").pair_with(&offer) {
        Err(TestDeviceError::Dial(DialError::Refused(RefusalReason::Offline))) => {}
        Err(other) => panic!("expected the Workstation to be offline, got {other}"),
        Ok(_) => panic!("a daemon the Relay had refused was reached"),
    }

    // Given the token, the daemon is registered without being restarted.
    workstation.reach(&relay);
}

// -- the switch ---------------------------------------------------------

/// A listener that is not a Relay and does not need to be: what is
/// asserted is whether anything CONNECTS to the address the daemon was
/// given, which is one layer below anything a Relay would see.
struct Address {
    listener: TcpListener,
}

impl Address {
    fn listen() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        Self { listener }
    }

    fn url(&self) -> String {
        format!("ws://127.0.0.1:{}", self.listener.local_addr().unwrap().port())
    }

    /// Whether a connection arrives within `within`.
    fn is_dialled_within(&self, within: Duration) -> bool {
        let deadline = Instant::now() + within;
        loop {
            match self.listener.accept() {
                Ok(_) => return true,
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {}
                Err(e) => panic!("accept failed: {e}"),
            }
            if Instant::now() >= deadline {
                return false;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}

#[test]
fn with_remote_access_off_the_daemon_dials_nothing() {
    let relay = LocalRelay::start();
    let mut workstation = Workstation::start(&relay);
    let address = Address::listen();

    // Everything a dial needs is stored -- a Relay URL, a token -- and
    // the switch is off.
    workstation.set_remote_access(false, Some(&address.url()), Some(TOKEN));
    assert!(
        !address.is_dialled_within(QUIET),
        "the daemon dialled its Relay with remote access off; its log:\n{}",
        workstation.log()
    );

    // Pairing draws a QR and still dials nothing: the switch is what
    // decides, not whether there is something to dial for.
    let _ = workstation.offer();
    assert!(!address.is_dialled_within(QUIET), "pressing Pair a device dialled the Relay");

    // The assertion above has teeth: this is the same daemon, the same
    // address and the same listener, and the only thing that changes is
    // the switch.
    workstation.set_remote_access(true, Some(&address.url()), Some(TOKEN));
    assert!(
        address.is_dialled_within(SOON),
        "the daemon did not dial with remote access on; its log:\n{}",
        workstation.log()
    );
}

/// A daemon that has never been told anything -- every daemon, on the
/// day it is first started -- has remote access off.
#[test]
fn a_daemon_that_was_never_told_has_remote_access_off() {
    let relay = LocalRelay::start();
    let mut workstation = Workstation::start(&relay);
    match workstation.command.request(&Request::ListDevices) {
        Response::Devices { remote_access_enabled, relay_url, relay_admission_set, devices } => {
            assert!(!remote_access_enabled);
            assert_eq!(relay_url, None);
            assert!(!relay_admission_set);
            assert!(devices.is_empty());
        }
        other => panic!("expected Devices, got {other:?}"),
    }
    assert_eq!(relay.relay.stats().accepted, 0);
}

#[test]
fn turning_remote_access_off_drops_the_relay_connection() {
    let relay = LocalRelay::start();
    let mut workstation = Workstation::start(&relay);
    workstation.reach(&relay);
    assert_eq!(relay.relay.stats().workstations, 1);

    workstation.set_remote_access(false, Some(&relay.url()), None);
    eventually("the daemon let go of the Relay", || relay.relay.stats().workstations == 0);

    // And it stays let go: it does not dial again a moment later.
    let accepted = relay.relay.stats().accepted;
    std::thread::sleep(QUIET);
    assert_eq!(relay.relay.stats().accepted, accepted, "the daemon dialled again while off");
    assert_eq!(relay.relay.stats().workstations, 0);

    // A Device that scans now is told the Workstation is not there.
    let qr = workstation.offer();
    match device(&relay, "late").pair(&qr) {
        Err(TestDeviceError::Dial(DialError::Refused(RefusalReason::Offline))) => {}
        Err(other) => panic!("expected the Workstation to be offline, got {other}"),
        Ok(_) => panic!("a Workstation with remote access off was reached"),
    }

    // On again, with the token it kept: `None` above left it alone.
    workstation.set_remote_access(true, Some(&relay.url()), None);
    eventually("the daemon took the Relay up again", || relay.relay.stats().workstations == 1);
}

/// "Revoke all" rotates the Workstation's key. The daemon meets its
/// Devices under an id derived from that key, so it has to move: a
/// Device that pinned the old key asks for the old id, and nobody is
/// there.
#[test]
fn revoke_all_moves_the_workstation_to_a_new_rendezvous() {
    let relay = LocalRelay::start();
    let mut workstation = Workstation::start(&relay);
    workstation.reach(&relay);
    let before = PairingQr::parse(&workstation.offer()).unwrap();

    let resp = workstation.command.request(&Request::RevokeAllDevices);
    assert!(matches!(resp, Response::Ok), "{resp:?}");

    let after = PairingQr::parse(&workstation.offer()).unwrap();
    assert_ne!(after.daemon_public_key, before.daemon_public_key);

    // A pairing against the new key completes, so the daemon is
    // registered under the new id...
    let deadline = Instant::now() + SOON;
    let pairing = loop {
        match device(&relay, "after the rotation").pair_with(&after) {
            Ok(pairing) => break pairing,
            Err(TestDeviceError::Dial(DialError::Refused(RefusalReason::Offline)))
                if Instant::now() < deadline =>
            {
                std::thread::sleep(Duration::from_millis(50))
            }
            Err(other) => panic!("the daemon never moved to its new rendezvous: {other}"),
        }
    };
    let (_, _, desk_code) = workstation.asked();
    assert_eq!(pairing.code, desk_code);

    // ...and nobody is left under the old one.
    match device(&relay, "before the rotation").pair_with(&before) {
        Err(TestDeviceError::Dial(DialError::Refused(RefusalReason::Offline))) => {}
        Err(other) => panic!("expected nobody at the old rendezvous, got {other}"),
        Ok(_) => panic!("the old rendezvous still reached the Workstation"),
    }
}

/// Turning remote access off lets go of the Relay -- all of it. A Device
/// that was half-way through pairing is not left holding a stream the
/// desk can still confirm.
#[test]
fn a_device_half_way_through_pairing_is_let_go_when_remote_access_is_turned_off() {
    let relay = LocalRelay::start();
    let mut workstation = Workstation::start(&relay);
    workstation.reach(&relay);

    let pairing = device(&relay, "half way").pair(&workstation.offer()).unwrap();
    let (device_id, _, desk_code) = workstation.asked();
    assert_eq!(pairing.code, desk_code);
    assert_eq!(relay.relay.stats().streams_open, 1);

    workstation.set_remote_access(false, Some(&relay.url()), None);

    // The Device is told, rather than left showing six digits.
    assert_eq!(pairing.verdict(SOON).unwrap(), PairingVerdict::Expired);
    eventually("the daemon let go of the stream", || relay.relay.stats().streams_open == 0);
    eventually("the daemon let go of the Relay", || relay.relay.stats().workstations == 0);

    match workstation.command.request(&Request::ConfirmPairing { device_id }) {
        Response::Error { message } => assert!(message.contains("no pairing waiting"), "{message}"),
        Response::Ok => panic!("a pairing was confirmed with remote access off"),
        other => panic!("expected an Error, got {other:?}"),
    }
    assert_eq!(workstation.devices(), vec![]);
}

/// The trust store is shared by the dev build's daemon and the release
/// build's. What either app shows is what the store says, so a daemon
/// has to follow the store even when the daemon that changed it was the
/// other one -- which cannot tell it.
#[test]
fn a_change_made_by_another_daemon_is_followed() {
    let relay = LocalRelay::start();
    let mut workstation = Workstation::start(&relay);
    workstation.reach(&relay);

    workstation.another_daemon_writes("remote_access_enabled", "0");
    eventually("the daemon let go of the Relay it was told of by nobody", || {
        relay.relay.stats().workstations == 0
    });
    // What this daemon tells ITS desk agrees with what it is doing.
    match workstation.command.request(&Request::ListDevices) {
        Response::Devices { remote_access_enabled, .. } => assert!(!remote_access_enabled),
        other => panic!("expected Devices, got {other:?}"),
    }
    match device(&relay, "late").pair(&workstation.offer()) {
        Err(TestDeviceError::Dial(DialError::Refused(RefusalReason::Offline))) => {}
        Err(other) => panic!("expected the Workstation to be offline, got {other}"),
        Ok(_) => panic!("a Workstation whose store says off was reached"),
    }

    workstation.another_daemon_writes("remote_access_enabled", "1");
    eventually("the daemon took the Relay up again", || relay.relay.stats().workstations == 1);

    // And a token the other daemon was given is the one this one dials
    // with from then on.
    workstation.another_daemon_writes("remote_access_relay_admission", "not-the-token");
    eventually("the daemon dialled with the token the store now holds", || {
        relay.relay.stats().refused_admission >= 1 && relay.relay.stats().workstations == 0
    });
}

// -- a Device that does not behave ----------------------------------------

/// A Device the Relay admitted, picked up by the daemon, that then says
/// nothing at all.
fn silent_device(relay: &LocalRelay, offer: &PairingQr) -> std::thread::JoinHandle<Result<RelayConnection, DialError>> {
    let url = relay.url();
    let key = protocol::hex_decode(&offer.daemon_public_key).unwrap();
    let hello = RelayHello::device(TOKEN, &rendezvous_id(&key), PURPOSE_PAIR);
    let options =
        DialOptions { extra_roots: vec![relay.certificate_der.clone()], ..DialOptions::default() };
    std::thread::spawn(move || dial(&url, &hello, &options))
}

/// Anything the Relay admits can ask to pair, and a stream that is
/// picked up costs the daemon a thread. A peer that is picked up and
/// then says nothing is given up on, so that however many of them there
/// are, the owner's Device still gets to pair.
#[test]
fn devices_that_say_nothing_do_not_keep_the_owner_from_pairing() {
    let relay = LocalRelay::start();
    let mut workstation = Workstation::start(&relay);
    workstation.reach(&relay);
    let offer = PairingQr::parse(&workstation.offer()).unwrap();

    // More than the daemon serves at once. The ones it picks up are
    // held open and never spoken on; the rest it leaves to the Relay.
    let silent: Vec<_> = (0..6).map(|_| silent_device(&relay, &offer)).collect();
    eventually("the daemon picked up as many as it serves at once", || {
        relay.relay.stats().streams_open == 4
    });
    assert_eq!(relay.relay.stats().streams, 4, "the daemon served every stream it was offered");

    // Given up on, all of them, in the time one read of the handshake
    // is allowed.
    eventually("the daemon gave up on the Devices that said nothing", || {
        relay.relay.stats().streams_open == 0
    });
    let held: Vec<_> = silent.into_iter().map(|s| s.join().unwrap()).collect();
    assert_eq!(held.iter().filter(|h| h.is_ok()).count(), 4);
    for left in held.iter().filter_map(|h| h.as_ref().err()) {
        assert!(
            matches!(left, DialError::Refused(RefusalReason::Unclaimed)),
            "expected the rest to be left unclaimed, got {left}"
        );
    }
    assert!(workstation.push.hears_nothing_for(Duration::from_millis(200)));

    // None of them used the secret, so the owner's Device pairs on the
    // QR that is still on the desk.
    let pairing = device(&relay, "the owner").pair_with(&offer).unwrap();
    let (device_id, name, desk_code) = workstation.asked();
    assert_eq!(name, "the owner");
    assert_eq!(pairing.code, desk_code);
    let resp = workstation.command.request(&Request::ConfirmPairing { device_id: device_id.clone() });
    assert!(matches!(resp, Response::Ok), "{resp:?}");
    assert_eq!(pairing.verdict(SOON).unwrap(), PairingVerdict::Paired { device_id });
    drop(held);
}

/// 05 §3: "a completed handshake spends it". A second Device that holds
/// the same QR -- a photograph of the screen -- gets no further than the
/// first one's success.
#[test]
fn a_secret_pairs_one_device() {
    let relay = LocalRelay::start();
    let mut workstation = Workstation::start(&relay);
    workstation.reach(&relay);
    let offer = PairingQr::parse(&workstation.offer()).unwrap();

    let first = device(&relay, "first").pair_with(&offer).unwrap();
    let (first_id, name, _) = workstation.asked();
    assert_eq!(name, "first");

    // The offer is spent, so the daemon does not pick a second stream up
    // at all.
    match device(&relay, "second").pair_with(&offer) {
        Err(TestDeviceError::Dial(DialError::Refused(RefusalReason::Unclaimed))) => {}
        Err(other) => panic!("expected the stream to be left unclaimed, got {other}"),
        Ok(_) => panic!("one secret reached the code stage twice"),
    }
    assert!(workstation.push.hears_nothing_for(Duration::from_millis(200)));

    let resp = workstation.command.request(&Request::ConfirmPairing { device_id: first_id.clone() });
    assert!(matches!(resp, Response::Ok), "{resp:?}");
    assert_eq!(first.verdict(SOON).unwrap(), PairingVerdict::Paired { device_id: first_id });
    assert_eq!(workstation.devices().len(), 1);
}

// -- the secret ---------------------------------------------------------

#[test]
fn a_wrong_secret_fails_the_handshake() {
    let relay = LocalRelay::start();
    let mut workstation = Workstation::start(&relay);
    workstation.reach(&relay);

    let scanned = PairingQr::parse(&workstation.offer()).unwrap();
    let mut photographed_too_late = scanned.clone();
    // The right Workstation, the right Relay, the right token, and a
    // secret that is not this offer's.
    photographed_too_late.secret = "5a".repeat(32);
    assert_ne!(photographed_too_late.secret, scanned.secret);

    // The Device cannot tell from its own side -- it has sent its last
    // message and computed a code -- so what it sees is a Workstation
    // that lets go without a word.
    let pairing = device(&relay, "attacker").pair_with(&photographed_too_late).unwrap();
    match pairing.verdict(SOON) {
        Err(TestDeviceError::Closed) => {}
        Err(other) => panic!("expected the Workstation to end the pairing, got {other}"),
        Ok(verdict) => panic!("a wrong secret reached a verdict: {verdict:?}"),
    }

    // The desk was never asked, and nothing was written.
    assert!(
        workstation.push.hears_nothing_for(QUIET),
        "the desk was asked to confirm a Device that did not hold the secret"
    );
    assert_eq!(workstation.devices(), vec![]);
    assert!(
        workstation.log().contains("does not match"),
        "the daemon should say why; its log:\n{}",
        workstation.log()
    );

    // The offer is not spent by a handshake that failed: the Device that
    // does hold the secret still pairs. So what failed above was the
    // secret, not the wire.
    let pairing = device(&relay, "the owner").pair_with(&scanned).unwrap();
    let (device_id, name, desk_code) = workstation.asked();
    assert_eq!(name, "the owner");
    assert_eq!(pairing.code, desk_code);
    let resp = workstation.command.request(&Request::ConfirmPairing { device_id: device_id.clone() });
    assert!(matches!(resp, Response::Ok), "{resp:?}");
    assert_eq!(pairing.verdict(SOON).unwrap(), PairingVerdict::Paired { device_id });
}

/// The other thing the Device checks for itself: that the Workstation
/// which answers is the one whose QR it scanned. A QR naming another key
/// meets at another rendezvous, where this Workstation is not.
#[test]
fn a_qr_naming_another_workstation_does_not_reach_this_one() {
    let relay = LocalRelay::start();
    let mut workstation = Workstation::start(&relay);
    workstation.reach(&relay);

    let mut offer = PairingQr::parse(&workstation.offer()).unwrap();
    offer.daemon_public_key = "7b".repeat(32);

    match device(&relay, "lost").pair_with(&offer) {
        Err(TestDeviceError::Dial(DialError::Refused(RefusalReason::Offline))) => {}
        Err(other) => panic!("expected nobody at that rendezvous, got {other}"),
        Ok(_) => panic!("a QR for another Workstation reached this one"),
    }
    assert!(workstation.push.hears_nothing_for(QUIET));
}
