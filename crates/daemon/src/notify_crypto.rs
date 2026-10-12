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
    let mut nonce = [0u8; NONCE_LEN];
    getrandom::getrandom(&mut nonce).expect("CSPRNG");
    seal_with_nonce(key_bytes, &nonce, counter, issued_at_secs, body)
}

/// `seal` with the nonce named: how the shared fixture's ciphertexts are
/// reproduced byte for byte. A nonce must never repeat under one key, so
/// outside the tests the only caller is `seal`, with a random one.
fn seal_with_nonce(
    key_bytes: &[u8],
    nonce: &[u8; NONCE_LEN],
    counter: u64,
    issued_at_secs: u64,
    body: &NotifyPlaintext,
) -> Result<Vec<u8>, NotifyCryptoError> {
    let json = serde_json::to_vec(body).map_err(|e| NotifyCryptoError::Malformed(e.to_string()))?;
    seal_plaintext(key_bytes, nonce, &plaintext(PAYLOAD_VERSION, counter, issued_at_secs, &json))
}

/// The AEAD plaintext: version, counter and issue time, the JSON, padded.
fn plaintext(version: u8, counter: u64, issued_at_secs: u64, json: &[u8]) -> Vec<u8> {
    let mut plain = Vec::new();
    plain.push(version);
    plain.extend_from_slice(&counter.to_be_bytes());
    plain.extend_from_slice(&issued_at_secs.to_be_bytes());
    plain.extend_from_slice(json);
    pad_in_place(&mut plain);
    plain
}

fn seal_plaintext(
    key_bytes: &[u8],
    nonce_bytes: &[u8; NONCE_LEN],
    plain: &[u8],
) -> Result<Vec<u8>, NotifyCryptoError> {
    let key = key_from(key_bytes)?;
    let nonce = Nonce::from_slice(nonce_bytes);
    let cipher = ChaCha20Poly1305::new(&key);
    let sealed = cipher
        .encrypt(nonce, Payload { msg: plain, aad: b"" })
        .map_err(|_| NotifyCryptoError::Decrypt)?;
    let mut out = Vec::with_capacity(NONCE_LEN + sealed.len());
    out.extend_from_slice(nonce_bytes);
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
    // after stripping is unambiguous. Pad byte value = number of pad bytes,
    // except that a plaintext which already fills its bucket gets a whole
    // bucket more, 256 bytes, and 256 does not fit in a byte: it is
    // written as 0, and `unpad` reads a 0 as 256.
    let need = PAD_BUCKET - (buf.len() % PAD_BUCKET);
    buf.extend(std::iter::repeat(need as u8).take(need));
}

