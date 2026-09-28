//! Send permissions: what a Workstation presents to have a push delivered.
//!
//! A Device mints one per Workstation and hands it over the encrypted
//! channel. It is `v1.<payload>.<tag>`, both base64url: the payload is the
//! permission's id, its Device's id and its expiry, and the tag is an
//! HMAC-SHA256 over `v1.<payload>` under a key only this gateway holds.
//!
//! The tag is what makes a guessed or edited permission cost nothing to
//! refuse -- no database read -- and what lets the expiry travel inside
//! the permission. It does NOT make a permission live: a cancelled one
//! still carries a perfect tag, so the permissions table is the other
//! half of every check (`Gateway::push`). HMAC rather than a public-key
//! signature because nobody but this gateway ever verifies one.

use crate::id::{random_bytes, Id};
use anyhow::{bail, Context, Result};
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use base64::Engine;
use ring::hmac;
use std::path::Path;

const VERSION: &str = "v1";
const PAYLOAD_LEN: usize = 16 + 16 + 8;

pub struct PermissionKey(hmac::Key);

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Claims {
    pub permission: Id,
    pub device: Id,
    /// Unix seconds.
    pub expires_at: u64,
}

impl PermissionKey {
    pub fn from_bytes(bytes: &[u8]) -> PermissionKey {
        PermissionKey(hmac::Key::new(hmac::HMAC_SHA256, bytes))
    }

    pub fn random() -> PermissionKey {
        PermissionKey::from_bytes(&random_bytes::<32>())
    }

    /// Reads the key file, creating it with a fresh random key the first
    /// time. The file is base64 text so an operator can also write one by
    /// hand; replacing it invalidates every permission ever issued.
    pub fn load_or_create(path: &Path) -> Result<PermissionKey> {
        match std::fs::read_to_string(path) {
            Ok(text) => {
                let bytes = STANDARD
                    .decode(text.trim())
                    .with_context(|| format!("{} is not base64", path.display()))?;
                if bytes.len() < 32 {
                    bail!("{} holds {} bytes; a permission key needs at least 32", path.display(), bytes.len());
                }
                Ok(PermissionKey::from_bytes(&bytes))
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                let bytes = random_bytes::<32>();
                write_private(path, format!("{}\n", STANDARD.encode(bytes)).as_bytes())
                    .with_context(|| format!("writing a new permission key to {}", path.display()))?;
                Ok(PermissionKey::from_bytes(&bytes))
            }
            Err(e) => Err(e).with_context(|| format!("reading {}", path.display())),
        }
    }

    pub fn sign(&self, claims: &Claims) -> String {
        let mut payload = [0u8; PAYLOAD_LEN];
        payload[..16].copy_from_slice(&claims.permission.0);
        payload[16..32].copy_from_slice(&claims.device.0);
        payload[32..].copy_from_slice(&claims.expires_at.to_be_bytes());
        let signed = format!("{VERSION}.{}", URL_SAFE_NO_PAD.encode(payload));
        let tag = hmac::sign(&self.0, signed.as_bytes());
        format!("{signed}.{}", URL_SAFE_NO_PAD.encode(tag.as_ref()))
    }

    /// The claims of a permission this key signed, or None for anything
    /// else. Says nothing about expiry or cancellation.
    pub fn verify(&self, permission: &str) -> Option<Claims> {
        let (signed, tag) = permission.rsplit_once('.')?;
        let (version, payload) = signed.split_once('.')?;
        if version != VERSION {
            return None;
        }
        let tag = URL_SAFE_NO_PAD.decode(tag).ok()?;
        hmac::verify(&self.0, signed.as_bytes(), &tag).ok()?;
        let payload = URL_SAFE_NO_PAD.decode(payload).ok()?;
        if payload.len() != PAYLOAD_LEN {
            return None;
        }
        Some(Claims {
            permission: Id(payload[..16].try_into().ok()?),
            device: Id(payload[16..32].try_into().ok()?),
            expires_at: u64::from_be_bytes(payload[32..].try_into().ok()?),
        })
    }
}

fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)?.write_all(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn claims() -> Claims {
        Claims { permission: Id::random(), device: Id::random(), expires_at: 1_900_000_000 }
    }

    #[test]
    fn a_signed_permission_verifies_to_its_claims() {
        let key = PermissionKey::random();
        let claims = claims();
        assert_eq!(key.verify(&key.sign(&claims)), Some(claims));
    }

    #[test]
    fn another_keys_permission_does_not_verify() {
        let permission = PermissionKey::random().sign(&claims());
        assert_eq!(PermissionKey::random().verify(&permission), None);
    }

    #[test]
    fn an_edited_permission_does_not_verify() {
        let key = PermissionKey::random();
        let claims = claims();
        let permission = key.sign(&claims);
        let (signed, tag) = permission.rsplit_once('.').unwrap();
        // A later expiry under the original tag.
        let later = key.sign(&Claims { expires_at: u64::MAX, ..claims });
        let (later_signed, _) = later.rsplit_once('.').unwrap();
        assert_eq!(key.verify(&format!("{later_signed}.{tag}")), None);
        assert_eq!(key.verify(&format!("v2{}.{tag}", &signed[2..])), None);
        assert_eq!(key.verify(&format!("{signed}.{}", &tag[1..])), None);
        assert_eq!(key.verify(""), None);
        assert_eq!(key.verify("v1.."), None);
    }

    #[test]
    fn the_key_file_is_created_once_and_then_reused() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested").join("permission.key");
        let permission = PermissionKey::load_or_create(&path).unwrap().sign(&claims());
        assert!(PermissionKey::load_or_create(&path).unwrap().verify(&permission).is_some());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
    }

    #[test]
    fn a_short_key_file_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("permission.key");
        std::fs::write(&path, STANDARD.encode([7u8; 16])).unwrap();
        assert!(PermissionKey::load_or_create(&path).is_err());
    }
}
