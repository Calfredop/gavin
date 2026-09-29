use super::*;
use protocol::device_wire::{PairingAck, UnlockProof};
use snow::params::{CipherChoice, DHChoice, HashChoice};
use snow::resolvers::{CryptoResolver, DefaultResolver};
use snow::types::{Cipher, Dh, Hash, Random};

const MAX_NOISE_MESSAGE: usize = 65535;

/// Bytes counted up from a seed: the Workstation's ephemeral key, made
/// reproducible. This crate is built without snow's own random source.
struct Counting(u8);

impl Random for Counting {
    fn try_fill_bytes(&mut self, dest: &mut [u8]) -> Result<(), snow::Error> {
        for byte in dest {
            *byte = self.0;
            self.0 = self.0.wrapping_add(1);
        }
        Ok(())
    }
}

struct Resolver;

impl CryptoResolver for Resolver {
    fn resolve_rng(&self) -> Option<Box<dyn Random>> {
        Some(Box::new(Counting(0x40)))
    }
    fn resolve_dh(&self, choice: &DHChoice) -> Option<Box<dyn Dh>> {
        DefaultResolver.resolve_dh(choice)
    }
    fn resolve_hash(&self, choice: &HashChoice) -> Option<Box<dyn Hash>> {
        DefaultResolver.resolve_hash(choice)
    }
    fn resolve_cipher(&self, choice: &CipherChoice) -> Option<Box<dyn Cipher>> {
        DefaultResolver.resolve_cipher(choice)
    }
}

fn frame(message: &[u8]) -> Vec<u8> {
    let mut out = (message.len() as u16).to_be_bytes().to_vec();
    out.extend_from_slice(message);
    out
}

fn unframe(bytes: &[u8]) -> &[u8] {
    let len = u16::from_be_bytes([bytes[0], bytes[1]]) as usize;
    assert_eq!(bytes.len(), 2 + len, "one frame, whole");
    &bytes[2..]
}

/// The Workstation's half of the pairing handshake, as the daemon's
/// `pairing.rs` runs it.
struct Workstation {
    keys: DeviceKeys,
    secret: [u8; 32],
    handshake: Option<snow::HandshakeState>,
    transport: Option<snow::TransportState>,
    hash: Vec<u8>,
    device_name: String,
}

impl Workstation {
    fn new() -> Self {
        Self {
            keys: DeviceKeys::generate(Entropy::from_bytes(vec![0x21; 32])).unwrap(),
            secret: [0x33; 32],
            handshake: None,
            transport: None,
            hash: Vec::new(),
            device_name: String::new(),
        }
    }

    fn qr(&self) -> String {
        PairingQr {
            daemon_public_key: protocol::hex_encode(&self.keys.public),
            secret: protocol::hex_encode(&self.secret),
            rendezvous: vec![
                "wss://relay.example/gavin".into(),
                "ws://127.0.0.1:8443".into(),
            ],
            protocol_version: protocol::PROTOCOL_VERSION,
            relay_admission: Some("let-me-in".into()),
        }
        .to_qr_string()
    }

    fn answer(&mut self, first: &[u8]) -> Vec<u8> {
        let mut handshake = snow::Builder::with_resolver(
            protocol::PAIRING_NOISE_PARAMS.parse().unwrap(),
            Box::new(Resolver),
        )
        .local_private_key(&self.keys.private)
        .unwrap()
        .psk(3, &self.secret)
        .unwrap()
        .build_responder()
        .unwrap();
        let mut payload = vec![0u8; MAX_NOISE_MESSAGE];
        handshake
            .read_message(unframe(first), &mut payload)
            .unwrap();
        let mut out = vec![0u8; MAX_NOISE_MESSAGE];
        let n = handshake.write_message(&[], &mut out).unwrap();
        self.handshake = Some(handshake);
        frame(&out[..n])
    }

    /// Reads message 3, and answers with the six digits the desk shows.
    fn finish(&mut self, third: &[u8]) -> String {
        let mut handshake = self.handshake.take().unwrap();
        let mut payload = vec![0u8; MAX_NOISE_MESSAGE];
        let n = handshake
            .read_message(unframe(third), &mut payload)
            .unwrap();
        self.device_name = String::from_utf8(payload[..n].to_vec()).unwrap();
        self.hash = handshake.get_handshake_hash().to_vec();
        self.transport = Some(handshake.into_transport_mode().unwrap());
        protocol::pairing_sas(&self.hash)
    }

