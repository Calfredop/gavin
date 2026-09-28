//! The Device's half of the pairing ceremony.
//!
//! `docs/security/05-remote-access.md` §3 settles the ceremony and the
//! daemon's `pairing.rs` is its other end. The human scans a QR at the
//! desk; this runs a Noise `XXpsk3` handshake with the secret the QR
//! carried; both screens then show six digits derived from both static
//! keys; the human compares them and confirms at the desk. Only then does
//! the Workstation answer -- and only then is the Device paired.
//!
//! What the Device owes the ceremony, and what this module is careful
//! about, is the one check nobody else can make: that the Workstation
//! which answered is the one whose QR was scanned. The pattern delivers
//! the Workstation's static key in message 2, before the secret is mixed
//! in, precisely so that a Device can compare it with the key it pinned
//! and walk away without having used the secret.

use crate::{noise, CoreError, DeviceKeys, Entropy};
use protocol::device_wire::{self, PairingVerdict};
use protocol::relay::{self, RelayHello, RelayUrl};
use protocol::PairingQr;

/// The largest Noise message, and so the largest frame.
const MAX_NOISE_MESSAGE: usize = 65535;

/// The two bytes of big-endian length in front of every frame.
const LENGTH_PREFIX: usize = 2;

/// The longest name a Device sends. The daemon cuts a longer one to this
/// before it is shown beside the Confirm button, so sending more would
/// only be sending what is thrown away.
pub const MAX_DEVICE_NAME: usize = 64;

/// What the caller does next.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PairingEvent {
    /// Put these bytes on the stream.
    Send(Vec<u8>),
    /// Show these six digits. The human compares them with the desk.
    CompareCode { sas: String },
    /// The desk ruled. Nothing follows.
    Finished(PairingVerdict),
}

/// Where a Device finds its Workstation: a Relay to dial, and the first
/// frame to send it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RelayDial {
    /// Dialled exactly as it is.
    pub url: String,
    pub hello: RelayHello,
}

/// The Relays a pairing QR names, in the order to try them.
///
/// An entry of the rendezvous list that is not a Relay URL this build may
/// dial is left out rather than refused: the list is where a direct
/// address will sit beside the Relay's, and a Device that cannot use one
/// entry can still use the next.
pub fn relay_dials(offer: &PairingQr) -> Result<Vec<RelayDial>, CoreError> {
    let workstation_key = workstation_key(offer)?;
    let rendezvous = relay::rendezvous_id(&workstation_key);
    let token = offer.relay_admission.as_deref().unwrap_or("");
    Ok(offer
        .rendezvous
        .iter()
        .filter_map(|url| RelayUrl::parse(url).ok())
        .map(|url| RelayDial {
            url: url.url,
            hello: RelayHello::device(token, &rendezvous, relay::PURPOSE_PAIR),
        })
        .collect())
}

fn workstation_key(offer: &PairingQr) -> Result<Vec<u8>, CoreError> {
    let key = protocol::hex_decode(&offer.daemon_public_key)
        .map_err(|e| CoreError::Offer(format!("the Workstation's key is not hex ({e})")))?;
    if key.len() != 32 {
        return Err(CoreError::Offer(format!(
            "the Workstation's key is {} bytes, not 32",
            key.len()
        )));
    }
    Ok(key)
}

fn secret(offer: &PairingQr) -> Result<[u8; 32], CoreError> {
    let bytes = protocol::hex_decode(&offer.secret)
        .map_err(|e| CoreError::Offer(format!("the pairing secret is not hex ({e})")))?;
    <[u8; 32]>::try_from(bytes.as_slice()).map_err(|_| {
        CoreError::Offer(format!("the pairing secret is {} bytes, not 32", bytes.len()))
    })
}

/// A name cut to what the desk will show, on a character boundary.
fn bounded_name(name: &str) -> String {
    name.chars().take(MAX_DEVICE_NAME).collect()
}

