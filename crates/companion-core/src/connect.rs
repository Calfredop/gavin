//! The Device's half of a connection to a Workstation it has paired with.
//!
//! `docs/security/05-remote-access.md` §5 settles the handshake and ADR
//! 0001 what follows it. The Device pinned the Workstation's static key
//! when it scanned the pairing QR, so it runs Noise `IK`: its first
//! message is sealed to that key and carries the Device's own, and a
//! Workstation holding any other key cannot read it. The Workstation
//! looks the Device's key up in its trust store.
//!
//! **Then the proof.** The Noise key is software, and a copy of it must
//! get an attacker nothing. So the first thing the Device sends on the
//! channel is its hardware key's signature over this handshake's hash --
//! made on the phone, by hardware that signs only while the phone is
//! unlocked and its owner has been present (ADR 0004). The Workstation
//! answers no request until that verifies against the key the Device
//! registered when it paired. The core does not sign; it says what is to
//! be signed (`ConnectEvent::Prove`) and is handed the signature
//! (`ConnectClient::prove`).
//!
//! **Then the stream.** Once the Workstation has said `connected`, what
//! travels is the daemon's own protocol: one JSON message a line. The
//! core cuts what it sends into frames and puts what it receives back
//! together, so a caller sends a message and is handed a message.

use crate::channel::{frame, Channel, Inbox, MAX_NOISE_MESSAGE};
use crate::pairing::RelayDial;
use crate::{noise, CoreError, DeviceKeys, Entropy};
use protocol::device_wire::{
    self, ConnectRefusal, ConnectVerdict, PairingVerdict, UnlockProof, MAX_PAYLOAD,
    NOTIFICATION_KEY_BYTES,
};
use protocol::relay;
use protocol::PairingQr;

/// The longest message the core will put together out of frames: the
/// daemon's own cap on one line of its protocol.
pub const MAX_MESSAGE_BYTES: usize = protocol::MAX_LINE_BYTES as usize;

/// What a Device keeps about a Workstation it has paired with: everything
/// it needs to find that Workstation again, and to know it when it does.
///
/// Made from the pairing QR and the desk's verdict, and kept by the
/// shell. `notification_key` belongs in the platform keystore, where the
/// phone's notification extension can read it; nothing else here is
/// secret to anyone who has seen the QR.
#[derive(Clone, PartialEq, Eq)]
pub struct PairedWorkstation {
    /// The Workstation's Noise static public key, as pinned from the QR.
    pub workstation_key: Vec<u8>,
    /// The Relays the QR named, in the order to try them.
    pub relays: Vec<String>,
    pub relay_admission: Option<String>,
    /// The direct listener's addresses the QR named (ADR 0009), tried
    /// before the Relays, and the pin its certificate is trusted by.
    /// Kept as they were at pairing: a LAN address that has since
    /// changed costs one try, and the Relay is still there after it.
    pub direct: Vec<String>,
    pub direct_pin: Option<String>,
    /// What the Workstation calls this Device.
    pub device_id: String,
    /// What the Workstation seals this Device's notifications with.
    pub notification_key: Vec<u8>,
}

impl PairedWorkstation {
    /// The Workstation `offer` named, now that the desk has ruled.
    /// `None` for any verdict but `Paired`: there is no Workstation to
    /// keep.
    pub fn from_pairing(
        offer: &PairingQr,
        verdict: &PairingVerdict,
    ) -> Result<Option<Self>, CoreError> {
        let PairingVerdict::Paired { device_id, notification_key } = verdict else {
            return Ok(None);
        };
        let notification_key = protocol::hex_decode(notification_key)
            .map_err(|e| CoreError::Frame(format!("the notification key is not hex ({e})")))?;
        if notification_key.len() != NOTIFICATION_KEY_BYTES {
            return Err(CoreError::Frame(format!(
                "the notification key is {} bytes, not {NOTIFICATION_KEY_BYTES}",
                notification_key.len()
            )));
        }
        Ok(Some(Self {
            workstation_key: workstation_key(&offer.daemon_public_key)?,
            relays: offer.rendezvous.clone(),
            relay_admission: offer.relay_admission.clone(),
            direct: offer.direct.clone(),
            direct_pin: offer.direct_pin.clone(),
            device_id: device_id.clone(),
            notification_key,
        }))
    }

    /// Where to dial to connect, in the order to try: the direct
    /// addresses, then the Relays. An entry this build may not dial is
    /// left out, as `relay_dials` leaves it out for a pairing.
    pub fn relay_dials(&self) -> Vec<RelayDial> {
        connect_dials(
            &self.workstation_key,
            &self.direct,
            self.direct_pin.as_deref(),
            &self.relays,
            self.relay_admission.as_deref(),
        )
    }
}

/// Where to dial to connect to the Workstation holding `workstation_key`,
/// through what it named at pairing, in the order to try: what
/// `PairedWorkstation::relay_dials` answers, for a caller that keeps the
/// Workstation its own way (the shell keeps a record, not this type).
pub fn connect_dials(
    workstation_key: &[u8],
    direct: &[String],
    direct_pin: Option<&str>,
    relays: &[String],
    relay_admission: Option<&str>,
) -> Vec<RelayDial> {
    crate::pairing::dials(
        workstation_key,
        direct,
        direct_pin,
        relays,
        relay_admission,
        relay::PURPOSE_CONNECT,
    )
}