    fn open(&mut self, bytes: &[u8]) -> Vec<u8> {
        let mut plaintext = vec![0u8; MAX_NOISE_MESSAGE];
        let n = self
            .transport
            .as_mut()
            .unwrap()
            .read_message(unframe(bytes), &mut plaintext)
            .unwrap();
        device_wire::unpad(&plaintext[..n]).unwrap().to_vec()
    }

    fn seal(&mut self, payload: &[u8]) -> Vec<u8> {
        let plaintext = device_wire::pad(payload).unwrap();
        let mut out = vec![0u8; MAX_NOISE_MESSAGE];
        let n = self
            .transport
            .as_mut()
            .unwrap()
            .write_message(&plaintext, &mut out)
            .unwrap();
        frame(&out[..n])
    }
}

fn hardware_key() -> String {
    format!("04{}", "66".repeat(64))
}

const SIGNATURE: &str = "3045022100aabb";

fn noise_key() -> String {
    "11".repeat(32)
}

fn call_json(value: Value) -> Value {
    serde_json::from_slice(&call(&serde_json::to_vec(&value).unwrap())).unwrap()
}

fn ok(value: Value) -> Value {
    let answer = call_json(value);
    answer
        .get("ok")
        .cloned()
        .unwrap_or_else(|| panic!("expected an answer, got {answer}"))
}

fn error_kind(value: Value) -> String {
    let answer = call_json(value);
    answer["error"]["kind"]
        .as_str()
        .unwrap_or_else(|| panic!("expected an error, got {answer}"))
        .to_string()
}

fn start(qr: &str) -> Value {
    call_json(json!({
        "op": "pairing-start",
        "qr": qr,
        "noisePrivateKey": noise_key(),
        "hardwareKey": hardware_key(),
        "deviceName": "Pocket",
        "entropy": "77".repeat(32),
    }))
}

fn receive(bytes: &[u8]) -> Vec<Value> {
    let answer = ok(json!({ "op": "pairing-receive", "bytes": protocol::hex_encode(bytes) }));
    answer["events"].as_array().unwrap().clone()
}

fn bytes_of(event: &Value) -> Vec<u8> {
    assert_eq!(event["type"], "send", "{event}");
    protocol::hex_decode(event["bytes"].as_str().unwrap()).unwrap()
}

/// Everything up to the desk's verdict: returns the Workstation, ready
/// to rule.
fn paired_up_to_the_verdict() -> Workstation {
    let mut ws = Workstation::new();
    let started = start(&ws.qr());
    let started = started
        .get("ok")
        .unwrap_or_else(|| panic!("{started}"))
        .clone();
    assert_eq!(
        started["workstationKey"],
        protocol::hex_encode(&ws.keys.public)
    );

    let second = ws.answer(&protocol::hex_decode(started["send"].as_str().unwrap()).unwrap());
    let events = receive(&second);
    assert_eq!(events.len(), 2, "{events:?}");
    let desk_code = ws.finish(&bytes_of(&events[0]));
    assert_eq!(ws.device_name, "Pocket");
    assert_eq!(events[1]["type"], "prove");
    assert_eq!(
        events[1]["handshakeHash"],
        protocol::hex_encode(&ws.hash),
        "the native plugin is handed the bare hash; it adds the unlock prefix itself"
    );

    let proved = ok(json!({ "op": "pairing-prove", "signature": SIGNATURE }));
    let events = proved["events"].as_array().unwrap();
    assert_eq!(
        events.len(),
        1,
        "no code before the Workstation takes the proof: {events:?}"
    );
    let proof = UnlockProof::from_bytes(&ws.open(&bytes_of(&events[0]))).unwrap();
    assert_eq!(proof.signature, SIGNATURE);
    assert_eq!(proof.hardware_key.as_deref(), Some(hardware_key().as_str()));

    let ack = ws.seal(&PairingAck::ProofTaken.to_bytes());
    let events = receive(&ack);
    assert_eq!(
        events,
        vec![json!({ "type": "compare-code", "code": desk_code })]
    );
    ws
}

