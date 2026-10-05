//! The connection handshake: how a paired Device proves it is that
//! Device, unlocked, over any byte stream.
//!
//! `docs/security/05-remote-access.md` §5 settles the handshake and ADR
//! 0001 what follows it. A Device that has paired runs Noise `IK`
//! against the Workstation key it pinned from the QR. Its first message
//! is sealed to that key and carries the Device's own static key, which
//! is looked up in the trust store; the daemon's answer completes the
//! handshake. Then the Device sends its proof -- its hardware key's
//! signature over this handshake's hash (`unlock.rs`) -- and only when
//! that verifies against the key the Device registered at pairing is the
//! connection a Device's.
//!
//! **A library over `Read + Write`, not a transport**, like `pairing.rs`
//! and for its reason: `remote.rs` feeds it the stream a Relay handed
//! over, and the tests below an in-process socket pair with the
//! Companion core's own client on the other end.
//!
//! **What each failure looks like to the Device.** A first message that
//! does not open ends the stream without a word: it was not sealed to
//! this Workstation's key, so there is no channel to say anything in.
//! That is what a Device that pinned a key "Revoke all" has since
//! rotated meets. Every refusal after that is said, by name, inside the
//! channel the handshake made -- to a peer that has by then proved it
//! holds the Device's Noise key.
//!
//! **Nothing here decides what a Device may do.** It answers whose
//! connection this is. `SessionManager::adopt_device` serves it, as the
//! Remote role.

use crate::pairing::{self, ResponderKeys, MAX_NOISE_MESSAGE};
use crate::trust::{Admission, Device};
use protocol::device_wire::{
    ConnectRefusal, ConnectVerdict, CONNECT_NOISE_PARAMS, CONNECT_PROLOGUE,
};
use std::io::{Read, Write};

/// A Device whose handshake completed and whose signature verified.
pub struct Accepted {
    /// The Device's row, as it was when the handshake's key was looked
    /// up.
    pub device: Device,
    /// The encrypted channel the handshake left behind, on which the
    /// Device has sent its proof and the daemon has sent nothing yet.
    pub transport: snow::TransportState,
}

/// Hand-written, and it leaves the transport out: see
/// `pairing::PairingHandshake`.
impl std::fmt::Debug for Accepted {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Accepted")
            .field("device_id", &self.device.device_id)
            .field("name", &self.device.name)
            .finish_non_exhaustive()
    }
}

/// A Device that was refused, and has been told so.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Refused {
    /// What the Device was told.
    pub reason: ConnectRefusal,
    /// Which Device, when the key that handshook is one the store holds.
    pub device_id: Option<String>,
    /// What was wrong with its proof, for the log. The Device is told
    /// `unlock` and no more.
    pub why: Option<String>,
}

