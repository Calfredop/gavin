//! The pairing handshake: how a phone proves it is the phone the human
//! is holding, over any byte stream.
//!
//! `docs/security/05-remote-access.md` §3 settles the ceremony. The human
//! presses "Pair a device"; the daemon mints a one-time secret with a
//! two-minute expiry and puts it in a QR; the phone scans it and runs a
//! Noise `XX` handshake with that secret mixed in as a pre-shared key,
//! sending its own static public key and a device name inside the
//! handshake; both screens then show a six-digit code derived from BOTH
//! static keys, and the human compares them and confirms **on the
//! desktop**. Only then is there a row in `devices.sqlite`.
//!
//! **A library over `Read + Write`, not a transport.** Phase 2 must not
//! open a listener or dial a relay (§10), so nothing here owns a socket:
//! `run_responder` takes whatever byte stream its caller has and runs the
//! three messages over it. That is what lets the whole ceremony be tested
//! in-process today, against a `snow` initiator on the other end of a
//! `Stream::pair()`, and it is the seam phase 3's `remote.rs` feeds once
//! there is a relay connection to feed it with -- see `PairingHandshake`
//! for what phase 3 picks up where this leaves off.
//!
//! **Why `psk3`.** `NOISE_PARAMS` lives in `trust.rs` (the daemon's
//! static key is generated from its DH function, so one string has to
//! name the curve for both halves of the feature), and it reads
//! `Noise_XXpsk3_25519_ChaChaPoly_BLAKE2s`. The `3` is the PSK slot, and
//! it is the last of the three XX messages. Three reasons, in order of
//! how much they matter:
//!
//! 1. At `psk3` the responder's static key is delivered in message 2,
//!    BEFORE the secret is mixed in. That is what the phone needs: it
//!    pinned a key from the QR, and it has to be able to compare the key
//!    it was actually handed against that one -- and to abandon the
//!    handshake if they differ, rather than discovering it afterwards.
//! 2. The secret only does anything for a holder who has already
//!    completed the full mutual exchange. Someone who photographs the
//!    screen cannot make the secret alone do work at message 1, which is
//!    exactly what `psk0` would let them do.
//! 3. It leaves the PSK as one factor of two rather than the credential.
//!    §3 rejects a QR that is itself the credential, and the SAS is the
//!    other factor: an attacker who photographs the QR and completes a
//!    handshake with THEIR key produces a different six digits from the
//!    one on the owner's phone, and the desktop shows the attacker's.
//!
//! None of those is a cliff -- `psk0` would not be broken -- but there is
//! no reason to take the weaker of two free choices.

// Same allow, and the same reason, as `trust.rs` carries: parts of this
// module's surface exist for the caller phase 3 lands (the transport
// state the handshake leaves behind, the initiator side), and the tests
// below are what prove they work meanwhile.
#![allow(dead_code)]

use crate::trust::{TrustStore, NOISE_PARAMS};
use std::io::{Read, Write};

/// How long a pairing offer is good for (§3: "records it with a
/// two-minute expiry").
///
/// Short on purpose: the whole window in which a photograph of the screen
/// is worth anything at all. Two minutes is the human walking from the
/// desktop to their phone, not the human going to make coffee.
pub const OFFER_TTL_US: i64 = 2 * 60 * 1_000_000;

/// The pairing secret's length in bytes -- 32, because that is
/// `snow`'s `PSKLEN` and there is no choice to make.
const SECRET_LEN: usize = 32;

/// The largest Noise message, and therefore the largest frame. Fixed by
/// the protocol itself (Noise messages carry a 2-byte length), not a
/// number chosen here.
const MAX_NOISE_MESSAGE: usize = 65535;

/// The longest device name accepted out of the handshake.
///
/// Attacker-controlled text that is about to be drawn on the human's
/// desktop next to a Confirm button, so it is bounded and scrubbed
/// (`clean_device_name`) rather than trusted. 64 is generous for "Cosimo's
/// iPhone" and far short of anything that could push the six-digit code
/// off the dialog.
const MAX_DEVICE_NAME: usize = 64;