/// Never the notification key.
impl std::fmt::Debug for PairedWorkstation {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PairedWorkstation")
            .field("workstation_key", &protocol::hex_encode(&self.workstation_key))
            .field("relays", &self.relays)
            .field("direct", &self.direct)
            .field("device_id", &self.device_id)
            .finish_non_exhaustive()
    }
}

fn workstation_key(hex: &str) -> Result<Vec<u8>, CoreError> {
    let key = protocol::hex_decode(hex)
        .map_err(|e| CoreError::Offer(format!("the Workstation's key is not hex ({e})")))?;
    checked_workstation_key(&key)
}

fn checked_workstation_key(key: &[u8]) -> Result<Vec<u8>, CoreError> {
    if key.len() != 32 {
        return Err(CoreError::Offer(format!(
            "the Workstation's key is {} bytes, not 32",
            key.len()
        )));
    }
    Ok(key.to_vec())
}

/// What the caller does next.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConnectEvent {
    /// Put these bytes on the stream.
    Send(Vec<u8>),
    /// Have the hardware key sign `message`, and hand the signature to
    /// `ConnectClient::prove`. Nothing more arrives until that is done.
    Prove { message: Vec<u8> },
    /// The Workstation verified the proof. The connection holds the
    /// Remote role, and messages may be sent.
    Connected { device_id: String },
    /// The Workstation refused. Nothing follows.
    Refused(ConnectRefusal),
    /// One message from the Workstation, whole, without its newline.
    Message(Vec<u8>),
}

enum State {
    /// Message 1 is sent; message 2 is awaited.
    AwaitingWorkstation(Box<snow::HandshakeState>),
    /// The handshake is done, and the hardware is signing it.
    AwaitingProof(Box<Channel>),
    /// The proof is sent.
    AwaitingVerdict(Box<Channel>),
    Connected(Box<Channel>),
    Finished,
    /// Something failed. Every later call says so again.
    Failed(CoreError),
}

/// One connection, from the first message to the last.
///
/// It does no I/O, like `PairingClient`: `start` returns the first bytes
/// to send, `receive` is handed whatever arrived, in any pieces, and
/// `send` returns the bytes a message becomes.
pub struct ConnectClient {
    state: State,
    inbox: Inbox,
    /// The message being put together, until its newline arrives.
    line: Vec<u8>,
}

impl ConnectClient {
    /// Begins a connection to the Workstation holding `workstation_key`.
    ///
    /// `entropy` must hold at least `CONNECT_ENTROPY` fresh random bytes,
    /// and must never be reused: it becomes this handshake's ephemeral
    /// key.
    pub fn start(
        workstation_key: &[u8],
        keys: &DeviceKeys,
        entropy: Entropy,
    ) -> Result<(Self, Vec<u8>), CoreError> {
        let workstation_key = checked_workstation_key(workstation_key)?;
        let mut handshake = noise::builder(noise::connect_params()?, entropy)
            .prologue(device_wire::CONNECT_PROLOGUE)
            .map_err(noise::handshake_error)?
            .local_private_key(&keys.private)
            .map_err(noise::handshake_error)?
            // The key pinned at pairing. There is nothing to compare
            // afterwards, as pairing compares: the first message is
            // sealed to this key, and only its holder can answer.
            .remote_public_key(&workstation_key)
            .map_err(noise::handshake_error)?
            .build_initiator()
            .map_err(noise::handshake_error)?;

        // -> e, es, s, ss
        let mut message = vec![0u8; MAX_NOISE_MESSAGE];
        let n = handshake.write_message(&[], &mut message).map_err(noise::handshake_error)?;

        let client = Self {
            state: State::AwaitingWorkstation(Box::new(handshake)),
            inbox: Inbox::default(),
            line: Vec::new(),
        };
        Ok((client, frame(&message[..n])))
    }

    /// Whether messages may be sent.
    pub fn is_connected(&self) -> bool {
        matches!(self.state, State::Connected(_))
    }

    fn fail(&mut self, e: CoreError) -> CoreError {
        self.state = State::Failed(e.clone());
        self.inbox.clear();
        self.line.clear();
        e
    }

