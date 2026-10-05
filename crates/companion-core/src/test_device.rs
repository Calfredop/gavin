//! The test Device: this core, built natively, with a transport.
//!
//! What seam 1 drives (`docs/superpowers/specs/2026-09-27-companion-design.md`,
//! "Testing Decisions"): a Device that pairs with a real daemon through a
//! real Relay, and then connects to it. It is the core's own
//! `PairingClient` and `ConnectClient` and nothing else beside them that
//! the shell will not also run -- what it adds is the three things the
//! shell's host supplies and a test has to: a socket, randomness read from
//! the operating system, and a key to sign with.
//!
//! **The key is software.** A phone keeps its P-256 key in hardware that
//! signs only while the phone is unlocked and its owner has been present
//! (ADR 0001). No test has such hardware, so a `SoftwareKey` stands in
//! for it. What it stands in for is the signature, which the daemon
//! verifies exactly as it would a phone's -- not the hardware's promise
//! about when it signs, which nothing here can make.
//!
//! **It can misbehave.** A test has to show the daemon the Devices it
//! refuses as well as the one it serves, so this one can be told to prove
//! itself badly (`Proving`) and to reach its Workstation through a Relay
//! that does more than copy (`Meddling`).

use crate::connect::{ConnectClient, ConnectEvent, PairedWorkstation};
use crate::pairing::{relay_dials, PairingClient, PairingEvent, RelayDial};
use crate::{CoreError, DeviceKeys, Entropy, CONNECT_ENTROPY, KEY_ENTROPY, PAIRING_ENTROPY};
use gavin_relay::client::{self, DialError, DialOptions, RelayStream};
use protocol::device_wire::{ConnectRefusal, PairingVerdict};
use protocol::{PairingQr, Request, Response};
use ring::signature::{EcdsaKeyPair, KeyPair, ECDSA_P256_SHA256_ASN1_SIGNING};
use std::collections::VecDeque;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

#[derive(Debug)]
pub enum TestDeviceError {
    /// The QR's string is not a pairing QR.
    Qr(String),
    /// Nothing names a Relay this Device may dial.
    NoRelay,
    /// The Relay was not reached, or refused.
    Dial(DialError),
    /// The core stopped.
    Core(CoreError),
    /// The Workstation refused the connection, and said why.
    Refused(ConnectRefusal),
    /// The desk's verdict was not that the Device is paired.
    NotPaired(PairingVerdict),
    /// The stream ended with the exchange unfinished: the Workstation
    /// let go without a word, which is what a handshake it could not
    /// read looks like from here.
    Closed,
    /// Nothing arrived in time.
    TimedOut,
    /// The stand-in for the hardware could not sign.
    Sign(String),
    /// What the Workstation sent was not a reply.
    Reply(String),
    Io(std::io::Error),
}

impl std::fmt::Display for TestDeviceError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TestDeviceError::Qr(why) => write!(f, "the pairing code did not scan: {why}"),
            TestDeviceError::NoRelay => write!(f, "there is no Relay to dial"),
            TestDeviceError::Dial(e) => write!(f, "{e}"),
            TestDeviceError::Core(e) => write!(f, "{e}"),
            TestDeviceError::Refused(reason) => write!(f, "{reason}"),
            TestDeviceError::NotPaired(verdict) => {
                write!(f, "the desk did not pair this Device: {verdict:?}")
            }
            TestDeviceError::Closed => {
                write!(f, "the Workstation ended the exchange without an answer")
            }
            TestDeviceError::TimedOut => write!(f, "the Workstation did not answer in time"),
            TestDeviceError::Sign(why) => write!(f, "the signature could not be made: {why}"),
            TestDeviceError::Reply(why) => write!(f, "the Workstation's reply was not one: {why}"),
            TestDeviceError::Io(e) => write!(f, "{e}"),
        }
    }
}

impl std::error::Error for TestDeviceError {}

impl From<CoreError> for TestDeviceError {
    fn from(e: CoreError) -> Self {
        TestDeviceError::Core(e)
    }
}

impl From<DialError> for TestDeviceError {
    fn from(e: DialError) -> Self {
        TestDeviceError::Dial(e)
    }
}

impl From<std::io::Error> for TestDeviceError {
    fn from(e: std::io::Error) -> Self {
        if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) {
            TestDeviceError::TimedOut
        } else {
            TestDeviceError::Io(e)
        }
    }
}

