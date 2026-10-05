//! The Companion UI bundle a Workstation serves (ADR 0005, companion-23).
//!
//! The Companion from the store is only a shell. The UI for working on a
//! Workstation is a web bundle built from the same commit as that
//! Workstation's desktop app, which ships it and serves it to Devices over
//! the encrypted channel. The publisher signs every bundle, and the shell
//! runs only a bundle whose signature checks against a key it pins -- so a
//! compromised Workstation cannot run code in the webview that also holds
//! the Device's keys for its other Workstations.
//!
//! This module is the contract every end shares:
//!
//! - **The archive.** A plain ustar tar of the built bundle's files
//!   (`pack`, `unpack`): no compression, no links, no directories of its
//!   own -- a path is a file. The reader refuses anything else, and any
//!   path that could leave the folder it is unpacked into.
//! - **The manifest** (`BundleManifest`): the archive's SHA-256, its size,
//!   an Ed25519 signature over `signing_message(hash)` and the key it
//!   verifies under. camelCase, since the shell reads it as JSON.
//! - **The verifier** (`verify`): the archive is the one the manifest
//!   names, and the signature checks under one of the keys the caller
//!   trusts. The shell hands it the publisher key it pins -- and, in a
//!   debug build only, a dev key made on the developer's machine.
//! - **The fetch** (`GetCompanionBundle` / `CompanionBundle` in `lib.rs`):
//!   the manifest, then the archive in chunks of at most `BUNDLE_CHUNK_MAX`
//!   bytes, each base64 in a JSON string. The daemon's line cap is a
//!   megabyte; the chunk cap keeps every answer well inside it.
//!
//! Signing has one implementation here (`sign`, for the Rust tooling and
//! the tests) and one in Node (`app/src-tauri/stage-companion.mjs`, which
//! the desktop build runs). The test vector under `test-fixtures/
//! companion-bundle/` pins the two to each other: the same files pack to
//! the same archive, and a signature made by either verifies here.
//!
//! No operating-system part anywhere: the Companion core verifies from
//! `wasm32-unknown-unknown`.

use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{hex_decode, hex_encode};

/// The bundle API version this crate writes. Like `ATTENTION_API_VERSION`:
/// the shell pins it across Workstation builds, and the answer only ever
/// grows by optional fields.
pub const COMPANION_BUNDLE_API_VERSION: u32 = 1;

/// What a signature covers: this prefix and the archive's SHA-256, so a
/// signature over a bundle can never be mistaken for one over anything
/// else the same key might sign.
pub const BUNDLE_SIGNING_DOMAIN: &[u8] = b"gavin-companion-bundle-v1";

/// The most archive bytes one `CompanionBundle` answer carries. Base64
/// makes it a third larger on the wire; the daemon's `MAX_LINE_BYTES` is
/// four times that.
pub const BUNDLE_CHUNK_MAX: u64 = 256 * 1024;

/// The largest archive a Device will fetch. A bundle is a few megabytes
/// of JavaScript; a manifest claiming more than this is refused before a
/// byte is asked for.
pub const BUNDLE_SIZE_MAX: u64 = 64 * 1024 * 1024;

/// The archive format the manifest names. The one value there is.
pub const BUNDLE_FORMAT_TAR: &str = "tar";

/// What a Workstation says of the bundle it serves. Signed by the
/// publisher at build time, carried unchanged.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BundleManifest {
    /// SHA-256 of the archive, lowercase hex. Also the name the shell
    /// caches it under.
    pub hash: String,
    /// The archive's length in bytes.
    pub size: u64,
    /// Ed25519 over `signing_message(hash)`, lowercase hex.
    pub signature: String,
    /// The Ed25519 public key the signature verifies under, lowercase
    /// hex. The shell compares it with the keys it trusts; a key it does
    /// not trust is refused before the signature is looked at.
    pub signer: String,
    /// `BUNDLE_FORMAT_TAR`. A reader refuses a format it does not know.
    pub format: String,
    /// The Gavin version that built it. For the logs; nothing is decided
    /// on it.
    #[serde(default)]
    pub gavin_version: String,
}

/// Why a bundle was not accepted. Each is a sentence the shell can show.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BundleRefusal {
    /// The manifest is not one this reader can use.
    Malformed(String),
    /// The archive is not the one the manifest names.
    HashMismatch,
    /// The manifest's signer is not a key the caller trusts.
    UntrustedSigner,
    /// The signature does not verify under the signer.
    BadSignature,
}