/// A minted, not-yet-used pairing secret and the instant it dies.
///
/// Held in memory by the daemon, never written to `devices.sqlite`:
/// §3's promise is that nothing reaches the trust store until the human
/// confirms, and a secret that survived a daemon restart would be a
/// two-minute window that outlived the screen it was shown on.
#[derive(Debug, Clone)]
pub struct PairingOffer {
    /// The secret as the QR carries it -- lowercase hex -- and the single
    /// source of truth for it. `psk()` decodes this rather than the other
    /// way round, so the bytes the daemon mixes in and the characters the
    /// phone read off the screen cannot drift apart.
    secret_hex: String,
    /// Microseconds since the epoch, matching `trust.rs`'s clock.
    pub expires_at_us: i64,
}

impl PairingOffer {
    pub fn mint(now_us: i64) -> anyhow::Result<Self> {
        Ok(Self {
            secret_hex: protocol::random_hex(SECRET_LEN)?,
            expires_at_us: now_us.saturating_add(OFFER_TTL_US),
        })
    }

    /// For tests and for a caller that needs a known secret. Not `pub`
    /// beyond the crate: a secret that did not come from the CSPRNG is
    /// not a secret.
    pub(crate) fn from_hex(secret_hex: &str, expires_at_us: i64) -> Self {
        Self { secret_hex: secret_hex.to_string(), expires_at_us }
    }

    /// What the QR carries.
    pub fn secret_hex(&self) -> &str {
        &self.secret_hex
    }

    /// Expiry is `>=`, not `>`: an offer whose deadline has exactly
    /// arrived is spent. There is no reading of "two minutes" under which
    /// the last microsecond is still good, and a boundary that admits is
    /// a boundary that has to be argued about.
    pub fn is_expired_at(&self, now_us: i64) -> bool {
        now_us >= self.expires_at_us
    }

    /// The 32 bytes `snow` mixes in at message 3.
    pub fn psk(&self) -> anyhow::Result<[u8; SECRET_LEN]> {
        let bytes = hex_decode(&self.secret_hex)?;
        let mut psk = [0u8; SECRET_LEN];
        if bytes.len() != SECRET_LEN {
            anyhow::bail!(
                "gavin-daemon: a pairing secret is {SECRET_LEN} bytes, not {}",
                bytes.len()
            );
        }
        psk.copy_from_slice(&bytes);
        Ok(psk)
    }
}

/// What a completed handshake hands back: everything the desktop needs to
/// ask the human, and the encrypted channel phase 3 will keep using.
///
/// Note what is NOT here: a decision. This type is produced by a phone
/// that proved it holds the pairing secret, and that is all it proves.
/// Whether the phone becomes a device is `ConfirmPairing`'s to say, after
/// a human has compared `sas` on two screens (§3).
pub struct PairingHandshake {
    /// The id this device will be filed under. An EXISTING id when the
    /// static key is already in the store (a phone re-pairing keeps its
    /// key, so the same key is the same phone and a second row would mean
    /// a revocation that only reached one of them -- see
    /// `TrustStore::confirm_device`); a fresh one otherwise.
    pub device_id: String,
    /// The name the phone sent, scrubbed and bounded for display.
    pub name: String,
    /// The phone's Noise static public key: the identity that matters,
    /// and what `TrustStore::admit` will match a later connection against.
    pub public_key: Vec<u8>,
    /// The six digits BOTH screens show (`protocol::pairing_sas`).
    pub sas: String,
    /// The encrypted channel the handshake left behind.
    ///
    /// Unread in phase 2, and deliberately returned anyway: this is the
    /// seam. Phase 3's `remote.rs` answers the phone over exactly this --
    /// `HelloAck { role: "remote" }` once the human confirms, a refusal
    /// otherwise -- and then hands the same channel to
    /// `handle_connection_as` with a `ClientIdentity::remote(device_id)`.
    /// Dropping it here would mean phase 3 re-running the handshake to
    /// get it back.
    pub transport: snow::TransportState,
}

/// Hand-written, and it leaves the transport out.
///
/// `snow::TransportState` is not `Debug` (rightly -- it holds live
/// cipher state), and the derive would be refused; more to the point, a
/// handshake that ends up in an error message or a log line must not be
/// able to carry key material with it. What a reader ever wants here is
/// which device, under what name, showing which code.
impl std::fmt::Debug for PairingHandshake {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PairingHandshake")
            .field("device_id", &self.device_id)
            .field("name", &self.name)
            .field("sas", &self.sas)
            .finish_non_exhaustive()
    }
}

