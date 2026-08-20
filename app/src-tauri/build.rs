fn main() {
    // tauri-build only watches tauri.conf.json, not the icon files, so a
    // regenerated icon never re-embeds into the dev binary (the macOS dev
    // Dock icon is baked in at compile time via generate_context!).
    println!("cargo:rerun-if-changed=icons");
    tauri_build::build()
}
