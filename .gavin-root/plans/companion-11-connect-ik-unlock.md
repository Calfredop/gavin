---
kind: task
title: Companion 11: a paired Device connects (IK plus hardware signature)
status: To Do
labels: ready-for-agent
parent: companion.md
complexity: intricate
---
Blocked by: companion-10-pair-through-relay.md

Part of `companion.md`. Read the spec (sections "The Device's keys and the Unlock", "Pairing and the trust store" and "The daemon's remote transport"), and ADRs 0001 and 0004, first.

## What to build

The connection handshake, and the Unlock's enforcement.

**Changes to pairing and the trust store:**
- **The pairing payload** gains the Device's hardware public key, and pairing agrees a per-Workstation notification key.
- **The trust store** gains a hardware-key column: an `ALTER TABLE … ADD COLUMN` beside the `CREATE TABLE`, with the duplicate-column error swallowed.
- **The Device cap** rises to five.

**The connection:**
- A paired Device connects through the Relay and completes Noise `IK`, then sends its **hardware signature over the handshake hash**. The daemon assigns the Remote role only once that signature verifies. The test Device uses a software P-256 key standing in for hardware.
- Revoking a Device drops its live remote connections.
- "Revoke all" rotates the Workstation key.
- A Device may remove its own row.
- A daemon token presented over the remote path is ignored.
- Until ticket 12, the Remote role still refuses every other request.

## Acceptance criteria (seam 1)

- [ ] A valid `IK` and signature get the Remote role; a missing or wrong signature gets no request answered
- [ ] A Relay that replays or tampers causes a failed handshake or a dropped frame
- [ ] Revoking drops the live connection, and after "Revoke all" an old Device's `IK` is refused (the proof 05 still owes)
- [ ] A sixth Device is refused
- [ ] A migration test against a trust store built by hand with the phase-2 schema, following the existing `pre_v*` tests
- [ ] A Device removing itself deletes only its own row
