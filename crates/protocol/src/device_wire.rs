//! What a Workstation and a Device say to each other inside the Noise
//! channel, and how each message is padded before it is sealed.
//!
//! Here, with no operating-system part to it, for the reason
//! `pairing_sas` is: the daemon and the Companion core are two programs
//! that must agree on these bytes, and the core is built for
//! `wasm32-unknown-unknown`.
//!
//! **The frame.** One message is one Noise transport message, written to
//! the stream the way the handshake's own messages are -- two bytes of
//! big-endian length, then the ciphertext. What is sealed is padded first:
//!
//! ```text
//! frame     = u16 BE length || ciphertext
//! plaintext = u16 BE payload length || payload || zero padding
//! ```
//!
//! The padding is chosen so the FRAME, as the Relay sees it, is a whole
//! number of 256-byte buckets. The Relay and anyone watching it learn
//! which bucket a message fell in and nothing finer. It blunts what frame
//! sizes give away; it does not erase it (`05-remote-access.md` §8).
//!
//! **Two handshakes, one proof.** A Device runs the pairing handshake
//! once and the connection handshake every time it connects, and the
//! first thing it sends on the channel either one leaves behind is the
//! same message: its hardware key's signature over that handshake's hash
//! (`UnlockProof`, ADR 0001). At pairing the proof also carries the key,
//! which is how the key is registered. At connection it is the Unlock's
//! enforcement: the daemon answers no request until it verifies.
//!
//! **After `connected`, a stream.** Both directions carry the daemon's
//! own protocol unchanged -- newline-delimited `Request` and `Response`
//! JSON -- as bytes, cut into frames wherever the sender likes. A line
//! may span frames and a frame may hold several lines.

use serde::{Deserialize, Serialize};

/// The bucket every frame is padded up to a multiple of.
pub const FRAME_BUCKET: usize = 256;

/// The two bytes of length in front of every frame, and in front of every
/// payload inside one.
const LENGTH_PREFIX: usize = 2;

/// The AEAD tag Noise appends to every transport message.
const TAG: usize = 16;

/// The largest Noise message, fixed by the Noise specification.
const MAX_NOISE_MESSAGE: usize = 65535;

/// The largest frame that is both a whole number of buckets and a Noise
/// message the length prefix can describe.
const MAX_FRAME: usize = (LENGTH_PREFIX + MAX_NOISE_MESSAGE) / FRAME_BUCKET * FRAME_BUCKET;

/// The largest payload one frame carries.
pub const MAX_PAYLOAD: usize = MAX_FRAME - LENGTH_PREFIX - TAG - LENGTH_PREFIX;

/// The plaintext to seal for `payload`: its length, the payload, and
/// enough zeroes that the frame on the wire is a whole number of buckets.
pub fn pad(payload: &[u8]) -> anyhow::Result<Vec<u8>> {
    if payload.len() > MAX_PAYLOAD {
        anyhow::bail!(
            "a message of {} bytes does not fit one frame (the limit is {MAX_PAYLOAD})",
            payload.len()
        );
    }
    let overhead = LENGTH_PREFIX + TAG + LENGTH_PREFIX;
    let frame = (overhead + payload.len()).div_ceil(FRAME_BUCKET) * FRAME_BUCKET;
    let mut plaintext = vec![0u8; frame - LENGTH_PREFIX - TAG];
    plaintext[..LENGTH_PREFIX].copy_from_slice(&(payload.len() as u16).to_be_bytes());
    plaintext[LENGTH_PREFIX..LENGTH_PREFIX + payload.len()].copy_from_slice(payload);
    Ok(plaintext)
}

/// The payload inside a plaintext `pad` produced.
///
/// The plaintext arrived inside an authenticated message, so a length
/// that does not fit is a peer that is wrong rather than an attacker on
/// the path -- and it is refused all the same, because the alternative is
/// reading past the end of what was sent.
pub fn unpad(plaintext: &[u8]) -> anyhow::Result<&[u8]> {
    if plaintext.len() < LENGTH_PREFIX {
        anyhow::bail!("a frame of {} bytes is too short to hold a message", plaintext.len());
    }
    let len = u16::from_be_bytes([plaintext[0], plaintext[1]]) as usize;
    let body = &plaintext[LENGTH_PREFIX..];
    if len > body.len() {
        anyhow::bail!("a frame claimed a message of {len} bytes and holds {}", body.len());
    }
    Ok(&body[..len])
}