/// Fresh bytes from the operating system, which is where a native build
/// takes them; the shell takes its own from the webview.
fn entropy(bytes: usize) -> Result<Entropy, TestDeviceError> {
    let hex = protocol::random_hex(bytes)?;
    let bytes = protocol::hex_decode(&hex).map_err(|e| TestDeviceError::Qr(e.to_string()))?;
    Ok(Entropy::from_bytes(bytes))
}

/// A P-256 key held in memory, standing in for the one a phone holds in
/// its hardware.
#[derive(Clone)]
pub struct SoftwareKey {
    pkcs8: Vec<u8>,
    public: Vec<u8>,
}

impl SoftwareKey {
    pub fn generate() -> Result<Self, TestDeviceError> {
        let rng = ring::rand::SystemRandom::new();
        let pkcs8 = EcdsaKeyPair::generate_pkcs8(&ECDSA_P256_SHA256_ASN1_SIGNING, &rng)
            .map_err(|e| TestDeviceError::Sign(e.to_string()))?;
        let pair = EcdsaKeyPair::from_pkcs8(&ECDSA_P256_SHA256_ASN1_SIGNING, pkcs8.as_ref(), &rng)
            .map_err(|e| TestDeviceError::Sign(e.to_string()))?;
        Ok(Self { pkcs8: pkcs8.as_ref().to_vec(), public: pair.public_key().as_ref().to_vec() })
    }

    /// The public half, as the uncompressed SEC1 point the wire carries.
    pub fn public(&self) -> &[u8] {
        &self.public
    }

    /// ECDSA over SHA-256 of `message`, ASN.1 DER: what a phone's
    /// hardware returns.
    pub fn sign(&self, message: &[u8]) -> Result<Vec<u8>, TestDeviceError> {
        let rng = ring::rand::SystemRandom::new();
        let pair = EcdsaKeyPair::from_pkcs8(&ECDSA_P256_SHA256_ASN1_SIGNING, &self.pkcs8, &rng)
            .map_err(|e| TestDeviceError::Sign(e.to_string()))?;
        let signature =
            pair.sign(&rng, message).map_err(|e| TestDeviceError::Sign(e.to_string()))?;
        Ok(signature.as_ref().to_vec())
    }
}

/// The public half only.
impl std::fmt::Debug for SoftwareKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SoftwareKey")
            .field("public", &protocol::hex_encode(&self.public))
            .finish_non_exhaustive()
    }
}

/// How a Device proves itself after a handshake.
#[derive(Debug, Clone)]
pub enum Proving {
    /// With the key it registered when it paired.
    Honestly,
    /// With another key. What a copy of this Device's Noise key can do
    /// from another phone: it has a hardware key, and not this one.
    With(SoftwareKey),
    /// With these bytes where the signature goes.
    Saying(Vec<u8>),
    /// With this where the whole proof goes: a Device that skips the
    /// proof and sends its first request in its place.
    Instead(Vec<u8>),
}

/// What becomes of something on its way through a Relay: `nth` counts
/// from zero, and what is returned is what arrives.
type Outbound = dyn Fn(usize, Vec<u8>) -> Vec<Vec<u8>> + Send + Sync;
type Inbound = dyn Fn(usize, Vec<u8>) -> Vec<u8> + Send + Sync;

/// A Relay that does more than copy.
///
/// The Relay carries bytes it cannot read, and the design's promise is
/// that one which drops, repeats or alters them causes a failed
/// connection and never a wrong answer. This is where a test plays that
/// Relay: at the Device's end of the pipe, where what the Device wrote
/// can be changed before the Workstation reads it, and the other way
/// about.
#[derive(Clone)]
pub struct Meddling {
    outbound: Arc<Outbound>,
    inbound: Arc<Inbound>,
}

impl Meddling {
    /// A Relay that copies, until told otherwise.
    pub fn none() -> Self {
        Self { outbound: Arc::new(|_, bytes| vec![bytes]), inbound: Arc::new(|_, bytes| bytes) }
    }

    /// What arrives at the Workstation in place of the `nth` thing the
    /// Device sends. The handshake's first message is the 0th, the proof
    /// the 1st, and each message after that the next.
    pub fn outbound(
        mut self,
        meddle: impl Fn(usize, Vec<u8>) -> Vec<Vec<u8>> + Send + Sync + 'static,
    ) -> Self {
        self.outbound = Arc::new(meddle);
        self
    }

