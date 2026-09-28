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

/// What the Workstation tells a Device once the human at the desk has
/// ruled on its pairing.
///
/// The one message the pairing stream carries after the handshake. Until
/// it arrives the Device is showing six digits and waiting; a stream that
/// closes without one is a pairing that failed, never one that succeeded
/// quietly.
///
/// camelCase, like `PairingQr`: it is read by the Companion.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum PairingVerdict {
    /// The human compared the codes and confirmed, and the row is
    /// written. `device_id` is what this Workstation calls the Device.
    #[serde(rename_all = "camelCase")]
    Paired { device_id: String },
    /// The human said no.
    Rejected,
    /// Nobody answered in time, or the desk started a new pairing.
    Expired,
    /// A verdict a newer Workstation sent.
    #[serde(other)]
    Unknown,
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
        let paired = PairingVerdict::Paired { device_id: "dev-0123".into() };
        assert_eq!(
            String::from_utf8(paired.to_bytes()).unwrap(),
            r#"{"type":"paired","deviceId":"dev-0123"}"#
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
}