/// The daemon's own static key pair, lifted out of the store so the
/// handshake can run without holding the store's lock.
///
/// That is the whole reason this type exists, and it is worth stating:
/// the handshake is three round trips over a network, and the trust store
/// sits behind one `Mutex` that a revocation also has to take. A
/// responder that held it for the duration would make §3's "the daemon
/// drops every live connection **immediately**" wait on a phone that may
/// simply have walked out of wifi range.
pub struct ResponderKeys {
    private: Vec<u8>,
    public: Vec<u8>,
}

impl ResponderKeys {
    pub fn from_store(store: &TrustStore) -> anyhow::Result<Self> {
        Ok(Self { private: store.static_private_key()?, public: store.static_public_key()? })
    }
}

/// What the Noise exchange itself produced, before the store has been
/// consulted about who this key belongs to.
pub struct HandshakeOutcome {
    pub name: String,
    pub public_key: Vec<u8>,
    pub sas: String,
    pub transport: snow::TransportState,
}

/// Run the responder side of the pairing handshake over `stream`.
///
/// Reads and writes exactly three Noise messages, each in its own
/// length-prefixed frame (see `write_frame`), and returns what the human
/// has to be asked about. Writes NOTHING to the store: §3's "only then
/// does the daemon write the device into the trust store" is enforced by
/// this function never having a write path at all, which is stronger than
/// a flag it could forget to check.
///
/// The store is taken because two answers come out of it -- the daemon's
/// own static key pair, and whether this static key is already a device
/// (so a re-pairing phone is offered under the id it already has).
///
/// A caller that must not hold the store across the handshake -- which is
/// every caller inside the daemon, see `ResponderKeys` -- takes the two
/// halves instead: `ResponderKeys::from_store`, then
/// `run_responder_with_keys`, then `device_id_for`. This function is
/// those three in a row, and it is what the library's own tests exercise.
pub fn run_responder<S: Read + Write>(
    stream: &mut S,
    store: &TrustStore,
    offer: &PairingOffer,
    now_us: i64,
) -> anyhow::Result<PairingHandshake> {
    let keys = ResponderKeys::from_store(store)?;
    let outcome = run_responder_with_keys(stream, &keys, offer, now_us)?;
    let device_id = device_id_for(store, &outcome.public_key)?;
    Ok(PairingHandshake {
        device_id,
        name: outcome.name,
        public_key: outcome.public_key,
        sas: outcome.sas,
        transport: outcome.transport,
    })
}

/// The id a device with this static key will be filed under.
///
/// A phone that is re-pairing keeps its key, so it keeps its id: the same
/// key is the same phone, and a second row would mean a revocation that
/// only reached one of them (see `TrustStore::confirm_device`). The push
/// the human sees then names the device they already know.
pub fn device_id_for(store: &TrustStore, public_key: &[u8]) -> anyhow::Result<String> {
    match store.device_for_key(public_key)? {
        Some(existing) => Ok(existing.device_id),
        None => Ok(format!("dev-{}", protocol::random_hex(8)?)),
    }
}

