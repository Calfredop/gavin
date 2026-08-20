---
title: Custom app icon (terminal + "> G")
status: Done
priority: low
---
# Custom app icon (terminal + "> G")

Replace the default Tauri icon set in `app/src-tauri/icons/` with a custom
icon: a macOS-style rounded-square terminal window showing a `>` prompt and
the letter `G`.

## Steps

- [x] Author a 1024×1024 SVG source (kept in `app/src-tauri/icons/icon.svg`)
- [x] Render to PNG with rsvg-convert
- [x] Regenerate the full icon set with `tauri icon`
- [x] Verify the icons render correctly (visual check of generated PNGs)
- [x] Dev-mode Dock icon: watch `icons/` in build.rs so icon changes re-embed
      into the dev binary (tauri-build doesn't watch icon files)
- [x] App name "Gavin" in Dock/taskbar: productName + window title in
      tauri.conf.json, and `[[bin]] name = "Gavin"` so the dev process name
      (which macOS shows for unbundled binaries) reads Gavin too
