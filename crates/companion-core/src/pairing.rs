//! The Device's half of the pairing ceremony.
//!
//! `docs/security/05-remote-access.md` §3 settles the ceremony and the
//! daemon's `pairing.rs` is its other end. The human scans a QR at the
//! desk; this runs a Noise `XXpsk3` handshake with the secret the QR
//! carried; both screens then show six digits derived from the handshake's
//! hash; the human compares them and confirms at the desk. Only then does
//! the Workstation answer -- and only then is the Device paired.
//!
//! What the Device owes the ceremony, and what this module is careful
//! about, is the one check nobody else can make: that the Workstation
//! which answered is the one whose QR was scanned. The pattern delivers
//! the Workstation's static key in message 2, before the secret is mixed
//! in, precisely so that a Device can compare it with the key it pinned
//! and walk away without having used the secret.
//!
//! **Pairing registers the hardware key** (ADR 0001). After its last
//! handshake message the Device sends its proof -- the hardware public
//! key, and that key's signature over this handshake -- and only then is
//! the desk asked anything. The core does not sign: the key cannot leave
//! the hardware that holds it. It says what is to be signed
//! (`PairingEvent::Prove`) and is handed the signature (`prove`).

use crate::channel::{frame, Channel, Inbox, MAX_NOISE_MESSAGE};
use crate::{noise, CoreError, DeviceKeys, Entropy};
use protocol::device_wire::{self, PairingAck, PairingVerdict, UnlockProof, HARDWARE_KEY_BYTES};
use protocol::relay::{self, RelayHello, RelayUrl};
use protocol::PairingQr;

/// The longest name a Device sends. The daemon cuts a longer one to this
/// before it is shown beside the Confirm button, so sending more would
/// only be sending what is thrown away.
pub const MAX_DEVICE_NAME: usize = 64;

/// What the caller does next.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PairingEvent {
    /// Put these bytes on the stream.
    Send(Vec<u8>),
    /// Have the hardware key sign `message`, and hand the signature to
    /// `PairingClient::prove`. Nothing more arrives until that is done.
    Prove { message: Vec<u8> },
    /// Show these six digits. The human compares them with the desk.
    CompareCode { sas: String },
    /// The desk ruled. Nothing follows.
    Finished(PairingVerdict),
}

/// Where a Device finds its Workstation: a Relay, or the Workstation's
/// own direct listener (ADR 0009), to dial, and the first frame to send
/// it -- the same frame either way.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RelayDial {
    /// Dialled exactly as it is.
    pub url: String,
    pub hello: RelayHello,
    /// For a direct listener, the one certificate to trust there
    /// (`protocol::relay::certificate_pin`): no root and no host name.
    /// `None` for a Relay, trusted as the platform trusts it.
    pub pin: Option<String>,
}

/// Where to dial a pairing QR's Workstation, in the order to try: its
/// direct listener's addresses, then its Relays.
///
/// An entry that is not one this build may dial is left out rather than
/// refused, so a Device that cannot use one entry can still use the next.
/// See `dials` for which those are.
pub fn relay_dials(offer: &PairingQr) -> Result<Vec<RelayDial>, CoreError> {
    let workstation_key = workstation_key(offer)?;
    Ok(dials(
        &workstation_key,
        &offer.direct,
        offer.direct_pin.as_deref(),
        &offer.rendezvous,
        offer.relay_admission.as_deref(),
        relay::PURPOSE_PAIR,
    ))
}

