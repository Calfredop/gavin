---
kind: task
title: Companion 10: a test Device pairs through a local Relay
status: Done
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

- [x] The test Device pairs through the Relay, both sides show the same six digits, and the trust store gains the row only after the desk confirms
- [x] A Relay connection without the admission token is refused
- [x] With remote access off, the daemon dials nothing (asserted)
- [x] A wrong secret fails the handshake
- [ ] Human test: On a build of this branch with its daemon rebuilt and restarted (v45), open Settings, Remote access: the new Admission token field saves when you leave it and then reads "A token is stored", Clear token empties it, the three notes read true, and Pair a device is greyed with a reason until remote access is on with a Relay URL

Prior art: the in-process pairing ceremony tests in the daemon's pairing module. Never `pkill gavin-daemon`: use an isolated daemon.