    /// Takes the bytes that arrived and says what to do next.
    ///
    /// An error ends the connection: the caller closes the stream, and
    /// every later call returns the same error.
    pub fn receive(&mut self, bytes: &[u8]) -> Result<Vec<ConnectEvent>, CoreError> {
        if let State::Failed(e) = &self.state {
            return Err(e.clone());
        }
        self.inbox.push(bytes);
        let mut events = Vec::new();
        // Nothing is read while the hardware is signing.
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

    /// The hardware's signature over what `ConnectEvent::Prove` named, as
    /// the hardware returned it (ASN.1 DER).
    pub fn prove(&mut self, signature: &[u8]) -> Result<Vec<ConnectEvent>, CoreError> {
        let proof =
            UnlockProof { signature: protocol::hex_encode(signature), hardware_key: None };
        self.prove_with(&proof.to_bytes())
    }

    /// Sends `payload` where the proof goes. What a Device that does not
    /// behave sends: the test Device is how the daemon is shown one.
    #[cfg(any(test, feature = "test-device"))]
    pub fn prove_saying(&mut self, payload: &[u8]) -> Result<Vec<ConnectEvent>, CoreError> {
        self.prove_with(payload)
    }

    fn prove_with(&mut self, payload: &[u8]) -> Result<Vec<ConnectEvent>, CoreError> {
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
        self.state = State::AwaitingVerdict(channel);
        let mut events = vec![ConnectEvent::Send(sealed)];
        events.extend(self.receive(&[])?);
        Ok(events)
    }

    /// The bytes that carry `message` to the Workstation: the message
    /// and its newline, in as many frames as it takes.
    pub fn send(&mut self, message: &[u8]) -> Result<Vec<u8>, CoreError> {
        let mut line = Vec::with_capacity(message.len() + 1);
        line.extend_from_slice(Self::one_line(message)?);
        line.push(b'\n');
        self.seal(&line)
    }

    /// The bytes that carry `messages` to the Workstation together: one
    /// run of lines, cut into frames wherever a frame ends. What a
    /// Device that sends faster than it reads looks like on the wire:
    /// the test Device is how the daemon is shown one.
    #[cfg(any(test, feature = "test-device"))]
    pub fn send_together(&mut self, messages: &[Vec<u8>]) -> Result<Vec<u8>, CoreError> {
        let mut lines = Vec::new();
        for message in messages {
            lines.extend_from_slice(Self::one_line(message)?);
            lines.push(b'\n');
        }
        self.seal(&lines)
    }

    fn one_line(message: &[u8]) -> Result<&[u8], CoreError> {
        if message.contains(&b'\n') {
            return Err(CoreError::Frame("a message is one line".into()));
        }
        if message.len() >= MAX_MESSAGE_BYTES {
            return Err(CoreError::Frame(format!(
                "a message of {} bytes is longer than the Workstation reads",
                message.len()
            )));
        }
        Ok(message)
    }

    /// `line` -- bytes of the stream -- in as many frames as it takes.
    fn seal(&mut self, line: &[u8]) -> Result<Vec<u8>, CoreError> {
        if let State::Failed(e) = &self.state {
            return Err(e.clone());
        }
        let State::Connected(channel) = &mut self.state else {
            return Err(CoreError::NotReady);
        };
        let mut out = Vec::new();
        let mut failed = None;
        for piece in line.chunks(MAX_PAYLOAD) {
            match channel.seal(piece) {
                Ok(sealed) => out.extend_from_slice(&sealed),
                Err(e) => {
                    failed = Some(e);
                    break;
                }
            }
        }
        match failed {
            // A frame was sealed and not sent, so the count the
            // Workstation reads against has moved on without it.
            Some(e) => Err(self.fail(e)),
            None => Ok(out),
        }
    }

    fn step(&mut self, message: &[u8], events: &mut Vec<ConnectEvent>) -> Result<(), CoreError> {
        match std::mem::replace(&mut self.state, State::Finished) {
            State::AwaitingWorkstation(mut handshake) => {
                // <- e, ee, se
                let mut payload = vec![0u8; MAX_NOISE_MESSAGE];
                handshake.read_message(message, &mut payload).map_err(noise::handshake_error)?;
                let message = device_wire::unlock_message(handshake.get_handshake_hash());
                let transport =
                    handshake.into_transport_mode().map_err(noise::handshake_error)?;
                events.push(ConnectEvent::Prove { message });
                self.state = State::AwaitingProof(Box::new(Channel::new(transport)));
                Ok(())
            }
            State::AwaitingVerdict(mut channel) => {
                let payload = channel.open(message)?;
                match ConnectVerdict::from_bytes(&payload)
                    .map_err(|e| CoreError::Frame(e.to_string()))?
                {
                    ConnectVerdict::Connected { device_id } => {
                        events.push(ConnectEvent::Connected { device_id });
                        self.state = State::Connected(channel);
                    }
                    ConnectVerdict::Refused { reason } => {
                        events.push(ConnectEvent::Refused(reason));
                        self.state = State::Finished;
                    }
                    // Not "connected", so not connected.
                    ConnectVerdict::Unknown => {
                        events.push(ConnectEvent::Refused(ConnectRefusal::Other));
                        self.state = State::Finished;
                    }
                }
                Ok(())
            }
            State::Connected(mut channel) => {
                let payload = channel.open(message)?;
                self.state = State::Connected(channel);
                for byte in payload {
                    if byte == b'\n' {
                        events.push(ConnectEvent::Message(std::mem::take(&mut self.line)));
                    } else if self.line.len() >= MAX_MESSAGE_BYTES {
                        return Err(CoreError::Frame(format!(
                            "a message from the Workstation passed {MAX_MESSAGE_BYTES} bytes \\
                             without ending"
                        )));
                    } else {
                        self.line.push(byte);
                    }
                }
                Ok(())
            }
            // `receive` reads nothing in this state.
            State::AwaitingProof(_) => Err(CoreError::NotReady),
            State::Finished => Err(CoreError::Finished),
            State::Failed(e) => Err(e),
        }
    }
}

/// Never the handshake or the channel: both hold live cipher state.
impl std::fmt::Debug for ConnectClient {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let state = match &self.state {
            State::AwaitingWorkstation(_) => "awaiting the Workstation",
            State::AwaitingProof(_) => "awaiting the hardware's signature",
            State::AwaitingVerdict(_) => "awaiting the Workstation's verdict",
            State::Connected(_) => "connected",
            State::Finished => "finished",
            State::Failed(_) => "failed",
        };
        f.debug_struct("ConnectClient").field("state", &state).finish_non_exhaustive()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::channel::testing::{unframe, unframe_all};
    use protocol::device_wire::FRAME_BUCKET;
    use protocol::relay::RelayHello;

