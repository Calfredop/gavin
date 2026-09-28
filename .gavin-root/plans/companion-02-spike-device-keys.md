---
kind: task
title: Companion 02: spike, Device keys and the Unlock on real phones
status: To Do
labels: ready-for-agent
parent: companion.md
complexity: complex
---
Blocked by: none (can start immediately)

Part of `companion.md`. Read the spec (sections "The Device's keys and the Unlock" and "The Companion shell"), `CONTEXT.md`, and ADRs 0001, 0004 and 0005 first.

## What to build

Answer these questions with a minimal, throwaway native test app: Swift for iOS and Kotlin for Android, inside a bare Capacitor shell. **Keep the app out of git** (build it in a scratch folder that git ignores). This rail's branch, `spike/companion-device-keys`, is merged into main, and only the findings document belongs there.

1. **Signing after one authentication.** A hardware-bound P-256 key requires user presence (a biometric, falling back to the passcode). After one authentication, can it sign repeatedly, across reconnects and for several Workstations, until the app is backgrounded or the phone locks, without prompting again?
   - Which exact parameters give that on iOS (access control plus a held authentication context) and on Android (auth-bound key parameters)?
   - What ends it?
   - Do Control Center and an incoming-call banner leave it intact?
2. **Emulated hardware.** Does the iOS Simulator offer the Secure Enclave, and do Android emulators offer StrongBox or TEE keys? If not, confirm the fallback: debug builds use a software key marked as such, accepted only by a dev daemon.
3. **The Noise key.** How is the X25519 Noise static key best stored so it is usable on this device only? That means the iOS Keychain accessibility class and the Android equivalent.
4. **Keeping keys out of bundles.** Can a shell-only Capacitor plugin expose all of this without any web bundle reaching it, as ADR 0005's constraint requires?

## Acceptance criteria

- [ ] Findings in `docs/research/`, with the recommended key parameters per platform
- [ ] ADR 0001 or ADR 0004 amended if a finding contradicts it

When the spike app runs, file a human test: the owner installs it on their iPhone and on an Android phone, and confirms the prompt behaviour for sign, sign again, background, Control Center, and lock.