enum State {
    /// Message 1 is sent; message 2 is awaited.
    AwaitingWorkstation(Box<snow::HandshakeState>),
    /// The handshake is done and the code is on screen.
    AwaitingVerdict(Box<snow::TransportState>),
    Finished,
    /// Something failed. Every later call says so again.
    Failed(CoreError),
}

/// One pairing, from the scan to the desk's answer.
///
/// It does no I/O: `start` returns the first bytes to send, and
/// `receive` is handed whatever arrived -- in any pieces, a byte at a
/// time if that is how the transport delivers -- and answers with what to
/// do next.
pub struct PairingClient {
    state: State,
    inbox: Vec<u8>,
    workstation_key: Vec<u8>,
    device_key: Vec<u8>,
    name: String,
}

impl PairingClient {
    /// Begins a pairing against the Workstation `offer` names.
    ///
    /// `entropy` must hold at least `PAIRING_ENTROPY` fresh
    /// random bytes, and must never be reused: it becomes this
    /// handshake's ephemeral key.
    pub fn start(
        offer: &PairingQr,
        keys: &DeviceKeys,
        device_name: &str,
        entropy: Entropy,
    ) -> Result<(Self, Vec<u8>), CoreError> {
        let workstation_key = workstation_key(offer)?;
        let psk = secret(offer)?;

        let mut handshake = noise::builder(noise::pairing_params()?, entropy)
            .local_private_key(&keys.private)
            .map_err(noise::handshake_error)?
            // Slot 3, the last of XX's three messages. See the daemon's
            // `pairing.rs` for why.
            .psk(3, &psk)
            .map_err(noise::handshake_error)?
            .build_initiator()
            .map_err(noise::handshake_error)?;

        // -> e
        let mut message = vec![0u8; MAX_NOISE_MESSAGE];
        let n = handshake.write_message(&[], &mut message).map_err(noise::handshake_error)?;

        let client = Self {
            state: State::AwaitingWorkstation(Box::new(handshake)),
            inbox: Vec::new(),
            workstation_key,
            device_key: keys.public.clone(),
            name: bounded_name(device_name),
        };
        Ok((client, frame(&message[..n])))
    }

    /// The six digits, once the handshake has reached them.
    pub fn code(&self) -> Option<String> {
        match self.state {
            State::AwaitingVerdict(_) | State::Finished => {
                Some(protocol::pairing_sas(&self.workstation_key, &self.device_key))
            }
            _ => None,
        }
    }

    /// Takes the bytes that arrived and says what to do next.
    ///
    /// An error ends the pairing: the caller closes the stream, and every
    /// later call returns the same error.
    pub fn receive(&mut self, bytes: &[u8]) -> Result<Vec<PairingEvent>, CoreError> {
        if let State::Failed(e) = &self.state {
            return Err(e.clone());
        }
        self.inbox.extend_from_slice(bytes);
        let mut events = Vec::new();
        while let Some(message) = self.next_frame() {
            if let Err(e) = self.step(&message, &mut events) {
                self.state = State::Failed(e.clone());
                self.inbox.clear();
                return Err(e);
            }
        }
        Ok(events)
    }

    /// The next whole frame in the inbox, if one has arrived.
    fn next_frame(&mut self) -> Option<Vec<u8>> {
        if self.inbox.len() < LENGTH_PREFIX {
            return None;
        }
        let len = u16::from_be_bytes([self.inbox[0], self.inbox[1]]) as usize;
        if self.inbox.len() < LENGTH_PREFIX + len {
            return None;
        }
        let message = self.inbox[LENGTH_PREFIX..LENGTH_PREFIX + len].to_vec();
        self.inbox.drain(..LENGTH_PREFIX + len);
        Some(message)
    }