    /// The Workstation's half, written out with `snow` so the client is
    /// tested against the handshake the daemon runs and not against
    /// itself.
    struct Workstation {
        keys: DeviceKeys,
        channel: Option<Channel>,
        device_key: Vec<u8>,
        /// The handshake hash, as this end computed it.
        hash: Vec<u8>,
    }

    impl Workstation {
        fn new(key_seed: u8) -> Self {
            Self {
                keys: DeviceKeys::generate(Entropy::from_bytes(vec![key_seed; 32])).unwrap(),
                channel: None,
                device_key: Vec::new(),
                hash: Vec::new(),
            }
        }

        /// Reads message 1 and answers with message 2. An error is a
        /// first message that was not sealed to this Workstation's key.
        fn answer(&mut self, first: &[u8]) -> Result<Vec<u8>, snow::Error> {
            let mut handshake = noise::builder(
                noise::connect_params().unwrap(),
                Entropy::from_bytes(vec![0x5a; 32]),
            )
            .prologue(device_wire::CONNECT_PROLOGUE)
            .unwrap()
            .local_private_key(&self.keys.private)
            .unwrap()
            .build_responder()
            .unwrap();
            let mut payload = vec![0u8; MAX_NOISE_MESSAGE];
            handshake.read_message(unframe(first), &mut payload)?;
            self.device_key = handshake.get_remote_static().unwrap().to_vec();
            let mut out = vec![0u8; MAX_NOISE_MESSAGE];
            let n = handshake.write_message(&[], &mut out)?;
            self.hash = handshake.get_handshake_hash().to_vec();
            self.channel = Some(Channel::new(handshake.into_transport_mode()?));
            Ok(frame(&out[..n]))
        }

        fn channel(&mut self) -> &mut Channel {
            self.channel.as_mut().unwrap()
        }

        fn read_proof(&mut self, sealed: &[u8]) -> UnlockProof {
            assert_eq!(sealed.len() % FRAME_BUCKET, 0, "the proof is one padded frame");
            UnlockProof::from_bytes(&self.channel().open(unframe(sealed)).unwrap()).unwrap()
        }

        fn rule(&mut self, verdict: &ConnectVerdict) -> Vec<u8> {
            self.channel().seal(&verdict.to_bytes()).unwrap()
        }

        /// Everything in `sealed`, opened and put end to end.
        fn read(&mut self, sealed: &[u8]) -> Vec<u8> {
            let mut bytes = Vec::new();
            for frame in unframe_all(sealed) {
                bytes.extend_from_slice(&self.channel().open(&frame).unwrap());
            }
            bytes
        }
    }

    fn device() -> DeviceKeys {
        DeviceKeys::generate(Entropy::from_bytes(vec![0x11; 32])).unwrap()
    }

    fn fresh() -> Entropy {
        Entropy::from_bytes(vec![0x22; 32])
    }

    const SIGNATURE: &[u8] = &[0x30, 0x45, 0x02, 0x21, 0x00, 0xaa, 0xbb];

    fn connected() -> ConnectVerdict {
        ConnectVerdict::Connected { device_id: "dev-0123".into() }
    }

    /// A client that has sent its proof, and the Workstation that read
    /// it.
    fn proved() -> (ConnectClient, Workstation) {
        let mut workstation = Workstation::new(0x33);
        let (mut client, first) =
            ConnectClient::start(&workstation.keys.public, &device(), fresh()).unwrap();
        let second = workstation.answer(&first).unwrap();
        let events = client.receive(&second).unwrap();
        assert!(matches!(events.as_slice(), [ConnectEvent::Prove { .. }]), "{events:?}");
        let events = client.prove(SIGNATURE).unwrap();
        let [ConnectEvent::Send(proof)] = events.as_slice() else { panic!("{events:?}") };
        workstation.read_proof(proof);
        (client, workstation)
    }

    /// A client the Workstation has said `connected` to.
    fn connection() -> (ConnectClient, Workstation) {
        let (mut client, mut workstation) = proved();
        let verdict = workstation.rule(&connected());
        assert_eq!(
            client.receive(&verdict).unwrap(),
            vec![ConnectEvent::Connected { device_id: "dev-0123".into() }]
        );
        (client, workstation)
    }

