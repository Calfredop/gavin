---
order: 21504
kind: task
title: Companion 20: Device keys in the shell
status: Done
labels: ready-for-agent
parent: companion.md
complexity: complex
---
Blocked by: companion-19-shell-demo.md, companion-02-spike-device-keys.md

Part of `companion.md`. Read the spec (section "The Device's keys and the Unlock"), ADRs 0001 and 0004, and ticket 02's findings in `docs/research/` first.

## What to build

The Device's keys, per ADR 0001 and ticket 02's findings, behind a **shell-only native plugin** that no bundle can reach:

- **The X25519 Noise key**, in the platform keystore, usable on this device only.
- **The hardware-bound P-256 key**, requiring user presence (a biometric, falling back to the passcode): the Secure Enclave on iOS, StrongBox or else the TEE on Android.
- **Refusal.** The shell refuses to set up a Device on a phone with no hardware keystore or no passcode.
- **Debug fallback.** On simulators and emulators, debug builds use a software key marked as such, if ticket 02 found no hardware there.

## Acceptance criteria

- [x] The plugin API can create the keys, return the public keys, sign a handshake hash with user presence, and delete the keys
- [x] The refusal path works when there is no hardware keystore or no passcode
- [x] The bundle webview cannot reach the plugin

When done, file a human test: on an iPhone and on an Android phone, the keys are created, and signing prompts for Face ID or fingerprint with passcode fallback.

## Plan

Branch `companion/phone` (worktree `.gavin-worktrees/companion-phone`), in `app/companion-shell/`.

- [x] `DeviceKeys` plugin, iOS (`DeviceKeysPlugin.swift`): Secure Enclave P-256 with `[.privateKeyUsage, .userPresence]`, Noise key as a this-device-only keychain item, first-launch wipe, refusal codes, Simulator debug fallback; registered on the shell's bridge only
- [x] `DeviceKeys` plugin, Android (`DeviceKeysPlugin.java`): StrongBox-else-TEE P-256 with the auth window, Noise key sealed by a Keystore AES key in `noBackupFilesDir`, backup and transfer off, minSdk 30, refusal codes, emulator debug fallback
- [x] Native signs only `"gavin-device-unlock-v1" || 32-byte handshake hash` (the wire's `unlock_message`), after a presence prompt
- [x] Shell web layer: plugin interface, pure `keys/` module (readiness and refusal, signature verification) with vitest
- [x] Keys check (debug builds): a self-check the hub runs on a launch flag, `scripts/keys.sh` to drive it on a Simulator or emulator, and a debug panel for the human test
- [x] Bundle probe: the probe also tries to reach `DeviceKeys`; verdict has a check for it
- [x] Prove on an iOS Simulator and an Android emulator: ready with a marked software key, refused without a passcode, refused as a release build would
- [x] README, suites (`companion-shell:test/check/build`), human test filed

## Outcome

Uncommitted on `companion/phone`, all under `app/companion-shell/` (its README's new "The Device's keys" section has the design).

- **The plugin**, `DeviceKeys`: `status`, `createKeys`, `publicKeys`, `noiseKey`, `sign`, `deleteKeys`, registered on the shell's own bridge only (`ShellViewController`, `MainActivity`). iOS `DeviceKeysPlugin.swift`: Secure Enclave P-256 with `[.privateKeyUsage, .userPresence]` and `WhenPasscodeSetThisDeviceOnly`; the Noise key a this-device-only keychain item; the first launch deletes what an earlier install left (proved: two items survived uninstall and reinstall, and the first launch removed them). Android `DeviceKeysPlugin.java`: StrongBox, else TEE, P-256 with the one-hour auth window, unlocked-device-required and an attestation chain; the Noise key sealed by a Keystore AES-GCM key in `noBackupFilesDir`; backup and device transfer off; minSdk 24 → 30 (the auth window needs it).
- **Sign** asks for the owner every time, then signs only `"gavin-device-unlock-v1" || hash` with the hash exactly 32 bytes, so the key can never be asked to sign anything else. The signatures verify with the wire's formats: `openssl dgst -sha256 -verify` accepted the Simulator's and the emulator's over the unlock message and refused them over the bare hash.
- **Refusal**: no passcode, or no hardware keystore, and the plugin refuses natively, not just the hub. A debug build on a Simulator or an emulator uses a software key marked `software-debug`; `--strict` makes a debug build refuse as a release build does.
- **Public keys**: the hardware key's 65-byte point (and on Android the attestation chain). The Noise key's public half is left to the Companion core's `DeviceKeys::from_private` (companion-21): neither iOS below Safari 18.4 nor Android below API 33 has X25519 anywhere else, and the core needs the private key anyway.
- **Proof**: `scripts/keys.sh` runs the keys check (`src/shell/keys/keysCheck.ts`) and answers the prompt. Results: `ready: software-debug` with all 11 checks passing on iOS 26.5 and 27.0 Simulators and an API 36 emulator with a PIN; `refused: no-passcode` on the emulator with no screen lock; `refused: no-hardware-keystore` under `--strict` on both platforms, with no keys left behind. `scripts/probe.sh` gained a check, "the Device's keys are out of the bundle's reach", and passed on iOS 26.5 and API 36: every one of eight `DeviceKeys` calls from inside the bundle webview failed.
- **For the human test**: a debug build shows a "Device keys" panel under the Workstations (Create keys / Sign / Delete keys).
- **Open**: the auth window T is ticket 02's recommended hour, since its decision is still unanswered. It is one constant (`AUTH_WINDOW_SECONDS`), baked into each key when it is made. A Simulator always reports a passcode, so iOS's no-passcode refusal is only covered by the code path and the unit tests. On API 30, StrongBox reads as `tee`. A debug build's Capacitor logging prints every plugin answer, the Noise key's included; a release build logs none of it.

- [ ] Human test: With a debug build on an iPhone and on an Android phone (Xcode / Android Studio, see `app/companion-shell/README.md`), open the "Device keys" panel under the Workstations: Create keys says the hardware key is in the Secure Enclave (iPhone) or StrongBox / the TEE (Android), not software-debug; Sign prompts for Face ID or a fingerprint, offers the passcode or PIN as the fallback, and ends "Signed, and the signature verifies against the hardware key"; Delete keys leaves none.