    /// What arrives at the Device in place of the `nth` thing it reads.
    pub fn inbound(
        mut self,
        meddle: impl Fn(usize, Vec<u8>) -> Vec<u8> + Send + Sync + 'static,
    ) -> Self {
        self.inbound = Arc::new(meddle);
        self
    }
}

/// The Device's end of the pipe, with whatever the Relay does to it.
struct Wire {
    stream: RelayStream,
    meddling: Meddling,
    sent: AtomicUsize,
    read: AtomicUsize,
}

impl Wire {
    fn dial(dial: &RelayDial, options: &DialOptions, meddling: &Meddling) -> Result<Self, TestDeviceError> {
        let stream = client::dial(&dial.url, &dial.hello, options)?.into_stream();
        Ok(Self {
            stream,
            meddling: meddling.clone(),
            sent: AtomicUsize::new(0),
            read: AtomicUsize::new(0),
        })
    }

    fn send(&mut self, bytes: Vec<u8>) -> Result<(), TestDeviceError> {
        let nth = self.sent.fetch_add(1, Ordering::SeqCst);
        for arriving in (self.meddling.outbound)(nth, bytes) {
            self.stream.write_all(&arriving)?;
            self.stream.flush()?;
        }
        Ok(())
    }

    /// What arrived within `within`. `Closed` is the end of the stream.
    fn read(&mut self, within: Duration) -> Result<Vec<u8>, TestDeviceError> {
        if within.is_zero() {
            return Err(TestDeviceError::TimedOut);
        }
        self.stream.set_read_timeout(Some(within))?;
        // Room for a whole frame, so that what is read is what one
        // message from the Workstation held and a test can name it.
        let mut buf = vec![0u8; 128 * 1024];
        let n = self.stream.read(&mut buf)?;
        if n == 0 {
            return Err(TestDeviceError::Closed);
        }
        buf.truncate(n);
        let nth = self.read.fetch_add(1, Ordering::SeqCst);
        Ok((self.meddling.inbound)(nth, buf))
    }

    fn close(self) {
        self.stream.close();
    }
}

/// One install of the Companion, as a test sees it.
///
/// A clone is the same install: the same keys, asked to behave another
/// way.
#[derive(Clone)]
pub struct TestDevice {
    pub name: String,
    pub keys: DeviceKeys,
    /// What stands in for the key in the phone's hardware.
    pub hardware: SoftwareKey,
    options: DialOptions,
    proving: Proving,
    meddling: Meddling,
}

impl TestDevice {
    /// A Device with keys of its own, as a fresh install has.
    pub fn new(name: &str) -> Result<Self, TestDeviceError> {
        Ok(Self {
            name: name.to_string(),
            keys: DeviceKeys::generate(entropy(KEY_ENTROPY)?)?,
            hardware: SoftwareKey::generate()?,
            options: DialOptions::default(),
            proving: Proving::Honestly,
            meddling: Meddling::none(),
        })
    }

    /// Trusts `certificate` (DER) in addition to what the machine
    /// trusts: the certificate of a Relay a test started a moment ago.
    pub fn trusting(mut self, certificate: Vec<u8>) -> Self {
        self.options.extra_roots.push(certificate);
        self
    }

    /// From now on, proves itself this way.
    pub fn proving(mut self, how: Proving) -> Self {
        self.proving = how;
        self
    }

    /// From now on, reaches its Workstation through a Relay that does
    /// this to what it carries.
    pub fn through(mut self, meddling: Meddling) -> Self {
        self.meddling = meddling;
        self
    }

    /// This Device's Noise key, on another phone: the same install's
    /// name and static key, and a hardware key of that phone's own.
    pub fn copied_to_another_phone(&self) -> Result<Self, TestDeviceError> {
        Ok(Self {
            name: self.name.clone(),
            keys: self.keys.clone(),
            hardware: SoftwareKey::generate()?,
            options: self.options.clone(),
            proving: Proving::Honestly,
            meddling: Meddling::none(),
        })
    }

    /// What goes where the proof goes: the signature, or whatever this
    /// Device was told to say in its place.
    fn proof(&self, message: &[u8]) -> Result<Proof, TestDeviceError> {
        Ok(match &self.proving {
            Proving::Honestly => Proof::Signature(self.hardware.sign(message)?),
            Proving::With(key) => Proof::Signature(key.sign(message)?),
            Proving::Saying(bytes) => Proof::Signature(bytes.clone()),
            Proving::Instead(payload) => Proof::Payload(payload.clone()),
        })
    }