    fn step(&mut self, message: &[u8], events: &mut Vec<PairingEvent>) -> Result<(), CoreError> {
        match std::mem::replace(&mut self.state, State::Finished) {
            State::AwaitingWorkstation(mut handshake) => {
                // <- e, ee, s, es
                let mut payload = vec![0u8; MAX_NOISE_MESSAGE];
                handshake.read_message(message, &mut payload).map_err(noise::handshake_error)?;

                // The check this pattern exists to allow. Made BEFORE
                // message 3 is written, which is the message the secret
                // goes into: a Workstation that is not the one whose QR
                // was scanned never sees anything derived from it.
                let answered = handshake
                    .get_remote_static()
                    .ok_or_else(|| CoreError::Handshake("the Workstation sent no key".into()))?;
                if answered != self.workstation_key.as_slice() {
                    return Err(CoreError::WrongWorkstation);
                }

                // -> s, se, psk   (the Device's key, and its name)
                let mut out = vec![0u8; MAX_NOISE_MESSAGE];
                let n = handshake
                    .write_message(self.name.as_bytes(), &mut out)
                    .map_err(noise::handshake_error)?;
                let transport =
                    handshake.into_transport_mode().map_err(noise::handshake_error)?;

                events.push(PairingEvent::Send(frame(&out[..n])));
                events.push(PairingEvent::CompareCode {
                    sas: protocol::pairing_sas(&self.workstation_key, &self.device_key),
                });
                self.state = State::AwaitingVerdict(Box::new(transport));
                Ok(())
            }
            State::AwaitingVerdict(mut transport) => {
                let mut plaintext = vec![0u8; MAX_NOISE_MESSAGE];
                let n = transport
                    .read_message(message, &mut plaintext)
                    .map_err(|e| CoreError::Frame(format!("{e:?}")))?;
                let payload = device_wire::unpad(&plaintext[..n])
                    .map_err(|e| CoreError::Frame(e.to_string()))?;
                let verdict = PairingVerdict::from_bytes(payload)
                    .map_err(|e| CoreError::Frame(e.to_string()))?;
                events.push(PairingEvent::Finished(verdict));
                self.state = State::Finished;
                Ok(())
            }
            State::Finished => Err(CoreError::Finished),
            State::Failed(e) => Err(e),
        }
    }
}

/// Never the handshake: it holds live cipher state.
impl std::fmt::Debug for PairingClient {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let state = match &self.state {
            State::AwaitingWorkstation(_) => "awaiting the Workstation",
            State::AwaitingVerdict(_) => "awaiting the desk",
            State::Finished => "finished",
            State::Failed(_) => "failed",
        };
        f.debug_struct("PairingClient").field("state", &state).finish_non_exhaustive()
    }
}

