---
kind: task
title: Companion 20: Device keys in the shell
status: To Do
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

- [ ] The plugin API can create the keys, return the public keys, sign a handshake hash with user presence, and delete the keys
- [ ] The refusal path works when there is no hardware keystore or no passcode
- [ ] The bundle webview cannot reach the plugin

When done, file a human test: on an iPhone and on an Android phone, the keys are created, and signing prompts for Face ID or fingerprint with passcode fallback.