#[test]
fn a_pairing_runs_through_the_json_face_and_keeps_the_workstation() {
    let mut ws = paired_up_to_the_verdict();
    let notification_key = "5a".repeat(32);
    let verdict = ws.seal(
        &PairingVerdict::Paired {
            device_id: "dev-1".into(),
            notification_key: notification_key.clone(),
        }
        .to_bytes(),
    );
    let events = receive(&verdict);
    assert_eq!(
        events,
        vec![json!({
            "type": "finished",
            "verdict": "paired",
            "workstation": {
                "workstationKey": protocol::hex_encode(&ws.keys.public),
                "relays": ["wss://relay.example/gavin", "ws://127.0.0.1:8443"],
                "relayAdmission": "let-me-in",
                "deviceId": "dev-1",
                "notificationKey": notification_key,
            },
        })]
    );
}

#[test]
fn a_desk_that_says_no_keeps_nothing() {
    let mut ws = paired_up_to_the_verdict();
    let events = receive(&ws.seal(&PairingVerdict::Rejected.to_bytes()));
    assert_eq!(
        events,
        vec![json!({ "type": "finished", "verdict": "rejected" })]
    );
}

#[test]
fn start_names_the_relays_to_dial_and_the_hello_for_each() {
    let ws = Workstation::new();
    let started = start(&ws.qr());
    let dials = started["ok"]["dials"].as_array().unwrap();
    assert_eq!(dials.len(), 2);
    assert_eq!(dials[0]["url"], "wss://relay.example/gavin");
    let hello: Value = serde_json::from_str(dials[1]["hello"].as_str().unwrap()).unwrap();
    assert_eq!(hello["role"], "device");
    assert_eq!(hello["token"], "let-me-in");
    assert_eq!(hello["purpose"], "pair");
    assert_eq!(
        hello["rendezvous"],
        protocol::relay::rendezvous_id(&ws.keys.public)
    );
}

#[test]
fn a_relay_this_build_may_not_dial_is_left_out() {
    let ws = Workstation::new();
    let mut offer = PairingQr::parse(&ws.qr()).unwrap();
    offer.rendezvous = vec!["ws://relay.example".into(), "wss://relay.example".into()];
    let started = start(&offer.to_qr_string());
    let urls: Vec<_> = started["ok"]["dials"]
        .as_array()
        .unwrap()
        .iter()
        .map(|d| d["url"].clone())
        .collect();
    assert_eq!(
        urls,
        vec![json!("wss://relay.example")],
        "ws:// to a public host is refused"
    );
}

#[test]
fn what_cannot_pair_is_refused_before_anything_is_dialled() {
    assert_eq!(
        error_kind(json!({
            "op": "pairing-start", "qr": "not a code", "noisePrivateKey": noise_key(),
            "hardwareKey": hardware_key(), "deviceName": "P", "entropy": "77".repeat(32),
        })),
        "offer"
    );

    let ws = Workstation::new();
    let mut old = PairingQr::parse(&ws.qr()).unwrap();
    old.protocol_version = protocol::PAIRING_MIN_VERSION - 1;
    let answer = start(&old.to_qr_string());
    assert_eq!(answer["error"]["kind"], "offer", "{answer}");
    assert!(
        answer["error"]["message"]
            .as_str()
            .unwrap()
            .contains("update Gavin at the desk"),
        "{answer}"
    );

    let short_key = call_json(json!({
        "op": "pairing-start", "qr": ws.qr(), "noisePrivateKey": "11".repeat(31),
        "hardwareKey": hardware_key(), "deviceName": "P", "entropy": "77".repeat(32),
    }));
    assert_eq!(short_key["error"]["kind"], "offer", "{short_key}");

    let not_a_point = call_json(json!({
        "op": "pairing-start", "qr": ws.qr(), "noisePrivateKey": noise_key(),
        "hardwareKey": "05".repeat(65), "deviceName": "P", "entropy": "77".repeat(32),
    }));
    assert_eq!(
        not_a_point["error"]["kind"], "hardware-key",
        "{not_a_point}"
    );

    let no_entropy = call_json(json!({
        "op": "pairing-start", "qr": ws.qr(), "noisePrivateKey": noise_key(),
        "hardwareKey": hardware_key(), "deviceName": "P", "entropy": "77".repeat(31),
    }));
    assert_eq!(no_entropy["error"]["kind"], "entropy", "{no_entropy}");
}