/// Two bytes of big-endian length, then the message: the framing the
/// daemon's `pairing.rs` reads. A Noise message cannot outgrow the
/// prefix -- both stop at 65535.
fn frame(message: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(LENGTH_PREFIX + message.len());
    out.extend_from_slice(&(message.len() as u16).to_be_bytes());
    out.extend_from_slice(message);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The Workstation's half, written out with `snow` so the client is
    /// tested against the handshake the daemon runs and not against
    /// itself. Draws its own ephemeral key from a pool, like the client,
    /// so every value below is reproducible.
    struct Workstation {
        keys: DeviceKeys,
        secret: [u8; 32],
        handshake: Option<snow::HandshakeState>,
        transport: Option<snow::TransportState>,
        device_name: Vec<u8>,
        device_key: Vec<u8>,
    }

    impl Workstation {
        fn new(key_seed: u8, secret: [u8; 32]) -> Self {
            Self {
                keys: DeviceKeys::generate(Entropy::from_bytes(vec![key_seed; 32])).unwrap(),
                secret,
                handshake: None,
                transport: None,
                device_name: Vec::new(),
                device_key: Vec::new(),
            }
        }

        fn offer(&self) -> PairingQr {
            PairingQr {
                daemon_public_key: protocol::hex_encode(&self.keys.public),
                secret: protocol::hex_encode(&self.secret),
                rendezvous: vec!["wss://relay.example/gavin".into()],
                protocol_version: protocol::PROTOCOL_VERSION,
                relay_admission: Some("let-me-in".into()),
            }
        }

        /// Reads message 1 and answers with message 2.
        fn answer(&mut self, first: &[u8]) -> Vec<u8> {
            let mut handshake = noise::builder(
                noise::pairing_params().unwrap(),
                Entropy::from_bytes(vec![0x5a; 32]),
            )
            .local_private_key(&self.keys.private)
            .unwrap()
            .psk(3, &self.secret)
            .unwrap()
            .build_responder()
            .unwrap();
            let mut payload = vec![0u8; MAX_NOISE_MESSAGE];
            handshake.read_message(unframe(first), &mut payload).unwrap();
            let mut out = vec![0u8; MAX_NOISE_MESSAGE];
            let n = handshake.write_message(&[], &mut out).unwrap();
            self.handshake = Some(handshake);
            frame(&out[..n])
        }

        /// Reads message 3. An error is a secret that did not match.
        fn finish(&mut self, third: &[u8]) -> Result<String, snow::Error> {
            let mut handshake = self.handshake.take().unwrap();
            let mut payload = vec![0u8; MAX_NOISE_MESSAGE];
            let n = handshake.read_message(unframe(third), &mut payload)?;
            self.device_name = payload[..n].to_vec();
            self.device_key = handshake.get_remote_static().unwrap().to_vec();
            self.transport = Some(handshake.into_transport_mode()?);
            Ok(protocol::pairing_sas(&self.keys.public, &self.device_key))
        }

        fn rule(&mut self, verdict: &PairingVerdict) -> Vec<u8> {
            let plaintext = device_wire::pad(&verdict.to_bytes()).unwrap();
            let mut out = vec![0u8; MAX_NOISE_MESSAGE];
            let n = self.transport.as_mut().unwrap().write_message(&plaintext, &mut out).unwrap();
            frame(&out[..n])
        }
    }

    fn unframe(bytes: &[u8]) -> &[u8] {
        let len = u16::from_be_bytes([bytes[0], bytes[1]]) as usize;
        assert_eq!(bytes.len(), LENGTH_PREFIX + len, "one frame, whole");
        &bytes[LENGTH_PREFIX..]
    }

    fn device() -> DeviceKeys {
        DeviceKeys::generate(Entropy::from_bytes(vec![0x11; 32])).unwrap()
    }

    fn fresh() -> Entropy {
        Entropy::from_bytes(vec![0x22; 32])
    }

    /// Runs the handshake and returns the client, the Workstation and
    /// the two events message 2 produced.
    fn handshake(name: &str) -> (PairingClient, Workstation, String) {
        let mut workstation = Workstation::new(0x33, [0x44; 32]);
        let (mut client, first) =
            PairingClient::start(&workstation.offer(), &device(), name, fresh()).unwrap();
        assert_eq!(client.code(), None, "no code before the Workstation has answered");

        let second = workstation.answer(&first);
        let events = client.receive(&second).unwrap();
        let (third, sas) = match events.as_slice() {
            [PairingEvent::Send(third), PairingEvent::CompareCode { sas }] => {
                (third.clone(), sas.clone())
            }
            other => panic!("expected message 3 then the code, got {other:?}"),
        };
        let desk = workstation.finish(&third).unwrap();
        assert_eq!(sas, desk, "the two screens must show the same code");
        (client, workstation, sas)
    }

    #[test]
    fn the_client_reaches_the_code_the_responder_computes() {
        let (client, workstation, sas) = handshake("Cosimo's iPhone");

        assert_eq!(sas.len(), 6);
        assert!(sas.chars().all(|c| c.is_ascii_digit()), "{sas}");
        assert_eq!(client.code().as_deref(), Some(sas.as_str()));

        // The Workstation learned the Device's real static key and the
        // name it sent -- what the desk will show and the row will hold.
        assert_eq!(workstation.device_key, device().public);
        assert_eq!(workstation.device_name, b"Cosimo's iPhone");
    }

    /// Every value in the ceremony comes from the two key pairs, the
    /// secret and the two ephemeral pools above, so the code is a
    /// constant -- pinned, so that a change to the derivation on either
    /// side is a failing test rather than two screens that disagree.
    #[test]
    fn the_code_is_the_protocol_crates_own() {
        let (_, workstation, sas) = handshake("iPhone");
        assert_eq!(sas, protocol::pairing_sas(&device().public, &workstation.keys.public));
        assert_eq!(sas, "795576");
    }

    /// A transport delivers bytes, not frames: a WebSocket message may
    /// hold half a frame or two of them.
    #[test]
    fn bytes_delivered_one_at_a_time_reach_the_same_code() {
        let mut workstation = Workstation::new(0x33, [0x44; 32]);
        let (mut client, first) =
            PairingClient::start(&workstation.offer(), &device(), "iPhone", fresh()).unwrap();
        let second = workstation.answer(&first);

        let mut events = Vec::new();
        for (i, byte) in second.iter().enumerate() {
            let step = client.receive(std::slice::from_ref(byte)).unwrap();
            if i + 1 < second.len() {
                assert!(step.is_empty(), "byte {i} of {} produced {step:?}", second.len());
            }
            events.extend(step);
        }
        assert!(
            matches!(
                events.as_slice(),
                [PairingEvent::Send(_), PairingEvent::CompareCode { .. }]
            ),
            "{events:?}"
        );

        // And the verdict's frame, split across two deliveries.
        let PairingEvent::Send(third) = &events[0] else { unreachable!() };
        workstation.finish(third).unwrap();
        let verdict = workstation.rule(&PairingVerdict::Rejected);
        let (head, tail) = verdict.split_at(100);
        assert!(client.receive(head).unwrap().is_empty());
        assert_eq!(
            client.receive(tail).unwrap(),
            vec![PairingEvent::Finished(PairingVerdict::Rejected)]
        );
    }

    /// The Device pinned a key from the QR. A Workstation that answers
    /// with another is not the one the human scanned, and the pairing
    /// ends before message 3 -- the one the secret goes into -- exists.
    #[test]
    fn a_workstation_with_another_key_is_abandoned_before_the_secret_is_used() {
        let scanned = Workstation::new(0x33, [0x44; 32]);
        let mut impostor = Workstation::new(0x77, [0x44; 32]);
        assert_ne!(scanned.keys.public, impostor.keys.public);

        let (mut client, first) =
            PairingClient::start(&scanned.offer(), &device(), "iPhone", fresh()).unwrap();
        let second = impostor.answer(&first);

        assert_eq!(client.receive(&second), Err(CoreError::WrongWorkstation));
        assert_eq!(client.code(), None, "no code for a Workstation that was not the one scanned");
        // And it stays ended.
        assert_eq!(client.receive(&second), Err(CoreError::WrongWorkstation));
        assert_eq!(client.receive(&[]), Err(CoreError::WrongWorkstation));
    }

    /// The other half of the ceremony's first factor: a Device that
    /// holds the wrong secret gets no further than message 3.
    #[test]
    fn a_wrong_secret_is_refused_by_the_responder() {
        let mut workstation = Workstation::new(0x33, [0x44; 32]);
        let mut offer = workstation.offer();
        offer.secret = protocol::hex_encode(&[0x45; 32]);

        let (mut client, first) =
            PairingClient::start(&offer, &device(), "iPhone", fresh()).unwrap();
        let second = workstation.answer(&first);
        let events = client.receive(&second).unwrap();
        let PairingEvent::Send(third) = &events[0] else { panic!("{events:?}") };

        assert!(workstation.finish(third).is_err(), "a wrong secret completed the handshake");
    }

    #[test]
    fn a_verdict_frame_finishes_the_pairing() {
        for verdict in [
            PairingVerdict::Paired { device_id: "dev-0123456789abcdef".into() },
            PairingVerdict::Rejected,
            PairingVerdict::Expired,
        ] {
            let (mut client, mut workstation, _) = handshake("iPhone");
            let frame = workstation.rule(&verdict);
            assert_eq!(
                frame.len() % device_wire::FRAME_BUCKET,
                0,
                "the verdict is one padded frame"
            );
            assert_eq!(client.receive(&frame).unwrap(), vec![PairingEvent::Finished(verdict)]);
            // Nothing follows a verdict.
            assert_eq!(client.receive(&frame), Err(CoreError::Finished));
        }
    }

    /// The Relay copies bytes and may alter them. A frame that does not
    /// open is an error, never a verdict.
    #[test]
    fn a_verdict_altered_on_the_way_is_an_error_not_a_verdict() {
        let (mut client, mut workstation, _) = handshake("iPhone");
        let mut frame =
            workstation.rule(&PairingVerdict::Paired { device_id: "dev-1".into() });
        let last = frame.len() - 1;
        frame[last] ^= 1;
        assert!(matches!(client.receive(&frame), Err(CoreError::Frame(_))));
    }

    #[test]
    fn entropy_that_runs_out_is_an_error_not_a_weak_key() {
        let workstation = Workstation::new(0x33, [0x44; 32]);
        for short in [0usize, 1, 31] {
            let started = PairingClient::start(
                &workstation.offer(),
                &device(),
                "iPhone",
                Entropy::from_bytes(vec![0x22; short]),
            );
            assert_eq!(started.err(), Some(CoreError::Entropy), "{short} bytes");
        }
    }

    #[test]
    fn an_offer_that_does_not_hold_a_key_and_a_secret_is_refused() {
        let workstation = Workstation::new(0x33, [0x44; 32]);
        let mut offer = workstation.offer();
        offer.daemon_public_key = "zz".into();
        assert!(matches!(
            PairingClient::start(&offer, &device(), "iPhone", fresh()),
            Err(CoreError::Offer(_))
        ));

        let mut offer = workstation.offer();
        offer.secret = "ab".repeat(31);
        assert!(matches!(
            PairingClient::start(&offer, &device(), "iPhone", fresh()),
            Err(CoreError::Offer(_))
        ));

        let mut offer = workstation.offer();
        offer.daemon_public_key = "ab".repeat(31);
        assert!(matches!(relay_dials(&offer), Err(CoreError::Offer(_))));
    }

    #[test]
    fn a_long_name_is_cut_to_what_the_desk_shows() {
        let long = "é".repeat(200);
        let (_, workstation, _) = handshake(&long);
        assert_eq!(
            String::from_utf8(workstation.device_name).unwrap(),
            "é".repeat(MAX_DEVICE_NAME),
            "cut on a character boundary, never through one"
        );
    }

    #[test]
    fn the_dial_carries_the_token_and_the_rendezvous_the_qr_names() {
        let workstation = Workstation::new(0x33, [0x44; 32]);
        let mut offer = workstation.offer();
        offer.rendezvous = vec![
            "wss://relay.example/gavin".into(),
            // Not a Relay this build may dial: left out, not fatal.
            "192.168.1.20:7000".into(),
            "ws://relay.example/plain".into(),
            "ws://127.0.0.1:9000".into(),
        ];

        let dials = relay_dials(&offer).unwrap();
        let urls: Vec<&str> = dials.iter().map(|d| d.url.as_str()).collect();
        assert_eq!(urls, vec!["wss://relay.example/gavin", "ws://127.0.0.1:9000"]);
        for dial in &dials {
            assert_eq!(
                dial.hello,
                RelayHello::device(
                    "let-me-in",
                    &relay::rendezvous_id(&workstation.keys.public),
                    relay::PURPOSE_PAIR
                )
            );
        }

        // A QR with no token still names the Relay; the Device then has
        // nothing to present, and the Relay is what says so.
        offer.relay_admission = None;
        let dials = relay_dials(&offer).unwrap();
        assert_eq!(dials[0].hello.admission().unwrap().1, "");
    }

    #[test]
    fn a_client_does_not_print_its_handshake() {
        let (client, _, _) = handshake("iPhone");
        let shown = format!("{client:?}");
        assert!(shown.contains("awaiting the desk"), "{shown}");
    }
}
