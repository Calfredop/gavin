//! The Relay, driven from outside: a real listener on this machine, and
//! the blocking client the daemon and the test Device dial it with.
//!
//! Every test here asserts what a peer would observe -- a refusal and its
//! reason, bytes that arrived, a connection that ended -- and none of them
//! looks inside the Relay.

use gavin_relay::client::{dial, DialError, DialOptions, RelayConnection, RelayStream};
use gavin_relay::server::{Limits, RelayConfig, RunningRelay, Tls};
use protocol::relay::{
    rendezvous_id, RefusalReason, RelayHello, RelayReply, PURPOSE_PAIR, RELAY_WIRE_VERSION,
};
use std::io::{Read, Write};
use std::net::TcpStream;
use std::time::{Duration, Instant};
use tungstenite::Message;

const TOKEN: &str = "let-me-in";

/// How long a test waits for something that should happen at once.
const SOON: Duration = Duration::from_secs(5);

fn relay() -> RunningRelay {
    RunningRelay::start(RelayConfig::local(TOKEN)).unwrap()
}

/// A Relay whose deadlines are short enough to wait out in a test.
fn impatient_relay() -> RunningRelay {
    let mut config = RelayConfig::local(TOKEN);
    config.limits = Limits {
        hello_deadline: Duration::from_millis(300),
        claim_deadline: Duration::from_millis(300),
        ..Limits::default()
    };
    RunningRelay::start(config).unwrap()
}

fn rendezvous(tag: u8) -> String {
    rendezvous_id(&[tag; 32])
}

fn options() -> DialOptions {
    DialOptions { hello_timeout: SOON, ..DialOptions::default() }
}

fn register(relay: &RunningRelay, rendezvous: &str) -> RelayConnection {
    dial(&relay.url(), &RelayHello::workstation(TOKEN, rendezvous), &options()).unwrap()
}

/// The stream id of the next announcement.
fn announced(workstation: &mut RelayConnection) -> String {
    match workstation.next_reply(SOON).unwrap() {
        Some(RelayReply::Incoming { stream, purpose }) => {
            assert_eq!(purpose, PURPOSE_PAIR);
            stream
        }
        other => panic!("expected an announcement, got {other:?}"),
    }
}

/// Dials as a Device on a thread of its own, because the dial returns
/// only once a Workstation has picked the stream up.
fn device_dialling(
    relay: &RunningRelay,
    rendezvous: &str,
) -> std::thread::JoinHandle<Result<RelayStream, DialError>> {
    let url = relay.url();
    let hello = RelayHello::device(TOKEN, rendezvous, PURPOSE_PAIR);
    std::thread::spawn(move || dial(&url, &hello, &options()).map(RelayConnection::into_stream))
}

/// A Device and a Workstation, joined.
fn joined(relay: &RunningRelay, rendezvous: &str) -> (RelayStream, RelayStream, RelayConnection) {
    let mut workstation = register(relay, rendezvous);
    let device = device_dialling(relay, rendezvous);
    let stream = announced(&mut workstation);
    let picked_up = dial(&relay.url(), &RelayHello::stream(TOKEN, rendezvous, &stream), &options())
        .unwrap()
        .into_stream();
    let mut device = device.join().unwrap().unwrap();
    let mut picked_up = picked_up;
    device.set_read_timeout(Some(SOON)).unwrap();
    picked_up.set_read_timeout(Some(SOON)).unwrap();
    (device, picked_up, workstation)
}

fn refusal<T>(result: Result<T, DialError>) -> RefusalReason {
    match result {
        Err(DialError::Refused(reason)) => reason,
        Err(other) => panic!("expected a refusal, got {other}"),
        Ok(_) => panic!("expected a refusal, and the Relay admitted the connection"),
    }
}

