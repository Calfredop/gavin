use std::path::PathBuf;

fn main() {
    // tauri-build only watches tauri.conf.json, not the icon files, so a
    // regenerated icon never re-embeds into the dev binary (the macOS dev
    // Dock icon is baked in at compile time via generate_context!).
    println!("cargo:rerun-if-changed=icons");
    embed_companion_bundle();
    tauri_build::build()
}

/// The Companion UI bundle this build carries, if `stage-companion.mjs`
/// staged one (ADR 0005, companion-23): the archive and its signed
/// manifest, written to `$OUT_DIR/companion_bundle.rs` for
/// `src/companion_bundle.rs` to include.
///
/// A missing staging is not an error here. `beforeDevCommand` and
/// `beforeBuildCommand` both run the staging first, so a `tauri dev` or a
/// `tauri build` always carries one; a bare `cargo build` or `cargo test
/// --workspace` on a clean checkout has none, and must keep compiling --
/// the same reason `externalBin` lives in the bundle overlay. Such a
/// build serves no bundle and tells a Device so.
fn embed_companion_bundle() {
    let manifest_dir = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
    let staged = manifest_dir.join("companion");
    let archive = staged.join("bundle.tar");
    let manifest = staged.join("bundle.json");
    // Watched whether or not they exist: staging one after a build that
    // had none must trigger a rebuild, and so must removing it.
    println!("cargo:rerun-if-changed={}", archive.display());
    println!("cargo:rerun-if-changed={}", manifest.display());
    let body = if archive.is_file() && manifest.is_file() {
        format!(
            "pub const ARCHIVE: Option<&[u8]> = Some(include_bytes!({:?}));\n\
             pub const MANIFEST_JSON: Option<&str> = Some(include_str!({:?}));\n",
            archive.display().to_string(),
            manifest.display().to_string(),
        )
    } else {
        "pub const ARCHIVE: Option<&[u8]> = None;\npub const MANIFEST_JSON: Option<&str> = None;\n".to_string()
    };
    let out = PathBuf::from(std::env::var("OUT_DIR").expect("OUT_DIR")).join("companion_bundle.rs");
    std::fs::write(&out, body).expect("write companion_bundle.rs");
}
