---
order: 22528
kind: task
title: Companion 21: the shell pairs with a real Workstation
status: Done
labels: ready-for-agent
parent: companion.md
complexity: complex
---
Blocked by: companion-20-shell-device-keys.md, companion-11-connect-ik-unlock.md, companion-03-protocol-wasm.md

Part of `companion.md`. Read the spec (sections "The Companion core", "Pairing and the trust store" and "The Companion shell") first.

## What to build

- **The core in the shell.** The Companion core, compiled to WASM, runs in the shell.
- **The pairing flow:**
  1. Scan the pairing QR code.
  2. Run the pairing handshake through the Relay it names, with its admission token.
  3. Show the six digits, to compare with the desk.
  4. Send the hardware public key from ticket 20.
- **The result.** When the desk confirms, the Workstation appears in the Workstations hub.

## Acceptance criteria

- [x] The WASM core builds in the shell's pipeline
- [x] A scripted pairing against a dev daemon and a local Relay completes (use the dev stack from ticket 17 if it exists)
- [x] The Workstation is persisted in the hub across app restarts

When done, file a human test: pair a real phone with the dev desktop; the codes match, the Workstation appears in the hub, and the Devices panel lists the phone.

## Plan

Branch `companion/phone` (worktree `.gavin-worktrees/companion-phone`). Ticket 17's dev stack does not exist yet, so the scripted pairing brings its own: the `gavin-relay` binary on loopback and an isolated daemon under a temporary `$HOME`.

- [x] `crates/companion-wasm`: the core's face for the shell -- a plain C ABI (no wasm-bindgen, so no extra tool in the pipeline), JSON in and out, one exchange per instance; the hardware-sign message stripped to the bare hash the native plugins take; native unit tests
- [x] The shell's pipeline builds it (`scripts/core.mjs` from `companion-shell:build`/`test`), CI gets the wasm target
- [x] `src/shell/core/`: loads the module and wraps it, tested in vitest against the real `.wasm`
- [x] `src/shell/pairing/`: the pairing driver (keys, Relay dial over the webview's WebSocket, handshake, sign, code, verdict) as a pure module with fakes, plus the Device name
- [x] `src/shell/hub/`: paired Workstations as records (id, default name, validation), persisted through a native store, listed in the hub
- [x] Native: `QrScanner` plugin (AVFoundation on iOS, Google code scanner on Android) with a debug-only scripted QR; `Workstations` store (keychain / Keystore-sealed file), wiped with the keys; Info.plist, manifest, CSP (`wasm-unsafe-eval`, `ws:`/`wss:`)
- [x] Hub UI: "Pair a Workstation", the pairing sheet (connecting, confirm on the phone, the six digits, paired with a name, failures)
- [x] Scripted pairing: `scripts/devstack.mjs` (relay + isolated daemon + the desk), a node end-to-end run of the shell's own pairing module, and `scripts/pair.sh ios <udid>` on a Simulator including a relaunch that still lists the Workstation (and `android <serial>` on an emulator)
- [x] README, suites, human test filed
- [ ] Decision: A release Android build lets ws:// through only to loopback, so a self-hosted Relay on the LAN must be wss:// there, while a debug build (and iOS, via NSAllowsLocalNetworking) allows ws:// to the LAN. Keep that, or let release Android allow ws:// to the LAN too (cleartext permitted app-wide; the core still refuses ws:// to public hosts)?
  Options: A) Keep: release Android needs wss:// beyond loopback B) Allow ws:// to the LAN in release Android too C) Tighten iOS release to match: wss:// beyond loopback
- [ ] Human test: Pair a real phone with the dev desktop (debug build from Xcode or Android Studio; Relay and settings as in app/companion-shell/README.md, "Pairing"): tap Pair a Workstation, scan the desk's code, confirm with Face ID or fingerprint; the six digits on the phone match the desk's; after Confirm at the desk the phone says Paired and the Workstation appears in the hub, still there after force-quitting the app; and the desk's device list shows the phone.

## Outcome

Uncommitted on `companion/phone` (worktree `.gavin-worktrees/companion-phone`). The shell README's new sections "The Companion core" and "Pairing" have the design.

- **The core in the shell.** New crate `crates/companion-wasm`: the Companion core behind a plain C ABI with JSON across it (`gavin_alloc` / `gavin_call` / `gavin_output`), importing nothing, one exchange per instance. No wasm-bindgen, so the pipeline needs cargo and the target and nothing else. `app/companion-shell/scripts/core.mjs` builds it with a new workspace profile `companion-wasm` (369 KB) into `static/companion-core.wasm`; `companion-shell:build`, `:test` and `:dev` run it first, and CI's Linux job gets the wasm target (the `wasm` job also links it). The page's CSP gains `'wasm-unsafe-eval'` and `ws:`/`wss:`.
- **The flow** (`src/shell/pairing/`): keys (refused on a phone that cannot be a Device, made at the first pairing), the core reads the code before anything is dialled, the first Relay answering `ready` carries the handshake over the webview's WebSocket, the hardware key signs (one prompt), the six digits show after the Workstation takes the proof, and the verdict. Every failure is said in words for the human (the core's own where it has them).
- **Native.** `QrScanner` (iOS: an AVFoundation scanner of the shell's own; Android: Google's code scanner, no camera permission). `Workstations`, the paired Workstations' store (iOS: a keychain item each, after-first-unlock, this device only; Android: one Keystore-sealed file in `noBackupFilesDir`), deleted with the Device's keys and on reinstall. Registered on the shell's bridge only; the bundle probe now also tries both from inside a bundle.
- **The hub** lists paired Workstations above the Demo ("Paired", not yet openable: companion-22/23), with "Pair a Workstation" and a pairing sheet; a new Workstation is named "Workstation" (then "Workstation 2") and can be renamed on the spot.
- **Proof.**
  - `cargo test -p companion-wasm`: 11 pass (the JSON face against a `snow` Workstation). Shell vitest: 134 pass, including the core wrapper against the real `.wasm`; `companion-shell:check` 0 errors; `companion-shell:build` carries the core.
  - `scripts/pair.sh node`: the shell's own pairing module and the real core in Node, against a real daemon (temp `$HOME`) through a real `gavin-relay`: paired with matching codes, declined by the desk, and a spent code refused. 3 pass.
  - `scripts/pair.sh ios 495B6D14…` (iPhone 17, iOS 26.5): a fresh debug install paired in WKWebView (codes 003207 on both screens, Face ID answered), the desk listed "iPhone", and after a relaunch the hub still listed `ws-a3e37ec491e06162`. Passed.
  - `scripts/pair.sh android emulator-5580 --pin 1234` (API 36): paired through `adb reverse`, codes 762432 on both, the desk listed the emulator, still listed after a restart. Passed.
  - `scripts/probe.sh` on both: 10/10, including the new "the paired Workstations and the camera are out of the bundle's reach".
- **Found on the way.** Android refused the WebView's `ws://` (`net::ERR_CLEARTEXT_NOT_PERMITTED`, visible only in the page console): a network security config now allows cleartext to loopback in a release build and to any host in a debug build (the Decision above asks about release). A desk that stops its Relay right after confirming cuts the verdict off; the dev stack holds it until the phone reports. The bundle probe's one-line verdict outgrew the device log's ~4 KB line; it now logs a line per check.
- **Not verified here:** the camera scanner on either platform (no camera on a Simulator; the emulator run used the scripted code), a real Secure Enclave or StrongBox key, and `ws://` to a LAN Relay (on this Mac the firewall holds a LAN listener behind its prompt). The human test covers all three. A release build's store review of the camera and local-network purpose strings is companion-24's.