/// Waits for the Relay's own count to reach what a test expects. The
/// count moves on the Relay's thread, a moment after the socket does.
fn eventually(what: &str, check: impl Fn() -> bool) {
    let deadline = Instant::now() + SOON;
    while !check() {
        assert!(Instant::now() < deadline, "{what}");
        std::thread::sleep(Duration::from_millis(10));
    }
}

/// A WebSocket to the Relay with nothing said on it yet, for the tests
/// that say something a well-behaved peer would not.
fn raw(relay: &RunningRelay) -> tungstenite::WebSocket<TcpStream> {
    let socket = TcpStream::connect(relay.local_addr()).unwrap();
    socket.set_read_timeout(Some(SOON)).unwrap();
    let (ws, _) = tungstenite::client::client(relay.url(), socket).unwrap();
    ws
}

/// What the Relay says to a raw connection, and whether it then closed.
fn said_then_closed(ws: &mut tungstenite::WebSocket<TcpStream>) -> Option<RelayReply> {
    let mut said = None;
    loop {
        match ws.read() {
            Ok(Message::Text(text)) => said = Some(RelayReply::from_frame(text.as_str()).unwrap()),
            Ok(Message::Close(_)) => continue,
            Ok(other) => panic!("the Relay sent {other:?}"),
            Err(tungstenite::Error::ConnectionClosed | tungstenite::Error::AlreadyClosed) => {
                return said
            }
            Err(tungstenite::Error::Io(e))
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) =>
            {
                panic!("the Relay left the connection open (it had said {said:?})")
            }
            // A socket closed without a closing handshake.
            Err(_) => return said,
        }
    }
}

/// A Relay that asks after its connections ten times a second, so a
/// test can tell a wait that is bounded from one that every ping renews.
fn attentive_relay() -> RunningRelay {
    let mut config = RelayConfig::local(TOKEN);
    config.limits = Limits {
        keepalive: Duration::from_millis(100),
        silence: Duration::from_millis(600),
        ..Limits::default()
    };
    RunningRelay::start(config).unwrap()
}

/// The Relay asks every leg whether it is still there, and each time it
/// does, something arrives on the socket. A read that started its wait
/// over for every ping would never give up on a peer that had gone
/// quiet -- and a Device that says nothing would hold a thread of the
/// daemon's for as long as it liked.
#[test]
fn a_read_gives_up_at_its_timeout_however_often_the_relay_asks_after_it() {
    let relay = attentive_relay();
    let (_device, mut workstation, _registration) = joined(&relay, &rendezvous(1));

    workstation.set_read_timeout(Some(Duration::from_millis(300))).unwrap();
    let started = Instant::now();
    let mut buf = [0u8; 1];
    let err = workstation.read(&mut buf).expect_err("nothing was sent, and something was read");
    assert!(
        matches!(err.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut),
        "{err}"
    );
    let waited = started.elapsed();
    assert!(waited >= Duration::from_millis(300), "gave up early, after {waited:?}");
    assert!(waited < Duration::from_millis(1500), "every ping renewed the wait: {waited:?}");
}

/// The other half of the same question: a leg that stops answering is
/// dropped. A laptop that slept takes its sockets with it and tells
/// nobody, and the Relay must not go on announcing streams to it.
#[test]
fn a_workstation_that_stops_answering_is_dropped() {
    let relay = attentive_relay();
    let r = rendezvous(1);

    // Registered by hand and then never read, so no ping is answered.
    let mut silent = raw(&relay);
    silent.send(Message::text(RelayHello::workstation(TOKEN, &r).to_frame())).unwrap();
    match silent.read().unwrap() {
        Message::Text(text) => {
            assert_eq!(RelayReply::from_frame(text.as_str()).unwrap(), RelayReply::Ready)
        }
        other => panic!("expected ready, got {other:?}"),
    }
    eventually("the Relay registered it", || relay.stats().workstations == 1);

    eventually("the Relay dropped the registration that went quiet", || {
        relay.stats().workstations == 0
    });
    assert_eq!(
        refusal(dial(&relay.url(), &RelayHello::device(TOKEN, &r, PURPOSE_PAIR), &options())),
        RefusalReason::Offline
    );
}

