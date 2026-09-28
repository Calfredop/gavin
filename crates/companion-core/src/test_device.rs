//! The test Device: this core, built natively, with a transport.
//!
//! What seam 1 drives (`docs/superpowers/specs/2026-09-27-companion-design.md`,
//! "Testing Decisions"): a Device that pairs with a real daemon through a
//! real Relay. It is the core's own `PairingClient` and nothing else
//! beside it that the shell will not also run -- what it adds is the two
//! things the shell's host supplies and a test has to: a socket, and
//! randomness read from the operating system.
//!
//! It holds no hardware key. Pairing does not use one yet; when the
//! connection handshake lands, a software P-256 key stands in here for
//! the one a phone keeps in its hardware.

use crate::pairing::{relay_dials, PairingClient, PairingEvent};
use crate::{CoreError, DeviceKeys, Entropy, KEY_ENTROPY, PAIRING_ENTROPY};
use gavin_relay::client::{self, DialError, DialOptions, RelayStream};
use protocol::device_wire::PairingVerdict;
use protocol::PairingQr;
use std::io::{Read, Write};
use std::time::{Duration, Instant};

#[derive(Debug)]
pub enum TestDeviceError {
    /// The QR's string is not a pairing QR.
    Qr(String),
    /// The QR names no Relay this Device may dial.
    NoRelay,
    /// The Relay was not reached, or refused.
    Dial(DialError),
    /// The core stopped.
    Core(CoreError),
    /// The stream ended with the pairing unfinished: the Workstation let
    /// go without a verdict, which is what a handshake it refused looks
    /// like from here.
    Closed,
    /// Nothing arrived in time.
    TimedOut,
    Io(std::io::Error),
}

impl std::fmt::Display for TestDeviceError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TestDeviceError::Qr(why) => write!(f, "the pairing code did not scan: {why}"),
            TestDeviceError::NoRelay => write!(f, "the pairing code names no Relay to dial"),
            TestDeviceError::Dial(e) => write!(f, "{e}"),
            TestDeviceError::Core(e) => write!(f, "{e}"),
            TestDeviceError::Closed => {
                write!(f, "the Workstation ended the pairing without an answer")
            }
            TestDeviceError::TimedOut => write!(f, "the Workstation did not answer in time"),
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

/// One install of the Companion, as a test sees it.
pub struct TestDevice {
    pub name: String,
    pub keys: DeviceKeys,
    options: DialOptions,
}

impl TestDevice {
    /// A Device with a key pair of its own, as a fresh install has.
    pub fn new(name: &str) -> Result<Self, TestDeviceError> {
        Ok(Self {
            name: name.to_string(),
            keys: DeviceKeys::generate(entropy(KEY_ENTROPY)?)?,
            options: DialOptions::default(),
        })
    }

    /// Trusts `certificate` (DER) in addition to what the machine
    /// trusts: the certificate of a Relay a test started a moment ago.
    pub fn trusting(mut self, certificate: Vec<u8>) -> Self {
        self.options.extra_roots.push(certificate);
        self
    }

    /// Scans `qr` and pairs. See `pair_with`.
    pub fn pair(&self, qr: &str) -> Result<Pairing, TestDeviceError> {
        let offer = PairingQr::parse(qr).map_err(|e| TestDeviceError::Qr(e.to_string()))?;
        self.pair_with(&offer)
    }

    /// Dials the Relay `offer` names, runs the handshake, and returns
    /// once the six digits are on this Device's screen.
    ///
    /// The Device is not paired when this returns: the desk has not
    /// ruled. `Pairing::verdict` is the wait for that.
    pub fn pair_with(&self, offer: &PairingQr) -> Result<Pairing, TestDeviceError> {
        let dial = relay_dials(offer)?.into_iter().next().ok_or(TestDeviceError::NoRelay)?;
        let mut stream = client::dial(&dial.url, &dial.hello, &self.options)?.into_stream();
        stream.set_read_timeout(Some(self.options.hello_timeout))?;

        let (mut client, first) =
            PairingClient::start(offer, &self.keys, &self.name, entropy(PAIRING_ENTROPY)?)?;
        stream.write_all(&first)?;
        stream.flush()?;

        let mut buf = [0u8; 4096];
        loop {
            let n = stream.read(&mut buf)?;
            if n == 0 {
                return Err(TestDeviceError::Closed);
            }
            let mut code = None;
            for event in client.receive(&buf[..n])? {
                match event {
                    PairingEvent::Send(bytes) => {
                        stream.write_all(&bytes)?;
                        stream.flush()?;
                    }
                    PairingEvent::CompareCode { sas } => code = Some(sas),
                    // Not before the code: the desk cannot have ruled on
                    // a handshake it has not seen finish.
                    PairingEvent::Finished(_) => return Err(TestDeviceError::Closed),
                }
            }
            if let Some(code) = code {
                return Ok(Pairing { code, client, stream });
            }
        }
    }
}

/// A pairing that has reached its six digits and is waiting on the desk.
pub struct Pairing {
    /// What this Device's screen shows.
    pub code: String,
    client: PairingClient,
    stream: RelayStream,
}

impl Pairing {
    /// Waits for the desk to rule.
    ///
    /// `Closed` is a Workstation that ended the stream without ruling --
    /// which, straight after the handshake, is one that refused the
    /// handshake: the Device cannot tell a wrong secret from its own side,
    /// and learns it from the silence.
    pub fn verdict(mut self, within: Duration) -> Result<PairingVerdict, TestDeviceError> {
        let deadline = Instant::now() + within;
        let mut buf = [0u8; 4096];
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return Err(TestDeviceError::TimedOut);
            }
            self.stream.set_read_timeout(Some(left))?;
            let n = self.stream.read(&mut buf)?;
            if n == 0 {
                return Err(TestDeviceError::Closed);
            }
            for event in self.client.receive(&buf[..n])? {
                if let PairingEvent::Finished(verdict) = event {
                    self.stream.close();
                    return Ok(verdict);
                }
            }
        }
    }

    /// Walks away: the Device closed the Companion, or lost its network.
    pub fn abandon(self) {
        self.stream.close();
    }
}