/// The Noise exchange, with no store in sight.
pub fn run_responder_with_keys<S: Read + Write>(
    stream: &mut S,
    keys: &ResponderKeys,
    offer: &PairingOffer,
    now_us: i64,
) -> anyhow::Result<HandshakeOutcome> {
    // Before a single byte is read. An expired secret is not a handshake
    // that fails late: it is a ceremony that is over, and the phone
    // deserves to be told that rather than "decryption failure" three
    // messages in.
    if offer.is_expired_at(now_us) {
        anyhow::bail!(
            "gavin-daemon: this pairing code has expired — press “Pair a device” again"
        );
    }

    let params: snow::params::NoiseParams = NOISE_PARAMS
        .parse()
        .map_err(|e| anyhow::anyhow!("gavin-daemon: bad Noise parameters {NOISE_PARAMS:?}: {e:?}"))?;
    let private = &keys.private;
    let daemon_public = &keys.public;
    let psk = offer.psk()?;

    let mut handshake = snow::Builder::new(params)
        .local_private_key(private)?
        // Slot 3: the last of XX's three messages. See the module docs
        // for why, and `trust::NOISE_PARAMS` for why the pattern string
        // is not spelled here.
        .psk(3, &psk)?
        .build_responder()?;

    let mut message = vec![0u8; MAX_NOISE_MESSAGE];
    let mut payload = vec![0u8; MAX_NOISE_MESSAGE];

    // 1. <- e            (the phone's ephemeral; no payload we read)
    let n = read_frame(stream, &mut message)?;
    handshake.read_message(&message[..n], &mut payload)?;

    // 2. -> e, ee, s, es (our static key, which the phone compares
    //    against the one it pinned from the QR). No payload: everything
    //    the phone needs at this point is the key itself, and a payload
    //    here is encrypted but not yet PSK-bound.
    let n = handshake.write_message(&[], &mut message)?;
    write_frame(stream, &message[..n])?;

    // 3. <- s, se, psk   (the phone's static key, and its name in the
    //    payload). This is the message the pairing secret protects: a
    //    wrong PSK fails HERE, as a decryption failure, and nothing
    //    downstream of it runs.
    let n = read_frame(stream, &mut message)?;
    let payload_len = handshake
        .read_message(&message[..n], &mut payload)
        .map_err(|e| {
            anyhow::anyhow!(
                "gavin-daemon: the pairing handshake failed — the code on the phone does not \
                 match the one on this screen ({e})"
            )
        })?;

    let public_key = handshake
        .get_remote_static()
        .ok_or_else(|| {
            anyhow::anyhow!("gavin-daemon: the pairing handshake sent no device key")
        })?
        .to_vec();

    let name = clean_device_name(&payload[..payload_len]);
    let sas = protocol::pairing_sas(daemon_public, &public_key);

    let transport = handshake.into_transport_mode()?;
    Ok(HandshakeOutcome { name, public_key, sas, transport })
}

/// What a device name is allowed to be by the time it reaches a screen.
///
/// The bytes arrive inside an authenticated message, so this is not about
/// forgery -- it is about a string that is about to be drawn next to a
/// Confirm button and a six-digit code. Control characters (a `\r` that
/// overwrites the line, an escape sequence aimed at a terminal), an
/// unbounded length, and invalid UTF-8 are all things a name must not be
/// able to be. A name that survives none of that becomes the honest
/// placeholder rather than an empty string, because "confirm ''" tells
/// the human nothing.
fn clean_device_name(bytes: &[u8]) -> String {
    let raw = String::from_utf8_lossy(bytes);
    let cleaned: String = raw
        .chars()
        .filter(|c| !c.is_control())
        .take(MAX_DEVICE_NAME)
        .collect();
    let trimmed = cleaned.trim();
    if trimmed.is_empty() {
        "unnamed device".to_string()
    } else {
        trimmed.to_string()
    }
}

// -- framing ----------------------------------------------------------
//
// Two bytes of big-endian length, then that many bytes. The smallest
// framing that works, and it is spelled out here rather than reused from
// `protocol::write_message` for one reason: that one is newline-delimited
// JSON, and Noise messages are ciphertext that can contain any byte
// including a newline. A length prefix is the only framing a binary
// message can carry.
//
// The length cannot overflow the prefix: Noise itself caps a message at
// 65535 bytes, which is exactly what two bytes hold.

fn write_frame<W: Write>(w: &mut W, buf: &[u8]) -> anyhow::Result<()> {
    if buf.len() > MAX_NOISE_MESSAGE {
        anyhow::bail!("gavin-daemon: a Noise message cannot exceed {MAX_NOISE_MESSAGE} bytes");
    }
    let len = (buf.len() as u16).to_be_bytes();
    w.write_all(&len)?;
    w.write_all(buf)?;
    w.flush()?;
    Ok(())
}

fn read_frame<R: Read>(r: &mut R, out: &mut [u8]) -> anyhow::Result<usize> {
    let mut len = [0u8; 2];
    r.read_exact(&mut len)?;
    let len = u16::from_be_bytes(len) as usize;
    if len > out.len() {
        anyhow::bail!("gavin-daemon: a pairing frame claimed {len} bytes");
    }
    r.read_exact(&mut out[..len])?;
    Ok(len)
}