impl std::fmt::Display for BundleRefusal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            BundleRefusal::Malformed(why) => write!(f, "the bundle's manifest cannot be read: {why}"),
            BundleRefusal::HashMismatch => f.write_str("the bundle is not the one its manifest names"),
            BundleRefusal::UntrustedSigner => {
                f.write_str("the bundle was signed by a key this Companion does not trust")
            }
            BundleRefusal::BadSignature => f.write_str("the bundle's signature does not verify"),
        }
    }
}

impl std::error::Error for BundleRefusal {}

/// The bytes a bundle signature is made over.
pub fn signing_message(hash: &[u8; 32]) -> Vec<u8> {
    let mut message = Vec::with_capacity(BUNDLE_SIGNING_DOMAIN.len() + 32);
    message.extend_from_slice(BUNDLE_SIGNING_DOMAIN);
    message.extend_from_slice(hash);
    message
}

pub fn archive_hash(archive: &[u8]) -> [u8; 32] {
    Sha256::digest(archive).into()
}

/// The public half of a signing seed.
pub fn public_key(seed: &[u8; 32]) -> [u8; 32] {
    SigningKey::from_bytes(seed).verifying_key().to_bytes()
}

/// Signs a bundle: the manifest for `archive` under `seed`.
pub fn sign(archive: &[u8], seed: &[u8; 32], gavin_version: &str) -> BundleManifest {
    let hash = archive_hash(archive);
    let key = SigningKey::from_bytes(seed);
    let signature = key.sign(&signing_message(&hash));
    BundleManifest {
        hash: hex_encode(&hash),
        size: archive.len() as u64,
        signature: hex_encode(&signature.to_bytes()),
        signer: hex_encode(&key.verifying_key().to_bytes()),
        format: BUNDLE_FORMAT_TAR.to_string(),
        gavin_version: gavin_version.to_string(),
    }
}

fn fixed<const N: usize>(field: &str, hex: &str) -> Result<[u8; N], BundleRefusal> {
    let bytes = hex_decode(hex).map_err(|_| BundleRefusal::Malformed(format!("{field} is not hex")))?;
    bytes
        .try_into()
        .map_err(|_| BundleRefusal::Malformed(format!("{field} is not {N} bytes")))
}

/// What a manifest must hold before an archive is even looked at: the
/// shell checks this on the manifest alone, before fetching a byte.
pub fn check_manifest(manifest: &BundleManifest) -> Result<(), BundleRefusal> {
    if manifest.format != BUNDLE_FORMAT_TAR {
        return Err(BundleRefusal::Malformed(format!(
            "its format is {:?}, and this reader knows only {BUNDLE_FORMAT_TAR:?}",
            manifest.format
        )));
    }
    if manifest.size > BUNDLE_SIZE_MAX {
        return Err(BundleRefusal::Malformed(format!(
            "it claims {} bytes, more than the {BUNDLE_SIZE_MAX} a Device will fetch",
            manifest.size
        )));
    }
    fixed::<32>("hash", &manifest.hash)?;
    fixed::<32>("signer", &manifest.signer)?;
    fixed::<64>("signature", &manifest.signature)?;
    Ok(())
}

/// Whether the manifest's signer is one of `trusted`. Checked before the
/// archive is fetched too: a bundle from a key the shell does not trust
/// is not worth the download.
pub fn signer_is_trusted(manifest: &BundleManifest, trusted: &[[u8; 32]]) -> Result<(), BundleRefusal> {
    let signer = fixed::<32>("signer", &manifest.signer)?;
    if trusted.contains(&signer) {
        Ok(())
    } else {
        Err(BundleRefusal::UntrustedSigner)
    }
}