/// And one that does answer is kept, for longer than the silence the
/// Relay allows: what is measured is silence, not age.
#[test]
fn a_workstation_that_answers_is_kept() {
    let relay = attentive_relay();
    let mut registered = register(&relay, &rendezvous(1));

    let until = Instant::now() + Duration::from_millis(1500);
    while Instant::now() < until {
        // Reading is what answers.
        assert_eq!(registered.next_reply(Duration::from_millis(100)).unwrap(), None);
    }
    assert_eq!(relay.stats().workstations, 1);
}

/// A stream with a leg that went quiet is let go, both legs.
#[test]
fn a_stream_with_a_leg_that_stops_answering_is_let_go() {
    let relay = attentive_relay();
    let (device, mut workstation, _registration) = joined(&relay, &rendezvous(1));
    assert_eq!(relay.stats().streams_open, 1);

    // The Device's end is held and never read. The Workstation's end is
    // read, which is what answers for it -- and is how it learns.
    let _held = device;
    workstation.set_read_timeout(Some(SOON)).unwrap();
    let mut buf = [0u8; 1];
    assert_eq!(workstation.read(&mut buf).unwrap(), 0, "the stream must end");
    eventually("the Relay let the stream go", || relay.stats().streams_open == 0);
}

#[test]
fn bytes_written_by_one_end_arrive_at_the_other() {
    let relay = relay();
    let (mut device, mut workstation, _registration) = joined(&relay, &rendezvous(1));

    device.write_all(b"from the device").unwrap();
    device.flush().unwrap();
    let mut got = [0u8; 15];
    workstation.read_exact(&mut got).unwrap();
    assert_eq!(&got, b"from the device");

    workstation.write_all(b"from the workstation").unwrap();
    workstation.flush().unwrap();
    let mut got = [0u8; 20];
    device.read_exact(&mut got).unwrap();
    assert_eq!(&got, b"from the workstation");

    // Every byte value, and more than one message's worth: the Relay
    // copies what it is given and has no opinion about it.
    let blob: Vec<u8> = (0..70_000u32).map(|i| (i % 256) as u8).collect();
    device.write_all(&blob).unwrap();
    device.flush().unwrap();
    let mut got = vec![0u8; blob.len()];
    workstation.read_exact(&mut got).unwrap();
    assert_eq!(got, blob);

    eventually("the Relay counted the stream", || relay.stats().streams == 1);
    assert_eq!(relay.stats().streams_open, 1);
    eventually("the Relay counted the bytes", || {
        relay.stats().bytes == (15 + 20 + blob.len()) as u64
    });
}

/// What one end writes in pieces arrives as the same bytes, in order,
/// however the other end chooses to read them.
#[test]
fn a_stream_is_bytes_not_messages() {
    let relay = relay();
    let (mut device, mut workstation, _registration) = joined(&relay, &rendezvous(1));

    for piece in [&b"ab"[..], b"cde", b"f"] {
        device.write_all(piece).unwrap();
        device.flush().unwrap();
    }
    let mut got = [0u8; 6];
    for byte in got.iter_mut() {
        workstation.read_exact(std::slice::from_mut(byte)).unwrap();
    }
    assert_eq!(&got, b"abcdef");
}

#[test]
fn closing_one_end_ends_the_other() {
    let relay = relay();
    let (device, mut workstation, _registration) = joined(&relay, &rendezvous(1));

    device.close();

    let mut buf = [0u8; 1];
    assert_eq!(workstation.read(&mut buf).unwrap(), 0, "the other end must read end of stream");
    eventually("the Relay let the stream go", || relay.stats().streams_open == 0);
}