fn unpad(buf: &[u8]) -> Result<&[u8], NotifyCryptoError> {
    let Some(&byte) = buf.last() else {
        return Err(NotifyCryptoError::Malformed("empty".into()));
    };
    let n = if byte == 0 { PAD_BUCKET } else { byte as usize };
    if n > buf.len() {
        return Err(NotifyCryptoError::Malformed("bad pad".into()));
    }
    if !buf[buf.len() - n..].iter().all(|&b| b == byte) {
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

    /// The table the phone's opener is held to
    /// (`test-fixtures/companion-notify/README.md`): the iOS Notification
    /// Service Extension opens these same bytes in Swift, and what keeps
    /// the two formats one format is that both read this file. Each case
    /// that names what it was sealed from is sealed again here, so a change
    /// to the format on this side fails here before it reaches a phone.
    #[test]
    fn every_case_in_the_shared_table_seals_and_opens_as_the_table_says() {
        use base64::Engine as _;
        let b64 = base64::engine::general_purpose::STANDARD;
        let table: serde_json::Value = serde_json::from_str(include_str!(
            "../../../test-fixtures/companion-notify/cases.json"
        ))
        .unwrap();
        let cases = table["cases"].as_array().unwrap();
        assert!(cases.len() >= 13, "the table has shrunk to {} cases", cases.len());

        let mut stale = Vec::new();
        for case in cases {
            let name = case["name"].as_str().unwrap();
            let key = protocol::hex_decode(case["key"].as_str().unwrap()).unwrap();
            if let Some(from) = case.get("sealed_from") {
                let nonce: [u8; NONCE_LEN] = protocol::hex_decode(from["nonce"].as_str().unwrap())
                    .unwrap()
                    .try_into()
                    .unwrap();
                let counter = from.get("counter").map_or(0, |v| v.as_u64().unwrap());
                let issued_at = from.get("issued_at").map_or(0, |v| v.as_u64().unwrap());
                let sealed = if let Some(body) = from.get("body") {
                    let body: NotifyPlaintext = serde_json::from_value(body.clone()).unwrap();
                    if case.get("fills_its_bucket").is_some() {
                        let json = serde_json::to_vec(&body).unwrap();
                        assert_eq!((17 + json.len()) % PAD_BUCKET, 0, "{name}: no longer fills its bucket");
                    }
                    seal_with_nonce(&key, &nonce, counter, issued_at, &body).unwrap()
                } else if let Some(json) = from.get("json") {
                    let version = from.get("version").map_or(PAYLOAD_VERSION, |v| v.as_u64().unwrap() as u8);
                    let plain = plaintext(version, counter, issued_at, json.as_str().unwrap().as_bytes());
                    seal_plaintext(&key, &nonce, &plain).unwrap()
                } else {
                    let plain = protocol::hex_decode(from["plaintext_hex"].as_str().unwrap()).unwrap();
                    seal_plaintext(&key, &nonce, &plain).unwrap()
                };
                let sealed = b64.encode(sealed);
                if sealed != case["c"].as_str().unwrap() {
                    stale.push(format!("{name}: {sealed}"));
                }
            }
        }
        assert!(stale.is_empty(), "the table's c is stale for:\n{}", stale.join("\n"));

        let mut refusals = std::collections::BTreeSet::new();
        for case in cases {
            let name = case["name"].as_str().unwrap();
            let key = protocol::hex_decode(case["key"].as_str().unwrap()).unwrap();
            let c = case["c"].as_str().unwrap();
            let opened = b64.decode(c).map_err(|e| e.to_string()).and_then(|c| {
                open(&key, &c).map_err(|e| e.to_string())
            });
            match (case.get("opens"), case.get("refuse")) {
                (Some(opens), None) => {
                    let opened = opened.unwrap_or_else(|e| panic!("{name}: {e}"));
                    assert_eq!(opened.counter, opens["counter"].as_u64().unwrap(), "{name}");
                    assert_eq!(opened.issued_at_secs, opens["issued_at"].as_u64().unwrap(), "{name}");
                    let body: NotifyPlaintext = serde_json::from_value(opens["body"].clone()).unwrap();
                    assert_eq!(opened.body, body, "{name}");
                }
                (None, Some(why)) => {
                    let why = why.as_str().unwrap();
                    refusals.insert(why);
                    let err = b64
                        .decode(c)
                        .map(|c| open(&key, &c))
                        .unwrap_or_else(|e| panic!("{name}: c is not base64: {e}"))
                        .err()
                        .unwrap_or_else(|| panic!("{name} opened; the table says {why}"));
                    assert_eq!(refusal_name(&err), why, "{name}: {err}");
                }
                _ => panic!("{name} must say exactly one of opens and refuse"),
            }
        }
        // Every refusal the phone can meet has a case.
        assert_eq!(
            refusals.into_iter().collect::<Vec<_>>(),
            vec!["decrypt", "malformed", "truncated", "version"]
        );
    }

    /// The table's name for a refusal, as the phone's opener names it.
    fn refusal_name(e: &NotifyCryptoError) -> &'static str {
        match e {
            NotifyCryptoError::BadKeyLen => "key",
            NotifyCryptoError::Truncated => "truncated",
            NotifyCryptoError::Decrypt => "decrypt",
            NotifyCryptoError::BadVersion(_) => "version",
            NotifyCryptoError::Malformed(_) => "malformed",
        }
    }

    #[test]
    fn a_plaintext_that_fills_its_bucket_still_opens() {
        // 17 bytes of header and 239 of JSON: the pad is a whole bucket,
        // written as 0, which `unpad` once refused.
        let mut body = notify_body();
        let bare = serde_json::to_vec(&NotifyPlaintext { text: Some(String::new()), ..body.clone() }).unwrap();
        body.text = Some("x".repeat(PAD_BUCKET - 17 - bare.len()));
        let sealed = seal(&key(), 2, 2, &body).unwrap();
        assert_eq!(sealed.len(), NONCE_LEN + 2 * PAD_BUCKET + 16);
        assert_eq!(open(&key(), &sealed).unwrap().body, body);
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