/// Accepts `archive` only if it is the one `manifest` names and the
/// signature checks under a key in `trusted`.
pub fn verify(archive: &[u8], manifest: &BundleManifest, trusted: &[[u8; 32]]) -> Result<(), BundleRefusal> {
    check_manifest(manifest)?;
    signer_is_trusted(manifest, trusted)?;
    let hash = fixed::<32>("hash", &manifest.hash)?;
    if archive.len() as u64 != manifest.size || archive_hash(archive) != hash {
        return Err(BundleRefusal::HashMismatch);
    }
    let signer = fixed::<32>("signer", &manifest.signer)?;
    let key = VerifyingKey::from_bytes(&signer).map_err(|_| BundleRefusal::UntrustedSigner)?;
    let signature = Signature::from_bytes(&fixed::<64>("signature", &manifest.signature)?);
    key.verify(&signing_message(&hash), &signature).map_err(|_| BundleRefusal::BadSignature)
}

// ---- the archive -------------------------------------------------------

/// One file of a bundle, as unpacked.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BundleFile {
    /// Relative, `/`-separated, and safe to join under a folder.
    pub path: String,
    pub data: Vec<u8>,
}

const BLOCK: usize = 512;

/// Whether `path` may name a file inside the folder a bundle is unpacked
/// into: relative, with no segment that goes up or nowhere, and none of
/// the characters an operating system reads as something else.
pub fn is_safe_path(path: &str) -> bool {
    !path.is_empty()
        && path.len() <= 255
        && !path.starts_with('/')
        && !path.contains('\\')
        && !path.contains('\0')
        && path.split('/').all(|segment| !segment.is_empty() && segment != "." && segment != "..")
}

fn octal(field: &[u8]) -> Result<u64, String> {
    let text: String = field
        .iter()
        .take_while(|b| **b != 0 && **b != b' ')
        .map(|b| *b as char)
        .collect();
    let text = text.trim_start_matches(' ');
    if text.is_empty() {
        return Ok(0);
    }
    u64::from_str_radix(text, 8).map_err(|_| format!("a header field is not octal: {text:?}"))
}

fn cstr(field: &[u8]) -> Result<&str, String> {
    let end = field.iter().position(|b| *b == 0).unwrap_or(field.len());
    std::str::from_utf8(&field[..end]).map_err(|_| "a header name is not UTF-8".to_string())
}

fn header_checksum(header: &[u8]) -> u64 {
    header
        .iter()
        .enumerate()
        .map(|(i, b)| if (148..156).contains(&i) { b' ' as u64 } else { *b as u64 })
        .sum()
}

/// The files of a bundle archive (`pack`'s output, or the Node packer's).
/// Refuses what a bundle never holds -- links, device nodes, extended
/// headers -- and any path `is_safe_path` would not join.
pub fn unpack(archive: &[u8]) -> Result<Vec<BundleFile>, String> {
    if archive.len() % BLOCK != 0 {
        return Err("the archive is not a whole number of blocks".to_string());
    }
    let mut files = Vec::new();
    let mut at = 0;
    while at + BLOCK <= archive.len() {
        let header = &archive[at..at + BLOCK];
        if header.iter().all(|b| *b == 0) {
            // The end marker, or padding after it. Nothing follows.
            break;
        }
        if octal(&header[148..156])? != header_checksum(header) {
            return Err("a header's checksum does not match".to_string());
        }
        if &header[257..262] != b"ustar" {
            return Err("an entry is not ustar".to_string());
        }
        let name = cstr(&header[0..100])?;
        let prefix = cstr(&header[345..500])?;
        let path = if prefix.is_empty() { name.to_string() } else { format!("{prefix}/{name}") };
        let size = octal(&header[124..136])? as usize;
        let typeflag = header[156];
        at += BLOCK;
        let data_end = at.checked_add(size).ok_or("an entry's size overflows")?;
        if data_end > archive.len() {
            return Err(format!("the entry {path:?} claims more bytes than the archive holds"));
        }
        match typeflag {
            b'0' | 0 => {
                if !is_safe_path(&path) {
                    return Err(format!("the entry {path:?} is not a path a bundle may hold"));
                }
                files.push(BundleFile { path, data: archive[at..data_end].to_vec() });
            }
            b'5' => {
                if size != 0 {
                    return Err(format!("the directory {path:?} claims a size"));
                }
            }
            other => {
                return Err(format!(
                    "the entry {path:?} is of a kind a bundle never holds (type {:?})",
                    other as char
                ));
            }
        }
        at = data_end.div_ceil(BLOCK) * BLOCK;
    }
    Ok(files)
}