#[test]
fn a_connection_without_the_admission_token_is_refused() {
    let relay = relay();
    let r = rendezvous(1);
    let _registered = register(&relay, &r);

    for hello in [
        RelayHello::workstation("", &r),
        RelayHello::device("", &r, PURPOSE_PAIR),
        RelayHello::stream("", &r, &"ab".repeat(16)),
    ] {
        assert_eq!(
            refusal(dial(&relay.url(), &hello, &options())),
            RefusalReason::Admission,
            "{hello:?}"
        );
    }
    assert_eq!(relay.stats().refused_admission, 3);
    assert_eq!(relay.stats().workstations, 1, "only the one that held the token is registered");
    assert_eq!(relay.stats().streams, 0);
}

#[test]
fn a_connection_with_the_wrong_token_is_refused() {
    let relay = relay();
    let r = rendezvous(1);
    let mut registered = register(&relay, &r);

    for token in ["let-me-in ", "LET-ME-IN", "let-me-i", "let-me-inn", "another"] {
        assert_eq!(
            refusal(dial(&relay.url(), &RelayHello::device(token, &r, PURPOSE_PAIR), &options())),
            RefusalReason::Admission,
            "{token:?}"
        );
    }
    // And the Workstation was never told about any of them: a Device that
    // was not admitted reaches nobody.
    assert_eq!(registered.next_reply(Duration::from_millis(200)).unwrap(), None);
}

/// A token is judged before anything else in the hello, so a peer that
/// was not admitted learns that it was not admitted and nothing more --
/// not whether a Workstation is there.
#[test]
fn a_refused_token_says_nothing_about_who_is_registered() {
    let relay = relay();
    let nobody = rendezvous(9);
    assert_eq!(
        refusal(dial(&relay.url(), &RelayHello::device("wrong", &nobody, PURPOSE_PAIR), &options())),
        RefusalReason::Admission
    );
    assert_eq!(
        refusal(dial(&relay.url(), &RelayHello::device("wrong", "not-an-id", PURPOSE_PAIR), &options())),
        RefusalReason::Admission
    );
}

#[test]
fn any_of_the_relays_tokens_admits() {
    let mut config = RelayConfig::local("old-token");
    config.tokens.push("new-token".into());
    let relay = RunningRelay::start(config).unwrap();
    let r = rendezvous(1);

    let _old = dial(&relay.url(), &RelayHello::workstation("old-token", &r), &options()).unwrap();
    let _new = dial(&relay.url(), &RelayHello::workstation("new-token", &r), &options()).unwrap();
    assert_eq!(
        refusal(dial(&relay.url(), &RelayHello::workstation("old-tokennew-token", &r), &options())),
        RefusalReason::Admission
    );
}

#[test]
fn a_relay_refuses_to_start_without_a_token() {
    for tokens in [vec![], vec![String::new()], vec!["   ".to_string()]] {
        let mut config = RelayConfig::local(TOKEN);
        config.tokens = tokens.clone();
        let err = RunningRelay::start(config).err().expect("a Relay with no token started");
        assert!(err.to_string().contains("admission token"), "{tokens:?}: {err}");
    }
}

#[test]
fn a_device_with_no_workstation_is_told_it_is_offline() {
    let relay = relay();
    let _someone_else = register(&relay, &rendezvous(1));

    assert_eq!(
        refusal(dial(
            &relay.url(),
            &RelayHello::device(TOKEN, &rendezvous(2), PURPOSE_PAIR),
            &options()
        )),
        RefusalReason::Offline
    );
}

#[test]
fn a_workstation_that_went_away_is_offline() {
    let relay = relay();
    let r = rendezvous(1);
    let registered = register(&relay, &r);
    eventually("the Relay registered it", || relay.stats().workstations == 1);

    registered.close();
    eventually("the Relay let the registration go", || relay.stats().workstations == 0);

    assert_eq!(
        refusal(dial(&relay.url(), &RelayHello::device(TOKEN, &r, PURPOSE_PAIR), &options())),
        RefusalReason::Offline
    );
}

