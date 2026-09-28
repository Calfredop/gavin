---
kind: task
title: Companion 21: the shell pairs with a real Workstation
status: To Do
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

- [ ] The WASM core builds in the shell's pipeline
- [ ] A scripted pairing against a dev daemon and a local Relay completes (use the dev stack from ticket 17 if it exists)
- [ ] The Workstation is persisted in the hub across app restarts

When done, file a human test: pair a real phone with the dev desktop; the codes match, the Workstation appears in the hub, and the Devices panel lists the phone.