#[test]
fn an_instance_runs_one_exchange() {
    let ws = Workstation::new();
    assert!(start(&ws.qr()).get("ok").is_some());
    assert_eq!(start(&ws.qr())["error"]["kind"], "request");
}

#[test]
fn nothing_is_read_before_a_pairing_starts() {
    assert_eq!(
        error_kind(json!({ "op": "pairing-receive", "bytes": "00" })),
        "not-ready"
    );
    assert_eq!(
        error_kind(json!({ "op": "pairing-prove", "signature": SIGNATURE })),
        "not-ready"
    );
}

#[test]
fn a_handshake_that_fails_ends_the_exchange() {
    let ws = Workstation::new();
    assert!(start(&ws.qr()).get("ok").is_some());
    // Not message 2: the Relay, or a Workstation that is not this one.
    assert_eq!(
        error_kind(json!({ "op": "pairing-receive", "bytes": format!("0020{}", "ab".repeat(32)) })),
        "handshake"
    );
    assert_eq!(
        error_kind(json!({ "op": "pairing-receive", "bytes": "" })),
        "handshake",
        "and every later call says so again"
    );
}

#[test]
fn what_is_not_a_call_is_refused_by_name() {
    assert_eq!(
        serde_json::from_slice::<Value>(&call(b"{")).unwrap()["error"]["kind"],
        "request"
    );
    assert_eq!(error_kind(json!({ "op": "connect-begin" })), "request");
    assert_eq!(
        error_kind(json!({ "op": "pairing-receive", "bytes": "zz" })),
        "request"
    );
}

#[test]
fn the_relays_replies_are_read_by_the_relays_own_contract() {
    assert_eq!(
        ok(json!({ "op": "relay-reply", "text": RelayReply::Ready.to_frame() })),
        json!({ "reply": "ready" })
    );
    let refused = ok(json!({
        "op": "relay-reply",
        "text": RelayReply::Refused { reason: protocol::relay::RefusalReason::Offline }.to_frame(),
    }));
    assert_eq!(refused["reply"], "refused");
    assert_eq!(refused["reason"], "offline");
    assert_eq!(
        refused["message"],
        protocol::relay::RefusalReason::Offline.to_string()
    );
    assert_eq!(
        ok(json!({ "op": "relay-reply", "text": "{\"type\":\"moved\"}" })),
        json!({ "reply": "other" })
    );
    assert_eq!(
        error_kind(json!({ "op": "relay-reply", "text": "hello" })),
        "request"
    );
}

#[test]
fn the_abi_takes_a_call_and_leaves_the_answer_to_be_read() {
    let input =
        serde_json::to_vec(&json!({ "op": "relay-reply", "text": RelayReply::Ready.to_frame() }))
            .unwrap();
    let answer = unsafe {
        let ptr = gavin_alloc(input.len());
        std::ptr::copy_nonoverlapping(input.as_ptr(), ptr, input.len());
        let len = gavin_call(ptr, input.len());
        std::slice::from_raw_parts(gavin_output(), len).to_vec()
    };
    assert_eq!(
        serde_json::from_slice::<Value>(&answer).unwrap(),
        json!({ "ok": { "reply": "ready" } })
    );

    let empty = unsafe {
        let len = gavin_call(gavin_alloc(0), 0);
        std::slice::from_raw_parts(gavin_output(), len).to_vec()
    };
    assert_eq!(
        serde_json::from_slice::<Value>(&empty).unwrap()["error"]["kind"],
        "request"
    );
}

// -- connecting ------------------------------------------------------------

/// The Workstation's half of the connection handshake, as the daemon's
/// `remote.rs` runs it: `IK`, the proof, the verdict, then the stream.
struct Connected {
    keys: DeviceKeys,
    handshake: Option<snow::HandshakeState>,
    transport: Option<snow::TransportState>,
    hash: Vec<u8>,
}

impl Connected {
    fn new() -> Self {
        Self {
            keys: DeviceKeys::generate(Entropy::from_bytes(vec![0x52; 32])).unwrap(),
            handshake: None,
            transport: None,
            hash: Vec::new(),
        }
    }

