---
kind: task
title: Companion 11: a paired Device connects (IK plus hardware signature)
status: Done
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

- [x] A valid `IK` and signature get the Remote role; a missing or wrong signature gets no request answered
- [x] A Relay that replays or tampers causes a failed handshake or a dropped frame
- [x] Revoking drops the live connection, and after "Revoke all" an old Device's `IK` is refused (the proof 05 still owes)
- [x] A sixth Device is refused
- [x] A migration test against a trust store built by hand with the phase-2 schema, following the existing `pre_v*` tests
- [x] A Device removing itself deletes only its own row

## Outcome

Built on branch `companion/wire` (worktree `.gavin-worktrees/companion-wire`), **uncommitted** — commits are the owner's call. `PROTOCOL_VERSION` is 46. Plan, wire contract and the review's findings: `docs/superpowers/plans/2026-09-28-companion-11-connect-ik-unlock.md`. What was settled by building it: `docs/security/05-remote-access.md` §10, "SECOND SLICE LANDED".

Where each criterion is proved (seam 1 is `crates/daemon/tests/device_wire.rs`, 35 tests):

1. `a_paired_device_connects_and_is_given_the_remote_role`, `a_device_that_sends_no_signature_gets_no_request_answered`, `a_copied_noise_key_on_another_phone_is_refused`
2. `a_relay_that_alters_the_handshake_causes_it_to_fail`, `a_relay_that_replays_a_recorded_connection_is_given_nothing`, `a_frame_the_relay_repeats_or_alters_ends_the_connection_unanswered`
3. `revoking_a_device_drops_its_live_connection_and_leaves_the_others`, `a_revocation_made_by_another_daemon_drops_the_live_connection`, `after_revoke_all_an_old_devices_ik_is_refused`
4. `a_sixth_device_is_refused` (and a revoked Device pairing again is a sixth)
5. `trust::tests::a_phase_two_trust_store_gains_the_hardware_key_column`
6. `a_device_removing_itself_deletes_only_its_own_row`

Also: `a_daemon_token_presented_over_the_remote_path_is_ignored`. That one found a real hole on the way — a `Hello` used to replace a connection's identity, and a `Hello` that presents nothing resolves to `local`, so a Device that said hello would have had the run of the daemon.

Checks run in the worktree: `cargo test --workspace` green (daemon 793 unit + 35 seam), both wasm checks, `cd app && npm test && npm run check && npm run build` green.

An independent review found eleven defects after the first green run; all are fixed with tests that fail without the fix. Two things it found are not this card's to settle and are filed:

- `companion-33-pairing-code-covers-the-handshake.md` (high, before ticket 12): the six digits cover only the two Noise keys, so a pairing made with a copied Noise key and another hardware key shows the code the owner's phone shows. It carries a Decision, because the spec says the SAS is reused as it is.
- `companion-34-desk-hears-of-refused-devices.md`: a failed proof is evidence of a copied key and reaches only the log.

Not built, and not asked of this ticket: the per-connection request rate and hourly rekey of 05 §5/§8, and Android's attestation chain at pairing (ADR 0001) — that arrives with the shell that produces one. A release daemon does not yet refuse a software key marked as such, because nothing marks one yet.
