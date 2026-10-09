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
    /// Refusals pushed (v62) that a test reading something else went
    /// past. `heard_refusal` takes them back out.
    refusals: std::collections::VecDeque<(String, protocol::DeviceRefusal)>,
    /// Presence pushes (v63) likewise, for `heard_presence`. Every
    /// forwarded command that names a workspace can send one, so a test
    /// that is about something else must be able to read past them.
    presences: std::collections::VecDeque<(String, protocol::DevicePresence)>,
    /// Ownership pushes (v68) likewise, for `ownership_of`: a Device's
    /// input or start can send one.
    owners: std::collections::VecDeque<protocol::SessionOwnership>,
}

impl Desk {
    fn connect(endpoint: &Endpoint, daemon_token: &str, kind: ConnectionKind) -> Self {
        Self::connect_speaking(endpoint, daemon_token, kind, protocol::PROTOCOL_VERSION)
    }

    /// An app that says it speaks `version`, for the app older than a bump.
    fn connect_speaking(
        endpoint: &Endpoint,
        daemon_token: &str,
        kind: ConnectionKind,
        version: u32,
    ) -> Self {
        let stream = Stream::connect(endpoint.clone()).unwrap();
        stream.set_read_timeout(Some(SOON)).unwrap();
        let reader = BufReader::new(stream.try_clone().unwrap());
        let mut desk =
            Self {
                stream,
                reader,
                refusals: Default::default(),
                presences: Default::default(),
                owners: Default::default(),
            };
        match desk.request(&Request::Hello {
            client: "app".into(),
            protocol_version: version,
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

    /// The next message, whatever it is.
    fn next_raw(&mut self) -> Response {
        read_message(&mut self.reader)
            .expect("the daemon did not answer in time")
            .expect("the daemon closed the connection")
    }

    /// The next message that is not the dial's state changing, which
    /// arrives whenever the Relay is dialled and is asserted on by the
    /// tests that are about it.
    fn next(&mut self) -> Response {
        loop {
            match self.next_raw() {
                Response::RelayStateChanged { .. } => {}
                Response::DeviceRefusalChanged { device_id, refusal } => {
                    self.refusals.push_back((device_id, refusal))
                }
                Response::DevicePresenceChanged { device_id, presence } => {
                    self.presences.push_back((device_id, presence))
                }
                Response::SessionOwnerChanged { ownership } => self.owners.push_back(ownership),
                other => return other,
            }
        }
    }

    /// The next presence the daemon pushes, whether it has already gone
    /// past or is still to come.
    fn heard_presence(&mut self) -> (String, protocol::DevicePresence) {
        loop {
            if let Some(heard) = self.presences.pop_front() {
                return heard;
            }
            match self.next_raw() {
                Response::RelayStateChanged { .. } => {}
                Response::DeviceRefusalChanged { device_id, refusal } => {
                    self.refusals.push_back((device_id, refusal))
                }
                Response::DevicePresenceChanged { device_id, presence } => {
                    return (device_id, presence)
                }
                Response::SessionOwnerChanged { ownership } => self.owners.push_back(ownership),
                other => panic!("expected DevicePresenceChanged, got {other:?}"),
            }
        }
    }

    /// Reads presence pushes until `device_id`'s satisfies `check`, and
    /// returns it. Each push is the whole presence, so the one that
    /// satisfies is the one to assert on; the ones before it are the
    /// steps that led there.
    ///
    /// Another Device's pushes are kept for a later call: two Devices'
    /// commands are answered on two connections, and whose push the daemon
    /// writes first is not the test's to decide.
    fn presence_of(
        &mut self,
        device_id: &str,
        check: impl Fn(&protocol::DevicePresence) -> bool,
    ) -> protocol::DevicePresence {
        let deadline = Instant::now() + SOON;
        loop {
            let found = self.presences.iter().position(|(id, p)| id == device_id && check(p));
            if let Some(at) = found {
                return self.presences.remove(at).unwrap().1;
            }
            assert!(Instant::now() < deadline, "no presence push for {device_id} came true");
            match self.next_raw() {
                Response::RelayStateChanged { .. } => {}
                Response::DeviceRefusalChanged { device_id, refusal } => {
                    self.refusals.push_back((device_id, refusal))
                }
                Response::DevicePresenceChanged { device_id, presence } => {
                    self.presences.push_back((device_id, presence))
                }
                Response::SessionOwnerChanged { ownership } => self.owners.push_back(ownership),
                other => panic!("expected DevicePresenceChanged, got {other:?}"),
            }
        }
    }

    /// Whether any presence push arrives within `within`, including one
    /// that already went past. Everything else is read and set aside.
    fn hears_no_presence_for(&mut self, within: Duration) -> bool {
        if !self.presences.is_empty() {
            return false;
        }
        self.stream.set_read_timeout(Some(within)).unwrap();
        let heard = loop {
            match read_message::<_, Response>(&mut self.reader) {
                Ok(Some(Response::DevicePresenceChanged { .. })) => break true,
                Ok(Some(_)) => continue,
                _ => break false,
            }
        };
        self.stream.set_read_timeout(Some(SOON)).unwrap();
        !heard
    }

    /// The next refusal the daemon pushes, whether it has already gone
    /// past or is still to come.
    fn heard_refusal(&mut self) -> (String, protocol::DeviceRefusal) {
        loop {
            if let Some(heard) = self.refusals.pop_front() {
                return heard;
            }
            match self.next_raw() {
                Response::RelayStateChanged { .. } => {}
                Response::DeviceRefusalChanged { device_id, refusal } => {
                    return (device_id, refusal)
                }
                Response::SessionOwnerChanged { ownership } => self.owners.push_back(ownership),
                other => panic!("expected DeviceRefusalChanged, got {other:?}"),
            }
        }
    }

    /// Reads ownership pushes (v68) until one for `session_id` satisfies
    /// `check`, and returns it; like `presence_of`, the ones before it are
    /// the steps that led there, and other sessions' are kept.
    fn ownership_of(
        &mut self,
        session_id: &str,
        check: impl Fn(&protocol::SessionOwnership) -> bool,
    ) -> protocol::SessionOwnership {
        let deadline = Instant::now() + SOON;
        loop {
            let found = self.owners.iter().position(|o| o.session_id == session_id && check(o));
            if let Some(at) = found {
                let heard = self.owners.remove(at).unwrap();
                // What came before it for this session is spent.
                self.owners.retain(|o| o.session_id != session_id);
                return heard;
            }
            assert!(Instant::now() < deadline, "no ownership push for {session_id} came true");
            match self.next_raw() {
                Response::RelayStateChanged { .. } => {}
                Response::DeviceRefusalChanged { device_id, refusal } => {
                    self.refusals.push_back((device_id, refusal))
                }
                Response::DevicePresenceChanged { device_id, presence } => {
                    self.presences.push_back((device_id, presence))
                }
                Response::SessionOwnerChanged { ownership } => self.owners.push_back(ownership),
                // A Device connecting or hanging up is what moves an owner
                // into and out of its grace, so those pushes come between.
                Response::DeviceConnected { .. } | Response::DeviceDisconnected { .. } => {}
                other => panic!("expected SessionOwnerChanged, got {other:?}"),
            }
        }
    }

    /// Whether anything arrives within `within`. For the pushes that
    /// must not be sent.
    fn hears_nothing_for(&mut self, within: Duration) -> bool {
        self.stream.set_read_timeout(Some(within)).unwrap();
        let heard = loop {
            match read_message::<_, Response>(&mut self.reader) {
                Ok(Some(Response::RelayStateChanged { .. })) => continue,
                Ok(Some(Response::DeviceRefusalChanged { device_id, refusal })) => {
                    self.refusals.push_back((device_id, refusal));
                    continue;
                }
                Ok(Some(Response::SessionOwnerChanged { ownership })) => {
                    self.owners.push_back(ownership);
                    continue;
                }
                other => break other,
            }
        };
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
        Self::launch(certificate_pem, None)
    }

    /// Starts a daemon that trusts `relay`'s certificate and launches its
    /// agents' browsers from `browsers`, this machine's Playwright
    /// browsers directory.
    fn start_with_browsers(relay: &LocalRelay, browsers: &std::path::Path) -> Self {
        Self::launch(&relay.certificate_pem, Some(browsers))
    }

    fn launch(certificate_pem: &str, browsers: Option<&std::path::Path>) -> Self {
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

        let mut daemon = Command::new(env!("CARGO_BIN_EXE_gavin-daemon"));
        daemon
            .env("HOME", home.path())
            .env("LOCALAPPDATA", home.path())
            .env("USERPROFILE", home.path())
            .env_remove("XDG_DATA_HOME")
            // The machine's certificate store, as far as this daemon is
            // concerned. Nothing in the daemon knows it is under test.
            .env("SSL_CERT_FILE", &roots)
            .env_remove("SSL_CERT_DIR")
            .stdout(Stdio::null())
            .stderr(Stdio::from(log));
        // The browsers stay where the machine keeps them: the temporary
        // home has none, and a download is the install step's to make.
        match browsers {
            Some(dir) => daemon.env("PLAYWRIGHT_BROWSERS_PATH", dir),
            None => daemon.env_remove("PLAYWRIGHT_BROWSERS_PATH"),
        };
        let daemon = daemon.spawn().expect("failed to spawn gavin-daemon");

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

    /// The desk's push connection, from an app that says it speaks
    /// `version`.
    fn push_speaking(&self, version: u32) -> Desk {
        Desk::connect_speaking(&self.endpoint(), &self.daemon_token, ConnectionKind::Push, version)
    }

    /// Opens the desktop's forwarding connection (v54).
    fn open_forwarding(&self) -> Desk {
        Desk::connect(&self.endpoint(), &self.daemon_token, ConnectionKind::Forward)
    }

    /// A connection of the desk's own for one request that streams, as
    /// `browser_view.rs` opens one per watch.
    fn open_command(&self) -> Desk {
        Desk::connect(&self.endpoint(), &self.daemon_token, ConnectionKind::Command)
    }
}

/// A scripted desktop stand-in on the forwarding connection: answers
/// every `ForwardCommand` with a fixed value, every `ForwardAttention`
/// with fixed items, every `ForwardBundle` from the bundle it carries
/// (if any), and can offer events.
struct StandIn {
    /// What reached it, in order (command name, or `"__attention__"`).
    received: Arc<Mutex<Vec<(String, serde_json::Value)>>>,
    /// Stop the loop.
    stop: Arc<std::sync::atomic::AtomicBool>,
    join: Option<std::thread::JoinHandle<()>>,
    /// Sends an event to offer, from the test thread.
    offer: Option<std::sync::mpsc::Sender<(String, serde_json::Value)>>,
}

impl StandIn {
    /// Answers every forwarded command with `value`.
    fn answering(desk: Desk, value: serde_json::Value) -> Self {
        Self::answering_with_attention(desk, value, vec![])
    }

    /// Answers forwarded commands with `value` and attention asks with
    /// `items`.
    fn answering_with_attention(
        desk: Desk,
        value: serde_json::Value,
        items: Vec<protocol::AttentionItem>,
    ) -> Self {
        Self::start(desk, value, items, None)
    }

    /// Answers bundle asks from `bundle` -- the manifest and the archive
    /// it names -- or, with `None`, as a desktop that carries no bundle.
    fn answering_with_bundle(
        desk: Desk,
        bundle: Option<(protocol::BundleManifest, Vec<u8>)>,
    ) -> Self {
        Self::start(desk, serde_json::json!(null), vec![], bundle)
    }

    fn start(
        desk: Desk,
        value: serde_json::Value,
        items: Vec<protocol::AttentionItem>,
        bundle: Option<(protocol::BundleManifest, Vec<u8>)>,
    ) -> Self {
        Self::spawn(desk, move |_, _| value.clone(), items, bundle)
    }

    /// Answers each forwarded command with what `answer` makes of its name
    /// and arguments -- the desktop's `create_session`, say, answering with
    /// the id of the session it started.
    fn answering_by(
        desk: Desk,
        answer: impl Fn(&str, &serde_json::Value) -> serde_json::Value + Send + 'static,
        items: Vec<protocol::AttentionItem>,
    ) -> Self {
        Self::spawn(desk, answer, items, None)
    }

    fn spawn(
        mut desk: Desk,
        answer: impl Fn(&str, &serde_json::Value) -> serde_json::Value + Send + 'static,
        items: Vec<protocol::AttentionItem>,
        bundle: Option<(protocol::BundleManifest, Vec<u8>)>,
    ) -> Self {
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
                        let value = answer(&command, &args);
                        received_thread.lock().unwrap().push((command, args));
                        let resp = desk.request(&Request::ForwardResult {
                            call_id,
                            value: Some(value),
                            error: None,
                        });
                        assert!(matches!(resp, Response::Ok), "{resp:?}");
                    }
                    Ok(Some(Response::ForwardAttention { call_id, version })) => {
                        received_thread.lock().unwrap().push((
                            "__attention__".into(),
                            serde_json::json!({ "version": version }),
                        ));
                        let resp = desk.request(&Request::AttentionResult {
                            call_id,
                            items: items.clone(),
                        });
                        assert!(matches!(resp, Response::Ok), "{resp:?}");
                    }
                    Ok(Some(Response::ForwardBundle { call_id, version, offset, length })) => {
                        received_thread.lock().unwrap().push((
                            "__bundle__".into(),
                            serde_json::json!({ "version": version, "offset": offset, "length": length }),
                        ));
                        // What the desktop host does: the manifest it
                        // embeds, and the slice the daemon asked for.
                        let (manifest, data) = match &bundle {
                            Some((manifest, archive)) => (
                                Some(manifest.clone()),
                                protocol::companion_bundle::encode_chunk(
                                    protocol::companion_bundle::chunk(archive, offset, length),
                                ),
                            ),
                            None => (None, String::new()),
                        };
                        let resp = desk.request(&Request::BundleResult {
                            call_id,
                            manifest,
                            offset,
                            data,
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

/// ADR 0006: a Device changes a workspace's settings, and adds a
/// workspace, through commands of their own -- never through the desk's
/// layout saves. On one connection the settings commands reach the desk
/// and come back answered, the layout-saving ones are refused, and the
/// desk sees the first kind only.
#[test]
fn the_workspace_settings_commands_reach_the_desk_and_the_layout_saves_do_not() {
    let relay = LocalRelay::start();
    let mut workstation = Workstation::start(&relay);
    workstation.reach(&relay);
    let device = device(&relay, "Seam one iPhone");
    let paired = workstation.pair(&device);
    let mut connection = device.connect(&paired).unwrap();
    let _ = workstation.connected();

    let stand_in = StandIn::answering(workstation.open_forwarding(), serde_json::json!({"id": "ws-new"}));

    let settings: Vec<(&str, serde_json::Value)> = vec![
        ("get_workspace_settings", serde_json::json!({})),
        (
            "set_workspace_settings",
            serde_json::json!({"workspaceId": "w1", "patch": {"color": "#a78bfa", "autoCommit": null}}),
        ),
        (
            "add_workspace",
            serde_json::json!({"settings": {"name": "weather-station", "rootPath": "/Users/me/code/weather-station"}}),
        ),
    ];
    for (command, args) in &settings {
        match connection
            .request(&Request::InvokeDesktop { command: (*command).into(), args: args.clone() }, SOON)
            .unwrap()
        {
            Response::DesktopResult { value, error } => {
                assert_eq!(error, None, "{command}");
                assert_eq!(value, Some(serde_json::json!({"id": "ws-new"})), "{command}");
            }
            other => panic!("{command} was answered {other:?}"),
        }
    }

    for command in ["set_workspaces_state", "set_file_tabs", "set_board_tabs", "set_card_tabs"] {
        match connection
            .request(&Request::InvokeDesktop { command: command.into(), args: serde_json::json!({}) }, SOON)
            .unwrap()
        {
            Response::Error { message } => {
                assert!(message.contains("may not invoke") && message.contains(command), "{command}: {message}");
            }
            other => panic!("{command} was answered {other:?}"),
        }
    }

    let expected: Vec<(String, serde_json::Value)> =
        settings.iter().map(|(command, args)| ((*command).to_string(), args.clone())).collect();
    eventually("the desk saw the settings commands, whole and in order", || stand_in.received() == expected);
    std::thread::sleep(Duration::from_millis(200));
    assert_eq!(stand_in.received(), expected, "a layout-saving command reached the desk");
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


// -- an agent's browser on the phone (playwright-companion-view) --------

/// What the desk offers a Device's view as (`browser_view.rs`).
const FRAME_EVENT: &str = "browser-frame";

/// A `browser-frame` payload, as the desk serialises a frame for the
/// frontend: `Response::BrowserFrame` in camelCase.
fn frame_payload(session_id: &str, seq: u64, data: &str, url: &str) -> serde_json::Value {
    serde_json::json!({
        "sessionId": session_id,
        "seq": seq,
        "data": data,
        "width": 1280,
        "height": 800,
        "url": url,
        "title": "",
    })
}

/// The next `browser-frame` the Device hears: its payload.
fn heard_frame(connection: &mut Connection) -> serde_json::Value {
    match connection.next(SOON) {
        Ok(Response::DesktopEvent { event, payload }) => {
            assert_eq!(event, FRAME_EVENT);
            payload
        }
        other => panic!("expected a {FRAME_EVENT} event, got {other:?}"),
    }
}

/// A paired Device, connected, that has asked the desk for a session's
/// browser the way the Companion's view does: it listens for the frames,
/// then has the desk run `watch_browser_for_device`.
fn watching_device(
    relay: &LocalRelay,
    workstation: &mut Workstation,
    session_id: &str,
) -> (Connection, StandIn) {
    let phone = device(relay, "Watching iPhone");
    let paired = workstation.pair(&phone);
    let mut connection = phone.connect(&paired).unwrap();
    assert_eq!(workstation.connected(), paired.device_id);
    let stand_in = StandIn::answering(
        workstation.open_forwarding(),
        serde_json::json!({ "frame": null, "leaseMs": 30_000 }),
    );

    // Not from the daemon: a Device asks it for nothing of its own, and a
    // stream of the session's screen least of all.
    assert_refused(
        &mut connection,
        &Request::WatchBrowser {
            session_id: session_id.into(),
            size: protocol::BrowserViewSize::Phone,
            max_fps: 2,
        },
    );
    match connection.request(&Request::ListenDesktop { event: FRAME_EVENT.into() }, SOON).unwrap() {
        Response::Ok => {}
        other => panic!("expected Ok, got {other:?}"),
    }
    let args = serde_json::json!({ "sessionId": session_id, "watcher": "phone-view-1" });
    let answer = invoked(&mut connection, "watch_browser_for_device", args.clone());
    assert_eq!(answer, Some(serde_json::json!({ "frame": null, "leaseMs": 30_000 })));
    assert_eq!(stand_in.received(), vec![("watch_browser_for_device".to_string(), args)]);
    (connection, stand_in)
}

/// Seam 1 for the phone's view of an agent's browser: what the desk
/// offers as `browser-frame` reaches the Device that listens for it,
/// whole -- a frame at the top of what a phone-size screencast measured
/// (28 KiB of JPEG, 38 KiB as base64, spec Q4), and one well past a Noise
/// frame and a Relay message, which the daemon splits on the way.
#[test]
fn a_browser_frame_the_desk_offers_reaches_the_listening_device_whole() {
    let relay = LocalRelay::start();
    let mut workstation = Workstation::start(&relay);
    workstation.reach(&relay);
    let (mut connection, stand_in) = watching_device(&relay, &mut workstation, "s-agent");

    for (seq, size) in [(1, 38 * 1024), (2, 200 * 1024)] {
        let data = format!("/9j/{}", "A".repeat(size - 4));
        stand_in.offer_event(FRAME_EVENT, frame_payload("s-agent", seq, &data, "https://example.test/"));
        let payload = heard_frame(&mut connection);
        assert_eq!(payload["seq"], seq);
        assert_eq!(payload["sessionId"], "s-agent");
        assert!(payload["data"] == data, "frame {seq} ({size} bytes) arrived altered");
    }
}

/// This machine's Playwright browsers directory, when it holds a complete
/// headless shell (`tests/playwright.rs`), read from the real environment.
fn installed_browsers() -> Option<PathBuf> {
    let home_var = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    let home = PathBuf::from(std::env::var_os(home_var)?);
    let dir = protocol::playwright::browsers_dir(protocol::HostOs::current(), &home, |k| std::env::var(k).ok());
    let complete: Vec<String> = std::fs::read_dir(&dir)
        .ok()?
        .filter_map(|e| e.ok())
        .filter(|e| e.path().join(protocol::playwright::INSTALLATION_COMPLETE).is_file())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    protocol::playwright::pick_revision(complete.iter().map(String::as_str))?;
    Some(dir)
}

/// One CDP command through the daemon's proxy, the way the Playwright MCP
/// drives the browser, read until its reply.
fn cdp_call(
    ws: &mut tungstenite::WebSocket<std::net::TcpStream>,
    id: u64,
    method: &str,
    params: serde_json::Value,
    session: Option<&str>,
) -> serde_json::Value {
    let mut message = serde_json::json!({ "id": id, "method": method, "params": params });
    if let Some(session) = session {
        message["sessionId"] = session.into();
    }
    ws.send(tungstenite::Message::Text(message.to_string().into())).unwrap();
    loop {
        let tungstenite::Message::Text(text) = ws.read().expect("a CDP reply") else { continue };
        let reply: serde_json::Value = serde_json::from_str(text.as_str()).unwrap();
        if reply["id"].as_u64() == Some(id) {
            assert!(reply.get("error").is_none(), "{method}: {reply}");
            return reply["result"].clone();
        }
    }
}

/// The width and height a JPEG says it is, from its base64: the start of
/// it decoded far enough to reach the frame header.
fn jpeg_size(base64: &str) -> Option<(u16, u16)> {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut bytes = Vec::new();
    let (mut acc, mut bits) = (0u32, 0u32);
    for c in base64.bytes().take(16 * 1024).take_while(|c| *c != b'=') {
        acc = ((acc << 6) | ALPHABET.iter().position(|a| *a == c)? as u32) & 0xFFFF;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            bytes.push((acc >> bits) as u8);
        }
    }
    // Segment by segment from the start-of-image marker to a start of
    // frame, whose height then width follow its length and precision.
    let mut at = 2;
    while at + 9 < bytes.len() {
        if bytes[at] != 0xFF {
            return None;
        }
        let marker = bytes[at + 1];
        let length = u16::from_be_bytes([bytes[at + 2], bytes[at + 3]]) as usize;
        if matches!(marker, 0xC0..=0xC3) {
            let height = u16::from_be_bytes([bytes[at + 5], bytes[at + 6]]);
            let width = u16::from_be_bytes([bytes[at + 7], bytes[at + 8]]);
            return Some((width, height));
        }
        at += 2 + length;
    }
    None
}

/// The same, end to end with a real browser: an agent's page, screencast
/// by the daemon at the phone's size and rate to a connection of the
/// desk's, offered on by the desk as `browser_view.rs` does, and received
/// by the Device through the Relay as the 640x400 JPEG it was sent.
/// Skips, saying why, where no headless shell is installed.
#[test]
fn a_real_agent_browsers_phone_frame_reaches_the_device() {
    let Some(browsers) = installed_browsers() else {
        assert!(
            std::env::var_os("GAVIN_REQUIRE_PLAYWRIGHT").is_none(),
            "GAVIN_REQUIRE_PLAYWRIGHT is set and no complete Playwright headless shell is installed"
        );
        eprintln!(
            "SKIPPED: no complete Playwright headless shell is installed on this machine -- run `npx {}` to run this test",
            protocol::playwright::install_args().join(" ")
        );
        return;
    };
    let relay = LocalRelay::start();
    let mut workstation = Workstation::start_with_browsers(&relay, &browsers);
    workstation.reach(&relay);
    let folder = tempfile::tempdir().unwrap();
    let root = folder.path().to_string_lossy().into_owned();
    let session_id = match workstation.command.request(&Request::CreateSession {
        workspace_path: root.clone(),
        cwd: root,
        command: None,
        profile_id: None,
        api_family: None,
        without_headroom: true,
    }) {
        Response::SessionCreated { id, .. } => id,
        other => panic!("CreateSession: {other:?}"),
    };
    let endpoint = match workstation.command.request(&Request::PlaywrightEndpoint { session_id: session_id.clone() }) {
        Response::PlaywrightEndpoint { endpoint, .. } => endpoint,
        other => panic!("PlaywrightEndpoint: {other:?}"),
    };

    let (mut connection, stand_in) = watching_device(&relay, &mut workstation, &session_id);

    // What the desk does with that call: a stream of its own at the
    // phone's size and rate (`DEVICE_FPS`).
    let mut watch = workstation.open_command();
    write_message(
        &mut watch.stream,
        &Request::WatchBrowser { session_id: session_id.clone(), size: protocol::BrowserViewSize::Phone, max_fps: 2 },
    )
    .unwrap();

    // The agent's first call launches the browser, and it opens a page.
    let authority = endpoint.strip_prefix("ws://").unwrap().split('/').next().unwrap().to_string();
    let tcp = std::net::TcpStream::connect(&authority).unwrap();
    tcp.set_read_timeout(Some(SOON)).unwrap();
    let (mut cdp, _) = tungstenite::client::client(endpoint.as_str(), tcp).expect("the proxy's handshake");
    let targets = cdp_call(&mut cdp, 1, "Target.getTargets", serde_json::json!({}), None);
    let page = targets["targetInfos"]
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["type"] == "page")
        .expect("the browser's first tab")["targetId"]
        .as_str()
        .unwrap()
        .to_string();
    let attached = cdp_call(&mut cdp, 2, "Target.attachToTarget", serde_json::json!({ "targetId": page, "flatten": true }), None);
    let cdp_session = attached["sessionId"].as_str().unwrap().to_string();
    let url = "data:text/html,<body style='background:%23246'><h1 style='color:white'>seen on the phone</h1></body>";
    cdp_call(&mut cdp, 3, "Page.navigate", serde_json::json!({ "url": url }), Some(&cdp_session));

    // Each frame the desk's stream reads, offered on to the Devices, until
    // one of that page has crossed.
    let deadline = Instant::now() + SOON;
    loop {
        assert!(Instant::now() < deadline, "no frame of the page reached the Device");
        let (seq, data, frame_url) = match watch.next() {
            Response::BrowserFrame { session_id: s, seq, data, url, .. } => {
                assert_eq!(s, session_id);
                (seq, data, url)
            }
            other => panic!("unexpected on the watch: {other:?}"),
        };
        stand_in.offer_event(FRAME_EVENT, frame_payload(&session_id, seq, &data, &frame_url));
        let payload = heard_frame(&mut connection);
        assert!(payload["data"] == data, "the frame arrived altered");
        if !frame_url.starts_with("data:text/html") {
            continue;
        }
        assert!(data.starts_with("/9j/"), "a JPEG, base64");
        assert_eq!(jpeg_size(&data), Some((640, 400)), "the phone's size");
        // Under one Noise frame, as the spec measured a phone frame.
        assert!(data.len() < 64 * 1024, "a phone frame of {} bytes", data.len());
        break;
    }

    // The browser ends with its session, not with the daemon: a daemon
    // shut down under a live session leaves its headless shell running.
    drop(cdp);
    assert!(matches!(workstation.command.request(&Request::KillSession { id: session_id.clone() }), Response::Ok));
    loop {
        match watch.next() {
            Response::BrowserGone { session_id: gone } => {
                assert_eq!(gone, session_id);
                break;
            }
            Response::BrowserFrame { .. } => continue,
            other => panic!("unexpected on the watch: {other:?}"),
        }
    }
}

// -- presence (companion-16) --------------------------------------------

/// Has the desktop run `command` through `connection`, and hands back what
/// it answered.
fn invoked(
    connection: &mut Connection,
    command: &str,
    args: serde_json::Value,
) -> Option<serde_json::Value> {
    match connection
        .request(&Request::InvokeDesktop { command: command.into(), args }, SOON)
        .unwrap()
    {
        Response::DesktopResult { value, error: None } => value,
        other => panic!("{command} was answered {other:?}"),
    }
}

/// The stand-in's desktop: `create_session` answers with the id of the
/// session it started, named after the cwd so each Device's is its own.
fn desktop(command: &str, args: &serde_json::Value) -> serde_json::Value {
    match command {
        "create_session" => {
            serde_json::json!(format!("started-in-{}", args["cwd"].as_str().unwrap_or("?")))
        }
        _ => serde_json::Value::Null,
    }
}

/// Seam 1: the desk hears where each of two Devices is and what it is
/// doing, from the commands each has the desktop run, and reads the same
/// back from the list.
#[test]
fn presence_pushes_reflect_what_two_devices_are_doing_at_once() {
    let relay = LocalRelay::start();
    let mut workstation = Workstation::start(&relay);
    workstation.reach(&relay);
    let phone = device(&relay, "Seam one iPhone");
    let tablet = device(&relay, "Seam one iPad");
    let paired_phone = workstation.pair(&phone);
    let paired_tablet = workstation.pair(&tablet);
    let mut phone_conn = phone.connect(&paired_phone).unwrap();
    assert_eq!(workstation.connected(), paired_phone.device_id);
    let mut tablet_conn = tablet.connect(&paired_tablet).unwrap();
    assert_eq!(workstation.connected(), paired_tablet.device_id);

    let _stand_in = StandIn::answering_by(workstation.open_forwarding(), desktop, vec![]);

    // The phone works in one workspace and starts a session there. The
    // tablet is in another, typing into a session the desk started.
    invoked(&mut phone_conn, "get_board", serde_json::json!({"workspaceId": "w-phone"}));
    invoked(&mut tablet_conn, "get_board", serde_json::json!({"workspaceId": "w-tablet"}));
    let started = invoked(
        &mut phone_conn,
        "create_session",
        serde_json::json!({
            "cwd": "/work/phone",
            "workspaceRoot": "/work/phone",
            "command": "claude",
            "profileId": "claude-code",
        }),
    );
    assert_eq!(started, Some(serde_json::json!("started-in-/work/phone")));
    invoked(
        &mut tablet_conn,
        "write_input",
        serde_json::json!({"sessionId": "desk-session", "data": "ls\r"}),
    );

    let phone_now =
        workstation.push.presence_of(&paired_phone.device_id, |p| !p.started.is_empty());
    assert_eq!(phone_now.workspace_id.as_deref(), Some("w-phone"));
    assert_eq!(phone_now.typing, None, "the phone typed nothing");
    assert_eq!(phone_now.started.len(), 1);
    assert_eq!(phone_now.started[0].session_id, "started-in-/work/phone");
    assert_eq!(phone_now.started[0].workspace_root.as_deref(), Some("/work/phone"));
    assert_eq!(phone_now.started[0].cwd.as_deref(), Some("/work/phone"));

    // A terminal in a workspace with no folder names nothing but the
    // workspace: no root, and no cwd -- it opens in the home folder.
    let scratch = invoked(
        &mut phone_conn,
        "create_session",
        serde_json::json!({"workspaceId": "w-scratch"}),
    );
    assert_eq!(scratch, Some(serde_json::json!("started-in-?")));
    let phone_now =
        workstation.push.presence_of(&paired_phone.device_id, |p| p.started.len() == 2);
    assert_eq!(phone_now.workspace_id.as_deref(), Some("w-scratch"));
    assert_eq!(phone_now.started[1].session_id, "started-in-?");
    assert_eq!(phone_now.started[1].workspace_id.as_deref(), Some("w-scratch"));
    assert_eq!(phone_now.started[1].workspace_root, None);
    assert_eq!(phone_now.started[1].cwd, None);

    let tablet_now = workstation.push.presence_of(&paired_tablet.device_id, |p| p.typing.is_some());
    assert_eq!(tablet_now.workspace_id.as_deref(), Some("w-tablet"));
    assert_eq!(
        tablet_now.typing.as_ref().map(|t| t.session_id.as_str()),
        Some("desk-session")
    );
    assert!(tablet_now.started.is_empty(), "the tablet started nothing");

    // The read-back agrees, so a desk that reloads has what it was pushed.
    let devices = workstation.devices();
    let presence_of = |id: &str| {
        devices.iter().find(|d| d.device_id == id).and_then(|d| d.presence.clone())
    };
    assert_eq!(presence_of(&paired_phone.device_id), Some(phone_now));
    assert_eq!(presence_of(&paired_tablet.device_id), Some(tablet_now));
}

/// A session the desk launches itself names no Device: nothing is pushed
/// about it, and no Device's account of what it started carries it.
#[test]
fn a_session_the_desk_starts_itself_names_no_device() {
    let relay = LocalRelay::start();
    let mut workstation = Workstation::start(&relay);
    workstation.reach(&relay);
    let phone = device(&relay, "Seam one iPhone");
    let paired = workstation.pair(&phone);
    let mut connection = phone.connect(&paired).unwrap();
    assert_eq!(workstation.connected(), paired.device_id);
    let _stand_in = StandIn::answering_by(workstation.open_forwarding(), desktop, vec![]);

    invoked(&mut connection, "get_board", serde_json::json!({"workspaceId": "w1"}));
    workstation.push.presence_of(&paired.device_id, |p| p.workspace_id.is_some());

    let home = workstation.home.path().to_string_lossy().to_string();
    let id = match workstation.command.request(&Request::CreateSession {
        workspace_path: home.clone(),
        cwd: home,
        command: None,
        profile_id: None,
        api_family: None,
        without_headroom: false,
    }) {
        Response::SessionCreated { id, .. } => id,
        other => panic!("expected a session, got {other:?}"),
    };

    assert!(
        workstation.push.hears_no_presence_for(QUIET),
        "the desk was told a Device did something when it launched {id} itself"
    );
    let devices = workstation.devices();
    let presence = devices[0].presence.clone().unwrap();
    assert!(presence.started.is_empty(), "{presence:?}");
}

/// A command the Device may not run says nothing about where it is: it
/// never reached the desktop, and a presence read off it would be a
/// Device's own say-so.
#[test]
fn a_refused_command_says_nothing_about_where_the_device_is() {
    let relay = LocalRelay::start();
    let mut workstation = Workstation::start(&relay);
    workstation.reach(&relay);
    let phone = device(&relay, "Seam one iPhone");
    let paired = workstation.pair(&phone);
    let mut connection = phone.connect(&paired).unwrap();
    assert_eq!(workstation.connected(), paired.device_id);
    let _stand_in = StandIn::answering_by(workstation.open_forwarding(), desktop, vec![]);

    let resp = connection
        .request(
            &Request::InvokeDesktop {
                command: "set_board_tabs".into(),
                args: serde_json::json!({"workspaceId": "w1", "tabs": []}),
            },
            SOON,
        )
        .unwrap();
    assert!(matches!(resp, Response::Error { .. }), "{resp:?}");

    assert!(workstation.push.hears_no_presence_for(QUIET), "a refused command moved the Device");
    assert_eq!(workstation.devices()[0].presence, None);
}

/// An app older than v63 cannot parse `DevicePresenceChanged` -- it would
/// read it as the reply to its next request -- so it is not sent one.
#[test]
fn an_app_older_than_the_bump_is_not_sent_the_presence_push() {
    let relay = LocalRelay::start();
    let mut workstation = Workstation::start(&relay);
    workstation.reach(&relay);
    let phone = device(&relay, "Seam one iPhone");
    let paired = workstation.pair(&phone);
    let mut older = workstation.push_speaking(protocol::DEVICE_PRESENCE_MIN_VERSION - 1);
    let mut connection = phone.connect(&paired).unwrap();
    assert_eq!(workstation.connected(), paired.device_id);
    let _stand_in = StandIn::answering_by(workstation.open_forwarding(), desktop, vec![]);

    invoked(&mut connection, "get_board", serde_json::json!({"workspaceId": "w1"}));
    // The current desk hears it, so the push was made...
    workstation.push.presence_of(&paired.device_id, |p| p.workspace_id.as_deref() == Some("w1"));
    // ...and the older one did not.
    assert!(
        older.hears_no_presence_for(QUIET),
        "an app that speaks v62 was sent a v63 push"
    );
}

// -- session ownership (v68) --------------------------------------------

/// What `command` was refused with: the owner refusal its error carries.
fn refused(connection: &mut Connection, command: &str, args: serde_json::Value) -> protocol::OwnerRefusal {
    match connection
        .request(&Request::InvokeDesktop { command: command.into(), args }, SOON)
        .unwrap()
    {
        Response::DesktopResult { value: None, error: Some(error) } => protocol::OwnerRefusal::from_error(&error)
            .unwrap_or_else(|| panic!("{command} was refused, but not by the session's owner: {error}")),
        other => panic!("expected {command} to be refused, got {other:?}"),
    }
}

/// `set_session_owner` as a Device asks it, answered by the daemon.
fn take(
    connection: &mut Connection,
    session_id: &str,
    to: Option<&str>,
    expect: Option<&str>,
) -> protocol::SessionOwnership {
    let args = serde_json::json!({ "sessionId": session_id, "to": to, "expect": expect, "force": true });
    serde_json::from_value(invoked(connection, "set_session_owner", args).expect("an ownership")).unwrap()
}

fn owner_id(ownership: &protocol::SessionOwnership) -> Option<&str> {
    ownership.owner.as_ref().map(|o| o.device_id.as_str())
}

/// Seam 1 (v68): two Devices, one session. The one that typed first owns
/// it and the other is refused, naming it, without the desk ever seeing
/// the keystroke; a Take over and a Hand over move it, and each time the
/// one left behind is the one refused. The desk hears every change, and
/// takes it back as the desk.
#[test]
fn one_session_takes_input_from_one_device_at_a_time() {
    let relay = LocalRelay::start();
    let mut workstation = Workstation::start(&relay);
    workstation.reach(&relay);
    let phone = device(&relay, "Seam one iPhone");
    let tablet = device(&relay, "Seam one iPad");
    let paired_phone = workstation.pair(&phone);
    let paired_tablet = workstation.pair(&tablet);
    let (phone_id, tablet_id) = (paired_phone.device_id.clone(), paired_tablet.device_id.clone());
    let mut phone_conn = phone.connect(&paired_phone).unwrap();
    assert_eq!(workstation.connected(), phone_id);
    let mut tablet_conn = tablet.connect(&paired_tablet).unwrap();
    assert_eq!(workstation.connected(), tablet_id);
    let stand_in = StandIn::answering_by(workstation.open_forwarding(), desktop, vec![]);
    let typed = |data: &str| serde_json::json!({ "sessionId": "s1", "data": data });
    let keystrokes = |stand_in: &StandIn| stand_in.received().iter().filter(|(c, _)| c == "write_input").count();

    // The phone types into a session nobody owns, and so owns it.
    invoked(&mut phone_conn, "write_input", typed("ls"));
    let claimed = workstation.push.ownership_of("s1", |o| o.owner.is_some());
    assert_eq!(owner_id(&claimed), Some(phone_id.as_str()));
    assert_eq!(claimed.owner.as_ref().unwrap().name, "Seam one iPhone");
    assert_eq!(claimed.reason, protocol::OwnerChange::Claimed);

    // The tablet is refused, naming the phone, and the desk sees nothing.
    match refused(&mut tablet_conn, "write_input", typed("rm")) {
        protocol::OwnerRefusal::Owned { owner, .. } => assert_eq!(owner.name, "Seam one iPhone"),
        other => panic!("expected Owned, got {other:?}"),
    }
    assert!(matches!(
        refused(&mut tablet_conn, "queue_input", serde_json::json!({ "sessionId": "s1", "text": "go" })),
        protocol::OwnerRefusal::Owned { .. }
    ));
    assert_eq!(keystrokes(&stand_in), 1, "only the phone's keystroke reached the desk");

    // The tablet takes over: answered by the daemon, as the tablet.
    let taken = take(&mut tablet_conn, "s1", Some(&tablet_id), Some(&phone_id));
    assert_eq!(owner_id(&taken), Some(tablet_id.as_str()));
    assert_eq!(taken.changed_by.as_deref(), Some(tablet_id.as_str()));
    assert_eq!(taken.reason, protocol::OwnerChange::TookOver);
    let heard = workstation.push.ownership_of("s1", |o| o.reason == protocol::OwnerChange::TookOver);
    assert_eq!(heard, taken, "the desk is told the same");
    assert!(matches!(refused(&mut phone_conn, "write_input", typed("x")), protocol::OwnerRefusal::Owned { .. }));
    invoked(&mut tablet_conn, "write_input", typed("pwd"));
    assert_eq!(keystrokes(&stand_in), 2);

    // The phone takes it back, then hands it to the tablet on purpose.
    take(&mut phone_conn, "s1", Some(&phone_id), Some(&tablet_id));
    let handed = take(&mut phone_conn, "s1", Some(&tablet_id), Some(&phone_id));
    assert_eq!(handed.reason, protocol::OwnerChange::HandedOver);
    assert_eq!(owner_id(&handed), Some(tablet_id.as_str()));
    assert!(matches!(refused(&mut phone_conn, "write_input", typed("x")), protocol::OwnerRefusal::Owned { .. }));

    // A Device reads back who owns what, who it is, and who it could hand
    // a session to.
    let list: protocol::session_owner::SessionOwnersList =
        serde_json::from_value(invoked(&mut phone_conn, "list_session_owners", serde_json::json!({})).unwrap())
            .unwrap();
    assert_eq!(list.you.as_deref(), Some(phone_id.as_str()));
    assert_eq!(list.owners.iter().map(owner_id).collect::<Vec<_>>(), [Some(tablet_id.as_str())]);
    let mut live: Vec<&str> = list.devices.iter().map(|d| d.device_id.as_str()).collect();
    live.sort();
    let mut both = [phone_id.as_str(), tablet_id.as_str()];
    both.sort();
    assert_eq!(live, both);

    // The desk takes it back, as the desk; now neither Device owns it.
    let back = match workstation.command.request(&Request::SetSessionOwner {
        id: "s1".into(),
        to: None,
        expect: Some(tablet_id.clone()),
        force: true,
    }) {
        Response::SessionOwnership { ownership } => ownership,
        other => panic!("expected SessionOwnership, got {other:?}"),
    };
    assert_eq!((back.owner.as_ref(), back.changed_by.as_ref()), (None, None));
    // A Take over that still expects the tablet lost the race to the desk.
    let late = serde_json::json!({ "sessionId": "s1", "to": phone_id, "expect": tablet_id, "force": true });
    assert!(matches!(
        refused(&mut phone_conn, "set_session_owner", late),
        protocol::OwnerRefusal::Changed { owner: None, .. }
    ));
}

/// A session a Device started is that Device's, and one whose owner is
/// revoked goes back to the desk at once rather than after a grace.
#[test]
fn a_started_session_is_its_devices_until_the_device_is_revoked() {
    let relay = LocalRelay::start();
    let mut workstation = Workstation::start(&relay);
    workstation.reach(&relay);
    let phone = device(&relay, "Seam one iPhone");
    let tablet = device(&relay, "Seam one iPad");
    let paired_phone = workstation.pair(&phone);
    let paired_tablet = workstation.pair(&tablet);
    let mut phone_conn = phone.connect(&paired_phone).unwrap();
    assert_eq!(workstation.connected(), paired_phone.device_id);
    let mut tablet_conn = tablet.connect(&paired_tablet).unwrap();
    assert_eq!(workstation.connected(), paired_tablet.device_id);
    let _stand_in = StandIn::answering_by(workstation.open_forwarding(), desktop, vec![]);

    let started = invoked(&mut phone_conn, "create_session", serde_json::json!({ "cwd": "/work/phone" }));
    let session_id = started.unwrap().as_str().unwrap().to_string();
    let owned = workstation.push.ownership_of(&session_id, |o| o.owner.is_some());
    assert_eq!(owned.reason, protocol::OwnerChange::Started);
    assert_eq!(owner_id(&owned), Some(paired_phone.device_id.as_str()));
    let typed = serde_json::json!({ "sessionId": session_id, "data": "x" });
    assert!(matches!(refused(&mut tablet_conn, "write_input", typed.clone()), protocol::OwnerRefusal::Owned { .. }));

    let resp = workstation.command.request(&Request::RevokeDevice { device_id: paired_phone.device_id.clone() });
    assert!(matches!(resp, Response::Ok), "{resp:?}");
    let released = workstation.push.ownership_of(&session_id, |o| o.owner.is_none());
    assert_eq!(released.reason, protocol::OwnerChange::Revoked);
    // Free for the taking: the tablet's next keystroke claims it.
    invoked(&mut tablet_conn, "write_input", typed);
    let claimed = workstation.push.ownership_of(&session_id, |o| o.owner.is_some());
    assert_eq!(owner_id(&claimed), Some(paired_tablet.device_id.as_str()));
}

/// An app older than v68 is sent nothing it cannot parse: the owner push
/// would be read as the reply to its next request. The current desk hears
/// the same change.
#[test]
fn an_app_older_than_the_bump_is_not_sent_the_owner_push() {
    let relay = LocalRelay::start();
    let mut workstation = Workstation::start(&relay);
    workstation.reach(&relay);
    let phone = device(&relay, "Seam one iPhone");
    let paired = workstation.pair(&phone);
    let mut older = workstation.push_speaking(protocol::SESSION_OWNERS_MIN_VERSION - 1);
    let mut connection = phone.connect(&paired).unwrap();
    assert_eq!(workstation.connected(), paired.device_id);
    let _stand_in = StandIn::answering_by(workstation.open_forwarding(), desktop, vec![]);

    invoked(&mut connection, "write_input", serde_json::json!({ "sessionId": "s1", "data": "x" }));
    workstation.push.ownership_of("s1", |o| o.owner.is_some());
    let heard_one = {
        older.stream.set_read_timeout(Some(QUIET)).unwrap();
        loop {
            match read_message::<_, Response>(&mut older.reader) {
                Ok(Some(Response::SessionOwnerChanged { .. })) => break true,
                Ok(Some(_)) => continue,
                _ => break false,
            }
        }
    };
    assert!(!heard_one, "an app that speaks v67 was sent a v68 push");
}

/// The owner going away is not the owner losing the session: it keeps it
/// through the grace, and the desk is told when the grace runs out.
#[test]
fn an_owner_that_hangs_up_keeps_its_session_through_the_grace() {
    let relay = LocalRelay::start();
    let mut workstation = Workstation::start(&relay);
    workstation.reach(&relay);
    let phone = device(&relay, "Seam one iPhone");
    let paired = workstation.pair(&phone);
    let mut phone_conn = phone.connect(&paired).unwrap();
    assert_eq!(workstation.connected(), paired.device_id);
    let _stand_in = StandIn::answering_by(workstation.open_forwarding(), desktop, vec![]);

    invoked(&mut phone_conn, "write_input", serde_json::json!({ "sessionId": "s1", "data": "x" }));
    workstation.push.ownership_of("s1", |o| o.owner.is_some());
    drop(phone_conn);
    let away = workstation.push.ownership_of("s1", |o| o.owner.as_ref().is_some_and(|o| o.away_since.is_some()));
    let owner = away.owner.unwrap();
    assert_eq!(owner.device_id, paired.device_id);
    assert_eq!(owner.releases_at, owner.away_since.map(|at| at + protocol::session_owner::OWNER_GRACE_SECS));

    // Back inside the grace: its own again.
    let _phone_conn = phone.connect(&paired).unwrap();
    let back = workstation.push.ownership_of("s1", |o| o.owner.as_ref().is_some_and(|o| o.away_since.is_none()));
    assert_eq!(owner_id(&back), Some(paired.device_id.as_str()));
}

// -- attention request (companion-14) -----------------------------------

/// The test Device gets the items the stand-in reports.
#[test]
fn the_attention_request_returns_the_items_the_stand_in_reports() {
    let relay = LocalRelay::start();
    let mut workstation = Workstation::start(&relay);
    workstation.reach(&relay);
    let device = device(&relay, "Seam one iPhone");
    let paired = workstation.pair(&device);
    let mut connection = device.connect(&paired).unwrap();
    assert_eq!(workstation.connected(), paired.device_id);

    let items = vec![protocol::AttentionItem {
        id: "waiting:s1".into(),
        workspace: "ws-1".into(),
        kind: protocol::AttentionKind::Waiting,
        text: "agent is asking".into(),
        target: protocol::AttentionTarget::Session { id: "s1".into() },
    }];
    let stand_in = StandIn::answering_with_attention(
        workstation.open_forwarding(),
        serde_json::json!(null),
        items.clone(),
    );

    match connection
        .request(
            &Request::GetAttention {
                version: protocol::ATTENTION_API_VERSION,
            },
            SOON,
        )
        .unwrap()
    {
        Response::Attention {
            state,
            items: got,
            version,
            reason,
        } => {
            assert_eq!(state, protocol::WorkstationState::Ready);
            assert_eq!(reason, None);
            assert_eq!(version, protocol::ATTENTION_API_VERSION);
            assert_eq!(got, items);
        }
        other => panic!("expected Attention, got {other:?}"),
    }

    eventually("the stand-in saw the attention ask", || {
        stand_in
            .received()
            .iter()
            .any(|(name, _)| name == "__attention__")
    });
}

/// "desktop app not running" is a state on the attention answer when the
/// stand-in is absent — not an Error, so the hub can draw it.
#[test]
fn the_attention_request_reports_desktop_app_not_running_when_the_stand_in_is_absent() {
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
            &Request::GetAttention {
                version: protocol::ATTENTION_API_VERSION,
            },
            SOON,
        )
        .unwrap()
    {
        Response::Attention {
            state,
            items,
            version,
            reason,
        } => {
            assert_eq!(state, protocol::WorkstationState::DesktopAppNotRunning);
            assert_eq!(reason, Some(protocol::NotRunningReason::NotConnected));
            assert!(items.is_empty());
            assert_eq!(version, protocol::ATTENTION_API_VERSION);
        }
        other => panic!("expected Attention, got {other:?}"),
    }
}

/// A desk whose forwarding connection drops and comes back -- the app
/// reconnected, or its forwarding loop redialled -- is Ready again on the
/// Device's next ask, with nothing restarted. In between, the Device is
/// told that no desktop app is connected, and the daemon's log says when
/// each happened.
#[test]
fn a_desk_whose_forwarding_connection_dropped_and_came_back_is_ready_again() {
    let relay = LocalRelay::start();
    let mut workstation = Workstation::start(&relay);
    workstation.reach(&relay);
    let device = device(&relay, "Seam one iPhone");
    let paired = workstation.pair(&device);
    let mut connection = device.connect(&paired).unwrap();
    let _ = workstation.connected();
    let mut ask = || {
        match connection
            .request(&Request::GetAttention { version: protocol::ATTENTION_API_VERSION }, SOON)
            .unwrap()
        {
            Response::Attention { state, items, reason, .. } => (state, items, reason),
            other => panic!("expected Attention, got {other:?}"),
        }
    };
    let items = vec![protocol::AttentionItem {
        id: "waiting:s1".into(),
        workspace: "ws-1".into(),
        kind: protocol::AttentionKind::Waiting,
        text: "agent is asking".into(),
        target: protocol::AttentionTarget::Session { id: "s1".into() },
    }];

    let first = StandIn::answering_with_attention(workstation.open_forwarding(), serde_json::json!(null), items.clone());
    assert_eq!(ask(), (protocol::WorkstationState::Ready, items.clone(), None));

    drop(first);
    // The daemon hears the close on the connection's own thread; an ask
    // that races it is told the connection was lost, and the next one
    // that nothing is connected.
    let deadline = Instant::now() + SOON;
    loop {
        let (state, got, reason) = ask();
        assert_eq!(state, protocol::WorkstationState::DesktopAppNotRunning);
        assert!(got.is_empty());
        if reason == Some(protocol::NotRunningReason::NotConnected) {
            break;
        }
        assert_eq!(reason, Some(protocol::NotRunningReason::ConnectionLost));
        assert!(Instant::now() < deadline, "the dropped connection was never noticed");
        std::thread::sleep(Duration::from_millis(20));
    }

    let _second = StandIn::answering_with_attention(workstation.open_forwarding(), serde_json::json!(null), items.clone());
    assert_eq!(ask(), (protocol::WorkstationState::Ready, items, None));

    let log = workstation.log();
    for said in [
        "registered; the desktop app is connected",
        "closed; no desktop app is connected now",
        "asked for attention with no desktop app connected",
    ] {
        assert_eq!(log.matches(said).count(), if said.starts_with("registered") { 2 } else { 1 }, "{said:?} in:\n{log}");
    }
}

/// The Companion bundle a Device asks for is the manifest first, then the
/// archive a chunk at a time, each cut to the wire's cap; what comes back
/// is byte for byte the archive the desktop signed, and verifies under
/// the key that signed it (ADR 0005, companion-23).
#[test]
fn the_companion_bundle_is_served_in_chunks_and_verifies() {
    use protocol::companion_bundle::{self, BUNDLE_CHUNK_MAX};

    let relay = LocalRelay::start();
    let mut workstation = Workstation::start(&relay);
    workstation.reach(&relay);
    let device = device(&relay, "Seam one iPhone");
    let paired = workstation.pair(&device);
    let mut connection = device.connect(&paired).unwrap();
    assert_eq!(workstation.connected(), paired.device_id);

    // Bigger than one chunk, so the fetch has to loop.
    let big: Vec<u8> = (0..(BUNDLE_CHUNK_MAX as usize * 2 + 777)).map(|i| (i % 251) as u8).collect();
    let archive = companion_bundle::pack(&[
        ("index.html", b"<!doctype html>" as &[u8]),
        ("_app/immutable/chunks/big.js", &big),
    ])
    .unwrap();
    let seed = [42u8; 32];
    let manifest = companion_bundle::sign(&archive, &seed, "test");
    let stand_in = StandIn::answering_with_bundle(
        workstation.open_forwarding(),
        Some((manifest.clone(), archive.clone())),
    );

    let ask = |connection: &mut Connection, offset: u64, length: u64| -> (protocol::BundleManifest, u64, Vec<u8>) {
        match connection
            .request(
                &Request::GetCompanionBundle {
                    version: protocol::COMPANION_BUNDLE_API_VERSION,
                    offset,
                    length,
                },
                SOON,
            )
            .unwrap()
        {
            Response::CompanionBundle { version, state, manifest, offset, data, .. } => {
                assert_eq!(version, protocol::COMPANION_BUNDLE_API_VERSION);
                assert_eq!(state, protocol::WorkstationState::Ready);
                (manifest.expect("a manifest"), offset, companion_bundle::decode_chunk(&data).unwrap())
            }
            other => panic!("expected CompanionBundle, got {other:?}"),
        }
    };

    // The manifest alone.
    let (got, offset, data) = ask(&mut connection, 0, 0);
    assert_eq!(got, manifest);
    assert_eq!(offset, 0);
    assert!(data.is_empty());

    // A length past the cap is cut to it.
    let (_, _, data) = ask(&mut connection, 0, u64::MAX);
    assert_eq!(data.len() as u64, BUNDLE_CHUNK_MAX);
    assert_eq!(data, archive[..BUNDLE_CHUNK_MAX as usize]);

    // The whole archive, the way the shell fetches it.
    let mut fetched = Vec::new();
    while (fetched.len() as u64) < manifest.size {
        let (_, offset, data) = ask(&mut connection, fetched.len() as u64, BUNDLE_CHUNK_MAX);
        assert_eq!(offset, fetched.len() as u64);
        assert!(!data.is_empty(), "an empty chunk before the end");
        fetched.extend_from_slice(&data);
    }
    assert_eq!(fetched, archive);
    companion_bundle::verify(&fetched, &manifest, &[companion_bundle::public_key(&seed)]).unwrap();
    let files = companion_bundle::unpack(&fetched).unwrap();
    assert_eq!(files.len(), 2);
    assert_eq!(files[0].path, "_app/immutable/chunks/big.js");
    assert_eq!(files[0].data, big);

    // Under another key it is refused: the shell's store build trusts
    // only the publisher's.
    assert_eq!(
        companion_bundle::verify(&fetched, &manifest, &[companion_bundle::public_key(&[1u8; 32])]),
        Err(companion_bundle::BundleRefusal::UntrustedSigner)
    );

    // Every ask reached the desktop, cut to the cap before it got there.
    eventually("the stand-in saw the bundle asks", || {
        stand_in.received().iter().filter(|(name, _)| name == "__bundle__").count() >= 5
    });
    for (_, args) in stand_in.received().iter().filter(|(name, _)| name == "__bundle__") {
        assert!(args["length"].as_u64().unwrap() <= BUNDLE_CHUNK_MAX);
    }
}

/// A desktop that carries no bundle says so with a state that is ready
/// and no manifest; with no desktop at all the answer is the "desktop
/// app not running" state, as for attention.
#[test]
fn the_companion_bundle_says_when_there_is_none_to_serve() {
    let relay = LocalRelay::start();
    let mut workstation = Workstation::start(&relay);
    workstation.reach(&relay);
    let device = device(&relay, "Seam one iPhone");
    let paired = workstation.pair(&device);
    let mut connection = device.connect(&paired).unwrap();
    let _ = workstation.connected();

    let ask = |connection: &mut Connection| {
        connection
            .request(
                &Request::GetCompanionBundle {
                    version: protocol::COMPANION_BUNDLE_API_VERSION,
                    offset: 0,
                    length: 0,
                },
                SOON,
            )
            .unwrap()
    };

    // No forwarding connection.
    match ask(&mut connection) {
        Response::CompanionBundle { state, manifest, data, reason, .. } => {
            assert_eq!(state, protocol::WorkstationState::DesktopAppNotRunning);
            assert_eq!(reason, Some(protocol::NotRunningReason::NotConnected));
            assert!(manifest.is_none());
            assert!(data.is_empty());
        }
        other => panic!("expected CompanionBundle, got {other:?}"),
    }

    // A desktop with nothing staged.
    let _stand_in = StandIn::answering_with_bundle(workstation.open_forwarding(), None);
    match ask(&mut connection) {
        Response::CompanionBundle { state, manifest, .. } => {
            assert_eq!(state, protocol::WorkstationState::Ready);
            assert!(manifest.is_none());
        }
        other => panic!("expected CompanionBundle, got {other:?}"),
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

// -- what the desk is told about the dial --------------------------------

fn relay_state(workstation: &mut Workstation) -> protocol::RelayState {
    match workstation.command.request(&Request::GetRelayState) {
        Response::RelayState { state } => state,
        other => panic!("expected RelayState, got {other:?}"),
    }
}

fn eventually_state(
    workstation: &mut Workstation,
    what: &str,
    check: impl Fn(&protocol::RelayState) -> bool,
) -> protocol::RelayState {
    let deadline = Instant::now() + SOON;
    loop {
        let state = relay_state(workstation);
        if check(&state) {
            return state;
        }
        assert!(Instant::now() < deadline, "{what}; the state is {state:?}");
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// The dial's state is what the desk shows beside the Relay URL: off
/// reads not wanted, a registered daemon reads connected, and a wrong
/// token reads failed in the Relay's own words -- without the token.
#[test]
fn the_desk_is_told_whether_the_daemon_reached_its_relay() {
    use protocol::RelayState;
    let relay = LocalRelay::start();
    let mut workstation = Workstation::start(&relay);

    assert_eq!(relay_state(&mut workstation), RelayState::NotWanted);

    let wrong = "not-the-token-9f3a";
    workstation.set_remote_access(true, Some(&relay.url()), Some(wrong));
    let failed = eventually_state(&mut workstation, "the wrong token was not reported", |s| {
        matches!(s, RelayState::Failed { .. })
    });
    match &failed {
        RelayState::Failed { why } => {
            assert_eq!(why, &RefusalReason::Admission.to_string());
        }
        other => panic!("{other:?}"),
    }
    // Neither the state nor the push nor the log carries the token.
    assert!(!serde_json::to_string(&failed).unwrap().contains(wrong));
    assert!(!workstation.log().contains(wrong), "the token reached the log");

    // The right token, without a restart: connected, since about now.
    workstation.set_remote_access(true, Some(&relay.url()), Some(TOKEN));
    let connected = eventually_state(&mut workstation, "the daemon did not connect", |s| {
        matches!(s, RelayState::Connected { .. })
    });
    match connected {
        RelayState::Connected { since } => {
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_secs() as i64;
            assert!((now - since).abs() < 60, "since {since} is not near {now}");
        }
        other => panic!("{other:?}"),
    }
    assert!(!workstation.log().contains(TOKEN), "the token reached the log");

    workstation.set_remote_access(false, Some(&relay.url()), None);
    eventually_state(&mut workstation, "off did not read as not wanted", |s| {
        *s == RelayState::NotWanted
    });
}

/// The desk hears the change without asking.
#[test]
fn a_change_of_the_dials_state_is_pushed_to_the_desk() {
    use protocol::RelayState;
    let relay = LocalRelay::start();
    let mut workstation = Workstation::start(&relay);
    let mut push = Desk::connect(&workstation.endpoint(), &workstation.daemon_token, ConnectionKind::Push);

    workstation.set_remote_access(true, Some(&relay.url()), Some(TOKEN));
    let mut saw_connected = false;
    for _ in 0..20 {
        match push.next_raw() {
            Response::RelayStateChanged { state: RelayState::Connected { .. } } => {
                saw_connected = true;
                break;
            }
            Response::RelayStateChanged { .. } => {}
            other => panic!("unexpected push {other:?}"),
        }
    }
    assert!(saw_connected, "no connected push arrived");
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
        Response::Devices { remote_access_enabled, relay_url, relay_admission_set, devices, .. } => {
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
    match device(&relay, "attacker").pair_with(&photographed_too_late) {
        Err(TestDeviceError::Closed) => {}
        Err(other) => panic!("expected the Workstation to end the pairing, got {other}"),
        Ok(pairing) => panic!("a wrong secret showed the code {}", pairing.code),
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
        Request::CreateSession {
            workspace_path: "/tmp".into(),
            cwd: "/tmp".into(),
            command: None,
            profile_id: None,
            api_family: None,
            without_headroom: false,
        },
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
        // Never acknowledged, so no code is shown: the Device learns
        // its proof was not taken before it puts anything on screen.
        match device(&relay, how).proving(proving).pair_with(&offer) {
            Err(TestDeviceError::Closed) => {}
            Err(other) => panic!("{how}: expected the Workstation to end the pairing, got {other}"),
            Ok(pairing) => panic!("{how}: the code {} was shown", pairing.code),
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

/// Ticket 34: a connection that completes the handshake with a paired
/// Device's Noise key and fails its signature is what a copied key looks
/// like, and the desk is told -- by a push, and by the row the next read of
/// the Device list returns.
#[test]
fn the_desk_is_told_when_a_copied_key_fails_its_proof() {
    let relay = LocalRelay::start();
    let mut workstation = Workstation::start(&relay);
    workstation.reach(&relay);
    let device = device(&relay, "Seam one iPhone");
    let paired = workstation.pair(&device);
    assert_eq!(workstation.devices()[0].last_refusal.clone(), None, "nothing was refused yet");

    let before = now_seconds();
    let copy = device.copied_to_another_phone().unwrap();
    assert!(matches!(
        copy.connect(&paired),
        Err(TestDeviceError::Refused(ConnectRefusal::Unlock))
    ));

    let (device_id, pushed) = workstation.push.heard_refusal();
    assert_eq!(device_id, paired.device_id);
    assert_eq!(pushed.reason, ConnectRefusal::Unlock);
    assert!(pushed.at >= before && pushed.at <= now_seconds(), "{}", pushed.at);

    let devices = workstation.devices();
    assert_eq!(devices.len(), 1);
    assert_eq!(devices[0].last_refusal, Some(pushed));

    // The real phone connecting afterwards does not wipe the record: a
    // copy that failed and then the phone that did is the order in which
    // the alarm would otherwise vanish.
    let _real = device.connect(&paired).unwrap();
    assert_eq!(workstation.connected(), paired.device_id);
    assert_eq!(workstation.devices()[0].last_refusal.as_ref().map(|r| r.reason), Some(ConnectRefusal::Unlock));
}

/// ...and a Device the human revoked, still trying.
#[test]
fn the_desk_is_told_when_a_revoked_device_is_refused() {
    let relay = LocalRelay::start();
    let mut workstation = Workstation::start(&relay);
    workstation.reach(&relay);
    let device = device(&relay, "Seam one iPhone");
    let paired = workstation.pair(&device);
    let resp = workstation
        .command
        .request(&Request::RevokeDevice { device_id: paired.device_id.clone() });
    assert!(matches!(resp, Response::Ok), "{resp:?}");

    assert!(matches!(
        device.connect(&paired),
        Err(TestDeviceError::Refused(ConnectRefusal::Revoked))
    ));
    let (device_id, pushed) = workstation.push.heard_refusal();
    assert_eq!(device_id, paired.device_id);
    assert_eq!(pushed.reason, ConnectRefusal::Revoked);
    let devices = workstation.devices();
    assert_eq!(devices[0].last_refusal, Some(pushed));
    assert!(devices[0].revoked_at.is_some());
}

/// An app older than v62 is sent nothing it cannot parse: a
/// `DeviceRefusalChanged` it has never heard of would be read as the reply
/// to a request. It still reads the row, which carries the new field only
/// where an older app ignores it.
#[test]
fn an_app_older_than_the_bump_is_not_sent_the_refusal_push() {
    let relay = LocalRelay::start();
    let mut workstation = Workstation::start(&relay);
    workstation.reach(&relay);
    let mut older = workstation.push_speaking(protocol::DEVICE_REFUSALS_MIN_VERSION - 1);
    let device = device(&relay, "Seam one iPhone");
    let paired = workstation.pair(&device);
    // Pairing pushes the desk's own dialog to `older` too, which it can
    // parse; let it go past.
    assert!(matches!(older.next(), Response::DevicePairingRequested { .. }));

    let copy = device.copied_to_another_phone().unwrap();
    assert!(matches!(
        copy.connect(&paired),
        Err(TestDeviceError::Refused(ConnectRefusal::Unlock))
    ));
    // The current app was told, so the daemon did push...
    workstation.push.heard_refusal();
    // ...and the older one heard nothing at all.
    assert!(older.hears_nothing_for(QUIET), "an app that speaks v61 was sent a v62 push");
    assert!(older.refusals.is_empty());
}

/// Ticket 33: the six digits cover the pairing they are shown for. A copy
/// of a Device's Noise key, on a phone with a hardware key of its own,
/// makes another handshake and so shows other digits -- the owner cannot be
/// walked into confirming a pairing they did not make by two screens that
/// happen to agree.
#[test]
fn two_pairings_with_one_noise_key_show_different_codes() {
    let relay = LocalRelay::start();
    let mut workstation = Workstation::start(&relay);
    workstation.reach(&relay);
    let device = device(&relay, "Seam one iPhone");
    let copy = device.copied_to_another_phone().unwrap();
    assert_eq!(copy.keys.public, device.keys.public);

    let first = device.pair(&workstation.offer()).unwrap();
    let (first_id, _, first_desk) = workstation.asked();
    assert_eq!(first.code, first_desk);
    let resp = workstation.command.request(&Request::ConfirmPairing { device_id: first_id.clone() });
    assert!(matches!(resp, Response::Ok), "{resp:?}");
    let first_code = first.code.clone();
    first.paired(SOON).unwrap();

    let second = copy.pair(&workstation.offer()).unwrap();
    let (second_id, _, second_desk) = workstation.asked();
    // The same Noise key is the same row, so the desk can say it knows it.
    assert_eq!(second_id, first_id);
    assert_eq!(second.code, second_desk);
    assert_ne!(second.code, first_code, "one Noise key showed one code twice");
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

/// v67, over the Device wire: a Device hands this Workstation its send
/// permission, and the desk's list says that Device -- and only that one
/// -- can be notified. Taking it back with an empty one says so too.
#[test]
fn a_device_hands_over_its_send_permission_over_the_wire() {
    let relay = LocalRelay::start();
    let mut workstation = Workstation::start(&relay);
    workstation.reach(&relay);
    let phone = device(&relay, "phone");
    let tablet = device(&relay, "tablet");
    let phone_paired = workstation.pair(&phone);
    let _tablet_paired = workstation.pair(&tablet);

    let mut connection = phone.connect(&phone_paired).unwrap();
    assert_eq!(workstation.connected(), phone_paired.device_id);
    let notifies = |workstation: &mut Workstation| -> Vec<(String, bool)> {
        let mut rows: Vec<_> = workstation.devices().into_iter().map(|d| (d.name, d.notifies)).collect();
        rows.sort();
        rows
    };

    let hand = |permission: &str| Request::SetThisDeviceSendPermission { permission: permission.into() };
    match connection.request(&hand("v1.claims.signature"), SOON) {
        Ok(Response::Ok) => {}
        other => panic!("expected the permission to be kept, got {other:?}"),
    }
    assert_eq!(notifies(&mut workstation), vec![("phone".into(), true), ("tablet".into(), false)]);

    match connection.request(&hand(""), SOON) {
        Ok(Response::Ok) => {}
        other => panic!("expected the permission to be taken back, got {other:?}"),
    }
    assert_eq!(notifies(&mut workstation), vec![("phone".into(), false), ("tablet".into(), false)]);
}
