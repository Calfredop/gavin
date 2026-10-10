---
order: 13312
kind: task
title: Driving the Companion on a real iPhone needs a loopback-only inspector path
status: Done
priority: medium
complexity: moderate
---
Found while running `companion-iphone-smoke-tests.md` on a physical iPhone 16 Pro (iOS 27.0).

**The gap.** Every Companion script (`probe.sh`, `keys.sh`, `pair.sh`, `hub.sh`) drives a Simulator or an emulator, where `simctl` and `adb` can tap and screenshot. A physical iPhone has neither, so an agent can only install, launch and read the console. The debug build's shell webview IS inspectable (Capacitor, `capacitor://localhost` shows up), and so is the bundle webview (`BundleViewController.swift`, `isInspectable = true` under `#if DEBUG`), so the page could be driven through Web Inspector.

**The trap.** `ios_webkit_debug_proxy` (Homebrew 1.9.2) has no bind-address option. `-u <udid>` listens on `*:9222` and `*:9221`. Measured on this Mac: with the macOS application firewall ON, `curl http://192.168.68.125:9222/json` from the Mac's own LAN address still answered `HTTP 200` and listed the page with its `webSocketDebuggerUrl`. That socket can evaluate JS in the shell webview, which holds the Device's Noise private key (a debug build also logs it, see the README's "A debug build logs every plugin answer") and, while unlocked, a live connection to the Workstation. Anyone on the LAN could drive the owner's Companion. The proxy was stopped within minutes and confirmed closed (`curl` refused).

**What to build.**
- A way to drive and read the webview of a physical device that listens on 127.0.0.1 only. Options: a small forwarder in `app/companion-shell/scripts/` that talks usbmuxd and the `com.apple.webinspector` service itself; or wrapping the proxy behind a pf rule the script installs and removes; or `pymobiledevice3 webinspector` if it can bind loopback. Pick by measuring each: it must refuse `curl http://<lan-ip>:<port>/json`.
- A `scripts/device-drive.sh ios-device <udid>` (or similar) that builds and installs a signed debug app (`DEVELOPMENT_TEAM` from env, never committed), launches it with `devicectl`, and exposes the loopback inspector.
- Note in `docs/companion-mobile.md` and the shell README: the device path, the proxy's bind trap, and that a physical phone's Face ID prompt still needs the owner.

**Acceptance.**
- [x] From the Mac's LAN address the inspector port is refused; from 127.0.0.1 the shell's page lists
- [x] The script can read the hub's DOM and click a hub button on the device
- [x] Docs name the trap

**Done 2026-10-09** (uncommitted; measured on the iPhone 16 Pro, iOS 27.0, `00008140-000E69260813C01C`).
- Picked `pymobiledevice3` (11.26.0, already the touch recorder's venv) over a pf rule and over a hand-written usbmuxd forwarder: it reaches `com.apple.webinspector` through the Mac's own usbmuxd, and its `webinspector cdp` binds `127.0.0.1` by default. But that bridge checks neither Host nor Origin, so a web page in a browser on this Mac could still open its WebSocket (no CORS on WebSockets) or read `/json` through a rebound DNS name. `scripts/device-inspector.py` runs the same bridge behind an ASGI guard: Host must be `127.0.0.1:<port>`/`localhost:<port>` (else 403), and a WebSocket Origin, if sent, must be that server (else 403); Playwright/Puppeteer send none.
- `scripts/device-drive.sh ios-device <udid> [install|launch|inspector|eval|dom|click]`. `install` signs with `DEVELOPMENT_TEAM` from the env, syncs, builds, `devicectl` installs and launches. `inspector` (default port 9322) refuses a port already taken, then measures its own pid's listening sockets with `lsof` and curls every non-127 `ifconfig` address, and stops itself if any answers. `dom`/`click`/`eval` go through `webview-eval.py` and open no port. `touch-recorder.sh` now evaluates through `device-drive.sh eval`.
- Measured: `/json` on `127.0.0.1:9322` listed `capacitor://localhost` with its `webSocketDebuggerUrl`; `100.79.93.51`, `192.168.68.125`, `169.254.97.98` refused (curl exit 7); `Host: rebind.example` → 403; a WebSocket upgrade with `Origin: https://evil.example` → 403, without Origin → 101. `dom` read the unlocked hub's inbox; `click "Demo Workstation"` opened `gavin-bundle://demo/` on the phone; `click Workstations gavin-bundle://` brought it back to the hub. A SIGTERM leaves no Python behind.
- Traps found on the way: port 9222 was already held by another session's `adb forward` (an Android webview's DevTools) — a readiness curl against it "succeeded" against the wrong server, hence the default 9322 and the taken-port refusal. A launch on a locked phone is refused (`devicectl` … `Locked`); unlock first. Face ID still needs the owner.
- Docs: shell README "A physical iPhone" + a Traps entry for `ios_webkit_debug_proxy`; `docs/companion-mobile.md` "Drive a physical iPhone" + the Related scripts row.