    /// Scans `qr` and pairs. See `pair_with`.
    pub fn pair(&self, qr: &str) -> Result<Pairing, TestDeviceError> {
        let offer = PairingQr::parse(qr).map_err(|e| TestDeviceError::Qr(e.to_string()))?;
        self.pair_with(&offer)
    }

    /// Dials the Relay `offer` names, runs the handshake, proves itself,
    /// and returns once the six digits are on this Device's screen.
    ///
    /// The Device is not paired when this returns: the desk has not
    /// ruled. `Pairing::verdict` is the wait for that.
    pub fn pair_with(&self, offer: &PairingQr) -> Result<Pairing, TestDeviceError> {
        let dial = relay_dials(offer)?.into_iter().next().ok_or(TestDeviceError::NoRelay)?;
        let mut wire = Wire::dial(&dial, &self.options, &self.meddling)?;

        let (mut client, first) = PairingClient::start(
            offer,
            &self.keys,
            self.hardware.public(),
            &self.name,
            entropy(PAIRING_ENTROPY)?,
        )?;
        wire.send(first)?;

        let mut events = VecDeque::new();
        loop {
            while let Some(event) = events.pop_front() {
                match event {
                    PairingEvent::Send(bytes) => wire.send(bytes)?,
                    PairingEvent::Prove { message } => {
                        events.extend(match self.proof(&message)? {
                            Proof::Signature(signature) => client.prove(&signature)?,
                            Proof::Payload(payload) => client.prove_saying(&payload)?,
                        });
                    }
                    PairingEvent::CompareCode { sas } => {
                        return Ok(Pairing { code: sas, offer: offer.clone(), client, wire });
                    }
                    // Not before the code: the desk cannot have ruled on
                    // a handshake it has not seen finish.
                    PairingEvent::Finished(_) => return Err(TestDeviceError::Closed),
                }
            }
            let arrived = wire.read(self.options.hello_timeout)?;
            events.extend(client.receive(&arrived)?);
        }
    }

    /// Connects to a Workstation this Device has paired with, and
    /// returns once the Workstation has said it is connected.
    pub fn connect(&self, workstation: &PairedWorkstation) -> Result<Connection, TestDeviceError> {
        let dial =
            workstation.relay_dials().into_iter().next().ok_or(TestDeviceError::NoRelay)?;
        self.connect_at(workstation, &dial)
    }

    /// `connect`, meeting the Workstation where `dial` says and not
    /// where the pinned key would: what a Device would do if it were
    /// told where a Workstation had moved to and not what its key had
    /// become.
    pub fn connect_at(
        &self,
        workstation: &PairedWorkstation,
        dial: &RelayDial,
    ) -> Result<Connection, TestDeviceError> {
        let mut wire = Wire::dial(dial, &self.options, &self.meddling)?;
        let (mut client, first) = ConnectClient::start(
            &workstation.workstation_key,
            &self.keys,
            entropy(CONNECT_ENTROPY)?,
        )?;
        wire.send(first)?;

        let mut events = VecDeque::new();
        loop {
            while let Some(event) = events.pop_front() {
                match event {
                    // A Workstation that has already refused has already
                    // hung up, and what it said is waiting to be read: a
                    // write that fails is not the news, and the read
                    // below is what says the stream has ended.
                    ConnectEvent::Send(bytes) => {
                        let _ = wire.send(bytes);
                    }
                    ConnectEvent::Prove { message } => {
                        events.extend(match self.proof(&message)? {
                            Proof::Signature(signature) => client.prove(&signature)?,
                            Proof::Payload(payload) => client.prove_saying(&payload)?,
                        });
                    }
                    ConnectEvent::Connected { device_id } => {
                        return Ok(Connection {
                            device_id,
                            client,
                            wire,
                            arrived: events
                                .into_iter()
                                .filter_map(|event| match event {
                                    ConnectEvent::Message(message) => Some(message),
                                    _ => None,
                                })
                                .collect(),
                        });
                    }
                    ConnectEvent::Refused(reason) => {
                        wire.close();
                        return Err(TestDeviceError::Refused(reason));
                    }
                    // Not before the verdict: nothing is answered until
                    // the proof has been verified.
                    ConnectEvent::Message(_) => return Err(TestDeviceError::Closed),
                }
            }
            let arrived = wire.read(self.options.hello_timeout)?;
            events.extend(client.receive(&arrived)?);
        }
    }
}