    /// The first message carries the Device's own key, sealed to the
    /// Workstation's: the Workstation learns who is calling from the
    /// handshake, and from nothing the Device merely says.
    #[test]
    fn the_workstation_learns_the_devices_key_from_the_first_message() {
        let mut workstation = Workstation::new(0x33);
        let (_, first) =
            ConnectClient::start(&workstation.keys.public, &device(), fresh()).unwrap();
        let wire = protocol::hex_encode(&first);
        assert!(!wire.contains(&protocol::hex_encode(&device().public)), "the key is sealed");

        workstation.answer(&first).unwrap();
        assert_eq!(workstation.device_key, device().public);
    }

    /// ADR 0001: what follows the handshake is the hardware's signature
    /// over its hash, and nothing else -- the key it is checked against
    /// is the one in the Workstation's trust store.
    #[test]
    fn the_proof_is_the_signature_over_this_handshake_and_names_no_key() {
        let mut workstation = Workstation::new(0x33);
        let (mut client, first) =
            ConnectClient::start(&workstation.keys.public, &device(), fresh()).unwrap();
        let second = workstation.answer(&first).unwrap();

        let events = client.receive(&second).unwrap();
        assert_eq!(
            events,
            vec![ConnectEvent::Prove { message: device_wire::unlock_message(&workstation.hash) }]
        );

        let events = client.prove(SIGNATURE).unwrap();
        let [ConnectEvent::Send(proof)] = events.as_slice() else { panic!("{events:?}") };
        assert_eq!(
            workstation.read_proof(proof),
            UnlockProof { signature: protocol::hex_encode(SIGNATURE), hardware_key: None }
        );
    }

    /// Two connections by one Device to one Workstation sign two
    /// different messages: a signature recorded from one is no use in
    /// the other.
    #[test]
    fn every_connection_signs_a_message_of_its_own() {
        let message = |device_entropy: u8| {
            let mut workstation = Workstation::new(0x33);
            let (mut client, first) = ConnectClient::start(
                &workstation.keys.public,
                &device(),
                Entropy::from_bytes(vec![device_entropy; 32]),
            )
            .unwrap();
            let second = workstation.answer(&first).unwrap();
            match client.receive(&second).unwrap().as_slice() {
                [ConnectEvent::Prove { message }] => message.clone(),
                other => panic!("{other:?}"),
            }
        };
        assert_ne!(message(0x22), message(0x23));
    }

    #[test]
    fn the_client_is_connected_once_the_workstation_says_so() {
        let (mut client, mut workstation) = proved();
        assert!(!client.is_connected(), "a proof sent is not a proof verified");
        assert_eq!(client.send(b"{}"), Err(CoreError::NotReady));

        let verdict = workstation.rule(&connected());
        assert_eq!(
            client.receive(&verdict).unwrap(),
            vec![ConnectEvent::Connected { device_id: "dev-0123".into() }]
        );
        assert!(client.is_connected());
    }

    #[test]
    fn a_refusal_ends_the_connection_and_says_why() {
        for reason in [
            ConnectRefusal::NotPaired,
            ConnectRefusal::Revoked,
            ConnectRefusal::Stale,
            ConnectRefusal::PairAgain,
            ConnectRefusal::Unlock,
            ConnectRefusal::Busy,
        ] {
            let (mut client, mut workstation) = proved();
            let verdict = workstation.rule(&ConnectVerdict::Refused { reason });
            assert_eq!(client.receive(&verdict).unwrap(), vec![ConnectEvent::Refused(reason)]);
            assert!(!client.is_connected());
            assert_eq!(client.send(b"{}"), Err(CoreError::NotReady));
            // Nothing follows a refusal.
            let more = workstation.rule(&connected());
            assert_eq!(client.receive(&more), Err(CoreError::Finished));
        }
    }