    /// Reads message 1 and answers with message 2; returns the Device's
    /// static key, as the Workstation learns it.
    fn answer(&mut self, first: &[u8]) -> (Vec<u8>, Vec<u8>) {
        let mut handshake = snow::Builder::with_resolver(
            device_wire::CONNECT_NOISE_PARAMS.parse().unwrap(),
            Box::new(Resolver),
        )
        .prologue(device_wire::CONNECT_PROLOGUE)
        .unwrap()
        .local_private_key(&self.keys.private)
        .unwrap()
        .build_responder()
        .unwrap();
        let mut payload = vec![0u8; MAX_NOISE_MESSAGE];
        handshake.read_message(unframe(first), &mut payload).unwrap();
        let device = handshake.get_remote_static().unwrap().to_vec();
        let mut out = vec![0u8; MAX_NOISE_MESSAGE];
        let n = handshake.write_message(&[], &mut out).unwrap();
        self.hash = handshake.get_handshake_hash().to_vec();
        self.transport = Some(handshake.into_transport_mode().unwrap());
        self.handshake = None;
        (device, frame(&out[..n]))
    }

    fn open(&mut self, bytes: &[u8]) -> Vec<u8> {
        let mut plaintext = vec![0u8; MAX_NOISE_MESSAGE];
        let n = self
            .transport
            .as_mut()
            .unwrap()
            .read_message(unframe(bytes), &mut plaintext)
            .unwrap();
        device_wire::unpad(&plaintext[..n]).unwrap().to_vec()
    }

    fn seal(&mut self, payload: &[u8]) -> Vec<u8> {
        let plaintext = device_wire::pad(payload).unwrap();
        let mut out = vec![0u8; MAX_NOISE_MESSAGE];
        let n = self
            .transport
            .as_mut()
            .unwrap()
            .write_message(&plaintext, &mut out)
            .unwrap();
        frame(&out[..n])
    }
}

fn connect_start(ws: &Connected) -> Value {
    call_json(json!({
        "op": "connect-start",
        "workstationKey": protocol::hex_encode(&ws.keys.public),
        "relays": ["wss://relay.example/gavin", "ws://relay.example", "ws://127.0.0.1:8443"],
        "relayAdmission": "let-me-in",
        "noisePrivateKey": noise_key(),
        "entropy": "78".repeat(32),
    }))
}

fn connect_receive(bytes: &[u8]) -> Vec<Value> {
    let answer = ok(json!({ "op": "connect-receive", "bytes": protocol::hex_encode(bytes) }));
    answer["events"].as_array().unwrap().clone()
}

/// Everything up to the verdict: returns the Workstation, ready to rule.
fn connected_up_to_the_verdict() -> Connected {
    let mut ws = Connected::new();
    let started = connect_start(&ws);
    let started = started.get("ok").unwrap_or_else(|| panic!("{started}")).clone();

    let (device, second) =
        ws.answer(&protocol::hex_decode(started["send"].as_str().unwrap()).unwrap());
    assert_eq!(
        device,
        DeviceKeys::from_private(&protocol::hex_decode(&noise_key()).unwrap()).unwrap().public,
        "message 1 carries the Device's own key, which the Workstation looks up"
    );
    let events = connect_receive(&second);
    assert_eq!(
        events,
        vec![json!({ "type": "prove", "handshakeHash": protocol::hex_encode(&ws.hash) })],
        "the native plugin is handed the bare hash; it adds the unlock prefix itself"
    );

    let proved = ok(json!({ "op": "connect-prove", "signature": SIGNATURE }));
    let events = proved["events"].as_array().unwrap();
    assert_eq!(events.len(), 1, "{events:?}");
    let proof = UnlockProof::from_bytes(&ws.open(&bytes_of(&events[0]))).unwrap();
    assert_eq!(proof.signature, SIGNATURE);
    assert_eq!(proof.hardware_key, None, "a connection's proof names no key: the row does");
    ws
}