/// How many bytes `plaintext_len` bytes of plaintext occupy on the wire,
/// length prefix and tag included.
pub fn frame_len(plaintext_len: usize) -> usize {
    LENGTH_PREFIX + plaintext_len + TAG
}

/// The Noise pattern a paired Device connects with, for both ends of it.
///
/// `IK`: the Device knows the Workstation's static key -- it pinned it
/// from the pairing QR -- so its first message is already sealed to that
/// key, and carries the Device's own. A Workstation that holds another
/// key cannot read it, which is what "Revoke all" rotating the key rests
/// on. The curve, cipher and hash are pairing's, so the Device's static
/// key is the one it paired with.
pub const CONNECT_NOISE_PARAMS: &str = "Noise_IK_25519_ChaChaPoly_BLAKE2s";

/// Mixed into the connection handshake by both ends before its first
/// message. A version in the string, for the reason `pairing_sas`'s
/// context has one: a Device and a Workstation that disagree about what
/// follows the handshake fail the handshake, not the conversation.
pub const CONNECT_PROLOGUE: &[u8] = b"gavin-device-connect-v1";

/// A hardware public key on this wire: the uncompressed SEC1 point of a
/// P-256 key, `04 || X || Y`. What `SecKeyCopyExternalRepresentation`
/// returns on iOS, and what the shell reads out of Android's
/// SubjectPublicKeyInfo.
pub const HARDWARE_KEY_BYTES: usize = 65;

/// A notification key: what a Workstation seals a Device's pushes with.
pub const NOTIFICATION_KEY_BYTES: usize = 32;

/// The domain separator for `unlock_message`.
const UNLOCK_CONTEXT: &[u8] = b"gavin-device-unlock-v1";

/// What a Device's hardware key signs to prove a handshake is its own.
///
/// ```text
/// message   = "gavin-device-unlock-v1" || handshake hash
/// signature = ECDSA-P256-SHA256(hardware key, message), ASN.1 DER
/// ```
///
/// The handshake hash covers both static keys and both ephemerals, so a
/// signature belongs to one handshake and is noise in any other: a Relay
/// that recorded one has nothing to replay it into. The prefix keeps the
/// one key a phone's hardware holds from ever being asked to sign bytes
/// that mean something somewhere else.
///
/// The message is what the hardware is handed; the SHA-256 is the
/// hardware's own. That is how both platforms sign
/// (`docs/research/2026-09-28-companion-device-keys.md`).
pub fn unlock_message(handshake_hash: &[u8]) -> Vec<u8> {
    let mut message = Vec::with_capacity(UNLOCK_CONTEXT.len() + handshake_hash.len());
    message.extend_from_slice(UNLOCK_CONTEXT);
    message.extend_from_slice(handshake_hash);
    message
}

/// The first message a Device sends on the channel a handshake left
/// behind: proof that the phone itself is on the other end.
///
/// One padded frame. camelCase, like `PairingQr`: the Companion writes it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnlockProof {
    /// The signature over `unlock_message`, ASN.1 DER, hex-encoded.
    pub signature: String,
    /// At pairing, the hardware public key being registered
    /// (`HARDWARE_KEY_BYTES`, hex-encoded). Absent when connecting: the
    /// key a connection is judged against is the one in the trust store,
    /// never one the connection brought with it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hardware_key: Option<String>,
}

impl UnlockProof {
    pub fn to_bytes(&self) -> Vec<u8> {
        serde_json::to_vec(self).unwrap_or_default()
    }

    pub fn from_bytes(bytes: &[u8]) -> anyhow::Result<Self> {
        Ok(serde_json::from_slice(bytes)?)
    }
}

/// What the Workstation tells a Device that has connected and sent its
/// proof. Until it arrives the Device sends nothing else.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum ConnectVerdict {
    /// The signature verified and the connection holds the Remote role.
    /// Everything after this is the stream.
    #[serde(rename_all = "camelCase")]
    Connected { device_id: String },
    /// No role, and no request will be answered. The stream ends.
    Refused { reason: ConnectRefusal },
    /// A verdict a newer Workstation sent.
    #[serde(other)]
    Unknown,
}

impl ConnectVerdict {
    pub fn to_bytes(&self) -> Vec<u8> {
        serde_json::to_vec(self).unwrap_or_default()
    }

    pub fn from_bytes(bytes: &[u8]) -> anyhow::Result<Self> {
        Ok(serde_json::from_slice(bytes)?)
    }
}