/// A bundle archive of `files`, the same bytes for the same input: paths
/// sorted, every header's mode `0644`, owner `0`, mtime `0`. The Node
/// packer writes the same, so both builds of one commit hash alike.
pub fn pack(files: &[(&str, &[u8])]) -> Result<Vec<u8>, String> {
    let mut sorted: Vec<(&str, &[u8])> = files.to_vec();
    sorted.sort_by(|a, b| a.0.cmp(b.0));
    let mut out = Vec::new();
    for (path, data) in sorted {
        if !is_safe_path(path) {
            return Err(format!("{path:?} is not a path a bundle may hold"));
        }
        let (prefix, name) = split_name(path)?;
        let mut header = [0u8; BLOCK];
        header[..name.len()].copy_from_slice(name.as_bytes());
        header[100..108].copy_from_slice(b"0000644\0");
        header[108..116].copy_from_slice(b"0000000\0");
        header[116..124].copy_from_slice(b"0000000\0");
        header[124..136].copy_from_slice(format!("{:011o}\0", data.len()).as_bytes());
        header[136..148].copy_from_slice(b"00000000000\0");
        header[156] = b'0';
        header[257..263].copy_from_slice(b"ustar\0");
        header[263..265].copy_from_slice(b"00");
        header[345..345 + prefix.len()].copy_from_slice(prefix.as_bytes());
        let checksum = header_checksum(&header);
        header[148..156].copy_from_slice(format!("{checksum:06o}\0 ").as_bytes());
        out.extend_from_slice(&header);
        out.extend_from_slice(data);
        out.resize(out.len().div_ceil(BLOCK) * BLOCK, 0);
    }
    out.resize(out.len() + 2 * BLOCK, 0);
    Ok(out)
}

/// A ustar name is 100 bytes, and a longer path is split at a `/` into
/// a prefix of at most 155 and a name of at most 100.
fn split_name(path: &str) -> Result<(&str, &str), String> {
    if path.len() <= 100 {
        return Ok(("", path));
    }
    for (i, c) in path.char_indices() {
        if c == '/' && i <= 155 && path.len() - i - 1 <= 100 {
            return Ok((&path[..i], &path[i + 1..]));
        }
    }
    Err(format!("{path:?} is too long for a ustar entry"))
}

// ---- chunks ------------------------------------------------------------

