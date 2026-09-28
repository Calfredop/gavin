//! End-to-end encrypted Companion notification payloads.
//!
//! The desk decides; this module seals. The AEAD plaintext carries a
//! version, a per-Workstation counter, an issue time, and the item
//! (security 06 §5.6). Ciphertext is padded to 256-byte buckets so the
//! Push gateway and the carriers learn nothing from the size. The
//! gateway never sees the key; the phone opens with the key agreed at
//! pairing.

use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{ChaCha20Poly1305, Key, Nonce};
use serde::{Deserialize, Serialize};

/// Bytes of a notification key. Agreed at pairing (ticket 11); one per
/// Device on this Workstation.
pub const NOTIFICATION_KEY_LEN: usize = 32;

/// Noise-style padding: every sealed payload lands in a 256-byte bucket
/// (plaintext before AEAD), matching the Relay's bucket from 05.
pub const PAD_BUCKET: usize = 256;

/// AEAD tag + nonce overhead. Ciphertext on the wire is
/// `nonce || ciphertext_with_tag`, and that whole thing is what the
/// daemon posts to `POST /v1/push` (1..=2048 bytes).
pub const NONCE_LEN: usize = 12;

const PAYLOAD_VERSION: u8 = 1;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NotifyOp {
    Notify,
    Resolve,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum NotifyTarget {
    Session { session_id: String },
    Card { path: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NotifyPlaintext {
    pub op: NotifyOp,
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<NotifyTarget>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpenedNotify {
    pub counter: u64,
    pub issued_at_secs: u64,
    pub body: NotifyPlaintext,
}

#[derive(Debug)]
pub enum NotifyCryptoError {
    BadKeyLen,
    Truncated,
    Decrypt,
    BadVersion(u8),
    Malformed(String),
}

impl std::fmt::Display for NotifyCryptoError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            NotifyCryptoError::BadKeyLen => {
                write!(f, "notification key must be {NOTIFICATION_KEY_LEN} bytes")
            }
            NotifyCryptoError::Truncated => write!(f, "ciphertext too short"),
            NotifyCryptoError::Decrypt => write!(f, "decrypt failed"),
            NotifyCryptoError::BadVersion(v) => write!(f, "unsupported payload version {v}"),
            NotifyCryptoError::Malformed(s) => write!(f, "malformed plaintext: {s}"),
        }
    }
}

impl std::error::Error for NotifyCryptoError {}

/// Seal a notify or resolve payload. `counter` is the Workstation's
/// next counter for this Device; the caller persists the bump after a
/// successful post.
pub fn seal(
    key_bytes: &[u8],
    counter: u64,
    issued_at_secs: u64,
    body: &NotifyPlaintext,
) -> Result<Vec<u8>, NotifyCryptoError> {
    let key = key_from(key_bytes)?;
    let mut plain = Vec::new();
    plain.push(PAYLOAD_VERSION);
    plain.extend_from_slice(&counter.to_be_bytes());
    plain.extend_from_slice(&issued_at_secs.to_be_bytes());
    let json = serde_json::to_vec(body).map_err(|e| NotifyCryptoError::Malformed(e.to_string()))?;
    plain.extend_from_slice(&json);
    pad_in_place(&mut plain);

    let mut nonce_bytes = [0u8; NONCE_LEN];
    getrandom::getrandom(&mut nonce_bytes).expect("CSPRNG");
    let nonce = Nonce::from_slice(&nonce_bytes);
    let cipher = ChaCha20Poly1305::new(&key);
    let sealed = cipher
        .encrypt(nonce, Payload { msg: &plain, aad: b"" })
        .map_err(|_| NotifyCryptoError::Decrypt)?;
    let mut out = Vec::with_capacity(NONCE_LEN + sealed.len());
    out.extend_from_slice(&nonce_bytes);
    out.extend_from_slice(&sealed);
    Ok(out)
}

/// Open a sealed payload. The caller drops replays by keeping the highest
/// counter seen per Workstation.
pub fn open(key_bytes: &[u8], ciphertext: &[u8]) -> Result<OpenedNotify, NotifyCryptoError> {
    let key = key_from(key_bytes)?;
    if ciphertext.len() <= NONCE_LEN {
        return Err(NotifyCryptoError::Truncated);
    }
    let (nonce_bytes, sealed) = ciphertext.split_at(NONCE_LEN);
    let nonce = Nonce::from_slice(nonce_bytes);
    let cipher = ChaCha20Poly1305::new(&key);
    let plain = cipher
        .decrypt(nonce, Payload { msg: sealed, aad: b"" })
        .map_err(|_| NotifyCryptoError::Decrypt)?;
    if plain.len() < 1 + 8 + 8 {
        return Err(NotifyCryptoError::Truncated);
    }
    let version = plain[0];
    if version != PAYLOAD_VERSION {
        return Err(NotifyCryptoError::BadVersion(version));
    }
    let counter = u64::from_be_bytes(plain[1..9].try_into().unwrap());
    let issued_at_secs = u64::from_be_bytes(plain[9..17].try_into().unwrap());
    let json = unpad(&plain[17..])?;
    let body: NotifyPlaintext =
        serde_json::from_slice(json).map_err(|e| NotifyCryptoError::Malformed(e.to_string()))?;
    Ok(OpenedNotify { counter, issued_at_secs, body })
}

fn key_from(key_bytes: &[u8]) -> Result<Key, NotifyCryptoError> {
    if key_bytes.len() != NOTIFICATION_KEY_LEN {
        return Err(NotifyCryptoError::BadKeyLen);
    }
    Ok(*Key::from_slice(key_bytes))
}

fn pad_in_place(buf: &mut Vec<u8>) {
    // PKCS#7-style over the bucket: at least one pad byte, so the length
    // after stripping is unambiguous. Pad byte value = number of pad bytes.
    let need = PAD_BUCKET - (buf.len() % PAD_BUCKET);
    let need = if need == 0 { PAD_BUCKET } else { need };
    buf.extend(std::iter::repeat(need as u8).take(need));
}

fn unpad(buf: &[u8]) -> Result<&[u8], NotifyCryptoError> {
    let Some(&n) = buf.last() else {
        return Err(NotifyCryptoError::Malformed("empty".into()));
    };
    let n = n as usize;
    if n == 0 || n > PAD_BUCKET || n > buf.len() {
        return Err(NotifyCryptoError::Malformed("bad pad".into()));
    }
    if !buf[buf.len() - n..].iter().all(|&b| b as usize == n) {
        return Err(NotifyCryptoError::Malformed("bad pad".into()));
    }
    Ok(&buf[..buf.len() - n])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key() -> [u8; 32] {
        let mut k = [0u8; 32];
        k[0] = 7;
        k[31] = 9;
        k
    }

    fn notify_body() -> NotifyPlaintext {
        NotifyPlaintext {
            op: NotifyOp::Notify,
            id: "session:s1".into(),
            kind: Some("asking".into()),
            text: Some("feat-x: which migration?".into()),
            workspace_id: Some("ws".into()),
            target: Some(NotifyTarget::Session { session_id: "s1".into() }),
        }
    }

    #[test]
    fn round_trip_decrypts_to_the_same_item() {
        let sealed = seal(&key(), 3, 1_700_000_000, &notify_body()).unwrap();
        let opened = open(&key(), &sealed).unwrap();
        assert_eq!(opened.counter, 3);
        assert_eq!(opened.issued_at_secs, 1_700_000_000);
        assert_eq!(opened.body, notify_body());
    }

    #[test]
    fn wrong_key_fails_closed() {
        let sealed = seal(&key(), 1, 1, &notify_body()).unwrap();
        let mut other = key();
        other[0] ^= 1;
        assert!(matches!(open(&other, &sealed), Err(NotifyCryptoError::Decrypt)));
    }

    #[test]
    fn resolve_carries_only_the_id() {
        let body = NotifyPlaintext {
            op: NotifyOp::Resolve,
            id: "session:s1".into(),
            kind: None,
            text: None,
            workspace_id: None,
            target: None,
        };
        let sealed = seal(&key(), 4, 2, &body).unwrap();
        let opened = open(&key(), &sealed).unwrap();
        assert_eq!(opened.body.op, NotifyOp::Resolve);
        assert_eq!(opened.body.id, "session:s1");
        assert!(opened.body.text.is_none());
    }

    #[test]
    fn ciphertext_fits_the_gateway_cap() {
        let sealed = seal(&key(), 1, 1, &notify_body()).unwrap();
        assert!(!sealed.is_empty());
        assert!(sealed.len() <= 2048, "got {} bytes", sealed.len());
        // At least one full padded bucket of plaintext + nonce + tag.
        assert!(sealed.len() >= PAD_BUCKET + NONCE_LEN + 16);
    }
}