#[test]
fn a_stream_nobody_claims_is_refused() {
    let relay = impatient_relay();
    let r = rendezvous(1);
    let mut workstation = register(&relay, &r);

    let device = device_dialling(&relay, &r);
    let stream = announced(&mut workstation);
    // Announced, and left alone.
    assert_eq!(refusal(device.join().unwrap()), RefusalReason::Unclaimed);

    // And it is gone: a Workstation that comes for it late finds nothing.
    assert_eq!(
        refusal(dial(&relay.url(), &RelayHello::stream(TOKEN, &r, &stream), &options())),
        RefusalReason::Gone
    );
    assert_eq!(relay.stats().streams, 0);
}

/// One Workstation, registered twice -- the dev daemon and the release
/// daemon share a key. Both are told; the one that wants the stream has
/// it; the other, coming late, finds it gone.
#[test]
fn a_stream_is_claimed_by_the_workstation_that_wants_it() {
    let relay = relay();
    let r = rendezvous(1);
    let mut first = register(&relay, &r);
    let mut second = register(&relay, &r);
    eventually("both are registered", || relay.stats().workstations == 2);

    let device = device_dialling(&relay, &r);
    let told_first = announced(&mut first);
    let told_second = announced(&mut second);
    assert_eq!(told_first, told_second, "one stream, announced twice");

    let mut picked_up =
        dial(&relay.url(), &RelayHello::stream(TOKEN, &r, &told_second), &options())
            .unwrap()
            .into_stream();
    let mut device = device.join().unwrap().unwrap();

    assert_eq!(
        refusal(dial(&relay.url(), &RelayHello::stream(TOKEN, &r, &told_first), &options())),
        RefusalReason::Gone,
        "a stream is picked up once"
    );

    device.write_all(b"hello").unwrap();
    device.flush().unwrap();
    let mut got = [0u8; 5];
    picked_up.set_read_timeout(Some(SOON)).unwrap();
    picked_up.read_exact(&mut got).unwrap();
    assert_eq!(&got, b"hello");
}

/// A stream id is not a capability on its own: it is picked up under the
/// rendezvous id it was announced to.
#[test]
fn a_stream_is_picked_up_only_under_its_own_rendezvous() {
    let relay = impatient_relay();
    let r = rendezvous(1);
    let mut workstation = register(&relay, &r);

    let device = device_dialling(&relay, &r);
    let stream = announced(&mut workstation);

    assert_eq!(
        refusal(dial(
            &relay.url(),
            &RelayHello::stream(TOKEN, &rendezvous(2), &stream),
            &options()
        )),
        RefusalReason::Gone
    );
    // And the attempt did not spend it.
    let _picked_up =
        dial(&relay.url(), &RelayHello::stream(TOKEN, &r, &stream), &options()).unwrap();
    device.join().unwrap().unwrap();
}

#[test]
fn a_fifth_registration_under_one_rendezvous_is_refused() {
    let relay = relay();
    let r = rendezvous(1);
    let held: Vec<RelayConnection> = (0..4).map(|_| register(&relay, &r)).collect();

    assert_eq!(
        refusal(dial(&relay.url(), &RelayHello::workstation(TOKEN, &r), &options())),
        RefusalReason::Busy
    );
    // Another Workstation is not held to this one's count.
    let _other = register(&relay, &rendezvous(2));
    drop(held);
}

