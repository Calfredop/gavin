---
kind: task
title: Companion 10: a test Device pairs through a local Relay
status: To Do
labels: ready-for-agent
parent: companion.md
complexity: intricate
---
Blocked by: none (can start immediately)

Part of `companion.md`. Read the spec (sections "The Relay", "The Companion core" and "Pairing and the trust store"), `CONTEXT.md`, ADR 0001, and 05's §3, §5 and §7 first.

## What to build

The first slice of the Device wire.

- **The Relay.** A new crate. It matches up a daemon and a Device and copies bytes between them over WebSocket and TLS. It requires an admission token.
- **The Companion core.** A new crate holding the Noise `XXpsk3` pairing client, with the pairing SAS reused from the protocol crate. It is built natively as the **test Device**.
- **The daemon dials.** When remote access is on, the daemon dials its Relay; phase 2 already stores the switch and the Relay URL. It runs the existing pairing responder on pairing streams the Relay hands it.
- **The pairing QR code** carries the Relay URL and the admission token.

## Acceptance criteria (seam 1: a real daemon under a temporary `$HOME`, a real local Relay, the test Device)

- [ ] The test Device pairs through the Relay, both sides show the same six digits, and the trust store gains the row only after the desk confirms
- [ ] A Relay connection without the admission token is refused
- [ ] With remote access off, the daemon dials nothing (asserted)
- [ ] A wrong secret fails the handshake

Prior art: the in-process pairing ceremony tests in the daemon's pairing module. Never `pkill gavin-daemon`: use an isolated daemon.