/// Run the responder side of the connection handshake over `stream`, and
/// read the Device's proof.
///
/// `admit` is asked about the static key the first message carried. It
/// is a closure so that the trust store's lock is held for that one
/// lookup and not across the round trips either side of it
/// (`pairing::ResponderKeys` has the reason).
///
/// `Ok(Err(refused))` is a Device that was refused and has been told so:
/// the verdict is already on the stream. `Err` is a handshake that never
/// made a channel, and nothing was said.
///
/// A Device that is accepted has NOT been told so. The caller says
/// `connected` once the connection is somewhere a revocation can find
/// it (`send_verdict`).
pub fn run_responder<S: Read + Write>(
    stream: &mut S,
    keys: &ResponderKeys,
    admit: impl FnOnce(&[u8]) -> anyhow::Result<Admission>,
) -> anyhow::Result<Result<Accepted, Refused>> {
    let params: snow::params::NoiseParams = CONNECT_NOISE_PARAMS.parse().map_err(|e| {
        anyhow::anyhow!("gavin-daemon: bad Noise parameters {CONNECT_NOISE_PARAMS:?}: {e:?}")
    })?;
    let mut handshake = snow::Builder::new(params)
        .prologue(CONNECT_PROLOGUE)?
        .local_private_key(keys.private())?
        .build_responder()?;

    let mut message = vec![0u8; MAX_NOISE_MESSAGE];
    let mut payload = vec![0u8; MAX_NOISE_MESSAGE];

    // 1. <- e, es, s, ss   (the Device's static key, sealed to ours)
    //
    //    A message that does not open was sealed to another key -- the
    //    one this Workstation held before "Revoke all" rotated it, or
    //    another Workstation's altogether -- or was altered on the way.
    //    Either way there is no channel, and so no way to say why.
    let n = pairing::read_frame(stream, &mut message)?;
    handshake.read_message(&message[..n], &mut payload).map_err(|e| {
        anyhow::anyhow!(
            "gavin-daemon: the connection handshake failed — its first message was not \
             addressed to this Workstation's key ({e})"
        )
    })?;
    let device_key = handshake
        .get_remote_static()
        .ok_or_else(|| anyhow::anyhow!("gavin-daemon: the connection handshake sent no device key"))?
        .to_vec();

    // Who that key is, before anything is sent back.
    let admission = admit(&device_key)?;

    // 2. -> e, ee, se
    //
    //    Sent whatever the store said. A Device that is going to be
    //    refused is owed the reason, and the only place to say it where
    //    the Relay cannot read or change it is inside the channel this
    //    message completes. It gives nothing away: the peer has proved
    //    it holds the Device's Noise key, and that key is no secret to
    //    itself.
    let n = handshake.write_message(&[], &mut message)?;
    pairing::write_frame(stream, &message[..n])?;

    // The hash of the whole handshake: what the Device's hardware signs.
    let hash = handshake.get_handshake_hash().to_vec();
    let mut transport = handshake.into_transport_mode()?;

    let (device, hardware_key) = match admission {
        Admission::Admitted(device) => match device.hardware_key.clone() {
            Some(key) => (device, key),
            // `admit` refuses a row with no hardware key, so this is a
            // store that answered out of turn. Refused all the same.
            None => {
                let refused = Refused {
                    reason: ConnectRefusal::PairAgain,
                    device_id: Some(device.device_id),
                    why: None,
                };
                return refuse(stream, &mut transport, refused);
            }
        },
        refused => {
            let refused = Refused {
                reason: refused.connect_refusal().unwrap_or(ConnectRefusal::Other),
                device_id: match refused {
                    Admission::Revoked(device)
                    | Admission::Stale(device)
                    | Admission::UnreadableRole(device)
                    | Admission::NoHardwareKey(device)
                    | Admission::Admitted(device) => Some(device.device_id),
                    Admission::Unknown => None,
                },
                why: None,
            };
            return refuse(stream, &mut transport, refused);
        }
    };

    // 3. <- the proof. Until it verifies the connection is anybody's who
    //    holds a copy of the Noise key, and no request is read.
    let proved = pairing::read_sealed(stream, &mut transport)
        .and_then(|proof| crate::unlock::connecting(&proof, &hash, &hardware_key));
    if let Err(e) = proved {
        let refused = Refused {
            reason: ConnectRefusal::Unlock,
            device_id: Some(device.device_id),
            why: Some(e.to_string()),
        };
        return refuse(stream, &mut transport, refused);
    }

    Ok(Ok(Accepted { device, transport }))
}

fn refuse<S: Write>(
    stream: &mut S,
    transport: &mut snow::TransportState,
    refused: Refused,
) -> anyhow::Result<Result<Accepted, Refused>> {
    // Best effort: a Device that has already hung up is refused whether
    // or not it hears of it.
    let _ = send_verdict(stream, transport, &ConnectVerdict::Refused { reason: refused.reason });
    Ok(Err(refused))
}

