//! Random identifiers and secrets.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use ring::digest;
use ring::rand::{SecureRandom, SystemRandom};
use std::fmt;

/// A Device's or a permission's id: 16 random bytes, written as 32
/// lowercase hex characters wherever it leaves the process.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub struct Id(pub [u8; 16]);

impl Id {
    pub fn random() -> Id {
        Id(random_bytes())
    }

    pub fn parse(text: &str) -> Option<Id> {
        if text.len() != 32 {
            return None;
        }
        let mut out = [0u8; 16];
        for (i, byte) in out.iter_mut().enumerate() {
            *byte = u8::from_str_radix(text.get(i * 2..i * 2 + 2)?, 16).ok()?;
        }
        // `from_str_radix` takes uppercase too; one spelling per id keeps
        // the database's text keys and the log's lines comparable.
        (text.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))).then_some(Id(out))
    }
}

impl fmt::Display for Id {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        for byte in self.0 {
            write!(f, "{byte:02x}")?;
        }
        Ok(())
    }
}

pub fn random_bytes<const N: usize>() -> [u8; N] {
    let mut out = [0u8; N];
    SystemRandom::new()
        .fill(&mut out)
        .expect("the OS random source failed");
    out
}

/// A Device's bearer secret: 32 random bytes, base64url. Only its hash is
/// stored, so a copy of the database authenticates as nobody.
pub fn new_secret() -> String {
    URL_SAFE_NO_PAD.encode(random_bytes::<32>())
}

pub fn secret_hash(secret: &str) -> [u8; 32] {
    let digest = digest::digest(&digest::SHA256, secret.as_bytes());
    let mut out = [0u8; 32];
    out.copy_from_slice(digest.as_ref());
    out
}

/// Constant-time equality for two hashes.
pub fn same_hash(a: &[u8; 32], b: &[u8; 32]) -> bool {
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_id_round_trips_through_its_text() {
        let id = Id::random();
        assert_eq!(Id::parse(&id.to_string()), Some(id));
    }

    #[test]
    fn an_id_has_exactly_one_spelling() {
        let id = Id::random();
        assert_eq!(Id::parse(&id.to_string().to_uppercase()), None);
        assert_eq!(Id::parse("abc"), None);
        assert_eq!(Id::parse(&"g".repeat(32)), None);
        // A multi-byte character must not panic the slicing.
        assert_eq!(Id::parse(&format!("é{}", "0".repeat(30))), None);
    }

    #[test]
    fn a_secret_matches_only_its_own_hash() {
        let secret = new_secret();
        assert!(same_hash(&secret_hash(&secret), &secret_hash(&secret)));
        assert!(!same_hash(&secret_hash(&secret), &secret_hash(&new_secret())));
    }
}