#[test]
fn a_connection_runs_through_the_json_face() {
    let mut ws = connected_up_to_the_verdict();
    let verdict = ws.seal(
        &device_wire::ConnectVerdict::Connected {
            device_id: "dev-1".into(),
        }
        .to_bytes(),
    );
    assert_eq!(
        connect_receive(&verdict),
        vec![json!({ "type": "connected", "deviceId": "dev-1" })]
    );

    let ask = r#"{"type":"GetAttention","version":1}"#;
    let sent = ok(json!({ "op": "connect-send", "message": ask }));
    let line = ws.open(&protocol::hex_decode(sent["bytes"].as_str().unwrap()).unwrap());
    assert_eq!(line, format!("{ask}\n").into_bytes(), "one line of the daemon's protocol");

    // The answer, in two pieces, and a second message behind it.
    let answer = r#"{"type":"Attention","state":"ready","items":[],"version":1}"#;
    let stream = format!("{answer}\n{{\"type\":\"Ok\"}}\n");
    let (head, tail) = stream.as_bytes().split_at(20);
    assert_eq!(connect_receive(&ws.seal(head)), Vec::<Value>::new());
    assert_eq!(
        connect_receive(&ws.seal(tail)),
        vec![
            json!({ "type": "message", "text": answer }),
            json!({ "type": "message", "text": "{\"type\":\"Ok\"}" }),
        ]
    );
}

#[test]
fn a_workstation_that_refuses_says_why_in_words() {
    let mut ws = connected_up_to_the_verdict();
    let verdict = ws.seal(
        &device_wire::ConnectVerdict::Refused {
            reason: ConnectRefusal::Revoked,
        }
        .to_bytes(),
    );
    assert_eq!(
        connect_receive(&verdict),
        vec![json!({
            "type": "refused",
            "reason": "revoked",
            "message": ConnectRefusal::Revoked.to_string(),
        })]
    );
    assert_eq!(
        error_kind(json!({ "op": "connect-send", "message": "{}" })),
        "not-ready",
        "nothing is sent on a refused connection"
    );
}

#[test]
fn connect_names_the_relays_to_dial_for_a_connection() {
    let ws = Connected::new();
    let started = connect_start(&ws);
    let dials = started["ok"]["dials"].as_array().unwrap();
    let urls: Vec<_> = dials.iter().map(|d| d["url"].clone()).collect();
    assert_eq!(
        urls,
        vec![json!("wss://relay.example/gavin"), json!("ws://127.0.0.1:8443")],
        "ws:// to a public host is refused"
    );
    let hello: Value = serde_json::from_str(dials[0]["hello"].as_str().unwrap()).unwrap();
    assert_eq!(hello["role"], "device");
    assert_eq!(hello["token"], "let-me-in");
    assert_eq!(hello["purpose"], "connect");
    assert_eq!(hello["rendezvous"], protocol::relay::rendezvous_id(&ws.keys.public));
}

#[test]
fn nothing_is_sent_before_the_workstation_says_connected() {
    assert_eq!(
        error_kind(json!({ "op": "connect-send", "message": "{}" })),
        "not-ready"
    );
    let ws = Connected::new();
    assert!(connect_start(&ws).get("ok").is_some());
    assert_eq!(
        error_kind(json!({ "op": "connect-send", "message": "{}" })),
        "not-ready"
    );
    assert_eq!(
        error_kind(json!({ "op": "connect-prove", "signature": SIGNATURE })),
        "not-ready",
        "nor is a proof taken before the handshake asks for one"
    );
}

#[test]
fn a_connection_is_an_exchange_of_its_own() {
    let ws = Connected::new();
    assert!(connect_start(&ws).get("ok").is_some());
    assert_eq!(connect_start(&ws)["error"]["kind"], "request");
    assert_eq!(start(&Workstation::new().qr())["error"]["kind"], "request");
}

#[test]
fn a_pairing_instance_does_not_connect() {
    assert!(start(&Workstation::new().qr()).get("ok").is_some());
    assert_eq!(connect_start(&Connected::new())["error"]["kind"], "request");
}

#[test]
fn a_workstation_key_of_the_wrong_shape_is_refused_before_anything_is_dialled() {
    let answer = call_json(json!({
        "op": "connect-start", "workstationKey": "ab".repeat(31), "relays": [],
        "relayAdmission": null, "noisePrivateKey": noise_key(), "entropy": "78".repeat(32),
    }));
    assert_eq!(answer["error"]["kind"], "offer", "{answer}");
}
