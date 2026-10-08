---
order: 14336
kind: task
title: Driving the Companion on a real iPhone needs a loopback-only inspector path
status: To Do
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
- [ ] From the Mac's LAN address the inspector port is refused; from 127.0.0.1 the shell's page lists
- [ ] The script can read the hub's DOM and click a hub button on the device
- [ ] Docs name the trap
