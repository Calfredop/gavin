---
order: 31744
kind: task
title: Companion 32: the desk says whether the daemon reached its Relay
status: To Do
parent: companion.md
priority: medium
complexity: moderate
---
Blocked by: companion-10-pair-through-relay.md. Best done with or just before companion-15-devices-panel.md, which moves the surface it belongs on.

Part of `companion.md`. Found while building ticket 10. Read `crates/daemon/src/remote.rs` and `app/src/lib/core/remoteAccess.ts` first.

## The problem

Since ticket 10 the daemon dials the Relay while remote access is on. Whether that worked is known only to the daemon's log. At the desk, a wrong admission token, a Relay that is down, a certificate the machine does not trust and a Relay that is connected all look the same: a switch that is on. The human finds out when a Device scans the QR and is told the Workstation is not there.

The app can already say one thing without the daemon's help — `relayUrlHint` mirrors the daemon's rule about which URLs it will dial — and nothing else.

## What to build

- The daemon keeps the state of its dial: not wanted, dialling, connected (since when), or failed (why, in the words `DialError` and `RefusalReason` already have).
- The desk reads it and is told when it changes. A new request TYPE and a push are the clean shape: both get a `min_version_for` arm, and neither widens a payload.
- The Settings section (or the Devices panel, if ticket 15 has landed) shows it beside the Relay URL, through the badge vocabulary in `ui/indicators.ts`.
- Pair a device is offered only while the daemon is connected; `pairingUnavailable` in `remoteAccess.ts` is where that rule lives.

## Acceptance criteria

- [ ] Seam 1 (`crates/daemon/tests/device_wire.rs`): the state reads connected after the daemon registers, failed with the admission reason after a wrong token, and not wanted with the switch off
- [ ] Unit tests for the pure module's copy and for the pairing rule
- [ ] A `FEATURE_MIN_VERSION` entry with a `featureBlockedReason` consumer on the surface that shows it
- [ ] The token never appears in the state, the push or the log