/// Why a Workstation refused a Device's connection.
///
/// Said to the Device, because each is a different thing for the
/// Companion to tell the human holding it. Every one of them is said to a
/// peer that has already proved it holds the Device's Noise key, inside
/// the channel that proved it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ConnectRefusal {
    /// The Workstation holds no row for this Device: it never paired
    /// here, or it removed itself.
    NotPaired,
    /// Revoked at the desk.
    Revoked,
    /// Unseen for ninety days.
    Stale,
    /// The row cannot be connected with as it stands -- it holds no
    /// hardware key, or a role this Workstation cannot read -- and
    /// pairing again is what replaces it.
    PairAgain,
    /// The proof did not verify: no signature, or not the registered
    /// hardware key's, or not over this handshake.
    Unlock,
    /// This Device already holds as many connections as one may.
    Busy,
    /// A reason a newer Workstation sent.
    #[serde(other)]
    Other,
}

impl std::fmt::Display for ConnectRefusal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            ConnectRefusal::NotPaired => "this Device is not paired with that Workstation",
            ConnectRefusal::Revoked => {
                "this Device was revoked at the Workstation — pair it again to use it"
            }
            ConnectRefusal::Stale => {
                "this Device has not been seen for 90 days — pair it again to use it"
            }
            ConnectRefusal::PairAgain => {
                "this Device has to be paired with the Workstation again before it can connect"
            }
            ConnectRefusal::Unlock => "the Workstation could not verify that this Device is unlocked",
            ConnectRefusal::Busy => "this Device already holds as many connections as it may",
            ConnectRefusal::Other => "the Workstation refused the connection",
        })
    }
}

/// What the Workstation tells a Device once the human at the desk has
/// ruled on its pairing.
///
/// The one message the pairing stream carries after the handshake. Until
/// it arrives the Device is showing six digits and waiting; a stream that
/// closes without one is a pairing that failed, never one that succeeded
/// quietly.
///
/// camelCase, like `PairingQr`: it is read by the Companion.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum PairingVerdict {
    /// The human compared the codes and confirmed, and the row is
    /// written. `device_id` is what this Workstation calls the Device.
    ///
    /// `notification_key` is the key this Workstation will seal this
    /// Device's notifications with: `NOTIFICATION_KEY_BYTES` random
    /// bytes, hex-encoded, minted by the daemon when the desk confirmed.
    /// It is agreed here, inside the channel the pairing handshake left
    /// behind, because that is the one moment both ends are certain of
    /// each other and neither the Relay nor the Push gateway is a party.
    /// Pairing again mints another.
    #[serde(rename_all = "camelCase")]
    Paired { device_id: String, notification_key: String },
    /// The human said no.
    Rejected,
    /// Nobody answered in time, or the desk started a new pairing.
    Expired,
    /// A verdict a newer Workstation sent.
    #[serde(other)]
    Unknown,
}

/// Hand-written, and it leaves the notification key out: a verdict that
/// reaches a log line or a failure message must not take the key with
/// it.
impl std::fmt::Debug for PairingVerdict {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PairingVerdict::Paired { device_id, .. } => {
                f.debug_struct("Paired").field("device_id", device_id).finish_non_exhaustive()
            }
            PairingVerdict::Rejected => f.write_str("Rejected"),
            PairingVerdict::Expired => f.write_str("Expired"),
            PairingVerdict::Unknown => f.write_str("Unknown"),
        }
    }
}

impl PairingVerdict {
    pub fn to_bytes(&self) -> Vec<u8> {
        serde_json::to_vec(self).unwrap_or_default()
    }

