---
kind: task
title: [feat] installers — Windows cross-compile on the Mac
parent: feat-installers.md
complexity: intricate
---
Make this Mac build Gavin's Windows x64 NSIS installer, for the parent plan's Preview build. The toolchain is already installed: `cargo-xwin`, Homebrew `llvm` and `nsis`, and the `x86_64-pc-windows-msvc` target. Use Tauri's documented route, `tauri build --runner cargo-xwin --target x86_64-pc-windows-msvc`, through `app/src-tauri/bundle.mjs` so the build number is stamped.

Known snag: `stage-sidecars.mjs` stages `gavin-daemon` and `gavin-mcp` under the host triple from `rustc -vV`. Give it a target mode that builds them for the Windows target with the same runner and stages them under that triple. Keep `externalBin` out of `tauri.conf.json` (`app/src-tauri/BUNDLING.md` explains why), and keep the macOS and native Windows builds working unchanged. Work in a worktree, never the shared checkout's `target/`.

**Done when** a `…-setup.exe` comes out, `file` reports a PE32+ executable, and its payload (listed with `7z l`) contains `gavin.exe`, `gavin-daemon.exe` and `gavin-mcp.exe`. Then file `Human test: install the cross-compiled setup .exe on Windows 11 and launch it; a session starts and the gavin_* tools answer` on the parent card (`gavin_request_human`).

**If it can't be made to work** (a crate that won't build under `clang-cl`, an NSIS step that only runs on Windows), stop. Write what failed and why under a `## Conclusion` heading in this card. The parent then falls back to uploading an `.exe` built on the Windows machine. Don't sink time into workarounds past a clear blocker.

## Conclusion

It works (2026-10-13). `node src-tauri/bundle.mjs --runner cargo-xwin --target x86_64-pc-windows-msvc` in a worktree at `~/Library/Caches/gavin-preview` produced `Gavin_0.1.0_x64-setup.exe` (17 MB). `7zz l` lists `Gavin.exe`, `gavin-daemon.exe` and `gavin-mcp.exe` in its payload, and each one unpacks as PE32+ x86-64.

- **Sidecars:** `stage-sidecars.mjs` now stages under Tauri's target triple (`TAURI_ENV_TARGET_TRIPLE`). When that differs from the host, it builds with `--target` through the app's runner, which `bundle.mjs` passes on as `GAVIN_CARGO_RUNNER`. Native builds are unchanged, and `stage-sidecars.test.mjs` pins that.
- **`makensis` needs a UTF-8 locale.** Homebrew's `makensis` 3.12 and 3.13 abort with `std::bad_alloc` on any `Exch` or `Pop` under the C locale. A shell with no `LANG` runs in that locale. The build sets `LC_ALL=en_US.UTF-8` for this step.
- **The "PE32+" check needed changing:** `file` reports the setup `.exe` as *PE32 … Nullsoft Installer*, because every NSIS installer is a 32-bit stub. The 64-bit check is done on the payload instead.

What's written up is in `app/src-tauri/BUNDLING.md`, "Cross-compiling the Windows installer on a Mac". The parent builds the Windows installer this way, so it needs no `--windows-exe` fallback.