    /// A verdict from a Workstation newer than this core is not the one
    /// word that opens the connection.
    #[test]
    fn a_verdict_the_core_has_never_heard_of_does_not_connect() {
        let (mut client, mut workstation) = proved();
        let verdict = workstation.channel().seal(br#"{"type":"queued","position":3}"#).unwrap();
        assert_eq!(
            client.receive(&verdict).unwrap(),
            vec![ConnectEvent::Refused(ConnectRefusal::Other)]
        );
        assert!(!client.is_connected());
    }

    /// "Revoke all" rotates the Workstation's key. A Device that pinned
    /// the old one seals its first message to a key nobody holds.
    #[test]
    fn a_workstation_with_another_key_cannot_read_the_first_message() {
        let pinned = Workstation::new(0x33);
        let mut rotated = Workstation::new(0x77);
        let (_, first) = ConnectClient::start(&pinned.keys.public, &device(), fresh()).unwrap();
        assert!(rotated.answer(&first).is_err(), "a rotated key read a message sealed to the old one");
    }

    /// And the other way about: an answer from anyone but the holder of
    /// the pinned key fails the handshake.
    #[test]
    fn an_answer_from_another_workstation_fails_the_handshake() {
        let pinned = Workstation::new(0x33);
        let (mut client, first) =
            ConnectClient::start(&pinned.keys.public, &device(), fresh()).unwrap();

        // An impostor cannot read message 1, so the best it can do is
        // answer a handshake of its own making.
        let mut impostor = Workstation::new(0x77);
        let (_, to_impostor) =
            ConnectClient::start(&impostor.keys.public, &device(), fresh()).unwrap();
        assert_ne!(first, to_impostor);
        let second = impostor.answer(&to_impostor).unwrap();

        assert!(matches!(client.receive(&second), Err(CoreError::Handshake(_))));
        assert_eq!(client.prove(SIGNATURE).err(), client.receive(&[]).err(), "and it stays failed");
    }

    #[test]
    fn a_message_two_altered_on_the_way_fails_the_handshake() {
        let mut workstation = Workstation::new(0x33);
        let (mut client, first) =
            ConnectClient::start(&workstation.keys.public, &device(), fresh()).unwrap();
        let second = workstation.answer(&first).unwrap();
        for at in [2usize, 20, second.len() - 1] {
            let (mut client, _) =
                ConnectClient::start(&workstation.keys.public, &device(), fresh()).unwrap();
            let mut altered = second.clone();
            altered[at] ^= 0x01;
            assert!(
                matches!(client.receive(&altered), Err(CoreError::Handshake(_))),
                "message 2 altered at byte {at} completed the handshake"
            );
        }
        // Untouched, it completes.
        assert!(client.receive(&second).is_ok());
    }

    #[test]
    fn a_verdict_altered_on_the_way_is_an_error_not_a_verdict() {
        let (mut client, mut workstation) = proved();
        let mut verdict = workstation.rule(&connected());
        let last = verdict.len() - 1;
        verdict[last] ^= 0x01;
        assert!(matches!(client.receive(&verdict), Err(CoreError::Frame(_))));
        assert!(!client.is_connected());
    }

    #[test]
    fn a_message_arrives_whole_and_without_its_newline() {
        let (mut client, mut workstation) = connection();
        let sealed = workstation.channel().seal(b"{\"type\":\"Ok\"}\n").unwrap();
        assert_eq!(
            client.receive(&sealed).unwrap(),
            vec![ConnectEvent::Message(br#"{"type":"Ok"}"#.to_vec())]
        );
    }

    /// The stream is bytes. A frame may end in the middle of a message
    /// and may hold more than one.
    #[test]
    fn a_message_cut_across_frames_arrives_whole() {
        let (mut client, mut workstation) = connection();
        let first = workstation.channel().seal(b"{\"a\":").unwrap();
        let second = workstation.channel().seal(b"1}\n{\"b\":2}\n{\"c\"").unwrap();
        let third = workstation.channel().seal(b":3}\n").unwrap();

        assert_eq!(client.receive(&first).unwrap(), vec![]);
        assert_eq!(
            client.receive(&second).unwrap(),
            vec![
                ConnectEvent::Message(br#"{"a":1}"#.to_vec()),
                ConnectEvent::Message(br#"{"b":2}"#.to_vec()),
            ]
        );
        assert_eq!(
            client.receive(&third).unwrap(),
            vec![ConnectEvent::Message(br#"{"c":3}"#.to_vec())]
        );
    }

    #[test]
    fn a_message_is_sent_as_one_line_in_padded_frames() {
        let (mut client, mut workstation) = connection();
        let sealed = client.send(br#"{"type":"RemoveThisDevice"}"#).unwrap();
        assert_eq!(sealed.len(), FRAME_BUCKET);
        assert_eq!(workstation.read(&sealed), b"{\"type\":\"RemoveThisDevice\"}\n");

        // One too long for a frame takes as many as it needs, and is
        // still one line at the other end.
        let long = vec![b'x'; MAX_PAYLOAD + 10];
        let sealed = client.send(&long).unwrap();
        assert_eq!(sealed.len() % FRAME_BUCKET, 0);
        assert_eq!(unframe_all(&sealed).len(), 2);
        let mut line = long.clone();
        line.push(b'\n');
        assert_eq!(workstation.read(&sealed), line);
    }

    #[test]
    fn a_message_that_is_not_one_line_is_not_sent() {
        let (mut client, mut workstation) = connection();
        assert!(matches!(client.send(b"{}\n{}"), Err(CoreError::Frame(_))));
        assert!(matches!(
            client.send(&vec![b'x'; MAX_MESSAGE_BYTES]),
            Err(CoreError::Frame(_))
        ));
        // Neither was sealed, so the connection is as it was.
        let sealed = client.send(b"{}").unwrap();
        assert_eq!(workstation.read(&sealed), b"{}\n");
    }

    /// The Relay copies bytes and may alter them. What does not open is
    /// an error, never a message -- and the connection is over.
    #[test]
    fn a_frame_altered_on_the_way_is_an_error_not_a_message() {
        let (mut client, mut workstation) = connection();
        let mut sealed = workstation.channel().seal(b"{\"type\":\"Ok\"}\n").unwrap();
        sealed[40] ^= 0x01;
        assert!(matches!(client.receive(&sealed), Err(CoreError::Frame(_))));

        let honest = workstation.channel().seal(b"{\"type\":\"Ok\"}\n").unwrap();
        assert!(matches!(client.receive(&honest), Err(CoreError::Frame(_))), "it stays over");
        assert!(matches!(client.send(b"{}"), Err(CoreError::Frame(_))));
    }

    /// Or repeat them.
    #[test]
    fn a_frame_delivered_twice_is_an_error_not_a_second_message() {
        let (mut client, mut workstation) = connection();
        let sealed = workstation.channel().seal(b"{\"type\":\"Ok\"}\n").unwrap();
        assert_eq!(client.receive(&sealed).unwrap().len(), 1);
        assert!(matches!(client.receive(&sealed), Err(CoreError::Frame(_))));
    }

    #[test]
    fn a_message_that_never_ends_is_given_up_on() {
        let (mut client, mut workstation) = connection();
        let piece = vec![b'x'; MAX_PAYLOAD];
        let mut ended = None;
        for _ in 0..=(MAX_MESSAGE_BYTES / MAX_PAYLOAD + 1) {
            let sealed = workstation.channel().seal(&piece).unwrap();
            if let Err(e) = client.receive(&sealed) {
                ended = Some(e);
                break;
            }
        }
        assert!(matches!(ended, Some(CoreError::Frame(_))), "{ended:?}");
    }

    #[test]
    fn nothing_is_read_while_the_hardware_is_signing() {
        let mut workstation = Workstation::new(0x33);
        let (mut client, first) =
            ConnectClient::start(&workstation.keys.public, &device(), fresh()).unwrap();
        assert_eq!(client.prove(SIGNATURE), Err(CoreError::NotReady), "nothing to sign yet");

        let mut bytes = workstation.answer(&first).unwrap();
        // A verdict that arrived with message 2, before any proof.
        bytes.extend_from_slice(&workstation.rule(&connected()));
        let events = client.receive(&bytes).unwrap();
        assert!(matches!(events.as_slice(), [ConnectEvent::Prove { .. }]), "{events:?}");
        assert!(!client.is_connected());

        let events = client.prove(SIGNATURE).unwrap();
        assert!(
            matches!(
                events.as_slice(),
                [ConnectEvent::Send(_), ConnectEvent::Connected { .. }]
            ),
            "{events:?}"
        );
        assert_eq!(client.prove(SIGNATURE), Err(CoreError::NotReady), "a second proof");
    }

    /// While the hardware is signing -- which on a phone can be while
    /// a prompt is on screen -- nothing is read, and what arrives is
    /// kept. How much is kept has a ceiling: the Relay is what is
    /// sending it.
    #[test]
    fn what_arrives_while_the_hardware_is_signing_is_bounded() {
        let mut workstation = Workstation::new(0x33);
        let (mut client, first) =
            ConnectClient::start(&workstation.keys.public, &device(), fresh()).unwrap();
        let second = workstation.answer(&first).unwrap();
        client.receive(&second).unwrap();

        // A verdict and a little more is kept.
        let verdict = workstation.rule(&connected());
        assert_eq!(client.receive(&verdict).unwrap(), vec![]);

        // A megabyte is not.
        let mut ended = None;
        for _ in 0..16 {
            if let Err(e) = client.receive(&vec![0u8; 64 * 1024]) {
                ended = Some(e);
                break;
            }
        }
        assert!(matches!(&ended, Some(CoreError::Frame(why)) if why.contains("more arrived")), "{ended:?}");
        assert_eq!(client.prove(SIGNATURE).err(), ended, "and the connection is over");
    }

    /// Many messages at once, as one run of bytes cut into frames
    /// wherever a frame ends. What the daemon is shown by a Device that
    /// sends faster than it reads.
    #[test]
    fn messages_sent_together_arrive_as_the_lines_they_were() {
        let (mut client, mut workstation) = connection();
        let messages: Vec<Vec<u8>> =
            (0..5000).map(|n| format!("{{\"n\":{n}}}").into_bytes()).collect();
        let sealed = client.send_together(&messages).unwrap();
        assert!(unframe_all(&sealed).len() < 5, "packed, not one frame apiece");

        let read = workstation.read(&sealed);
        let lines: Vec<&[u8]> = read.split(|b| *b == b'\n').collect();
        assert_eq!(lines.len(), 5001, "5000 lines and what follows the last newline");
        assert_eq!(lines[0], br#"{"n":0}"#);
        assert_eq!(lines[4999], br#"{"n":4999}"#);
        assert!(lines[5000].is_empty());
    }

    #[test]
    fn entropy_that_runs_out_is_an_error_not_a_weak_key() {
        let workstation = Workstation::new(0x33);
        for short in [0usize, 1, 31] {
            let started = ConnectClient::start(
                &workstation.keys.public,
                &device(),
                Entropy::from_bytes(vec![0x22; short]),
            );
            assert_eq!(started.err(), Some(CoreError::Entropy), "{short} bytes");
        }
    }

    #[test]
    fn a_workstation_key_of_the_wrong_length_is_refused() {
        assert!(matches!(
            ConnectClient::start(&[0x33; 31], &device(), fresh()),
            Err(CoreError::Offer(_))
        ));
    }

    fn offer() -> PairingQr {
        PairingQr {
            daemon_public_key: protocol::hex_encode(&Workstation::new(0x33).keys.public),
            secret: "44".repeat(32),
            rendezvous: vec![
                "wss://relay.example/gavin".into(),
                // Not a Relay this build may dial: left out, not fatal.
                "192.168.1.20:7000".into(),
                "ws://127.0.0.1:9000".into(),
            ],
            protocol_version: protocol::PROTOCOL_VERSION,
            relay_admission: Some("let-me-in".into()),
            direct: Vec::new(),
            direct_pin: None,
        }
    }

    fn paired() -> PairingVerdict {
        PairingVerdict::Paired {
            device_id: "dev-0123".into(),
            notification_key: "5c".repeat(NOTIFICATION_KEY_BYTES),
        }
    }

    #[test]
    fn a_pairing_leaves_a_workstation_to_connect_to() {
        let workstation = PairedWorkstation::from_pairing(&offer(), &paired()).unwrap().unwrap();
        assert_eq!(workstation.workstation_key, Workstation::new(0x33).keys.public);
        assert_eq!(workstation.device_id, "dev-0123");
        assert_eq!(workstation.notification_key, vec![0x5c; 32]);

        let dials = workstation.relay_dials();
        let urls: Vec<&str> = dials.iter().map(|d| d.url.as_str()).collect();
        assert_eq!(urls, vec!["wss://relay.example/gavin", "ws://127.0.0.1:9000"]);
        for dial in &dials {
            assert_eq!(
                dial.hello,
                RelayHello::device(
                    "let-me-in",
                    &relay::rendezvous_id(&workstation.workstation_key),
                    relay::PURPOSE_CONNECT
                )
            );
        }
    }

    /// A Workstation that offered its direct listener (ADR 0009) is
    /// dialled there first, with the pin and with no admission token --
    /// the token is the Relay's -- and through its Relays after.
    #[test]
    fn a_workstation_with_a_direct_listener_is_dialled_there_first() {
        let mut offer = offer();
        offer.direct = vec!["wss://100.79.93.51:8445".into(), "wss://192.168.1.20:8445".into()];
        offer.direct_pin = Some("ab".repeat(32));
        let workstation = PairedWorkstation::from_pairing(&offer, &paired()).unwrap().unwrap();
        assert_eq!(workstation.direct, offer.direct);

        let dials = workstation.relay_dials();
        let urls: Vec<&str> = dials.iter().map(|d| d.url.as_str()).collect();
        assert_eq!(
            urls,
            vec![
                "wss://100.79.93.51:8445",
                "wss://192.168.1.20:8445",
                "wss://relay.example/gavin",
                "ws://127.0.0.1:9000"
            ]
        );
        let rendezvous = relay::rendezvous_id(&workstation.workstation_key);
        for direct in &dials[..2] {
            assert_eq!(direct.pin.as_deref(), Some("ab".repeat(32).as_str()));
            assert_eq!(direct.hello, RelayHello::device("", &rendezvous, relay::PURPOSE_CONNECT));
        }
        for relay in &dials[2..] {
            assert_eq!(relay.pin, None);
            assert_eq!(relay.hello.admission().unwrap().1, "let-me-in");
        }
    }

    /// A direct address is trusted by its pin and nothing else, so one
    /// with no pin, or a plain one a pin cannot be checked on, is not
    /// dialled at all.
    #[test]
    fn a_direct_address_with_nothing_to_trust_it_by_is_left_out() {
        let key = Workstation::new(0x33).keys.public.clone();
        let direct = vec!["wss://10.0.0.4:8445".to_string(), "ws://10.0.0.5:8445".to_string()];
        let relays = vec!["wss://relay.example".to_string()];
        let urls = |pin: Option<&str>| -> Vec<String> {
            connect_dials(&key, &direct, pin, &relays, None).into_iter().map(|d| d.url).collect()
        };
        assert_eq!(urls(None), vec!["wss://relay.example"]);
        assert_eq!(urls(Some("not a pin")), vec!["wss://relay.example"]);
        assert_eq!(urls(Some(&"AB".repeat(32))), vec!["wss://10.0.0.4:8445", "wss://relay.example"]);
    }

    #[test]
    fn a_pairing_the_desk_did_not_confirm_leaves_nothing() {
        for verdict in [PairingVerdict::Rejected, PairingVerdict::Expired, PairingVerdict::Unknown] {
            assert_eq!(PairedWorkstation::from_pairing(&offer(), &verdict).unwrap(), None);
        }
    }

    #[test]
    fn a_notification_key_that_is_not_one_is_refused() {
        for key in ["".to_string(), "5c".repeat(31), "zz".repeat(32)] {
            let verdict =
                PairingVerdict::Paired { device_id: "dev-0123".into(), notification_key: key };
            assert!(matches!(
                PairedWorkstation::from_pairing(&offer(), &verdict),
                Err(CoreError::Frame(_))
            ));
        }
    }

    #[test]
    fn a_paired_workstation_does_not_print_its_notification_key() {
        let workstation = PairedWorkstation::from_pairing(&offer(), &paired()).unwrap().unwrap();
        let shown = format!("{workstation:?}");
        assert!(shown.contains("dev-0123"), "{shown}");
        assert!(!shown.contains(&"5c".repeat(8)), "{shown}");
    }

    #[test]
    fn a_client_does_not_print_its_channel() {
        let (client, _) = connection();
        assert!(format!("{client:?}").contains("connected"));
    }
}