#[test]
fn a_first_frame_that_is_not_a_hello_is_refused() {
    let relay = relay();
    for first in [
        Message::text("hello"),
        Message::text("{}"),
        Message::text(r#"{"role":"device"}"#),
        Message::Binary(vec![1, 2, 3].into()),
        Message::text("x".repeat(5000)),
    ] {
        let mut ws = raw(&relay);
        ws.send(first.clone()).unwrap();
        assert_eq!(
            said_then_closed(&mut ws),
            Some(RelayReply::Refused { reason: RefusalReason::Malformed }),
            "{first:?}"
        );
    }
}

#[test]
fn a_hello_the_relay_cannot_serve_is_refused_by_name() {
    let relay = relay();
    let r = rendezvous(1);

    // A version from the future.
    let mut ws = raw(&relay);
    ws.send(Message::text(format!(
        r#"{{"role":"workstation","v":{},"token":"{TOKEN}","rendezvous":"{r}"}}"#,
        RELAY_WIRE_VERSION + 1
    )))
    .unwrap();
    assert_eq!(
        said_then_closed(&mut ws),
        Some(RelayReply::Refused { reason: RefusalReason::Version })
    );

    // A role from the future.
    let mut ws = raw(&relay);
    ws.send(Message::text(format!(r#"{{"role":"observer","v":1,"token":"{TOKEN}"}}"#))).unwrap();
    assert_eq!(
        said_then_closed(&mut ws),
        Some(RelayReply::Refused { reason: RefusalReason::Version })
    );

    // Ids that are not ids, and a purpose that is not a label.
    for hello in [
        RelayHello::workstation(TOKEN, "not-an-id"),
        RelayHello::device(TOKEN, &r.to_uppercase(), PURPOSE_PAIR),
        RelayHello::device(TOKEN, &r, ""),
        RelayHello::device(TOKEN, &r, "pair\n"),
        RelayHello::device(TOKEN, &r, &"p".repeat(33)),
        RelayHello::stream(TOKEN, &r, "not-a-stream"),
    ] {
        assert_eq!(
            refusal(dial(&relay.url(), &hello, &options())),
            RefusalReason::Malformed,
            "{hello:?}"
        );
    }
}

/// A purpose is a label to the Relay: one it has never heard of is
/// forwarded as it came, so a later purpose needs no Relay release.
#[test]
fn a_purpose_the_relay_has_never_heard_of_is_forwarded() {
    let relay = impatient_relay();
    let r = rendezvous(1);
    let mut workstation = register(&relay, &r);

    let url = relay.url();
    let hello = RelayHello::device(TOKEN, &r, "connect-v2");
    let device = std::thread::spawn(move || dial(&url, &hello, &options()));

    match workstation.next_reply(SOON).unwrap() {
        Some(RelayReply::Incoming { purpose, .. }) => assert_eq!(purpose, "connect-v2"),
        other => panic!("expected an announcement, got {other:?}"),
    }
    assert_eq!(refusal(device.join().unwrap()), RefusalReason::Unclaimed);
}

#[test]
fn a_silent_connection_is_dropped_at_the_deadline() {
    let relay = impatient_relay();
    let started = Instant::now();
    let mut ws = raw(&relay);

    assert_eq!(said_then_closed(&mut ws), None, "there is nobody to refuse by name");
    assert!(
        started.elapsed() < Duration::from_secs(3),
        "the Relay held a silent connection for {:?}",
        started.elapsed()
    );
}

#[test]
fn a_text_frame_on_a_spliced_stream_ends_both_legs() {
    let relay = relay();
    let r = rendezvous(1);
    let mut workstation = register(&relay, &r);

    // The Device's leg by hand, so it can say what a Device would not.
    let mut device = raw(&relay);
    device.send(Message::text(RelayHello::device(TOKEN, &r, PURPOSE_PAIR).to_frame())).unwrap();
    let stream = announced(&mut workstation);
    let mut picked_up = dial(&relay.url(), &RelayHello::stream(TOKEN, &r, &stream), &options())
        .unwrap()
        .into_stream();
    picked_up.set_read_timeout(Some(SOON)).unwrap();
    match device.read().unwrap() {
        Message::Text(text) => {
            assert_eq!(RelayReply::from_frame(text.as_str()).unwrap(), RelayReply::Ready)
        }
        other => panic!("expected ready, got {other:?}"),
    }

    device.send(Message::text("not ciphertext")).unwrap();

    let mut buf = [0u8; 1];
    assert_eq!(picked_up.read(&mut buf).unwrap(), 0, "the Workstation's leg must end");
    assert_eq!(said_then_closed(&mut device), None, "and so must the Device's");
    eventually("the Relay let the stream go", || relay.stats().streams_open == 0);
    assert_eq!(relay.stats().bytes, 0, "the text was never copied");
}

// -- TLS ---------------------------------------------------------------

/// A Relay serving a certificate minted a moment ago, for `localhost`.
fn tls_relay() -> (RunningRelay, Vec<u8>) {
    let minted = rcgen::generate_simple_self_signed(vec!["localhost".to_string()]).unwrap();
    let mut config = RelayConfig::local(TOKEN);
    config.tls = Some(Tls {
        certificate_chain_pem: minted.cert.pem().into_bytes(),
        private_key_pem: minted.signing_key.serialize_pem().into_bytes(),
    });
    (RunningRelay::start(config).unwrap(), minted.cert.der().to_vec())
}

#[test]
fn a_tls_relay_is_reached_by_a_client_that_trusts_its_certificate() {
    let (relay, certificate) = tls_relay();
    let url = relay.url_for("localhost");
    assert!(url.starts_with("wss://"), "{url}");
    let trusting = DialOptions { extra_roots: vec![certificate], ..options() };
    let r = rendezvous(1);

    let mut workstation = dial(&url, &RelayHello::workstation(TOKEN, &r), &trusting).unwrap();
    let device = {
        let (url, trusting, r) = (url.clone(), trusting.clone(), r.clone());
        std::thread::spawn(move || {
            dial(&url, &RelayHello::device(TOKEN, &r, PURPOSE_PAIR), &trusting)
                .map(RelayConnection::into_stream)
        })
    };
    let stream = announced(&mut workstation);
    let mut picked_up =
        dial(&url, &RelayHello::stream(TOKEN, &r, &stream), &trusting).unwrap().into_stream();
    let mut device = device.join().unwrap().unwrap();

    device.write_all(b"through tls").unwrap();
    device.flush().unwrap();
    let mut got = [0u8; 11];
    picked_up.set_read_timeout(Some(SOON)).unwrap();
    picked_up.read_exact(&mut got).unwrap();
    assert_eq!(&got, b"through tls");

    // Admission is the same question over TLS.
    assert_eq!(
        refusal(dial(&url, &RelayHello::workstation("wrong", &r), &trusting)),
        RefusalReason::Admission
    );
}

#[test]
fn a_tls_relay_whose_certificate_is_not_trusted_is_not_dialled() {
    let (relay, _certificate) = tls_relay();
    let result = dial(
        &relay.url_for("localhost"),
        &RelayHello::workstation(TOKEN, &rendezvous(1)),
        &options(),
    );
    match result {
        Err(DialError::Tls(_)) => {}
        Err(other) => panic!("expected a certificate error, got {other}"),
        Ok(_) => panic!("a certificate nobody trusts was accepted"),
    }
    assert_eq!(relay.stats().workstations, 0);
}

#[test]
fn a_plain_url_to_a_public_host_is_never_dialled() {
    match dial(
        "ws://relay.example:9000",
        &RelayHello::workstation(TOKEN, &rendezvous(1)),
        &options(),
    ) {
        Err(DialError::Url(e)) => assert!(e.to_string().contains("wss://"), "{e}"),
        Err(other) => panic!("expected the URL to be refused, got {other}"),
        Ok(_) => panic!("a plain URL to a public host was dialled"),
    }
}

#[test]
fn a_relay_that_is_not_there_is_an_error_not_a_hang() {
    // Bound and dropped: a port nothing is listening on.
    let port = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
    let started = Instant::now();
    let result = dial(
        &format!("ws://127.0.0.1:{port}"),
        &RelayHello::workstation(TOKEN, &rendezvous(1)),
        &options(),
    );
    assert!(matches!(result, Err(DialError::Connect(_))), "{:?}", result.err().map(|e| e.to_string()));
    assert!(started.elapsed() < SOON);
}