/// Where to dial the Workstation holding `workstation_key`, for
/// `purpose`, in the order to try: the direct addresses, then the Relays.
///
/// A direct address is dialled with the pin and an EMPTY admission
/// token: the token is the Relay's, and a LAN address a Mac has since
/// given up could be anyone's. One with no pin to trust it by, or that
/// is not `wss://`, is left out -- a pin is a certificate to check, and
/// there is nothing else to trust a direct listener by. A Relay is
/// dialled with the token, as before.
pub(crate) fn dials(
    workstation_key: &[u8],
    direct: &[String],
    direct_pin: Option<&str>,
    relays: &[String],
    relay_admission: Option<&str>,
    purpose: &str,
) -> Vec<RelayDial> {
    let rendezvous = relay::rendezvous_id(workstation_key);
    let pin = direct_pin.map(|pin| pin.trim().to_ascii_lowercase()).filter(|pin| {
        pin.len() == 64 && pin.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    });
    let direct = pin.iter().flat_map(|pin| {
        direct
            .iter()
            .filter_map(|url| RelayUrl::parse(url).ok())
            .filter(|url| url.secure)
            .map(|url| RelayDial {
                url: url.url,
                hello: RelayHello::device("", &rendezvous, purpose),
                pin: Some(pin.clone()),
            })
    });
    let token = relay_admission.unwrap_or("");
    let relays = relays.iter().filter_map(|url| RelayUrl::parse(url).ok()).map(|url| RelayDial {
        url: url.url,
        hello: RelayHello::device(token, &rendezvous, purpose),
        pin: None,
    });
    direct.chain(relays).collect()
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

/// A hardware public key, by its shape: the uncompressed SEC1 point of a
/// P-256 key. Whether it is a point ON the curve is the Workstation's to
/// say, which verifies a signature with it before it asks the desk.
pub(crate) fn hardware_key(key: &[u8]) -> Result<Vec<u8>, CoreError> {
    if key.len() != HARDWARE_KEY_BYTES {
        return Err(CoreError::HardwareKey(format!(
            "it is {} bytes, not the {HARDWARE_KEY_BYTES} of an uncompressed P-256 point",
            key.len()
        )));
    }
    if key[0] != 0x04 {
        return Err(CoreError::HardwareKey(
            "it is not an uncompressed point (its first byte is not 04)".into(),
        ));
    }
    Ok(key.to_vec())
}

enum State {
    /// Message 1 is sent; message 2 is awaited.
    AwaitingWorkstation(Box<snow::HandshakeState>),
    /// The handshake is done, and the hardware is signing it.
    AwaitingProof(Box<Channel>),
    /// The proof is sent; the Workstation has not yet said it took it.
    AwaitingAck(Box<Channel>),
    /// The proof was taken and the code is on screen.
    AwaitingVerdict(Box<Channel>),
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
    inbox: Inbox,
    workstation_key: Vec<u8>,
    hardware_key: Vec<u8>,
    name: String,
    /// The six digits, known once the handshake is done and shown once
    /// the Workstation has taken the proof.
    sas: Option<String>,
}

impl PairingClient {
    /// Begins a pairing against the Workstation `offer` names.
    ///
    /// `hardware_key` is the public half of the Device's hardware key,
    /// as `HARDWARE_KEY_BYTES` of uncompressed SEC1 point: what this
    /// pairing registers.
    ///
    /// `entropy` must hold at least `PAIRING_ENTROPY` fresh
    /// random bytes, and must never be reused: it becomes this
    /// handshake's ephemeral key.
    pub fn start(
        offer: &PairingQr,
        keys: &DeviceKeys,
        hardware_key: &[u8],
        device_name: &str,
        entropy: Entropy,
    ) -> Result<(Self, Vec<u8>), CoreError> {
        // Before anything is sent. A Workstation that old reads no proof
        // and sends no notification key, and the pairing secret is good
        // for one handshake: better not spent on one that cannot end in
        // a pairing.
        if offer.protocol_version < protocol::PAIRING_MIN_VERSION {
            return Err(CoreError::Offer(format!(
                "the Workstation's Gavin is older than this Companion can pair with \
                 (it speaks version {}, and pairing takes {}) — update Gavin at the desk",
                offer.protocol_version,
                protocol::PAIRING_MIN_VERSION
            )));
        }
        let workstation_key = workstation_key(offer)?;
        let psk = secret(offer)?;
        let hardware_key = self::hardware_key(hardware_key)?;

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
            inbox: Inbox::default(),
            workstation_key,
            hardware_key,
            name: bounded_name(device_name),
            sas: None,
        };
        Ok((client, frame(&message[..n])))
    }

    /// The hardware's signature over what `PairingEvent::Prove` named,
    /// as the hardware returned it (ASN.1 DER).
    ///
    /// Answers with the proof to send -- and with whatever had arrived
    /// meanwhile and was waiting on this. The code follows the
    /// Workstation's acknowledgement, not this.
    pub fn prove(&mut self, signature: &[u8]) -> Result<Vec<PairingEvent>, CoreError> {
        let proof = UnlockProof {
            signature: protocol::hex_encode(signature),
            hardware_key: Some(protocol::hex_encode(&self.hardware_key)),
        };
        self.prove_with(&proof.to_bytes())
    }

    /// Sends `payload` where the proof goes. What a Device that does not
    /// behave sends: the test Device is how the daemon is shown one.
    #[cfg(any(test, feature = "test-device"))]
    pub fn prove_saying(&mut self, payload: &[u8]) -> Result<Vec<PairingEvent>, CoreError> {
        self.prove_with(payload)
    }

    fn prove_with(&mut self, payload: &[u8]) -> Result<Vec<PairingEvent>, CoreError> {
        if let State::Failed(e) = &self.state {
            return Err(e.clone());
        }
        let State::AwaitingProof(_) = self.state else {
            return Err(CoreError::NotReady);
        };
        let State::AwaitingProof(mut channel) =
            std::mem::replace(&mut self.state, State::Finished)
        else {
            unreachable!("checked a line above");
        };
        let sealed = match channel.seal(payload) {
            Ok(sealed) => sealed,
            Err(e) => return Err(self.fail(e)),
        };
        self.state = State::AwaitingAck(channel);
        let mut events = vec![PairingEvent::Send(sealed)];
        events.extend(self.receive(&[])?);
        Ok(events)
    }

    fn fail(&mut self, e: CoreError) -> CoreError {
        self.state = State::Failed(e.clone());
        self.inbox.clear();
        e
    }

    /// The six digits, once the Workstation has taken the proof.
    pub fn code(&self) -> Option<String> {
        match self.state {
            State::AwaitingVerdict(_) | State::Finished => self.sas.clone(),
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
        self.inbox.push(bytes);
        let mut events = Vec::new();
        // Nothing is read while the hardware is signing: what follows
        // the handshake on the Workstation's side follows the proof, and
        // is read once the proof has been made.
        while !matches!(self.state, State::AwaitingProof(_)) {
            let Some(message) = self.inbox.next_frame() else { break };
            if let Err(e) = self.step(&message, &mut events) {
                return Err(self.fail(e));
            }
        }
        if let Err(e) = self.inbox.within_bounds() {
            return Err(self.fail(e));
        }
        Ok(events)
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
                // The hash of the whole handshake, which is what the
                // hardware signs: both static keys and both ephemerals
                // are in it, so the signature is good for this pairing
                // and no other.
                let hash = handshake.get_handshake_hash().to_vec();
                let message = device_wire::unlock_message(&hash);
                self.sas = Some(protocol::pairing_sas(&hash));
                let transport =
                    handshake.into_transport_mode().map_err(noise::handshake_error)?;

                events.push(PairingEvent::Send(frame(&out[..n])));
                events.push(PairingEvent::Prove { message });
                self.state = State::AwaitingProof(Box::new(Channel::new(transport)));
                Ok(())
            }
            State::AwaitingAck(mut channel) => {
                let payload = channel.open(message)?;
                match PairingAck::from_bytes(&payload) {
                    Ok(PairingAck::ProofTaken) => {}
                    // Not the acknowledgement: nothing this Workstation
                    // said makes the digits safe to show.
                    _ => return Err(CoreError::Frame("the Workstation did not take the proof".into())),
                }
                let sas = self.sas.clone().ok_or(CoreError::NotReady)?;
                events.push(PairingEvent::CompareCode { sas });
                self.state = State::AwaitingVerdict(channel);
                Ok(())
            }
            State::AwaitingVerdict(mut channel) => {
                let payload = channel.open(message)?;
                let verdict = PairingVerdict::from_bytes(&payload)
                    .map_err(|e| CoreError::Frame(e.to_string()))?;
                events.push(PairingEvent::Finished(verdict));
                self.state = State::Finished;
                Ok(())
            }
            // `receive` reads nothing in this state.
            State::AwaitingProof(_) => Err(CoreError::NotReady),
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
            State::AwaitingProof(_) => "awaiting the hardware's signature",
            State::AwaitingAck(_) => "awaiting the Workstation's acknowledgement",
            State::AwaitingVerdict(_) => "awaiting the desk",
            State::Finished => "finished",
            State::Failed(_) => "failed",
        };
        f.debug_struct("PairingClient").field("state", &state).finish_non_exhaustive()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::channel::testing::unframe;
    use crate::channel::MAX_NOISE_MESSAGE;
    use protocol::device_wire::UnlockProof;

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
        /// The handshake hash, as this end computed it.
        hash: Vec<u8>,
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
                hash: Vec::new(),
            }
        }

        fn offer(&self) -> PairingQr {
            PairingQr {
                daemon_public_key: protocol::hex_encode(&self.keys.public),
                secret: protocol::hex_encode(&self.secret),
                rendezvous: vec!["wss://relay.example/gavin".into()],
                protocol_version: protocol::PROTOCOL_VERSION,
                relay_admission: Some("let-me-in".into()),
                direct: Vec::new(),
                direct_pin: None,
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
            self.hash = handshake.get_handshake_hash().to_vec();
            self.transport = Some(handshake.into_transport_mode()?);
            Ok(protocol::pairing_sas(&self.hash))
        }

        /// The acknowledgement the Workstation sends once it has taken
        /// the proof.
        fn ack(&mut self) -> Vec<u8> {
            let plaintext = device_wire::pad(&PairingAck::ProofTaken.to_bytes()).unwrap();
            let mut out = vec![0u8; MAX_NOISE_MESSAGE];
            let n = self.transport.as_mut().unwrap().write_message(&plaintext, &mut out).unwrap();
            frame(&out[..n])
        }

        /// Opens the Device's proof: the frame that follows message 3.
        fn read_proof(&mut self, frame: &[u8]) -> UnlockProof {
            assert_eq!(frame.len() % device_wire::FRAME_BUCKET, 0, "the proof is one padded frame");
            let mut plaintext = vec![0u8; MAX_NOISE_MESSAGE];
            let n = self
                .transport
                .as_mut()
                .unwrap()
                .read_message(unframe(frame), &mut plaintext)
                .unwrap();
            UnlockProof::from_bytes(device_wire::unpad(&plaintext[..n]).unwrap()).unwrap()
        }

        fn rule(&mut self, verdict: &PairingVerdict) -> Vec<u8> {
            let plaintext = device_wire::pad(&verdict.to_bytes()).unwrap();
            let mut out = vec![0u8; MAX_NOISE_MESSAGE];
            let n = self.transport.as_mut().unwrap().write_message(&plaintext, &mut out).unwrap();
            frame(&out[..n])
        }
    }

    fn device() -> DeviceKeys {
        DeviceKeys::generate(Entropy::from_bytes(vec![0x11; 32])).unwrap()
    }

    /// A hardware public key, by its shape: the core carries the key and
    /// never computes with it.
    fn hardware_key() -> Vec<u8> {
        let mut key = vec![0x04];
        key.extend_from_slice(&[0x66; 64]);
        key
    }

    /// What the hardware answered with. The core carries this too.
    const SIGNATURE: &[u8] = &[0x30, 0x45, 0x02, 0x21, 0x00, 0xaa, 0xbb];

    fn start(offer: &PairingQr, name: &str) -> Result<(PairingClient, Vec<u8>), CoreError> {
        PairingClient::start(offer, &device(), &hardware_key(), name, fresh())
    }

    /// Message 3 and what the hardware is to sign, out of what message 2
    /// produced.
    fn third_and_message(events: &[PairingEvent]) -> (Vec<u8>, Vec<u8>) {
        match events {
            [PairingEvent::Send(third), PairingEvent::Prove { message }] => {
                (third.clone(), message.clone())
            }
            other => panic!("expected message 3 then a proof to make, got {other:?}"),
        }
    }

    /// The proof's frame, out of what proving produced: and no code yet,
    /// because the Workstation has not said it took the proof.
    fn proof_frame(events: &[PairingEvent]) -> Vec<u8> {
        match events {
            [PairingEvent::Send(proof)] => proof.clone(),
            other => panic!("expected the proof and nothing else, got {other:?}"),
        }
    }

    /// The code, out of what the acknowledgement produced.
    fn code_of(events: &[PairingEvent]) -> String {
        match events {
            [PairingEvent::CompareCode { sas }] => sas.clone(),
            other => panic!("expected the code, got {other:?}"),
        }
    }

    fn fresh() -> Entropy {
        Entropy::from_bytes(vec![0x22; 32])
    }

    /// Runs the handshake and the proof, and returns the client, the
    /// Workstation and the code.
    fn handshake(name: &str) -> (PairingClient, Workstation, String) {
        let mut workstation = Workstation::new(0x33, [0x44; 32]);
        let (mut client, first) = start(&workstation.offer(), name).unwrap();
        assert_eq!(client.code(), None, "no code before the Workstation has answered");

        let second = workstation.answer(&first);
        let (third, _) = third_and_message(&client.receive(&second).unwrap());
        let desk = workstation.finish(&third).unwrap();

        let proof = proof_frame(&client.prove(SIGNATURE).unwrap());
        workstation.read_proof(&proof);
        let ack = workstation.ack();
        let sas = code_of(&client.receive(&ack).unwrap());
        assert_eq!(sas, desk, "the two screens must show the same code");
        (client, workstation, sas)
    }

    /// ADR 0001: the Device registers its hardware key at pairing. What
    /// follows message 3 is the key and the hardware's signature over
    /// this handshake, in one padded frame, sealed by the channel the
    /// handshake left.
    #[test]
    fn the_proof_follows_message_three_and_carries_the_hardware_key() {
        let mut workstation = Workstation::new(0x33, [0x44; 32]);
        let (mut client, first) = start(&workstation.offer(), "iPhone").unwrap();
        let second = workstation.answer(&first);
        let (third, message) = third_and_message(&client.receive(&second).unwrap());
        workstation.finish(&third).unwrap();

        // What the hardware is asked to sign is this handshake's hash, as
        // the Workstation computed it too.
        assert_eq!(message, device_wire::unlock_message(&workstation.hash));
        assert_eq!(workstation.hash.len(), 32);

        let proof = proof_frame(&client.prove(SIGNATURE).unwrap());
        let text = String::from_utf8_lossy(&proof).to_string();
        assert!(!text.contains("hardwareKey") && !text.contains("signature"), "sealed: {text}");
        assert_eq!(
            workstation.read_proof(&proof),
            UnlockProof {
                signature: protocol::hex_encode(SIGNATURE),
                hardware_key: Some(protocol::hex_encode(&hardware_key())),
            }
        );
    }

    /// The code goes on screen once the Workstation has said it took the
    /// proof: a Device showing six digits is one the desk is being asked
    /// about. A handshake that lost the race for the one-use secret is
    /// never acknowledged, and shows nothing.
    #[test]
    fn no_code_is_shown_before_the_proof_is_made() {
        let mut workstation = Workstation::new(0x33, [0x44; 32]);
        let (mut client, first) = start(&workstation.offer(), "iPhone").unwrap();
        let second = workstation.answer(&first);
        let events = client.receive(&second).unwrap();
        assert!(
            !events.iter().any(|e| matches!(e, PairingEvent::CompareCode { .. })),
            "{events:?}"
        );
        assert_eq!(client.code(), None);

        let (third, _) = third_and_message(&events);
        workstation.finish(&third).unwrap();
        let events = client.prove(SIGNATURE).unwrap();
        assert_eq!(events.len(), 1, "{events:?}");
        assert_eq!(client.code(), None, "the proof is sent, but nobody has said it was taken");

        let ack = workstation.ack();
        let sas = code_of(&client.receive(&ack).unwrap());
        assert_eq!(client.code().as_deref(), Some(sas.as_str()));
    }

    /// Anything but the acknowledgement after the proof ends the pairing
    /// with no code shown.
    #[test]
    fn a_frame_that_is_not_the_acknowledgement_shows_no_code() {
        let (mut client, first, mut workstation) = {
            let workstation = Workstation::new(0x33, [0x44; 32]);
            let (client, first) = start(&workstation.offer(), "iPhone").unwrap();
            (client, first, workstation)
        };
        let second = workstation.answer(&first);
        let (third, _) = third_and_message(&client.receive(&second).unwrap());
        workstation.finish(&third).unwrap();
        client.prove(SIGNATURE).unwrap();

        // The desk's ruling, before the acknowledgement: not it.
        let ruling = workstation.rule(&PairingVerdict::Rejected);
        assert!(matches!(client.receive(&ruling), Err(CoreError::Frame(_))));
        assert_eq!(client.code(), None);
    }

    /// Two pairings made with one Device key show different codes: the
    /// code covers the handshake, not the keys. This is the attacker of
    /// ticket 33, who holds a copy of the Noise key.
    #[test]
    fn two_handshakes_with_one_device_key_show_different_codes() {
        let run = |ephemeral: u8| {
            let mut workstation = Workstation::new(0x33, [0x44; 32]);
            let (mut client, first) = PairingClient::start(
                &workstation.offer(),
                &device(),
                &hardware_key(),
                "iPhone",
                Entropy::from_bytes(vec![ephemeral; 32]),
            )
            .unwrap();
            let second = workstation.answer(&first);
            let (third, _) = third_and_message(&client.receive(&second).unwrap());
            workstation.finish(&third).unwrap();
            client.prove(SIGNATURE).unwrap();
            let ack = workstation.ack();
            code_of(&client.receive(&ack).unwrap())
        };
        assert_ne!(run(0x22), run(0x23));
    }

    #[test]
    fn a_proof_is_made_once_and_only_when_asked_for() {
        let mut workstation = Workstation::new(0x33, [0x44; 32]);
        let (mut client, first) = start(&workstation.offer(), "iPhone").unwrap();
        assert_eq!(
            client.prove(SIGNATURE),
            Err(CoreError::NotReady),
            "before the Workstation has answered there is nothing to sign"
        );

        // Not reading the Workstation's answer was not an error the
        // pairing cannot recover from.
        let second = workstation.answer(&first);
        client.receive(&second).unwrap();
        client.prove(SIGNATURE).unwrap();
        assert_eq!(client.prove(SIGNATURE), Err(CoreError::NotReady), "a second proof");
    }

    /// The verdict can only follow the proof. One that arrives before it
    /// stays unread until the proof has been made.
    #[test]
    fn a_verdict_is_not_read_before_the_proof_is_made() {
        let mut workstation = Workstation::new(0x33, [0x44; 32]);
        let (mut client, first) = start(&workstation.offer(), "iPhone").unwrap();
        let second = workstation.answer(&first);
        let (third, _) = third_and_message(&client.receive(&second).unwrap());
        workstation.finish(&third).unwrap();

        let mut early = workstation.ack();
        early.extend(workstation.rule(&PairingVerdict::Rejected));
        assert_eq!(client.receive(&early).unwrap(), vec![]);
        let events = client.prove(SIGNATURE).unwrap();
        assert_eq!(events.len(), 3, "{events:?}");
        assert!(matches!(events[1], PairingEvent::CompareCode { .. }), "{events:?}");
        assert_eq!(events[2], PairingEvent::Finished(PairingVerdict::Rejected));
    }

    /// See `connect`'s test of the same name: what arrives while the
    /// hardware is signing is kept, up to a ceiling.
    #[test]
    fn what_arrives_while_the_hardware_is_signing_is_bounded() {
        let mut workstation = Workstation::new(0x33, [0x44; 32]);
        let (mut client, first) = start(&workstation.offer(), "iPhone").unwrap();
        let second = workstation.answer(&first);
        client.receive(&second).unwrap();

        let mut ended = None;
        for _ in 0..16 {
            if let Err(e) = client.receive(&vec![0u8; 64 * 1024]) {
                ended = Some(e);
                break;
            }
        }
        assert!(matches!(&ended, Some(CoreError::Frame(why)) if why.contains("more arrived")), "{ended:?}");
        assert_eq!(client.prove(SIGNATURE).err(), ended);
    }

    /// A daemon older than the one that reads the proof would wait for
    /// nothing and answer with no notification key. Its QR says which it
    /// is, so the Device declines before the secret has been used.
    #[test]
    fn an_offer_from_an_older_workstation_is_refused() {
        let workstation = Workstation::new(0x33, [0x44; 32]);
        let mut offer = workstation.offer();
        offer.protocol_version = protocol::PAIRING_MIN_VERSION - 1;
        let err = start(&offer, "iPhone").err().unwrap();
        assert!(matches!(&err, CoreError::Offer(why) if why.contains("older")), "{err:?}");

        offer.protocol_version = protocol::PAIRING_MIN_VERSION;
        assert!(start(&offer, "iPhone").is_ok());
        // A newer one is the Workstation's to refuse, not the Device's.
        offer.protocol_version = protocol::PROTOCOL_VERSION + 10;
        assert!(start(&offer, "iPhone").is_ok());
    }

    #[test]
    fn a_hardware_key_that_is_not_a_point_is_refused() {
        let workstation = Workstation::new(0x33, [0x44; 32]);
        let mut compressed = vec![0x02];
        compressed.extend_from_slice(&[0x66; 32]);
        let mut wrong_tag = hardware_key();
        wrong_tag[0] = 0x05;
        for key in [Vec::new(), vec![0x04; 64], vec![0x04; 66], compressed, wrong_tag] {
            let started =
                PairingClient::start(&workstation.offer(), &device(), &key, "iPhone", fresh());
            assert!(
                matches!(started, Err(CoreError::HardwareKey(_))),
                "a key of {} bytes was accepted",
                key.len()
            );
        }
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
        assert_eq!(sas, protocol::pairing_sas(&workstation.hash));
        assert_eq!(sas, "517223");
    }

    /// A transport delivers bytes, not frames: a WebSocket message may
    /// hold half a frame or two of them.
    #[test]
    fn bytes_delivered_one_at_a_time_reach_the_same_code() {
        let mut workstation = Workstation::new(0x33, [0x44; 32]);
        let (mut client, first) = start(&workstation.offer(), "iPhone").unwrap();
        let second = workstation.answer(&first);

        let mut events = Vec::new();
        for (i, byte) in second.iter().enumerate() {
            let step = client.receive(std::slice::from_ref(byte)).unwrap();
            if i + 1 < second.len() {
                assert!(step.is_empty(), "byte {i} of {} produced {step:?}", second.len());
            }
            events.extend(step);
        }
        let (third, _) = third_and_message(&events);

        // And the verdict's frame, split across two deliveries.
        workstation.finish(&third).unwrap();
        let proof = proof_frame(&client.prove(SIGNATURE).unwrap());
        workstation.read_proof(&proof);
        let ack = workstation.ack();
        code_of(&client.receive(&ack).unwrap());
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

        let (mut client, first) = start(&scanned.offer(), "iPhone").unwrap();
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

        let (mut client, first) = start(&offer, "iPhone").unwrap();
        let second = workstation.answer(&first);
        let (third, _) = third_and_message(&client.receive(&second).unwrap());

        assert!(workstation.finish(&third).is_err(), "a wrong secret completed the handshake");
    }

    #[test]
    fn a_verdict_frame_finishes_the_pairing() {
        for verdict in [
            PairingVerdict::Paired {
                device_id: "dev-0123456789abcdef".into(),
                notification_key: "5c".repeat(32),
            },
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
        let mut frame = workstation.rule(&PairingVerdict::Paired {
            device_id: "dev-1".into(),
            notification_key: "5c".repeat(32),
        });
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
                &hardware_key(),
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
        assert!(matches!(start(&offer, "iPhone"), Err(CoreError::Offer(_))));

        let mut offer = workstation.offer();
        offer.secret = "ab".repeat(31);
        assert!(matches!(start(&offer, "iPhone"), Err(CoreError::Offer(_))));

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

    /// A QR with only a direct listener and no Relay (ADR 0009) still has
    /// somewhere to pair: the listener, by its pin.
    #[test]
    fn a_qr_with_only_a_direct_listener_is_paired_there() {
        let workstation = Workstation::new(0x33, [0x44; 32]);
        let mut offer = workstation.offer();
        offer.rendezvous = Vec::new();
        offer.relay_admission = None;
        offer.direct = vec!["wss://192.168.1.20:8445".into()];
        offer.direct_pin = Some("cd".repeat(32));

        let dials = relay_dials(&offer).unwrap();
        assert_eq!(dials.len(), 1);
        assert_eq!(dials[0].url, "wss://192.168.1.20:8445");
        assert_eq!(dials[0].pin.as_deref(), Some("cd".repeat(32).as_str()));
        assert_eq!(
            dials[0].hello,
            RelayHello::device("", &relay::rendezvous_id(&workstation.keys.public), relay::PURPOSE_PAIR)
        );
    }

    #[test]
    fn a_client_does_not_print_its_handshake() {
        let (client, _, _) = handshake("iPhone");
        let shown = format!("{client:?}");
        assert!(shown.contains("awaiting the desk"), "{shown}");
    }
}