enum Proof {
    Signature(Vec<u8>),
    Payload(Vec<u8>),
}

/// A pairing that has reached its six digits and is waiting on the desk.
pub struct Pairing {
    /// What this Device's screen shows.
    pub code: String,
    offer: PairingQr,
    client: PairingClient,
    wire: Wire,
}

impl Pairing {
    /// Waits for the desk to rule.
    ///
    /// `Closed` is a Workstation that ended the stream without ruling --
    /// which, straight after the handshake, is one that refused the
    /// handshake or the proof: the Device cannot tell a wrong secret
    /// from its own side, and learns it from the silence.
    pub fn verdict(mut self, within: Duration) -> Result<PairingVerdict, TestDeviceError> {
        let verdict = self.await_verdict(within)?;
        self.wire.close();
        Ok(verdict)
    }

    /// Waits for the desk to confirm, and returns what the Device keeps
    /// about the Workstation it is now paired with.
    pub fn paired(mut self, within: Duration) -> Result<PairedWorkstation, TestDeviceError> {
        let verdict = self.await_verdict(within)?;
        let kept = PairedWorkstation::from_pairing(&self.offer, &verdict)?;
        self.wire.close();
        kept.ok_or(TestDeviceError::NotPaired(verdict))
    }

    fn await_verdict(&mut self, within: Duration) -> Result<PairingVerdict, TestDeviceError> {
        let deadline = Instant::now() + within;
        loop {
            let arrived = self.wire.read(deadline.saturating_duration_since(Instant::now()))?;
            for event in self.client.receive(&arrived)? {
                if let PairingEvent::Finished(verdict) = event {
                    return Ok(verdict);
                }
            }
        }
    }

    /// Walks away: the Device closed the Companion, or lost its network.
    pub fn abandon(self) {
        self.wire.close();
    }
}

/// A connection the Workstation has given the Remote role.
pub struct Connection {
    /// What the Workstation calls this Device.
    pub device_id: String,
    client: ConnectClient,
    wire: Wire,
    /// Messages that have arrived and not been asked for yet.
    arrived: VecDeque<Vec<u8>>,
}

impl Connection {
    /// Sends `request` and waits for what answers it.
    pub fn request(&mut self, request: &Request, within: Duration) -> Result<Response, TestDeviceError> {
        self.send(request)?;
        self.next(within)
    }

    pub fn send(&mut self, request: &Request) -> Result<(), TestDeviceError> {
        let message =
            serde_json::to_vec(request).map_err(|e| TestDeviceError::Reply(e.to_string()))?;
        let sealed = self.client.send(&message)?;
        self.wire.send(sealed)
    }

    /// Sends every one of `requests` at once, reading nothing
    /// meanwhile: a Device that sends faster than it reads.
    pub fn send_together(&mut self, requests: &[Request]) -> Result<(), TestDeviceError> {
        let messages = requests
            .iter()
            .map(|request| {
                serde_json::to_vec(request).map_err(|e| TestDeviceError::Reply(e.to_string()))
            })
            .collect::<Result<Vec<_>, _>>()?;
        let sealed = self.client.send_together(&messages)?;
        self.wire.send(sealed)
    }

    /// The Workstation's next message.
    pub fn next(&mut self, within: Duration) -> Result<Response, TestDeviceError> {
        let deadline = Instant::now() + within;
        loop {
            if let Some(message) = self.arrived.pop_front() {
                return serde_json::from_slice(&message)
                    .map_err(|e| TestDeviceError::Reply(e.to_string()));
            }
            let arrived = self.wire.read(deadline.saturating_duration_since(Instant::now()))?;
            for event in self.client.receive(&arrived)? {
                if let ConnectEvent::Message(message) = event {
                    self.arrived.push_back(message);
                }
            }
        }
    }

    /// Waits for the Workstation to end the connection, and says
    /// whether it did, within `within`, without saying anything more
    /// first.
    pub fn is_dropped(&mut self, within: Duration) -> bool {
        matches!(self.next(within), Err(TestDeviceError::Closed))
    }

    /// Hangs up.
    pub fn close(self) {
        self.wire.close();
    }
}