/// Tells the Device what became of its connection: one padded frame,
/// sealed by the channel the handshake left.
pub fn send_verdict<S: Write>(
    stream: &mut S,
    transport: &mut snow::TransportState,
    verdict: &ConnectVerdict,
) -> anyhow::Result<()> {
    pairing::write_sealed(stream, transport, &verdict.to_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::trust::{DeviceRole, Registration, TrustStore};
    use crate::unlock::testing::HardwareKey;
    use companion_core::connect::{ConnectClient, ConnectEvent};
    use companion_core::{CoreError, DeviceKeys, Entropy};
    use protocol::transport::Stream;
    use std::net::Shutdown;
    use std::time::Duration;

    const NOW: i64 = 1_770_000_000_000_000;
    const DAY_US: i64 = 24 * 60 * 60 * 1_000_000;

    fn store(dir: &tempfile::TempDir) -> TrustStore {
        TrustStore::open(&dir.path().join("devices.sqlite")).unwrap()
    }

    fn entropy() -> Entropy {
        Entropy::from_bytes(protocol::hex_decode(&protocol::random_hex(32).unwrap()).unwrap())
    }

    /// A Device: the Companion core's own client, a Noise key and a
    /// stand-in for the key in its hardware.
    struct Phone {
        keys: DeviceKeys,
        hardware: HardwareKey,
    }

    impl Phone {
        fn new() -> Self {
            Self { keys: DeviceKeys::generate(entropy()).unwrap(), hardware: HardwareKey::generate() }
        }

        fn paired_with(store: &TrustStore, device_id: &str) -> Self {
            let phone = Self::new();
            store
                .confirm_device_at(
                    device_id,
                    &Registration {
                        public_key: phone.keys.public.clone(),
                        name: device_id.to_string(),
                        role: DeviceRole::Remote,
                        hardware_key: phone.hardware.public(),
                        notification_key: vec![0x5c; 32],
                    },
                    NOW,
                )
                .unwrap();
            phone
        }
    }

    /// What a Device saw of a connection.
    #[derive(Debug, PartialEq)]
    enum Saw {
        /// The handshake completed and the proof was sent; this is what
        /// came back.
        Verdict(ConnectVerdict),
        /// The stream ended with nothing said.
        Closed,
        /// The core stopped.
        Failed(CoreError),
    }

    /// Everything a Device wrote, in order, for a Relay to replay.
    type Recording = Vec<Vec<u8>>;

    /// Reads whatever arrives next, or nothing at the end of the stream.
    fn arrived(stream: &mut Stream) -> Vec<u8> {
        let mut buf = vec![0u8; 8192];
        match stream.read(&mut buf) {
            Ok(n) => buf[..n].to_vec(),
            Err(_) => Vec::new(),
        }
    }

    /// Reads until the core makes something of what arrived. A frame is
    /// two writes on a socket pair -- its length, then the rest -- and a
    /// read can return between them.
    fn until_something(stream: &mut Stream, client: &mut ConnectClient) -> Vec<ConnectEvent> {
        loop {
            let bytes = arrived(stream);
            assert!(!bytes.is_empty(), "the stream ended with nothing said");
            let events = client.receive(&bytes).unwrap();
            if !events.is_empty() {
                return events;
            }
        }
    }

    /// Connects `phone` to the Workstation holding `workstation_key`,
    /// signing with `signer`, and says what it saw.
    fn connect(
        stream: &mut Stream,
        phone: &Phone,
        workstation_key: &[u8],
        sign: impl Fn(&[u8]) -> Option<Vec<u8>>,
        recording: &mut Recording,
    ) -> Saw {
        let (mut client, first) =
            ConnectClient::start(workstation_key, &phone.keys, entropy()).unwrap();
        stream.write_all(&first).unwrap();
        recording.push(first);
        loop {
            let bytes = arrived(stream);
            if bytes.is_empty() {
                return Saw::Closed;
            }
            let mut events = match client.receive(&bytes) {
                Ok(events) => events,
                Err(e) => return Saw::Failed(e),
            };
            while !events.is_empty() {
                match events.remove(0) {
                    ConnectEvent::Send(bytes) => {
                        // A Workstation that has already refused has
                        // already hung up, and what it said is waiting
                        // to be read: the write failing is not the news.
                        let _ = stream.write_all(&bytes);
                        recording.push(bytes);
                    }
                    ConnectEvent::Prove { message } => match sign(&message) {
                        Some(signature) => events.extend(client.prove(&signature).unwrap()),
                        // Says nothing more, and hangs up.
                        None => {
                            let _ = stream.shutdown(Shutdown::Write);
                        }
                    },
                    ConnectEvent::Connected { device_id } => {
                        return Saw::Verdict(ConnectVerdict::Connected { device_id })
                    }
                    ConnectEvent::Refused(reason) => {
                        return Saw::Verdict(ConnectVerdict::Refused { reason })
                    }
                    ConnectEvent::Message(_) => panic!("a message before the verdict"),
                }
            }
        }
    }

    /// The signature the Device's own hardware makes. `message` is what
    /// the core asked to have signed, prefix and all, so it is signed as
    /// it stands.
    fn honestly(key: &HardwareKey) -> impl Fn(&[u8]) -> Option<Vec<u8>> + '_ {
        move |message| Some(key.sign_message(message))
    }

    fn refused(reason: ConnectRefusal) -> Saw {
        Saw::Verdict(ConnectVerdict::Refused { reason })
    }

    /// Runs the responder over one end of a socket pair, as the daemon
    /// does -- looking the Device up in the store under `dir`, and
    /// saying `connected` to a Device that is accepted -- while `then`
    /// has the other end.
    ///
    /// The responder opens the store for itself, as a second daemon
    /// sharing the file would: a `TrustStore` is one thread's.
    fn serve(
        dir: &tempfile::TempDir,
        now_us: i64,
        then: impl FnOnce(&mut Stream),
    ) -> anyhow::Result<Result<String, ConnectRefusal>> {
        let path = dir.path().join("devices.sqlite");
        let (mut client, server) = Stream::pair().unwrap();
        client.set_read_timeout(Some(Duration::from_secs(20))).unwrap();
        let serving = std::thread::spawn(move || {
            let store = TrustStore::open(&path).unwrap();
            let keys = ResponderKeys::from_store(&store).unwrap();
            let mut server = server;
            server.set_read_timeout(Some(Duration::from_secs(20))).unwrap();
            let outcome = run_responder(&mut server, &keys, |key| store.admit_at(key, now_us));
            let outcome = outcome.map(|accepted| {
                accepted.map_err(|refused| refused.reason).map(|mut accepted| {
                    let device_id = accepted.device.device_id.clone();
                    send_verdict(
                        &mut server,
                        &mut accepted.transport,
                        &ConnectVerdict::Connected { device_id: device_id.clone() },
                    )
                    .unwrap();
                    device_id
                })
            });
            let _ = server.shutdown(Shutdown::Both);
            outcome
        });
        then(&mut client);
        let _ = client.shutdown(Shutdown::Both);
        serving.join().unwrap()
    }

    fn run(
        dir: &tempfile::TempDir,
        now_us: i64,
        phone: &Phone,
        workstation_key: &[u8],
        sign: impl Fn(&[u8]) -> Option<Vec<u8>>,
    ) -> (anyhow::Result<Result<String, ConnectRefusal>>, Saw, Recording) {
        let mut saw = None;
        let mut recording = Recording::new();
        let served = serve(dir, now_us, |stream| {
            saw = Some(connect(stream, phone, workstation_key, &sign, &mut recording));
        });
        (served, saw.unwrap(), recording)
    }

    /// The card's first criterion, at the library's seam: a valid `IK`
    /// and a valid signature are a Device's connection.
    #[test]
    fn a_paired_device_is_accepted_once_its_signature_verifies() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(&dir);
        let phone = Phone::paired_with(&store, "dev-1");
        let key = store.static_public_key().unwrap();

        let (served, saw, _) = run(&dir, NOW, &phone, &key, honestly(&phone.hardware));

        assert_eq!(served.unwrap(), Ok("dev-1".to_string()));
        assert_eq!(saw, Saw::Verdict(ConnectVerdict::Connected { device_id: "dev-1".into() }));
        // Judging a Device does not renew it: §3's "no silent renewal on
        // use". Whoever takes the connection on is who records it seen.
        assert_eq!(store.device("dev-1").unwrap().unwrap().last_seen_at_us, NOW);
    }

    /// What the log is given about a refusal: which Device, and what
    /// was wrong with its proof. The Device is told the reason and no
    /// more.
    #[test]
    fn a_refusal_names_the_device_and_what_was_wrong_for_the_log() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(&dir);
        let phone = Phone::paired_with(&store, "dev-1");
        let stranger = Phone::new();
        let keys = ResponderKeys::from_store(&store).unwrap();
        let key = store.static_public_key().unwrap();
        let another_phone = HardwareKey::generate();

        let mut refusals = Vec::new();
        for (phone, signer) in [(&phone, &another_phone), (&stranger, &stranger.hardware)] {
            let (mut client, mut server) = Stream::pair().unwrap();
            client.set_read_timeout(Some(Duration::from_secs(20))).unwrap();
            let refused = std::thread::scope(|scope| {
                scope.spawn(|| {
                    let mut recording = Recording::new();
                    connect(&mut client, phone, &key, honestly(signer), &mut recording);
                });
                let refused =
                    run_responder(&mut server, &keys, |key| store.admit_at(key, NOW)).unwrap();
                let _ = server.shutdown(Shutdown::Both);
                refused
            });
            refusals.push(refused.unwrap_err());
        }

        assert_eq!(refusals[0].reason, ConnectRefusal::Unlock);
        assert_eq!(refusals[0].device_id.as_deref(), Some("dev-1"));
        assert!(
            refusals[0].why.as_deref().is_some_and(|why| why.contains("does not verify")),
            "{:?}",
            refusals[0]
        );
        assert_eq!(
            refusals[1],
            Refused { reason: ConnectRefusal::NotPaired, device_id: None, why: None }
        );
    }

    /// And the other half of it: a copy of the Device's Noise key, on a
    /// phone whose hardware holds some other key, completes the
    /// handshake and gets no further (ADR 0001: "a copied Noise key
    /// therefore gets an attacker nothing").
    #[test]
    fn a_copied_noise_key_with_another_hardware_key_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(&dir);
        let phone = Phone::paired_with(&store, "dev-1");
        let key = store.static_public_key().unwrap();
        let another_phone = HardwareKey::generate();

        let (served, saw, _) = run(&dir, NOW, &phone, &key, honestly(&another_phone));

        assert_eq!(served.unwrap(), Err(ConnectRefusal::Unlock));
        assert_eq!(saw, refused(ConnectRefusal::Unlock));
    }

    #[test]
    fn a_signature_that_is_not_one_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(&dir);
        let phone = Phone::paired_with(&store, "dev-1");
        let key = store.static_public_key().unwrap();

        for said in [Vec::new(), vec![0u8; 70], b"trust me".to_vec()] {
            let (served, saw, _) = run(&dir, NOW, &phone, &key, |_| Some(said.clone()));
            assert_eq!(served.unwrap(), Err(ConnectRefusal::Unlock), "{said:?}");
            assert_eq!(saw, refused(ConnectRefusal::Unlock), "{said:?}");
        }
    }

    /// A Device that completes the handshake and sends no proof.
    #[test]
    fn a_device_that_sends_no_signature_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(&dir);
        let phone = Phone::paired_with(&store, "dev-1");
        let key = store.static_public_key().unwrap();

        let (served, _, _) = run(&dir, NOW, &phone, &key, |_| None);

        assert_eq!(served.unwrap(), Err(ConnectRefusal::Unlock));
    }

    /// One that sends its first request where the proof goes.
    #[test]
    fn a_request_in_the_proofs_place_is_refused_and_not_read_as_a_request() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(&dir);
        let phone = Phone::paired_with(&store, "dev-1");
        let key = store.static_public_key().unwrap();

        let mut saw = None;
        let served = serve(&dir, NOW, |stream| {
            let (mut client, first) = ConnectClient::start(&key, &phone.keys, entropy()).unwrap();
            stream.write_all(&first).unwrap();
            let events = until_something(stream, &mut client);
            assert!(matches!(events.as_slice(), [ConnectEvent::Prove { .. }]), "{events:?}");
            for event in client.prove_saying(b"{\"type\":\"RemoveThisDevice\"}\n").unwrap() {
                if let ConnectEvent::Send(bytes) = event {
                    stream.write_all(&bytes).unwrap();
                }
            }
            saw = Some(until_something(stream, &mut client));
        });

        assert_eq!(served.unwrap(), Err(ConnectRefusal::Unlock));
        assert_eq!(saw.unwrap(), vec![ConnectEvent::Refused(ConnectRefusal::Unlock)]);
        assert!(store.device("dev-1").unwrap().is_some(), "the request was acted on");
    }

    #[test]
    fn a_device_the_store_does_not_admit_is_told_why() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(&dir);
        let key = store.static_public_key().unwrap();

        let stranger = Phone::new();
        let revoked = Phone::paired_with(&store, "revoked");
        store.revoke("revoked").unwrap();
        let keyless = Phone::paired_with(&store, "keyless");
        store.raw("UPDATE devices SET hardware_key = NULL WHERE device_id = 'keyless'");
        let stale = Phone::paired_with(&store, "stale");

        for (phone, now, reason) in [
            (&stranger, NOW, ConnectRefusal::NotPaired),
            (&revoked, NOW, ConnectRefusal::Revoked),
            (&keyless, NOW, ConnectRefusal::PairAgain),
            (&stale, NOW + 90 * DAY_US, ConnectRefusal::Stale),
        ] {
            let (served, saw, _) = run(&dir, now, phone, &key, honestly(&phone.hardware));
            assert_eq!(served.unwrap(), Err(reason));
            assert_eq!(saw, refused(reason));
        }
        // The day before, the same Device is served.
        let (served, _, _) =
            run(&dir, NOW + 89 * DAY_US, &stale, &key, honestly(&stale.hardware));
        assert_eq!(served.unwrap(), Ok("stale".to_string()));
    }

    /// The `IK` half of the proof `05-remote-access.md` §10 still owed:
    /// "an old device's `IK` against a rotated key, refused". The Device
    /// pinned the key this Workstation held; "Revoke all" rotated it; the
    /// first message is sealed to a key nobody holds any more.
    #[test]
    fn after_revoke_all_an_old_devices_first_message_does_not_open() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(&dir);
        let phone = Phone::paired_with(&store, "dev-1");
        let pinned = store.static_public_key().unwrap();

        store.revoke_all().unwrap();
        assert_ne!(store.static_public_key().unwrap(), pinned);

        let (served, saw, _) = run(&dir, NOW, &phone, &pinned, honestly(&phone.hardware));
        let err = served.unwrap_err();
        assert!(err.to_string().contains("not addressed to this Workstation's key"), "{err}");
        // Nothing was said: there was no channel to say it in.
        assert_eq!(saw, Saw::Closed);

        // And a Device that somehow learned the new key is refused by
        // its row, which "Revoke all" marked.
        let rotated = store.static_public_key().unwrap();
        let (served, saw, _) = run(&dir, NOW, &phone, &rotated, honestly(&phone.hardware));
        assert_eq!(served.unwrap(), Err(ConnectRefusal::Revoked));
        assert_eq!(saw, refused(ConnectRefusal::Revoked));
    }

    /// A Relay that alters the first message causes a failed handshake.
    #[test]
    fn a_first_message_altered_on_the_way_fails_the_handshake() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(&dir);
        let phone = Phone::paired_with(&store, "dev-1");
        let key = store.static_public_key().unwrap();

        let (_, first) = ConnectClient::start(&key, &phone.keys, entropy()).unwrap();
        for at in [2usize, 40, first.len() - 1] {
            let mut heard = Vec::new();
            let served = serve(&dir, NOW, |stream| {
                let mut altered = first.clone();
                altered[at] ^= 0x01;
                stream.write_all(&altered).unwrap();
                heard = arrived(stream);
            });
            assert!(served.is_err(), "a first message altered at byte {at} was read");
            assert!(heard.is_empty(), "and it was answered");
        }
    }

    /// A Relay that recorded a whole connection and plays it again. The
    /// first message opens -- it is the Device's own -- and the daemon
    /// answers it with a fresh ephemeral key, so the channel that results
    /// is not the one the recorded proof was sealed in.
    #[test]
    fn a_recorded_connection_played_again_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(&dir);
        let phone = Phone::paired_with(&store, "dev-1");
        let key = store.static_public_key().unwrap();

        let (served, _, recording) = run(&dir, NOW, &phone, &key, honestly(&phone.hardware));
        assert_eq!(served.unwrap(), Ok("dev-1".to_string()));
        assert_eq!(recording.len(), 2);

        let mut heard = Vec::new();
        let served = serve(&dir, NOW, |stream| {
            for bytes in &recording {
                stream.write_all(bytes).unwrap();
            }
            loop {
                let bytes = arrived(stream);
                if bytes.is_empty() {
                    break;
                }
                heard.extend_from_slice(&bytes);
            }
        });

        assert_eq!(served.unwrap(), Err(ConnectRefusal::Unlock));
        // What came back is the daemon's half of a handshake and a
        // refusal, sealed in a channel the Relay holds no key to.
        assert!(!heard.is_empty());
    }

    #[test]
    fn a_device_that_hangs_up_mid_handshake_is_an_error_and_not_a_connection() {
        let dir = tempfile::tempdir().unwrap();
        drop(store(&dir));
        let served = serve(&dir, NOW, |stream| {
            stream.write_all(&[0x00]).unwrap();
        });
        assert!(served.is_err());
        let served = serve(&dir, NOW, |_| {});
        assert!(served.is_err());
    }

    #[test]
    fn an_accepted_device_does_not_print_its_channel() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(&dir);
        let phone = Phone::paired_with(&store, "dev-1");
        let key = store.static_public_key().unwrap();
        let keys = ResponderKeys::from_store(&store).unwrap();
        let (mut client, server) = Stream::pair().unwrap();

        let device = std::thread::spawn(move || {
            let (mut core, first) = ConnectClient::start(&key, &phone.keys, entropy()).unwrap();
            client.write_all(&first).unwrap();
            for event in until_something(&mut client, &mut core) {
                if let ConnectEvent::Prove { message } = event {
                    for event in core.prove(&phone.hardware.sign_message(&message)).unwrap() {
                        if let ConnectEvent::Send(bytes) = event {
                            client.write_all(&bytes).unwrap();
                        }
                    }
                }
            }
        });
        let mut server = server;
        let accepted = run_responder(&mut server, &keys, |key| store.admit_at(key, NOW))
            .unwrap()
            .unwrap_or_else(|refused| panic!("{refused:?}"));
        device.join().unwrap();

        let shown = format!("{accepted:?}");
        assert!(shown.contains("dev-1"), "{shown}");
        assert!(!shown.contains("transport"), "{shown}");
    }
}
