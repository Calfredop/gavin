//! The Companion UI bundle this desktop build carries, and how it is
//! served (ADR 0005, companion-23).
//!
//! `stage-companion.mjs` builds the bundle from this same commit, packs
//! it into an archive, signs it and stages both under
//! `src-tauri/companion/`; `build.rs` embeds them here. A Device asks the
//! daemon for the bundle, the daemon asks this desktop over the forwarding
//! connection (`ForwardBundle`), and `answer` returns the manifest and
//! the asked-for slice of the archive -- the contract and the chunk cap
//! are `protocol::companion_bundle`'s.
//!
//! A build that staged nothing (a bare `cargo build`) carries `None` and
//! answers with no manifest: the Device is told this Workstation serves
//! no UI, rather than being handed a bundle from some other build.

use protocol::companion_bundle::{chunk, encode_chunk};
use protocol::BundleManifest;
use std::sync::OnceLock;

mod embedded {
    include!(concat!(env!("OUT_DIR"), "/companion_bundle.rs"));
}

/// The manifest, parsed once. `None` when nothing was staged, or when
/// what was staged does not parse -- which `stage-companion.mjs` never
/// writes, and which is treated as "no bundle" rather than served.
fn manifest() -> Option<&'static BundleManifest> {
    static PARSED: OnceLock<Option<BundleManifest>> = OnceLock::new();
    PARSED
        .get_or_init(|| {
            let json = embedded::MANIFEST_JSON?;
            match serde_json::from_str::<BundleManifest>(json) {
                Ok(m) => Some(m),
                Err(e) => {
                    eprintln!("gavin: the staged Companion bundle manifest does not parse: {e}");
                    None
                }
            }
        })
        .as_ref()
}

/// What this build carries: the manifest and the archive it names.
pub fn carried() -> Option<(&'static BundleManifest, &'static [u8])> {
    let manifest = manifest()?;
    let archive = embedded::ARCHIVE?;
    if archive.len() as u64 != manifest.size {
        eprintln!(
            "gavin: the staged Companion bundle is {} bytes and its manifest says {}",
            archive.len(),
            manifest.size
        );
        return None;
    }
    Some((manifest, archive))
}

/// The answer to a `ForwardBundle { offset, length }`: the manifest and
/// the slice, base64 -- or no manifest at all.
pub fn answer(offset: u64, length: u64) -> (Option<BundleManifest>, u64, String) {
    match carried() {
        Some((manifest, archive)) => (Some(manifest.clone()), offset, encode_chunk(chunk(archive, offset, length))),
        None => (None, 0, String::new()),
    }
}

/// One line for the log at forwarding start, so a dev build that skipped
/// the staging says so once instead of being found out by a phone.
pub fn describe() -> String {
    match carried() {
        Some((manifest, _)) => format!(
            "Companion bundle {}… ({} bytes, signed by {}…)",
            &manifest.hash[..12],
            manifest.size,
            &manifest.signer[..12]
        ),
        None => "no Companion bundle staged (run `node src-tauri/stage-companion.mjs`); Devices will be told there is none".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Whatever was staged (or not), the answer is consistent with itself:
    /// a manifest that names the archive served, or nothing at all.
    #[test]
    fn the_answer_is_the_manifest_and_a_slice_of_the_archive_it_names() {
        let (manifest, offset, data) = answer(0, 16);
        match (manifest, carried()) {
            (Some(m), Some((carried_manifest, archive))) => {
                assert_eq!(&m, carried_manifest);
                assert_eq!(offset, 0);
                let bytes = protocol::companion_bundle::decode_chunk(&data).unwrap();
                assert_eq!(bytes, &archive[..16.min(archive.len())]);
                assert_eq!(protocol::hex_encode(&protocol::companion_bundle::archive_hash(archive)), m.hash);
                // Past the end: empty, never an error.
                let (_, _, tail) = answer(m.size, 16);
                assert_eq!(tail, "");
            }
            (None, None) => {
                assert_eq!(data, "");
                assert!(describe().contains("no Companion bundle"));
            }
            other => panic!("the answer and what is carried disagree: {other:?}"),
        }
    }
}