/// One chunk of the archive, as `CompanionBundle.data` carries it.
pub fn encode_chunk(bytes: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

pub fn decode_chunk(data: &str) -> Result<Vec<u8>, String> {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD
        .decode(data)
        .map_err(|e| format!("a bundle chunk is not base64: {e}"))
}

/// The slice of `archive` a `GetCompanionBundle { offset, length }` asks
/// for: at most `BUNDLE_CHUNK_MAX` bytes, and nothing past the end.
pub fn chunk(archive: &[u8], offset: u64, length: u64) -> &[u8] {
    let start = (offset.min(archive.len() as u64)) as usize;
    let end = (offset.saturating_add(length.min(BUNDLE_CHUNK_MAX))).min(archive.len() as u64) as usize;
    &archive[start..end]
}

#[cfg(test)]
mod tests {
    use super::*;

    const SEED: [u8; 32] = [7u8; 32];

    fn files() -> Vec<(&'static str, &'static [u8])> {
        vec![
            ("index.html", b"<!doctype html><script src=\"_app/a.js\"></script>" as &[u8]),
            ("_app/a.js", b"console.log(1)\n"),
            ("_app/immutable/assets/0.css", b""),
        ]
    }

    #[test]
    fn pack_and_unpack_round_trip_sorted_and_padded() {
        let archive = pack(&files()).unwrap();
        assert_eq!(archive.len() % 512, 0);
        let out = unpack(&archive).unwrap();
        let paths: Vec<&str> = out.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(paths, ["_app/a.js", "_app/immutable/assets/0.css", "index.html"]);
        assert_eq!(out[0].data, b"console.log(1)\n");
        assert_eq!(out[1].data, b"");
    }

    #[test]
    fn packing_is_deterministic() {
        let a = pack(&files()).unwrap();
        let mut reversed = files();
        reversed.reverse();
        let b = pack(&reversed).unwrap();
        assert_eq!(a, b);
    }

    #[test]
    fn the_fixture_pins_the_node_packer_to_this_one() {
        // test-fixtures/companion-bundle/: the same files, and the hash the
        // Node packer's output must have. Both suites read this file.
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../test-fixtures/companion-bundle");
        let expected: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(root.join("expected.json")).unwrap()).unwrap();
        let mut entries = Vec::new();
        for path in expected["files"].as_array().unwrap() {
            let path = path.as_str().unwrap().to_string();
            let data = std::fs::read(root.join("files").join(&path)).unwrap();
            entries.push((path, data));
        }
        let borrowed: Vec<(&str, &[u8])> = entries.iter().map(|(p, d)| (p.as_str(), d.as_slice())).collect();
        let archive = pack(&borrowed).unwrap();
        assert_eq!(hex_encode(&archive_hash(&archive)), expected["archiveSha256"].as_str().unwrap());
        // The archive itself is in the fixture too, for the shell's suite,
        // which has no packer: it must be this one.
        assert_eq!(decode_chunk(expected["archiveBase64"].as_str().unwrap()).unwrap(), archive);
        // And a manifest the Node signer wrote over that archive verifies.
        let manifest: BundleManifest = serde_json::from_value(expected["manifest"].clone()).unwrap();
        let signer: [u8; 32] = hex_decode(&manifest.signer).unwrap().try_into().unwrap();
        verify(&archive, &manifest, &[signer]).unwrap();
        // ...and is the one this signer writes under the same seed.
        let seed: [u8; 32] = hex_decode(expected["seed"].as_str().unwrap()).unwrap().try_into().unwrap();
        assert_eq!(sign(&archive, &seed, &manifest.gavin_version), manifest);
    }

    #[test]
    fn unpack_refuses_what_a_bundle_never_holds() {
        let mut archive = pack(&files()).unwrap();
        // A symlink entry.
        archive[156] = b'2';
        let checksum = header_checksum(&archive[..512]);
        archive[148..156].copy_from_slice(format!("{checksum:06o}\0 ").as_bytes());
        assert!(unpack(&archive).unwrap_err().contains("never holds"));

        // A path that leaves the folder, written straight into a header.
        let mut escaping = pack(&[("a.js", b"x")]).unwrap();
        escaping[..6].copy_from_slice(b"../a.j");
        escaping[6] = b's';
        let checksum = header_checksum(&escaping[..512]);
        escaping[148..156].copy_from_slice(format!("{checksum:06o}\0 ").as_bytes());
        assert!(unpack(&escaping).unwrap_err().contains("not a path"));

        // A corrupted byte fails the checksum.
        let mut corrupt = pack(&files()).unwrap();
        corrupt[3] ^= 0xff;
        assert!(unpack(&corrupt).unwrap_err().contains("checksum"));

        // A size past the end.
        let mut truncated = pack(&[("a.js", &[1u8; 700])]).unwrap();
        truncated.truncate(512 + 512);
        assert!(unpack(&truncated).unwrap_err().contains("more bytes"));

        assert!(unpack(&[1u8; 100]).is_err());
        assert_eq!(unpack(&[0u8; 1024]).unwrap(), vec![]);
    }

    #[test]
    fn safe_paths() {
        for ok in ["index.html", "_app/immutable/chunks/a.js", "a b.txt", "ünïcode.js"] {
            assert!(is_safe_path(ok), "{ok}");
        }
        for bad in ["", "/etc/passwd", "../x", "a/../b", "a//b", "./a", "a/", "a\\b", "a\0b"] {
            assert!(!is_safe_path(bad), "{bad:?}");
        }
    }

    #[test]
    fn long_names_use_the_prefix() {
        let dir = "d".repeat(120);
        let path = format!("{dir}/f.js");
        let archive = pack(&[(path.as_str(), b"x")]).unwrap();
        let out = unpack(&archive).unwrap();
        assert_eq!(out[0].path, path);
        let too_long = format!("{}/{}", "p".repeat(160), "n".repeat(120));
        assert!(pack(&[(too_long.as_str(), b"x")]).is_err());
    }

    #[test]
    fn a_signed_bundle_verifies_under_its_signer_and_under_no_other() {
        let archive = pack(&files()).unwrap();
        let manifest = sign(&archive, &SEED, "0.1.0");
        let signer = public_key(&SEED);
        assert_eq!(manifest.signer, hex_encode(&signer));
        assert_eq!(manifest.size, archive.len() as u64);
        verify(&archive, &manifest, &[signer]).unwrap();
        verify(&archive, &manifest, &[[1u8; 32], signer]).unwrap();

        // The publisher key alone: a dev-key bundle is refused, before the
        // signature is even looked at.
        assert_eq!(verify(&archive, &manifest, &[public_key(&[9u8; 32])]), Err(BundleRefusal::UntrustedSigner));
        assert_eq!(signer_is_trusted(&manifest, &[]), Err(BundleRefusal::UntrustedSigner));
    }

    #[test]
    fn a_bad_signature_or_a_changed_archive_is_refused() {
        let archive = pack(&files()).unwrap();
        let manifest = sign(&archive, &SEED, "0.1.0");
        let signer = public_key(&SEED);

        let mut forged = manifest.clone();
        let mut sig = hex_decode(&forged.signature).unwrap();
        sig[10] ^= 1;
        forged.signature = hex_encode(&sig);
        assert_eq!(verify(&archive, &forged, &[signer]), Err(BundleRefusal::BadSignature));

        // Signed by a trusted key, but over another archive's hash.
        let other = pack(&[("index.html", b"other")]).unwrap();
        let swapped = sign(&other, &SEED, "0.1.0");
        assert_eq!(verify(&archive, &swapped, &[signer]), Err(BundleRefusal::HashMismatch));

        // The archive changed under a manifest that names the original.
        let mut changed = archive.clone();
        let last = changed.len() - 1;
        changed[last] ^= 1;
        assert_eq!(verify(&changed, &manifest, &[signer]), Err(BundleRefusal::HashMismatch));

        // A manifest claiming the right hash under a key that never signed
        // it: the attacker's own key is not trusted, and a trusted key's
        // signature over a stranger's hash does not exist.
        let mut resigned = manifest.clone();
        resigned.signer = hex_encode(&public_key(&[3u8; 32]));
        assert_eq!(verify(&archive, &resigned, &[signer]), Err(BundleRefusal::UntrustedSigner));
    }

    #[test]
    fn a_malformed_manifest_is_refused_on_its_own() {
        let archive = pack(&files()).unwrap();
        let good = sign(&archive, &SEED, "0.1.0");
        let signer = public_key(&SEED);

        let mut m = good.clone();
        m.format = "zip".into();
        assert!(matches!(check_manifest(&m), Err(BundleRefusal::Malformed(_))));

        let mut m = good.clone();
        m.size = BUNDLE_SIZE_MAX + 1;
        assert!(matches!(check_manifest(&m), Err(BundleRefusal::Malformed(_))));

        let mut m = good.clone();
        m.hash = "zz".into();
        assert!(matches!(verify(&archive, &m, &[signer]), Err(BundleRefusal::Malformed(_))));

        let mut m = good.clone();
        m.signature = "ab".into();
        assert!(matches!(verify(&archive, &m, &[signer]), Err(BundleRefusal::Malformed(_))));

        // The manifest reads with a field it has never heard of, and
        // without `gavinVersion`: growth is by optional fields.
        let json = serde_json::json!({
            "hash": good.hash, "size": good.size, "signature": good.signature,
            "signer": good.signer, "format": "tar", "compression": "none"
        });
        let read: BundleManifest = serde_json::from_value(json).unwrap();
        assert_eq!(read.gavin_version, "");
        verify(&archive, &read, &[signer]).unwrap();
    }

    #[test]
    fn chunks_are_capped_and_never_past_the_end() {
        let archive: Vec<u8> = (0..1000u32).map(|i| i as u8).collect();
        assert_eq!(chunk(&archive, 0, 10), &archive[..10]);
        assert_eq!(chunk(&archive, 990, 100), &archive[990..]);
        assert_eq!(chunk(&archive, 2000, 100), &[] as &[u8]);
        assert_eq!(chunk(&archive, 0, u64::MAX).len(), 1000);
        let big = vec![0u8; BUNDLE_CHUNK_MAX as usize + 5];
        assert_eq!(chunk(&big, 0, u64::MAX).len(), BUNDLE_CHUNK_MAX as usize);
        assert_eq!(chunk(&big, u64::MAX - 1, 10), &[] as &[u8]);
        let text = encode_chunk(&archive[..7]);
        assert_eq!(decode_chunk(&text).unwrap(), &archive[..7]);
        assert!(decode_chunk("not base64!").is_err());
    }
}