    pub fn from_bytes(bytes: &[u8]) -> anyhow::Result<Self> {
        Ok(serde_json::from_slice(bytes)?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_padded_frame_is_a_multiple_of_the_bucket_on_the_wire() {
        for len in [0usize, 1, 17, 236, 237, 238, 255, 256, 492, 493, 4000, MAX_PAYLOAD] {
            let plaintext = pad(&vec![7u8; len]).unwrap();
            let frame = frame_len(plaintext.len());
            assert_eq!(frame % FRAME_BUCKET, 0, "a {len}-byte message made a {frame}-byte frame");
            assert!(
                plaintext.len() + TAG <= MAX_NOISE_MESSAGE,
                "a {len}-byte message does not fit a Noise message"
            );
        }
        // The smallest message takes one bucket and the first that does
        // not fit one takes two: the bucket is what a watcher learns.
        assert_eq!(frame_len(pad(&[0u8; 236]).unwrap().len()), FRAME_BUCKET);
        assert_eq!(frame_len(pad(&[0u8; 237]).unwrap().len()), 2 * FRAME_BUCKET);
        assert_eq!(frame_len(pad(&[]).unwrap().len()), FRAME_BUCKET);
    }

    #[test]
    fn padding_round_trips_every_length_up_to_the_cap() {
        for len in (0..=1024).chain([MAX_PAYLOAD - 1, MAX_PAYLOAD]) {
            let payload: Vec<u8> = (0..len).map(|i| (i % 251) as u8).collect();
            let plaintext = pad(&payload).unwrap();
            assert_eq!(unpad(&plaintext).unwrap(), payload.as_slice(), "{len} bytes");
        }
    }

    #[test]
    fn a_payload_over_the_cap_is_refused() {
        assert_eq!(MAX_PAYLOAD, 65516);
        let err = pad(&vec![0u8; MAX_PAYLOAD + 1]).unwrap_err();
        assert!(err.to_string().contains("does not fit"), "{err}");
    }

    #[test]
    fn a_frame_whose_length_field_lies_is_refused() {
        assert!(unpad(&[]).is_err());
        assert!(unpad(&[0]).is_err());
        // Claims 5 bytes and holds 3.
        let err = unpad(&[0, 5, 1, 2, 3]).unwrap_err();
        assert!(err.to_string().contains("claimed"), "{err}");
        // Claims exactly what it holds.
        assert_eq!(unpad(&[0, 3, 1, 2, 3]).unwrap(), &[1, 2, 3]);
        assert_eq!(unpad(&[0, 0]).unwrap(), &[] as &[u8]);
    }

    #[test]
    fn a_verdict_round_trips() {
        let paired =
            PairingVerdict::Paired { device_id: "dev-0123".into(), notification_key: "0f".into() };
        assert_eq!(
            String::from_utf8(paired.to_bytes()).unwrap(),
            r#"{"type":"paired","deviceId":"dev-0123","notificationKey":"0f"}"#
        );
        for verdict in [paired, PairingVerdict::Rejected, PairingVerdict::Expired] {
            assert_eq!(PairingVerdict::from_bytes(&verdict.to_bytes()).unwrap(), verdict);
        }
        assert_eq!(
            String::from_utf8(PairingVerdict::Rejected.to_bytes()).unwrap(),
            r#"{"type":"rejected"}"#
        );
    }

    #[test]
    fn a_verdict_this_build_has_never_heard_of_is_a_value() {
        assert_eq!(
            PairingVerdict::from_bytes(br#"{"type":"deferred","until":1}"#).unwrap(),
            PairingVerdict::Unknown
        );
        assert!(PairingVerdict::from_bytes(b"not json").is_err());
    }

    /// What the hardware is asked to sign, byte for byte. Two programs
    /// build it and a phone's keystore signs it, so a change to it is a
    /// failing test here before it is a Device that cannot connect.
    #[test]
    fn the_unlock_message_is_pinned() {
        let hash = [0xabu8; 32];
        let message = unlock_message(&hash);
        assert_eq!(&message[..22], b"gavin-device-unlock-v1");
        assert_eq!(&message[22..], &hash);
        assert_eq!(message.len(), 54);
        // Bound to the handshake: another handshake is another message.
        assert_ne!(unlock_message(&[0xacu8; 32]), message);
    }

    #[test]
    fn a_proof_round_trips_with_and_without_a_key() {
        let connecting = UnlockProof { signature: "3045".into(), hardware_key: None };
        assert_eq!(
            String::from_utf8(connecting.to_bytes()).unwrap(),
            r#"{"signature":"3045"}"#
        );
        assert_eq!(UnlockProof::from_bytes(&connecting.to_bytes()).unwrap(), connecting);

        let pairing = UnlockProof { signature: "3045".into(), hardware_key: Some("04ab".into()) };
        assert_eq!(
            String::from_utf8(pairing.to_bytes()).unwrap(),
            r#"{"signature":"3045","hardwareKey":"04ab"}"#
        );
        assert_eq!(UnlockProof::from_bytes(&pairing.to_bytes()).unwrap(), pairing);
    }

    /// A Device that skipped the proof and sent its first request in the
    /// proof's place has sent something that is not a proof.
    #[test]
    fn a_request_is_not_a_proof() {
        assert!(UnlockProof::from_bytes(br#"{"type":"ListSessions"}"#).is_err());
        assert!(UnlockProof::from_bytes(b"").is_err());
        assert!(UnlockProof::from_bytes(b"not json").is_err());
    }

    #[test]
    fn a_paired_verdict_carries_the_notification_key() {
        let paired = PairingVerdict::Paired {
            device_id: "dev-0123".into(),
            notification_key: "ab".repeat(NOTIFICATION_KEY_BYTES),
        };
        let text = String::from_utf8(paired.to_bytes()).unwrap();
        assert!(text.starts_with(r#"{"type":"paired","deviceId":"dev-0123","notificationKey":"abab"#), "{text}");
        assert_eq!(PairingVerdict::from_bytes(&paired.to_bytes()).unwrap(), paired);
        // With the 64 hex digits of a real key it still takes one bucket.
        assert_eq!(frame_len(pad(&paired.to_bytes()).unwrap().len()), FRAME_BUCKET);
    }

    /// A verdict reaches a test's failure message, and one day a log
    /// line, by being formatted. The key in it must not.
    #[test]
    fn a_paired_verdict_does_not_print_the_notification_key() {
        let paired = PairingVerdict::Paired {
            device_id: "dev-0123".into(),
            notification_key: "a7".repeat(NOTIFICATION_KEY_BYTES),
        };
        let shown = format!("{paired:?}");
        assert!(shown.contains("dev-0123"), "{shown}");
        assert!(!shown.contains("a7a7"), "{shown}");
        assert_eq!(format!("{:?}", PairingVerdict::Rejected), "Rejected");
    }

    #[test]
    fn a_connect_verdict_round_trips() {
        let connected = ConnectVerdict::Connected { device_id: "dev-0123".into() };
        assert_eq!(
            String::from_utf8(connected.to_bytes()).unwrap(),
            r#"{"type":"connected","deviceId":"dev-0123"}"#
        );
        let refused = ConnectVerdict::Refused { reason: ConnectRefusal::PairAgain };
        assert_eq!(
            String::from_utf8(refused.to_bytes()).unwrap(),
            r#"{"type":"refused","reason":"pair-again"}"#
        );
        for verdict in [
            connected,
            refused,
            ConnectVerdict::Refused { reason: ConnectRefusal::NotPaired },
            ConnectVerdict::Refused { reason: ConnectRefusal::Revoked },
            ConnectVerdict::Refused { reason: ConnectRefusal::Stale },
            ConnectVerdict::Refused { reason: ConnectRefusal::Unlock },
            ConnectVerdict::Refused { reason: ConnectRefusal::Busy },
        ] {
            assert_eq!(ConnectVerdict::from_bytes(&verdict.to_bytes()).unwrap(), verdict);
        }
    }

    #[test]
    fn a_refusal_this_build_has_never_heard_of_is_a_value() {
        assert_eq!(
            ConnectVerdict::from_bytes(br#"{"type":"refused","reason":"on-holiday"}"#).unwrap(),
            ConnectVerdict::Refused { reason: ConnectRefusal::Other }
        );
        assert_eq!(
            ConnectVerdict::from_bytes(br#"{"type":"queued","position":3}"#).unwrap(),
            ConnectVerdict::Unknown
        );
        assert!(ConnectVerdict::from_bytes(b"not json").is_err());
    }

    /// Every refusal says something a person can act on.
    #[test]
    fn every_refusal_has_something_to_say() {
        for reason in [
            ConnectRefusal::NotPaired,
            ConnectRefusal::Revoked,
            ConnectRefusal::Stale,
            ConnectRefusal::PairAgain,
            ConnectRefusal::Unlock,
            ConnectRefusal::Busy,
            ConnectRefusal::Other,
        ] {
            assert!(!reason.to_string().is_empty(), "{reason:?}");
        }
    }

    /// `IK`, on the curve, cipher and hash pairing runs on: one suite,
    /// and the Device's static key is the one it paired with.
    #[test]
    fn the_connection_pattern_is_ik_on_the_pairing_suite() {
        assert_eq!(CONNECT_NOISE_PARAMS, "Noise_IK_25519_ChaChaPoly_BLAKE2s");
        let suite = |params: &str| params.splitn(3, '_').nth(2).map(str::to_string);
        assert_eq!(suite(CONNECT_NOISE_PARAMS), suite(crate::PAIRING_NOISE_PARAMS));
        assert_eq!(CONNECT_PROLOGUE, b"gavin-device-connect-v1");
        assert_eq!(HARDWARE_KEY_BYTES, 65);
    }
}