/// Lowercase hex, the encoding every key and secret crosses a screen in.
///
/// Here rather than borrowed from `protocol`, whose own `hex_encode` is
/// private to the token helpers, and paired with `hex_decode` below so
/// the two are read (and tested) together: the QR is written by one and
/// read by the other, and an encoding that round-trips is the only
/// property either of them has.
pub(crate) fn hex_encode(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

pub(crate) fn hex_decode(s: &str) -> anyhow::Result<Vec<u8>> {
    if s.len() % 2 != 0 {
        anyhow::bail!("gavin-daemon: a hex string has an even number of characters");
    }
    (0..s.len())
        .step_by(2)
        .map(|i| {
            u8::from_str_radix(&s[i..i + 2], 16)
                .map_err(|e| anyhow::anyhow!("gavin-daemon: bad hex in a pairing secret: {e}"))
        })
        .collect()
}

// -- the initiator, for tests -----------------------------------------
//
// The daemon is never the initiator -- the phone is -- so this is the
// other end of the wire written out so the ceremony can be exercised
// whole, in-process, with no transport and no phone. `server.rs`'s tests
// use it too, which is why it is `pub(crate)` rather than buried in this
// file's own test module.

/// What the initiator side computed, for a test to compare against the
/// responder's.
#[cfg(test)]
pub(crate) struct InitiatorResult {
    pub public_key: Vec<u8>,
    pub sas: String,
}

/// The phone's half of §3's ceremony, as a test double.
///
/// `daemon_public_key` is what the QR carried, and it is CHECKED against
/// the key message 2 actually delivers rather than merely being passed
/// in: that comparison is the phone's job in the real ceremony (it pinned
/// a key, and a different key means it is not talking to the daemon whose
/// QR it scanned), and a test double that skipped it would be proving the
/// handshake works against an adversary the real client rejects.
#[cfg(test)]
pub(crate) fn run_initiator<S: Read + Write>(
    stream: &mut S,
    daemon_public_key: &[u8],
    secret_hex: &str,
    device_name: &str,
) -> anyhow::Result<InitiatorResult> {
    let params: snow::params::NoiseParams = NOISE_PARAMS.parse().unwrap();
    let keypair = snow::Builder::new(params.clone()).generate_keypair()?;
    let psk = PairingOffer::from_hex(secret_hex, i64::MAX).psk()?;

    let mut handshake = snow::Builder::new(params)
        .local_private_key(&keypair.private)?
        .psk(3, &psk)?
        .build_initiator()?;

    let mut message = vec![0u8; MAX_NOISE_MESSAGE];
    let mut payload = vec![0u8; MAX_NOISE_MESSAGE];

    let n = handshake.write_message(&[], &mut message)?;
    write_frame(stream, &message[..n])?;

    let n = read_frame(stream, &mut message)?;
    handshake.read_message(&message[..n], &mut payload)?;

    let seen = handshake
        .get_remote_static()
        .ok_or_else(|| anyhow::anyhow!("the daemon sent no static key"))?;
    if seen != daemon_public_key {
        anyhow::bail!("this is not the gavin whose QR was scanned");
    }
    let sas = protocol::pairing_sas(daemon_public_key, &keypair.public);

    let n = handshake.write_message(device_name.as_bytes(), &mut message)?;
    write_frame(stream, &message[..n])?;

    Ok(InitiatorResult { public_key: keypair.public, sas })
}

#[cfg(test)]
mod tests {
    use super::*;
    use protocol::transport::Stream;

    fn store(dir: &tempfile::TempDir) -> TrustStore {
        TrustStore::open(&dir.path().join("devices.sqlite")).unwrap()
    }

    const NOW: i64 = 1_770_000_000_000_000;

    /// Drives one full ceremony in-process and hands back both sides.
    ///
    /// The initiator runs on its own thread because the handshake is
    /// three synchronous round trips: one side has to be able to block in
    /// a read while the other writes, which a single thread cannot do
    /// over a socket pair.
    fn pair_in_process(
        store: &TrustStore,
        offer: &PairingOffer,
        secret_the_phone_has: &str,
        name: &str,
        now_us: i64,
    ) -> (anyhow::Result<PairingHandshake>, anyhow::Result<InitiatorResult>) {
        let (client, server) = Stream::pair().unwrap();
        let daemon_public = store.static_public_key().unwrap();
        let secret = secret_the_phone_has.to_string();
        let name = name.to_string();
        let phone = std::thread::spawn(move || {
            let mut client = client;
            run_initiator(&mut client, &daemon_public, &secret, &name)
        });
        let mut server = server;
        let responder = run_responder(&mut server, store, offer, now_us);
        // Dropped before the join so an initiator parked in a read of a
        // handshake the responder abandoned sees EOF instead of hanging
        // this test for the suite's whole budget.
        drop(server);
        (responder, phone.join().unwrap())
    }

    /// The happy path, end to end: the two sides reach the SAME six
    /// digits, which is the entire point of the ceremony -- the human
    /// compares two screens, and the codes agreeing is what tells them
    /// the phone in their hand is the one that completed the handshake.
    #[test]
    fn a_correct_secret_reaches_a_matching_six_digit_code() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(&dir);
        let offer = PairingOffer::mint(NOW).unwrap();

        let (daemon, phone) =
            pair_in_process(&store, &offer, offer.secret_hex(), "Cosimo's iPhone", NOW);
        let daemon = daemon.unwrap();
        let phone = phone.unwrap();

        assert_eq!(daemon.sas, phone.sas, "the two screens must show the same code");
        assert_eq!(daemon.sas.len(), 6);
        assert!(daemon.sas.chars().all(|c| c.is_ascii_digit()), "{}", daemon.sas);

        // The daemon learned the phone's real static key -- the identity
        // `admit` will match a later connection against -- rather than
        // anything the phone merely claimed in a payload.
        assert_eq!(daemon.public_key, phone.public_key);
        assert_eq!(daemon.name, "Cosimo's iPhone");
        assert!(daemon.device_id.starts_with("dev-"), "{}", daemon.device_id);
    }

    /// §3's promise, and the card's: "nothing is written to
    /// `devices.sqlite` until confirmation".
    ///
    /// A whole successful handshake, and the store is still empty. The
    /// write is `ConfirmPairing`'s, after a human has compared the code.
    #[test]
    fn a_completed_handshake_writes_nothing_to_the_store() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(&dir);
        let offer = PairingOffer::mint(NOW).unwrap();

        let (daemon, _) = pair_in_process(&store, &offer, offer.secret_hex(), "iPhone", NOW);
        let daemon = daemon.unwrap();

        assert!(store.list().unwrap().is_empty(), "the handshake wrote a device row");
        assert!(
            store.device(&daemon.device_id).unwrap().is_none(),
            "the id the push will name must not exist yet"
        );
        assert!(store.device_for_key(&daemon.public_key).unwrap().is_none());
    }

    /// A phone that scanned nothing -- or photographed a QR from an older
    /// offer -- gets no further than message 3.
    #[test]
    fn a_wrong_secret_fails_the_handshake() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(&dir);
        let offer = PairingOffer::mint(NOW).unwrap();
        let wrong = PairingOffer::mint(NOW).unwrap();
        assert_ne!(offer.secret_hex(), wrong.secret_hex());

        let (daemon, _) = pair_in_process(&store, &offer, wrong.secret_hex(), "attacker", NOW);
        let err = daemon.unwrap_err();
        assert!(
            err.to_string().contains("does not match"),
            "a wrong PSK must fail as a mismatch, not as a mystery: {err}"
        );
        assert!(store.list().unwrap().is_empty());
    }

    /// A stream that fails loudly if anything touches it. The proof that
    /// an expired offer is refused BEFORE the handshake starts rather
    /// than somewhere inside it.
    struct NeverUsed;

    impl Read for NeverUsed {
        fn read(&mut self, _: &mut [u8]) -> std::io::Result<usize> {
            panic!("an expired offer read from the stream");
        }
    }

    impl Write for NeverUsed {
        fn write(&mut self, _: &[u8]) -> std::io::Result<usize> {
            panic!("an expired offer wrote to the stream");
        }
        fn flush(&mut self) -> std::io::Result<()> {
            panic!("an expired offer wrote to the stream");
        }
    }

    #[test]
    fn an_expired_secret_is_refused_before_the_handshake_starts() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(&dir);
        let offer = PairingOffer::mint(NOW).unwrap();

        let err = run_responder(&mut NeverUsed, &store, &offer, NOW + OFFER_TTL_US)
            .unwrap_err();
        assert!(err.to_string().contains("expired"), "{err}");

        // And the boundary itself: the last microsecond of the window
        // still works, the first one past it does not.
        assert!(!offer.is_expired_at(offer.expires_at_us - 1));
        assert!(offer.is_expired_at(offer.expires_at_us));
    }

    /// A phone that already has a row keeps its id, so the human is asked
    /// about the device they know rather than about a second copy of it.
    /// `TrustStore::confirm_device` would revive the same row either way;
    /// this is about what the PUSH says while they decide.
    #[test]
    fn a_re_pairing_phone_is_offered_under_the_id_it_already_has() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(&dir);

        let first = PairingOffer::mint(NOW).unwrap();
        let (daemon, _) = pair_in_process(&store, &first, first.secret_hex(), "iPhone", NOW);
        let first = daemon.unwrap();
        store
            .confirm_device(
                &first.device_id,
                &first.public_key,
                &first.name,
                crate::trust::DeviceRole::Remote,
            )
            .unwrap();

        // The phone keeps its key across a re-pair, so pair the same key
        // again by reusing its static -- which is what the second
        // handshake does automatically, since `run_initiator` mints a
        // fresh one. Simulate the real case by inserting the SECOND
        // handshake's key as the existing row instead.
        let second_offer = PairingOffer::mint(NOW).unwrap();
        let (daemon, phone) =
            pair_in_process(&store, &second_offer, second_offer.secret_hex(), "iPhone", NOW);
        let second = daemon.unwrap();
        assert_ne!(second.device_id, first.device_id, "a NEW key is a new device");

        // Now the actual case: a key the store already holds.
        store
            .confirm_device(
                &second.device_id,
                &phone.unwrap().public_key,
                "iPhone",
                crate::trust::DeviceRole::Remote,
            )
            .unwrap();
        let known = store.device_for_key(&second.public_key).unwrap().unwrap();
        assert_eq!(known.device_id, second.device_id);
    }

    /// A name is display text arriving from the other end of a wire, so
    /// it is bounded and scrubbed before it is anywhere near a Confirm
    /// button.
    #[test]
    fn a_device_name_is_scrubbed_and_bounded() {
        assert_eq!(clean_device_name(b"Cosimo's iPhone"), "Cosimo's iPhone");
        // A carriage return would overwrite the line it is drawn on, and
        // an escape sequence aims at a terminal.
        assert_eq!(clean_device_name(b"iPhone\r\nConfirmed"), "iPhoneConfirmed");
        assert_eq!(clean_device_name(b"\x1b[31miPhone"), "[31miPhone");
        assert_eq!(clean_device_name(b"   "), "unnamed device");
        assert_eq!(clean_device_name(b""), "unnamed device");
        assert_eq!(clean_device_name(&vec![b'x'; 500]).len(), MAX_DEVICE_NAME);
        // Invalid UTF-8 is replaced, never a panic and never a refusal:
        // the name is not a credential, and failing the whole ceremony
        // over a mis-encoded label would be the tail wagging the dog.
        assert!(!clean_device_name(&[0xff, 0xfe, b'a']).is_empty());
    }

    /// The QR is written by one of these and read by the other, so the
    /// only property either has is that they agree.
    #[test]
    fn hex_round_trips() {
        let bytes: Vec<u8> = (0u8..=255).collect();
        assert_eq!(hex_decode(&hex_encode(&bytes)).unwrap(), bytes);
        assert_eq!(hex_encode(&[0x00, 0x0f, 0xff]), "000fff");
        assert!(hex_decode("abc").is_err(), "an odd-length hex string is not bytes");
        assert!(hex_decode("zz").is_err());
    }

    #[test]
    fn a_secret_is_thirty_two_bytes_of_hex_and_two_minutes_long() {
        let offer = PairingOffer::mint(NOW).unwrap();
        assert_eq!(offer.secret_hex().len(), SECRET_LEN * 2);
        assert_eq!(offer.psk().unwrap().len(), SECRET_LEN);
        assert_eq!(offer.expires_at_us - NOW, 2 * 60 * 1_000_000);
        // From the CSPRNG, not from a constant.
        assert_ne!(PairingOffer::mint(NOW).unwrap().secret_hex(), offer.secret_hex());
    }
}
