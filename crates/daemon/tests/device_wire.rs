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
//! desktop app holds, the push one and the command one -- and, for the
//! forwarding tests, a scripted stand-in on the Forward connection.
//!
//! What each test asserts is what one of those three parties would
//! observe -- six digits, a refusal, a row in a list read back later, a
//! socket nobody connected to.

use companion_core::connect::PairedWorkstation;
use companion_core::pairing::RelayDial;
use companion_core::test_device::{Connection, Meddling, Proving, TestDevice, TestDeviceError};
use companion_core::CoreError;
use gavin_relay::client::{dial, DialError, DialOptions, RelayConnection};
use gavin_relay::server::{RelayConfig, RunningRelay, Tls};
use protocol::device_wire::{ConnectRefusal, PairingVerdict};
use protocol::relay::{rendezvous_id, RefusalReason, RelayHello, PURPOSE_CONNECT, PURPOSE_PAIR};
use protocol::transport::{Endpoint, Stream};
use protocol::{
    read_message, write_message, ConnectionKind, DeviceInfo, HelloAuth, PairingQr, Request,
    Response,
};
use std::io::{BufReader, Read, Write};
use std::net::TcpListener;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
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
    /// What the desktop app proves itself to its daemon with.
    daemon_token: String,
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
        Self { home, data, daemon, daemon_token, push, command }
    }

    /// The trust store's file, opened the way ANOTHER daemon sharing it
    /// would open it.
    fn store(&self) -> rusqlite::Connection {
        let store = rusqlite::Connection::open(self.data.join("devices.sqlite")).unwrap();
        store.busy_timeout(SOON).unwrap();
        store
    }

    /// Writes one remote-access setting straight into the trust store,
    /// the way ANOTHER daemon sharing it would: the dev build's and the
    /// release build's open the same `devices.sqlite`, and neither can
    /// tell the other what it wrote.
    fn another_daemon_writes(&self, key: &str, value: &str) {
        self.store()
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

    /// The names of the Devices in the trust store, as the desk reads
    /// them.
    fn device_names(&mut self) -> Vec<String> {
        self.devices().into_iter().map(|d| d.name).collect()
    }

    /// Pairs `device` at this desk: the scan, the six digits compared,
    /// Confirm pressed. Returns what the Device keeps.
    fn pair(&mut self, device: &TestDevice) -> PairedWorkstation {
        let pairing = device.pair(&self.offer()).unwrap();
        let (device_id, name, desk_code) = self.asked();
        assert_eq!(name, device.name);
        assert_eq!(pairing.code, desk_code, "the two screens must show the same code");
        let resp = self.command.request(&Request::ConfirmPairing { device_id: device_id.clone() });
        assert!(matches!(resp, Response::Ok), "{resp:?}");
        let paired = pairing.paired(SOON).unwrap();
        assert_eq!(paired.device_id, device_id);
        paired
    }

    /// The Device the desk is told has connected.
    fn connected(&mut self) -> String {
        match self.push.next() {
            Response::DeviceConnected { device_id } => device_id,
            other => panic!("expected DeviceConnected, got {other:?}"),
        }
    }

    /// The Device the desk is told has gone.
    fn disconnected(&mut self) -> String {
        match self.push.next() {
            Response::DeviceDisconnected { device_id } => device_id,
            other => panic!("expected DeviceDisconnected, got {other:?}"),
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

/// The id a Device was paired under, out of the verdict that says it
/// was.
fn paired_as(verdict: PairingVerdict) -> String {
    match verdict {
        PairingVerdict::Paired { device_id, notification_key } => {
            assert_eq!(notification_key.len(), 64, "a notification key is 32 bytes of hex");
            device_id
        }
        other => panic!("expected the Device to be paired, got {other:?}"),
    }
}

fn eventually(what: &str, check: impl Fn() -> bool) {
    let deadline = Instant::now() + SOON;
    while !check() {
        assert!(Instant::now() < deadline, "{what}");
        std::thread::sleep(Duration::from_millis(20));
    }
}

impl Workstation {
    /// The daemon's local endpoint, for a desk connection this test opens
    /// itself (the forwarding stand-in).
    fn endpoint(&self) -> Endpoint {
        Endpoint::new(self.data.join(protocol::profile_file_name(
            "daemon",
            "sock",
            protocol::BuildProfile::current(),
        )))
    }

    /// Opens the desktop's forwarding connection (v47).
    fn open_forwarding(&self) -> Desk {
        Desk::connect(&self.endpoint(), &self.daemon_token, ConnectionKind::Forward)
    }
}

/// A scripted desktop stand-in on the forwarding connection: answers
/// every `ForwardCommand` with a fixed value, and can offer events.
struct StandIn {
    /// What reached it, in order.
    received: Arc<Mutex<Vec<(String, serde_json::Value)>>>,
    /// Stop the loop.
    stop: Arc<std::sync::atomic::AtomicBool>,
    join: Option<std::thread::JoinHandle<()>>,
    /// Sends an event to offer, from the test thread.
    offer: Option<std::sync::mpsc::Sender<(String, serde_json::Value)>>,
}

impl StandIn {
    /// Answers every forwarded command with `value`.
    fn answering(mut desk: Desk, value: serde_json::Value) -> Self {
        let received = Arc::new(Mutex::new(Vec::new()));
        let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let (offer_tx, offer_rx) = std::sync::mpsc::channel::<(String, serde_json::Value)>();
        let received_thread = Arc::clone(&received);
        let stop_thread = Arc::clone(&stop);
        let join = std::thread::spawn(move || {
            desk.stream.set_read_timeout(Some(Duration::from_millis(50))).unwrap();
            while !stop_thread.load(std::sync::atomic::Ordering::SeqCst) {
                while let Ok((event, payload)) = offer_rx.try_recv() {
                    let resp = desk.request(&Request::OfferDesktopEvent { event, payload });
                    assert!(matches!(resp, Response::Ok), "{resp:?}");
                }
                match read_message::<_, Response>(&mut desk.reader) {
                    Ok(Some(Response::ForwardCommand { call_id, command, args })) => {
                        received_thread.lock().unwrap().push((command, args));
                        let resp = desk.request(&Request::ForwardResult {
                            call_id,
                            value: Some(value.clone()),
                            error: None,
                        });
                        assert!(matches!(resp, Response::Ok), "{resp:?}");
                    }
                    Ok(Some(other)) => panic!("stand-in saw {other:?}"),
                    Ok(None) => break,
                    Err(e) => {
                        let msg = format!("{e:#}");
                        if msg.contains("timed out")
                            || msg.contains("WouldBlock")
                            || msg.contains("Resource temporarily unavailable")
                        {
                            continue;
                        }
                        break;
                    }
                }
            }
        });
        Self {
            received,
            stop,
            join: Some(join),
            offer: Some(offer_tx),
        }
    }

    fn received(&self) -> Vec<(String, serde_json::Value)> {
        self.received.lock().unwrap().clone()
    }

    fn offer_event(&self, event: &str, payload: serde_json::Value) {
        self.offer
            .as_ref()
            .unwrap()
            .send((event.to_string(), payload))
            .unwrap();
        // Give the stand-in a moment to write it.
        std::thread::sleep(Duration::from_millis(80));
    }
}

impl Drop for StandIn {
    fn drop(&mut self) {
        self.stop.store(true, std::sync::atomic::Ordering::SeqCst);
        self.offer.take();
        if let Some(join) = self.join.take() {
            let _ = join.join();
        }
    }
}

// -- forwarding (companion-12) ------------------------------------------

/// An allowed command reaches the stand-in, and its result returns.
#[test]
fn an_allowed_command_reaches_the_stand_in_and_its_result_returns() {
    let relay = LocalRelay::start();
    let mut workstation = Workstation::start(&relay);
    workstation.reach(&relay);
    let device = device(&relay, "Seam one iPhone");
    let paired = workstation.pair(&device);
    let mut connection = device.connect(&paired).unwrap();
    assert_eq!(workstation.connected(), paired.device_id);

    let stand_in = StandIn::answering(
        workstation.open_forwarding(),
        serde_json::json!({"columns": [], "labels": []}),
    );

    let args = serde_json::json!({"workspaceId": "w1"});
    match connection
        .request(
            &Request::InvokeDesktop { command: "get_board".into(), args: args.clone() },
            SOON,
        )
        .unwrap()
    {
        Response::DesktopResult { value, error } => {
            assert_eq!(error, None);
            assert_eq!(value, Some(serde_json::json!({"columns": [], "labels": []})));
        }
        other => panic!("expected DesktopResult, got {other:?}"),
    }

    eventually("the stand-in saw the command", || {
        stand_in.received() == vec![("get_board".into(), args.clone())]
    });
}

/// Trust and layout-saving commands are refused before any forwarding.
#[test]
fn trust_and_layout_commands_are_refused_before_any_forwarding() {
    let relay = LocalRelay::start();
    let mut workstation = Workstation::start(&relay);
    workstation.reach(&relay);
    let device = device(&relay, "Seam one iPhone");
    let paired = workstation.pair(&device);
    let mut connection = device.connect(&paired).unwrap();
    let _ = workstation.connected();

    let stand_in = StandIn::answering(workstation.open_forwarding(), serde_json::json!(null));

    for command in [
        "begin_pairing",
        "list_devices",
        "revoke_device",
        "set_remote_access",
        "set_workspaces_state",
        "set_board_tabs",
        "set_file_tabs",
        "set_card_tabs",
    ] {
        match connection
            .request(
                &Request::InvokeDesktop {
                    command: command.into(),
                    args: serde_json::json!({}),
                },
                SOON,
            )
            .unwrap()
        {
            Response::Error { message } => {
                assert!(
                    message.contains("may not invoke") && message.contains(command),
                    "{command}: {message}"
                );
            }
            other => panic!("{command} was answered {other:?}"),
        }
    }

    assert_eq!(stand_in.received(), vec![], "a refused command reached the stand-in");
}

/// An unknown command name is refused.
#[test]
fn an_unknown_command_name_is_refused() {
    let relay = LocalRelay::start();
    let mut workstation = Workstation::start(&relay);
    workstation.reach(&relay);
    let device = device(&relay, "Seam one iPhone");
    let paired = workstation.pair(&device);
    let mut connection = device.connect(&paired).unwrap();
    let _ = workstation.connected();

    let stand_in = StandIn::answering(workstation.open_forwarding(), serde_json::json!(null));

    match connection
        .request(
            &Request::InvokeDesktop {
                command: "not_a_real_command".into(),
                args: serde_json::json!({}),
            },
            SOON,
        )
        .unwrap()
    {
        Response::Error { message } => {
            assert!(message.contains("unknown desktop command"), "{message}");
        }
        other => panic!("expected Error, got {other:?}"),
    }
    assert_eq!(stand_in.received(), vec![]);
}

/// Events reach only the Devices that subscribed.
#[test]
fn events_reach_only_the_devices_that_subscribed() {
    let relay = LocalRelay::start();
    let mut workstation = Workstation::start(&relay);
    workstation.reach(&relay);
    let listening = device(&relay, "Listening");
    let quiet = device(&relay, "Quiet");
    let paired_listening = workstation.pair(&listening);
    let paired_quiet = workstation.pair(&quiet);

    let mut listening_conn = listening.connect(&paired_listening).unwrap();
    assert_eq!(workstation.connected(), paired_listening.device_id);
    let mut quiet_conn = quiet.connect(&paired_quiet).unwrap();
    assert_eq!(workstation.connected(), paired_quiet.device_id);

    let stand_in = StandIn::answering(workstation.open_forwarding(), serde_json::json!(null));

    match listening_conn
        .request(&Request::ListenDesktop { event: "status-changed".into() }, SOON)
        .unwrap()
    {
        Response::Ok => {}
        other => panic!("expected Ok, got {other:?}"),
    }
    // Quiet never listens.

    stand_in.offer_event("status-changed", serde_json::json!({"id": "s1", "status": "idle"}));

    match listening_conn.next(SOON).unwrap() {
        Response::DesktopEvent { event, payload } => {
            assert_eq!(event, "status-changed");
            assert_eq!(payload, serde_json::json!({"id": "s1", "status": "idle"}));
        }
        other => panic!("expected DesktopEvent, got {other:?}"),
    }

    // The quiet Device must not see it.
    match quiet_conn.next(Duration::from_millis(400)) {
        Err(TestDeviceError::TimedOut) => {}
        Ok(Response::DesktopEvent { .. }) => {
            panic!("a Device that did not listen got an event")
        }
        other => panic!("expected silence, got {other:?}"),
    }
}

/// "desktop app not running" is answered when the stand-in is absent.
#[test]
fn desktop_app_not_running_is_answered_when_the_stand_in_is_absent() {
    let relay = LocalRelay::start();
    let mut workstation = Workstation::start(&relay);
    workstation.reach(&relay);
    let device = device(&relay, "Seam one iPhone");
    let paired = workstation.pair(&device);
    let mut connection = device.connect(&paired).unwrap();
    let _ = workstation.connected();

    // Push and command are live; the forwarding connection is not.
    match connection
        .request(
            &Request::InvokeDesktop {
                command: "get_board".into(),
                args: serde_json::json!({}),
            },
            SOON,
        )
        .unwrap()
    {
        Response::Error { message } => {
            assert!(
                message.contains("desktop app not running"),
                "{message}"
            );
        }
        other => panic!("expected Error, got {other:?}"),
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
    assert_eq!(paired_as(pairing.verdict(SOON).unwrap()), device_id);

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
    silent_stream(relay, &offer.daemon_public_key, PURPOSE_PAIR)
}

/// A stream for `purpose` to the Workstation holding `workstation_key`,
/// on which nothing has been said.
fn silent_stream(
    relay: &LocalRelay,
    workstation_key: &str,
    purpose: &'static str,
) -> std::thread::JoinHandle<Result<RelayConnection, DialError>> {
    let url = relay.url();
    let key = protocol::hex_decode(workstation_key).unwrap();
    let hello = RelayHello::device(TOKEN, &rendezvous_id(&key), purpose);
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
    assert_eq!(paired_as(pairing.verdict(SOON).unwrap()), device_id);
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
    assert_eq!(paired_as(first.verdict(SOON).unwrap()), first_id);
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
    assert_eq!(paired_as(pairing.verdict(SOON).unwrap()), device_id);
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

// -- connecting -----------------------------------------------------------

/// What the Remote role is refused: a reading of every kind a Device
/// might try, and the Trust requests above all.
fn refused_to_a_device() -> Vec<Request> {
    vec![
        Request::GetProtocolVersion,
        Request::ListSessions,
        Request::CreateSession { workspace_path: "/tmp".into(), cwd: "/tmp".into(), command: None },
        Request::WriteInput { id: "s".into(), data: "rm -rf ~\n".into() },
        Request::BeginPairing,
        Request::ListDevices,
        Request::RevokeAllDevices,
        Request::SetRemoteAccess { enabled: false, relay_url: None, relay_admission: None },
        Request::Shutdown,
    ]
}

fn assert_refused(connection: &mut Connection, request: &Request) {
    match connection.request(request, SOON) {
        Ok(Response::Forbidden { role, .. }) => assert_eq!(role, "remote", "{request:?}"),
        other => panic!("{request:?} was answered {other:?}"),
    }
}

/// The card's first criterion: "a valid `IK` and signature get the
/// Remote role".
#[test]
fn a_paired_device_connects_and_is_given_the_remote_role() {
    let relay = LocalRelay::start();
    let mut workstation = Workstation::start(&relay);
    workstation.reach(&relay);
    let device = device(&relay, "Seam one iPhone");
    let paired = workstation.pair(&device);
    let streams = relay.relay.stats().streams;

    let mut connection = device.connect(&paired).unwrap();

    assert_eq!(connection.device_id, paired.device_id);
    // The desk is told who is on.
    assert_eq!(workstation.connected(), paired.device_id);
    // Through the Relay, as one more stream it copied.
    assert_eq!(relay.relay.stats().streams, streams + 1);
    assert_eq!(relay.relay.stats().streams_open, 1);

    // The Remote role refuses the daemon's own requests: everything a
    // Device might try that is not RemoveThisDevice or a forwarded
    // desktop command. Trust above all.
    for request in refused_to_a_device() {
        assert_refused(&mut connection, &request);
    }

    connection.close();
    assert_eq!(workstation.disconnected(), paired.device_id);
    eventually("the Relay let the stream go", || relay.relay.stats().streams_open == 0);

    // And again: a Device connects as often as it likes.
    let mut again = device.connect(&paired).unwrap();
    assert_eq!(workstation.connected(), paired.device_id);
    assert_refused(&mut again, &Request::ListSessions);
}

/// The spec's seam 1: "pairing over the Relay registers the hardware
/// key". What the row holds is what the Device's hardware holds the
/// private half of, and the notification key is the one the Device was
/// told.
#[test]
fn pairing_through_the_relay_registers_the_hardware_key() {
    let relay = LocalRelay::start();
    let mut workstation = Workstation::start(&relay);
    workstation.reach(&relay);
    let device = device(&relay, "Seam one iPhone");

    let paired = workstation.pair(&device);

    let (noise, hardware, notification): (Vec<u8>, Vec<u8>, Vec<u8>) = workstation
        .store()
        .query_row(
            "SELECT public_key, hardware_key, notification_key FROM devices WHERE device_id = ?1",
            [&paired.device_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap();
    assert_eq!(noise, device.keys.public);
    assert_eq!(hardware, device.hardware.public());
    assert_eq!(hardware.len(), 65);
    assert_eq!(notification, paired.notification_key);
    assert_eq!(notification.len(), 32);

    // The desk's list carries neither: a screen has no use for a key.
    let listed = serde_json::to_string(&workstation.devices()).unwrap();
    assert!(!listed.contains(&protocol::hex_encode(&hardware)), "{listed}");
    assert!(!listed.contains(&protocol::hex_encode(&notification)), "{listed}");
}

/// A pairing whose proof does not verify never reaches the desk: a
/// Device that cannot sign with the key it registers is one that could
/// never connect.
#[test]
fn a_pairing_whose_proof_does_not_verify_asks_the_desk_nothing() {
    let relay = LocalRelay::start();
    let mut workstation = Workstation::start(&relay);
    workstation.reach(&relay);
    let offer = PairingQr::parse(&workstation.offer()).unwrap();

    let another = device(&relay, "another phone").hardware;
    for (how, proving) in [
        ("signed by another key", Proving::With(another)),
        ("not a signature", Proving::Saying(b"trust me".to_vec())),
        ("not a proof", Proving::Instead(b"{\"type\":\"ListSessions\"}\n".to_vec())),
    ] {
        let pairing = device(&relay, how).proving(proving).pair_with(&offer).unwrap();
        match pairing.verdict(SOON) {
            Err(TestDeviceError::Closed) => {}
            other => panic!("{how}: expected the Workstation to end the pairing, got {other:?}"),
        }
    }
    assert!(workstation.push.hears_nothing_for(QUIET), "the desk was asked about one of them");
    assert_eq!(workstation.devices(), vec![]);

    // None of them spent the secret: the owner's Device pairs on the QR
    // that is still on the desk.
    let owner = device(&relay, "the owner");
    let pairing = owner.pair_with(&offer).unwrap();
    let (_, name, desk_code) = workstation.asked();
    assert_eq!(name, "the owner");
    assert_eq!(pairing.code, desk_code);
}

/// The card's first criterion, its second half: "a missing or wrong
/// signature gets no request answered".
#[test]
fn a_device_that_sends_no_signature_gets_no_request_answered() {
    let relay = LocalRelay::start();
    let mut workstation = Workstation::start(&relay);
    workstation.reach(&relay);
    let device = device(&relay, "Seam one iPhone");
    let paired = workstation.pair(&device);

    // A Device that completes the handshake and goes straight to its
    // first request. It asks to be removed, which a Device that had
    // proved itself would be granted.
    let skipping =
        device.clone().proving(Proving::Instead(b"{\"type\":\"RemoveThisDevice\"}\n".to_vec()));
    match skipping.connect(&paired) {
        Err(TestDeviceError::Refused(ConnectRefusal::Unlock)) => {}
        Err(other) => panic!("expected the proof to be asked for, got {other}"),
        Ok(_) => panic!("a Device that proved nothing was connected"),
    }

    // Nothing was answered and nothing was done: the desk heard of no
    // connection, and the row the request named is where it was.
    assert!(workstation.push.hears_nothing_for(QUIET), "the desk was told of a connection");
    assert_eq!(workstation.device_names(), vec!["Seam one iPhone"]);
    eventually("the daemon let the stream go", || relay.relay.stats().streams_open == 0);

    // What was refused was the proof and nothing else about the Device.
    device.connect(&paired).unwrap();
    assert_eq!(workstation.connected(), paired.device_id);
}

/// ADR 0001: "a copied Noise key therefore gets an attacker nothing".
#[test]
fn a_copied_noise_key_on_another_phone_is_refused() {
    let relay = LocalRelay::start();
    let mut workstation = Workstation::start(&relay);
    workstation.reach(&relay);
    let device = device(&relay, "Seam one iPhone");
    let paired = workstation.pair(&device);

    // Everything the Companion keeps in software, on a phone whose
    // hardware holds a key of its own.
    let copy = device.copied_to_another_phone().unwrap();
    assert_eq!(copy.keys.public, device.keys.public);
    assert_ne!(copy.hardware.public(), device.hardware.public());
    match copy.connect(&paired) {
        Err(TestDeviceError::Refused(ConnectRefusal::Unlock)) => {}
        Err(other) => panic!("expected the signature to be refused, got {other}"),
        Ok(_) => panic!("a copy of the Noise key was connected"),
    }

    // And a signature that is not one at all.
    for said in [Vec::new(), vec![0x30; 70], b"trust me".to_vec()] {
        match device.clone().proving(Proving::Saying(said.clone())).connect(&paired) {
            Err(TestDeviceError::Refused(ConnectRefusal::Unlock)) => {}
            Err(other) => panic!("{said:?}: expected the signature to be refused, got {other}"),
            Ok(_) => panic!("{said:?} was taken for a signature"),
        }
    }
    assert!(workstation.push.hears_nothing_for(QUIET), "the desk was told of a connection");
    assert!(
        workstation.log().contains("did not prove it is unlocked"),
        "the daemon should say why; its log:\n{}",
        workstation.log()
    );
}

/// A peer the Relay admitted, picked up by the daemon, that says nothing
/// at all: given up on, as the ones that ask to pair are.
#[test]
fn a_stream_that_connects_and_says_nothing_is_given_up_on() {
    let relay = LocalRelay::start();
    let mut workstation = Workstation::start(&relay);
    workstation.reach(&relay);
    let key = PairingQr::parse(&workstation.offer()).unwrap().daemon_public_key;

    let silent = silent_stream(&relay, &key, PURPOSE_CONNECT);
    eventually("the daemon picked the stream up", || relay.relay.stats().streams_open == 1);
    eventually("the daemon gave up on it", || relay.relay.stats().streams_open == 0);
    assert!(silent.join().unwrap().is_ok(), "the stream was carried, and then let go");
    assert!(workstation.push.hears_nothing_for(Duration::from_millis(200)));
}

// -- a Relay that does more than copy --------------------------------------

fn altering(nth: usize) -> impl Fn(usize, Vec<u8>) -> Vec<Vec<u8>> + Send + Sync + 'static {
    move |n, mut bytes| {
        if n == nth {
            let middle = bytes.len() / 2;
            bytes[middle] ^= 0x01;
        }
        vec![bytes]
    }
}

/// The card's second criterion, the handshake's half: "a Relay that
/// replays or tampers causes a failed handshake".
#[test]
fn a_relay_that_alters_the_handshake_causes_it_to_fail() {
    let relay = LocalRelay::start();
    let mut workstation = Workstation::start(&relay);
    workstation.reach(&relay);
    let device = device(&relay, "Seam one iPhone");
    let paired = workstation.pair(&device);

    // The Device's first message, altered on its way to the Workstation.
    // It no longer opens, and the Workstation lets go without a word.
    let first_altered = device.clone().through(Meddling::none().outbound(altering(0)));
    match first_altered.connect(&paired) {
        Err(TestDeviceError::Closed) => {}
        Err(other) => panic!("expected the Workstation to let go, got {other}"),
        Ok(_) => panic!("an altered first message completed a handshake"),
    }
    assert!(
        workstation.log().contains("not addressed to this Workstation's key"),
        "the daemon should say why; its log:\n{}",
        workstation.log()
    );

    // The Workstation's answer, altered on its way to the Device.
    let answer_altered = device.clone().through(Meddling::none().inbound(|n, mut bytes| {
        if n == 0 {
            bytes[10] ^= 0x01;
        }
        bytes
    }));
    match answer_altered.connect(&paired) {
        Err(TestDeviceError::Core(CoreError::Handshake(_))) => {}
        Err(other) => panic!("expected the handshake to fail, got {other}"),
        Ok(_) => panic!("an altered answer completed a handshake"),
    }

    // The Device's proof, altered: it does not open, so it proves
    // nothing.
    let proof_altered = device.clone().through(Meddling::none().outbound(altering(1)));
    match proof_altered.connect(&paired) {
        Err(TestDeviceError::Refused(ConnectRefusal::Unlock)) => {}
        Err(other) => panic!("expected the proof to be refused, got {other}"),
        Ok(_) => panic!("an altered proof was verified"),
    }

    // None of the three was a connection.
    assert!(workstation.push.hears_nothing_for(QUIET), "the desk was told of a connection");

    // Untouched, the same Device connects: what failed was what the
    // Relay did, not the pairing.
    device.connect(&paired).unwrap();
    assert_eq!(workstation.connected(), paired.device_id);
}

/// "A whole recorded handshake replays into a failed handshake"
/// (`05-remote-access.md` §8). The Relay saw every byte of a connection
/// that was served, and plays them to the Workstation again.
#[test]
fn a_relay_that_replays_a_recorded_connection_is_given_nothing() {
    let relay = LocalRelay::start();
    let mut workstation = Workstation::start(&relay);
    workstation.reach(&relay);
    let device = device(&relay, "Seam one iPhone");
    let paired = workstation.pair(&device);

    let recorded: Arc<Mutex<Vec<Vec<u8>>>> = Arc::default();
    let tape = Arc::clone(&recorded);
    let recording = device.clone().through(Meddling::none().outbound(move |_, bytes| {
        tape.lock().unwrap().push(bytes.clone());
        vec![bytes]
    }));
    let mut connection = recording.connect(&paired).unwrap();
    assert_eq!(workstation.connected(), paired.device_id);
    // A request a Device is granted, so that a replay that was served
    // would show: the row would go.
    assert_refused(&mut connection, &Request::ListSessions);
    connection.send(&Request::RemoveThisDevice).unwrap();
    assert!(matches!(connection.next(SOON), Ok(Response::Ok)));
    assert!(connection.is_dropped(SOON));
    assert_eq!(workstation.disconnected(), paired.device_id);
    assert_eq!(workstation.devices(), vec![]);
    let recorded = recorded.lock().unwrap().clone();
    assert_eq!(recorded.len(), 4, "the handshake, the proof and two requests");

    // The Device pairs again -- the same install, so the same keys --
    // and the Relay plays its recording.
    let paired = workstation.pair(&device);
    let mut replay =
        silent_stream(&relay, &protocol::hex_encode(&paired.workstation_key), PURPOSE_CONNECT)
            .join()
            .unwrap()
            .unwrap()
            .into_stream();
    for bytes in &recorded {
        // The Workstation hangs up part of the way through, and that is
        // the point: what could not be written was not read either.
        if replay.write_all(bytes).and_then(|_| replay.flush()).is_err() {
            break;
        }
    }
    replay.set_read_timeout(Some(SOON)).unwrap();
    let mut heard = Vec::new();
    let mut buf = [0u8; 4096];
    loop {
        match replay.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => heard.extend_from_slice(&buf[..n]),
            Err(e) => panic!("the Workstation did not end the replayed stream: {e}"),
        }
    }

    // What came back is the Workstation's half of a handshake and one
    // frame the Relay cannot read: a refusal. Had it been served there
    // would be an answer after it for each request replayed.
    assert_eq!(heard.len(), (2 + 48) + 256, "{} bytes came back", heard.len());
    assert!(workstation.push.hears_nothing_for(QUIET), "the desk was told of a connection");
    assert_eq!(workstation.device_names(), vec!["Seam one iPhone"], "the replay was acted on");
}

/// The card's second criterion, the other half: "or a dropped frame".
/// Inside a connection that is being served, a frame the Relay repeats
/// or alters is not read, and the connection is over.
#[test]
fn a_frame_the_relay_repeats_or_alters_ends_the_connection_unanswered() {
    let relay = LocalRelay::start();
    let mut workstation = Workstation::start(&relay);
    workstation.reach(&relay);
    let device = device(&relay, "Seam one iPhone");
    let paired = workstation.pair(&device);

    // Altered: the Device's first request (the handshake is the 0th
    // thing it sends and the proof the 1st).
    let altered = device.clone().through(Meddling::none().outbound(altering(2)));
    let mut connection = altered.connect(&paired).unwrap();
    assert_eq!(workstation.connected(), paired.device_id);
    connection.send(&Request::RemoveThisDevice).unwrap();
    assert!(connection.is_dropped(SOON), "an altered frame was answered");
    assert_eq!(workstation.disconnected(), paired.device_id);
    assert_eq!(workstation.device_names(), vec!["Seam one iPhone"], "and it was acted on");

    // Repeated: the same request, delivered twice. It is a request that
    // is refused, so that an answer is something to count.
    let repeated = device.clone().through(Meddling::none().outbound(|n, bytes| {
        if n == 2 {
            vec![bytes.clone(), bytes]
        } else {
            vec![bytes]
        }
    }));
    let mut connection = repeated.connect(&paired).unwrap();
    assert_eq!(workstation.connected(), paired.device_id);
    connection.send(&Request::ListSessions).unwrap();
    let mut answers = 0;
    loop {
        match connection.next(SOON) {
            Ok(Response::Forbidden { .. }) => answers += 1,
            Err(TestDeviceError::Closed) => break,
            other => panic!("expected an answer or the end, got {other:?}"),
        }
    }
    assert!(answers <= 1, "a frame delivered twice was answered {answers} times");
    assert_eq!(workstation.disconnected(), paired.device_id);
    assert!(
        workstation.log().contains("did not open"),
        "the daemon should say why; its log:\n{}",
        workstation.log()
    );

    // The Workstation's answer, altered on its way back: the Device
    // reads an error and never a reply.
    let answer_altered = device.clone().through(Meddling::none().inbound(|n, mut bytes| {
        // The handshake's answer is the 0th thing the Device reads and
        // the verdict the 1st.
        if n == 2 {
            bytes[100] ^= 0x01;
        }
        bytes
    }));
    let mut connection = answer_altered.connect(&paired).unwrap();
    assert_eq!(workstation.connected(), paired.device_id);
    match connection.request(&Request::ListSessions, SOON) {
        Err(TestDeviceError::Core(CoreError::Frame(_))) => {}
        other => panic!("expected a frame that does not open, got {other:?}"),
    }
}

// -- revoking ---------------------------------------------------------------

/// The card's third criterion, its first half: "revoking drops the live
/// connection".
#[test]
fn revoking_a_device_drops_its_live_connection_and_leaves_the_others() {
    let relay = LocalRelay::start();
    let mut workstation = Workstation::start(&relay);
    workstation.reach(&relay);
    let lost = device(&relay, "the lost phone");
    let kept = device(&relay, "the tablet");
    let lost_paired = workstation.pair(&lost);
    let kept_paired = workstation.pair(&kept);

    let mut lost_connection = lost.connect(&lost_paired).unwrap();
    assert_eq!(workstation.connected(), lost_paired.device_id);
    let mut lost_second = lost.connect(&lost_paired).unwrap();
    assert_eq!(workstation.connected(), lost_paired.device_id);
    let mut kept_connection = kept.connect(&kept_paired).unwrap();
    assert_eq!(workstation.connected(), kept_paired.device_id);

    let resp = workstation
        .command
        .request(&Request::RevokeDevice { device_id: lost_paired.device_id.clone() });
    assert!(matches!(resp, Response::Ok), "{resp:?}");

    // Both of its connections, at once.
    assert!(lost_connection.is_dropped(SOON), "a revoked Device was still connected");
    assert!(lost_second.is_dropped(SOON), "a revoked Device was still connected");
    assert_eq!(workstation.disconnected(), lost_paired.device_id);
    assert_eq!(workstation.disconnected(), lost_paired.device_id);

    // The other Device's goes on being served.
    assert_refused(&mut kept_connection, &Request::ListSessions);

    // And it does not come back: the row says revoked, and the Device is
    // told so.
    match lost.connect(&lost_paired) {
        Err(TestDeviceError::Refused(ConnectRefusal::Revoked)) => {}
        Err(other) => panic!("expected the Device to be told it was revoked, got {other}"),
        Ok(_) => panic!("a revoked Device connected"),
    }
    assert!(workstation.push.hears_nothing_for(QUIET), "the desk was told of a connection");

    // Until the desk pairs it again.
    let again = workstation.pair(&lost);
    assert_eq!(again.device_id, lost_paired.device_id, "the same install is the same Device");
    lost.connect(&again).unwrap();
    assert_eq!(workstation.connected(), lost_paired.device_id);
}

/// The trust store is shared by the dev build's daemon and the release
/// build's, and either can be the one carrying a Device's connection. A
/// revocation pressed at the OTHER one's desk marks the row and shuts
/// the connections that daemon holds, which are not this one's -- so a
/// daemon goes on reading the rows of the Devices it is carrying.
#[test]
fn a_revocation_made_by_another_daemon_drops_the_live_connection() {
    let relay = LocalRelay::start();
    let mut workstation = Workstation::start(&relay);
    workstation.reach(&relay);
    let revoked = device(&relay, "revoked elsewhere");
    let removed = device(&relay, "removed elsewhere");
    let kept = device(&relay, "kept");
    let revoked_paired = workstation.pair(&revoked);
    let removed_paired = workstation.pair(&removed);
    let kept_paired = workstation.pair(&kept);

    let mut revoked_connection = revoked.connect(&revoked_paired).unwrap();
    assert_eq!(workstation.connected(), revoked_paired.device_id);
    let mut removed_connection = removed.connect(&removed_paired).unwrap();
    assert_eq!(workstation.connected(), removed_paired.device_id);
    let mut kept_connection = kept.connect(&kept_paired).unwrap();
    assert_eq!(workstation.connected(), kept_paired.device_id);

    // As the other daemon writes them: straight into the file.
    workstation
        .store()
        .execute(
            "UPDATE devices SET revoked_at_us = last_seen_at_us WHERE device_id = ?1",
            [&revoked_paired.device_id],
        )
        .unwrap();
    assert!(revoked_connection.is_dropped(SOON), "a Device revoked elsewhere stayed connected");
    assert_eq!(workstation.disconnected(), revoked_paired.device_id);

    // A Device that removed itself, on a connection the other daemon
    // was carrying.
    workstation
        .store()
        .execute("DELETE FROM devices WHERE device_id = ?1", [&removed_paired.device_id])
        .unwrap();
    assert!(removed_connection.is_dropped(SOON), "a Device removed elsewhere stayed connected");
    assert_eq!(workstation.disconnected(), removed_paired.device_id);

    // The one nobody touched goes on being served.
    assert_refused(&mut kept_connection, &Request::ListSessions);
    assert!(workstation.push.hears_nothing_for(QUIET), "a Device nobody revoked was dropped");
    assert_refused(&mut kept_connection, &Request::ListSessions);
}

/// Where a Device meets the Workstation holding `key` on `relay`.
fn meeting(relay: &LocalRelay, key: &[u8]) -> RelayDial {
    RelayDial {
        url: relay.url(),
        hello: RelayHello::device(TOKEN, &rendezvous_id(key), PURPOSE_CONNECT),
    }
}

/// The card's third criterion, its second half, and the proof
/// `05-remote-access.md` §10 left owing: "after 'Revoke all' an old
/// Device's `IK` is refused".
#[test]
fn after_revoke_all_an_old_devices_ik_is_refused() {
    let relay = LocalRelay::start();
    let mut workstation = Workstation::start(&relay);
    workstation.reach(&relay);
    let device = device(&relay, "paired before");
    let paired = workstation.pair(&device);
    let mut connection = device.connect(&paired).unwrap();
    assert_eq!(workstation.connected(), paired.device_id);

    let resp = workstation.command.request(&Request::RevokeAllDevices);
    assert!(matches!(resp, Response::Ok), "{resp:?}");

    // The connection it held goes with the key it was made under.
    assert!(connection.is_dropped(SOON), "a Device outlived Revoke all");
    assert_eq!(workstation.disconnected(), paired.device_id);

    // The Workstation's key is another key now.
    let rotated =
        protocol::hex_decode(&PairingQr::parse(&workstation.offer()).unwrap().daemon_public_key)
            .unwrap();
    assert_ne!(rotated, paired.workstation_key);

    // Left to itself, the Device looks where the key it pinned says to
    // look, and nobody is there.
    let deadline = Instant::now() + SOON;
    loop {
        match device.connect(&paired) {
            Err(TestDeviceError::Dial(DialError::Refused(RefusalReason::Offline))) => break,
            // The moment before the daemon has moved: it is still where
            // it was, and the handshake is what fails.
            Err(TestDeviceError::Closed)
            | Err(TestDeviceError::Dial(DialError::Refused(RefusalReason::Unclaimed)))
                if Instant::now() < deadline =>
            {
                std::thread::sleep(Duration::from_millis(50))
            }
            Err(other) => panic!("expected nobody at the old rendezvous, got {other}"),
            Ok(_) => panic!("a Device paired before Revoke all connected"),
        }
    }

    // Shown where the Workstation has moved to, it runs `IK` against the
    // key it pinned. That key is gone: the first message is sealed to
    // nobody, and the handshake fails.
    let moved = meeting(&relay, &rotated);
    let deadline = Instant::now() + SOON;
    loop {
        match device.connect_at(&paired, &moved) {
            Err(TestDeviceError::Closed) => break,
            Err(TestDeviceError::Dial(DialError::Refused(RefusalReason::Offline)))
                if Instant::now() < deadline =>
            {
                std::thread::sleep(Duration::from_millis(50))
            }
            Err(other) => panic!("expected the handshake to fail, got {other}"),
            Ok(_) => panic!("an IK against the rotated key completed"),
        }
    }
    assert!(
        workstation.log().contains("not addressed to this Workstation's key"),
        "the daemon should say why; its log:\n{}",
        workstation.log()
    );

    // And told the new key as well, it is refused by its row.
    let told = PairedWorkstation { workstation_key: rotated, ..paired.clone() };
    match device.connect(&told) {
        Err(TestDeviceError::Refused(ConnectRefusal::Revoked)) => {}
        Err(other) => panic!("expected the Device to be told it was revoked, got {other}"),
        Ok(_) => panic!("a Device revoked by Revoke all connected"),
    }
    assert!(workstation.push.hears_nothing_for(QUIET), "the desk was told of a connection");
}

// -- a Device, or a peer, that does not behave ---------------------------------

/// A Device that sends faster than it reads: thousands of requests in
/// one frame, each of which is answered with more than it took to ask.
/// Every one of them is answered, and the connection is there
/// afterwards.
#[test]
fn a_great_many_requests_in_one_frame_are_each_answered() {
    let relay = LocalRelay::start();
    let mut workstation = Workstation::start(&relay);
    workstation.reach(&relay);
    let device = device(&relay, "in a hurry");
    let paired = workstation.pair(&device);
    let mut connection = device.connect(&paired).unwrap();
    assert_eq!(workstation.connected(), paired.device_id);

    let requests: Vec<Request> = (0..5000).map(|_| Request::ListSessions).collect();
    connection.send_together(&requests).unwrap();
    for n in 0..requests.len() {
        match connection.next(SOON) {
            Ok(Response::Forbidden { role, .. }) => assert_eq!(role, "remote"),
            other => panic!(
                "request {n} of {} was answered {other:?}; the daemon's log:\n{}",
                requests.len(),
                workstation.log()
            ),
        }
    }

    // Served still, and let go of when the Device goes.
    assert_refused(&mut connection, &Request::GetProtocolVersion);
    connection.close();
    assert_eq!(workstation.disconnected(), paired.device_id);
    eventually("the Relay let the stream go", || relay.relay.stats().streams_open == 0);
}

/// A peer that sends its handshake a byte at a time, each inside the
/// time a read is given. The handshake has a deadline of its own, so it
/// is given up on as the peers that say nothing are -- and the owner's
/// Device connects.
#[test]
fn peers_that_trickle_a_handshake_are_given_up_on() {
    let relay = LocalRelay::start();
    let mut workstation = Workstation::start(&relay);
    workstation.reach(&relay);
    let owner = device(&relay, "the owner");
    let paired = workstation.pair(&owner);
    let key = protocol::hex_encode(&paired.workstation_key);

    // Anything the Relay admits: these hold no Device's key at all.
    let trickling: Vec<_> = (0..4)
        .map(|_| {
            let mut stream = silent_stream(&relay, &key, PURPOSE_CONNECT)
                .join()
                .unwrap()
                .unwrap()
                .into_stream();
            std::thread::spawn(move || {
                // A frame that claims 65535 bytes, and delivers one
                // every second for as long as anyone is reading.
                while stream.write_all(&[0xff]).and_then(|_| stream.flush()).is_ok() {
                    std::thread::sleep(Duration::from_secs(1));
                }
            })
        })
        .collect();
    eventually("the daemon picked all four up", || relay.relay.stats().streams_open == 4);

    eventually("the daemon gave up on the peers that trickled", || {
        relay.relay.stats().streams_open == 0
    });
    for peer in trickling {
        peer.join().unwrap();
    }
    assert!(workstation.push.hears_nothing_for(Duration::from_millis(200)));

    owner.connect(&paired).unwrap();
    assert_eq!(workstation.connected(), paired.device_id);
}

/// Anything the Relay admits can ask for a connection at any time. The
/// ones that ask and then say nothing hold places of their own, and not
/// the ones a pairing needs.
#[test]
fn streams_that_connect_and_say_nothing_do_not_keep_the_owner_from_pairing() {
    let relay = LocalRelay::start();
    let mut workstation = Workstation::start(&relay);
    workstation.reach(&relay);
    let offer = PairingQr::parse(&workstation.offer()).unwrap();

    let silent: Vec<_> = (0..8)
        .map(|_| silent_stream(&relay, &offer.daemon_public_key, PURPOSE_CONNECT))
        .collect();
    eventually("the daemon picked the silent streams up", || {
        relay.relay.stats().streams_open >= 4
    });

    let owner = device(&relay, "the owner");
    let pairing = owner.pair_with(&offer).unwrap();
    let (device_id, name, desk_code) = workstation.asked();
    assert_eq!(name, "the owner");
    assert_eq!(pairing.code, desk_code);
    let resp = workstation.command.request(&Request::ConfirmPairing { device_id: device_id.clone() });
    assert!(matches!(resp, Response::Ok), "{resp:?}");
    assert_eq!(paired_as(pairing.verdict(SOON).unwrap()), device_id);
    drop(silent);
}

// -- how many, and for how long ---------------------------------------------

/// The card's fourth criterion: "a sixth Device is refused".
#[test]
fn a_sixth_device_is_refused() {
    let relay = LocalRelay::start();
    let mut workstation = Workstation::start(&relay);
    workstation.reach(&relay);

    let names = ["phone", "tablet", "spare", "work phone", "old phone"];
    let paired: Vec<(TestDevice, PairedWorkstation)> = names
        .iter()
        .map(|name| {
            let device = device(&relay, name);
            let paired = workstation.pair(&device);
            (device, paired)
        })
        .collect();
    assert_eq!(workstation.device_names(), names);

    let sixth = device(&relay, "one too many");
    let pairing = sixth.pair(&workstation.offer()).unwrap();
    let (device_id, _, desk_code) = workstation.asked();
    assert_eq!(pairing.code, desk_code);

    match workstation.command.request(&Request::ConfirmPairing { device_id: device_id.clone() }) {
        Response::Error { message } => {
            assert!(message.contains("already paired"), "{message}");
            assert!(message.contains("the limit is 5"), "{message}");
        }
        other => panic!("expected the sixth Device to be refused, got {other:?}"),
    }
    assert_eq!(workstation.device_names(), names);

    // The five that are paired are the five that connect.
    for (device, paired) in &paired {
        device.connect(paired).unwrap();
        assert_eq!(workstation.connected(), paired.device_id);
        assert_eq!(workstation.disconnected(), paired.device_id);
    }

    // Revoking one makes room, and the Confirm that was refused is
    // pressed again: the sixth Device did not have to start over.
    let resp = workstation
        .command
        .request(&Request::RevokeDevice { device_id: paired[4].1.device_id.clone() });
    assert!(matches!(resp, Response::Ok), "{resp:?}");
    let resp = workstation.command.request(&Request::ConfirmPairing { device_id });
    assert!(matches!(resp, Response::Ok), "{resp:?}");
    let kept = pairing.paired(SOON).unwrap();
    let _connection = sixth.connect(&kept).unwrap();
    assert_eq!(workstation.connected(), kept.device_id);

    // The one that was revoked comes back for a place that has been
    // given away: it is a sixth Device, and is refused like one.
    let (revoked, _) = &paired[4];
    let pairing = revoked.pair(&workstation.offer()).unwrap();
    let (device_id, name, _) = workstation.asked();
    assert_eq!(name, "old phone");
    match workstation.command.request(&Request::ConfirmPairing { device_id: device_id.clone() }) {
        Response::Error { message } => {
            assert!(message.contains("the limit is 5"), "{message}")
        }
        other => panic!("expected a revoked Device pairing again to be refused, got {other:?}"),
    }
    let trusted = workstation.devices().into_iter().filter(|d| d.revoked_at.is_none()).count();
    assert_eq!(trusted, 5);
    let resp = workstation.command.request(&Request::RejectPairing { device_id });
    assert!(matches!(resp, Response::Ok), "{resp:?}");
    assert_eq!(pairing.verdict(SOON).unwrap(), PairingVerdict::Rejected);
}

/// A Device the Workstation has not seen for ninety days pairs again
/// before it connects, and one that connects is seen.
#[test]
fn a_device_unseen_for_ninety_days_is_told_to_pair_again() {
    let relay = LocalRelay::start();
    let mut workstation = Workstation::start(&relay);
    workstation.reach(&relay);
    let device = device(&relay, "in a drawer");
    let paired = workstation.pair(&device);
    let day_us: i64 = 24 * 60 * 60 * 1_000_000;
    let seen = |workstation: &Workstation, days_ago: i64| {
        workstation
            .store()
            .execute(
                "UPDATE devices SET last_seen_at_us = last_seen_at_us - ?1",
                [days_ago * day_us],
            )
            .unwrap();
    };

    // Eighty-nine days: served, and the connection is what renews it.
    seen(&workstation, 89);
    assert!(workstation.devices()[0].last_seen_at < now_seconds() - 88 * 24 * 60 * 60);
    device.connect(&paired).unwrap();
    assert_eq!(workstation.connected(), paired.device_id);
    assert_eq!(workstation.disconnected(), paired.device_id);
    assert!(
        workstation.devices()[0].last_seen_at > now_seconds() - 60,
        "a connection did not count as seeing the Device"
    );

    // Ninety-one: refused, and told what to do about it.
    seen(&workstation, 91);
    match device.connect(&paired) {
        Err(TestDeviceError::Refused(ConnectRefusal::Stale)) => {}
        Err(other) => panic!("expected the Device to be told it is stale, got {other}"),
        Ok(_) => panic!("a Device unseen for ninety-one days connected"),
    }
    assert!(workstation.devices()[0].stale);
    // Being refused is not being seen.
    assert!(workstation.devices()[0].last_seen_at < now_seconds() - 90 * 24 * 60 * 60);
    assert!(workstation.push.hears_nothing_for(QUIET), "the desk was told of a connection");
}

fn now_seconds() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() as i64
}

// -- what a Device may do -----------------------------------------------------

/// The card's sixth criterion: "a Device removing itself deletes only
/// its own row".
#[test]
fn a_device_removing_itself_deletes_only_its_own_row() {
    let relay = LocalRelay::start();
    let mut workstation = Workstation::start(&relay);
    workstation.reach(&relay);
    let leaving = device(&relay, "leaving");
    let staying = device(&relay, "staying");
    let gone_already = device(&relay, "revoked at the desk");
    let leaving_paired = workstation.pair(&leaving);
    let staying_paired = workstation.pair(&staying);
    let gone_paired = workstation.pair(&gone_already);
    let resp = workstation
        .command
        .request(&Request::RevokeDevice { device_id: gone_paired.device_id.clone() });
    assert!(matches!(resp, Response::Ok), "{resp:?}");
    let key_before = PairingQr::parse(&workstation.offer()).unwrap().daemon_public_key;

    let mut asking = leaving.connect(&leaving_paired).unwrap();
    assert_eq!(workstation.connected(), leaving_paired.device_id);
    let mut other_connection = leaving.connect(&leaving_paired).unwrap();
    assert_eq!(workstation.connected(), leaving_paired.device_id);
    let mut staying_connection = staying.connect(&staying_paired).unwrap();
    assert_eq!(workstation.connected(), staying_paired.device_id);
    // The store as it stands with all three in it, and everyone who is
    // going to connect connected.
    let before = workstation.devices();
    assert_eq!(before.len(), 3);

    // It is answered, and then let go -- on every connection it holds.
    match asking.request(&Request::RemoveThisDevice, SOON) {
        Ok(Response::Ok) => {}
        other => panic!("expected the Device to be removed, got {other:?}"),
    }
    assert!(asking.is_dropped(SOON));
    assert!(other_connection.is_dropped(SOON));
    assert_eq!(workstation.disconnected(), leaving_paired.device_id);
    assert_eq!(workstation.disconnected(), leaving_paired.device_id);

    // Its own row, and nothing else: the other two are as they were,
    // the one that was revoked still listed as revoked.
    let after = workstation.devices();
    let kept: Vec<DeviceInfo> =
        before.into_iter().filter(|d| d.device_id != leaving_paired.device_id).collect();
    assert_eq!(after, kept);
    assert_eq!(after.len(), 2);
    assert!(after.iter().any(|d| d.name == "revoked at the desk" && d.revoked_at.is_some()));

    // Nor did it move the Workstation: that is "Revoke all", and the
    // desk's.
    assert_eq!(PairingQr::parse(&workstation.offer()).unwrap().daemon_public_key, key_before);
    assert_refused(&mut staying_connection, &Request::ListSessions);

    // It is a Device this Workstation has never heard of now.
    match leaving.connect(&leaving_paired) {
        Err(TestDeviceError::Refused(ConnectRefusal::NotPaired)) => {}
        Err(other) => panic!("expected the Device to be unknown, got {other}"),
        Ok(_) => panic!("a Device that removed itself connected"),
    }
}

/// `05-remote-access.md` §4: "a daemon token presented over the remote
/// transport is ignored, not honoured". The token here is the real one,
/// read from the file the desktop app reads it from.
#[test]
fn a_daemon_token_presented_over_the_remote_path_is_ignored() {
    let relay = LocalRelay::start();
    let mut workstation = Workstation::start(&relay);
    workstation.reach(&relay);
    let device = device(&relay, "Seam one iPhone");
    let paired = workstation.pair(&device);

    for auth in [
        HelloAuth::DaemonToken { token: workstation.daemon_token.clone() },
        // Nothing at all, which on the local socket is the `local` role
        // and everything the daemon does.
        HelloAuth::None,
    ] {
        let mut connection = device.connect(&paired).unwrap();
        assert_eq!(workstation.connected(), paired.device_id);

        let hello = Request::Hello {
            client: "app".into(),
            protocol_version: protocol::PROTOCOL_VERSION,
            auth: auth.clone(),
            nonce: "seam-one".into(),
            connection: Some(ConnectionKind::Push),
        };
        match connection.request(&hello, SOON) {
            Ok(Response::HelloAck { role, server_proof, .. }) => {
                assert_eq!(role, "remote", "{auth:?} changed the role");
                assert_eq!(server_proof, None);
            }
            other => panic!("expected HelloAck, got {other:?}"),
        }
        // What it may do is what it could do before it said so.
        for request in refused_to_a_device() {
            assert_refused(&mut connection, &request);
        }
        connection.close();
        assert_eq!(workstation.disconnected(), paired.device_id);
    }

    // Nothing it asked for was done: remote access is on, the Device is
    // paired, and the Workstation is where it was.
    match workstation.command.request(&Request::ListDevices) {
        Response::Devices { devices, remote_access_enabled, .. } => {
            assert!(remote_access_enabled);
            assert_eq!(devices.len(), 1);
            assert_eq!(devices[0].revoked_at, None);
        }
        other => panic!("expected Devices, got {other:?}"),
    }
    assert_eq!(relay.relay.stats().workstations, 1);
}

/// Turning remote access off lets go of the Relay -- all of it. A
/// Device that is connected is part of what is let go.
#[test]
fn turning_remote_access_off_drops_a_connected_device() {
    let relay = LocalRelay::start();
    let mut workstation = Workstation::start(&relay);
    workstation.reach(&relay);
    let device = device(&relay, "Seam one iPhone");
    let paired = workstation.pair(&device);
    let mut connection = device.connect(&paired).unwrap();
    assert_eq!(workstation.connected(), paired.device_id);

    workstation.set_remote_access(false, Some(&relay.url()), None);

    assert!(connection.is_dropped(SOON), "a Device stayed connected with remote access off");
    assert_eq!(workstation.disconnected(), paired.device_id);
    eventually("the daemon let go of the Relay", || relay.relay.stats().workstations == 0);
    eventually("the daemon let go of the stream", || relay.relay.stats().streams_open == 0);
    match device.connect(&paired) {
        Err(TestDeviceError::Dial(DialError::Refused(RefusalReason::Offline))) => {}
        Err(other) => panic!("expected the Workstation to be offline, got {other}"),
        Ok(_) => panic!("a Workstation with remote access off was reached"),
    }

    // The Device is still paired: the switch is not a revocation.
    workstation.set_remote_access(true, Some(&relay.url()), None);
    eventually("the daemon took the Relay up again", || relay.relay.stats().workstations == 1);
    device.connect(&paired).unwrap();
    assert_eq!(workstation.connected(), paired.device_id);
}
