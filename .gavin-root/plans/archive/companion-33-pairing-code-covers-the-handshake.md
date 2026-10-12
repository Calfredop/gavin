---
order: 32768
kind: task
title: Companion 33: the six digits cover the pairing they are shown for
status: Done
parent: companion.md
priority: high
complexity: moderate
---
Blocked by: companion-11-connect-ik-unlock.md. Must land before companion-12-daemon-forwards-commands.md gives the Remote role any reach.

Part of `companion.md`. Found by the independent review of ticket 11. Read ADR 0001, `protocol::pairing_sas` and its doc comment, `crates/daemon/src/unlock.rs` (`registering`), `crates/daemon/src/pairing.rs` and `crates/companion-core/src/pairing.rs` first.

## The problem

ADR 0001's promise is that a copied Noise key gets an attacker nothing, because every connection is signed by a hardware key that cannot leave the phone. Ticket 11 enforces that at connection. At PAIRING it can be walked round.

The six-digit code is derived from the two Noise static keys and nothing else. So two handshakes made with the same Device key against the same Workstation show the same six digits — whoever made them, and whichever hardware key each one registered.

Someone who holds a copy of a Device's Noise key AND sees the pairing QR while the owner is pairing that Device can:

1. Run the pairing handshake first, with the copied Noise key and a P-256 key of their own. Their proof verifies: it is signed by the key it registers.
2. That handshake spends the offer, so the owner's phone is refused — but the phone has already computed its six digits and is showing them. The core emits `CompareCode` as soon as it has sent its proof, with nothing from the Workstation to say the proof was taken.
3. The desk shows the same six digits. The human compares, sees them match, and confirms.
4. The row now holds the attacker's hardware key under the owner's Device. The attacker connects; the owner's phone is refused `unlock`.

If the Device was already paired, the confirm silently REPLACES the hardware key on the row the desk already trusts, and the dialog does not say that this pairing is for a Device it knows.

The preconditions are demanding — a copied key, sight of the QR, and the owner pairing at that moment — but the copied key is exactly the threat the second key exists for, and after ticket 12 the prize is full control.

Ticket 11 did what it could without changing the ceremony: pairing again now drops the connections made under the old keys, so the owner's phone going dark is at least visible.

## What to build

- **The code covers the handshake.** Derive the six digits from the pairing handshake's hash (which covers both static keys, both ephemerals and the secret's mixing), or from the static keys and the hardware key together. Then a handshake the owner's phone did not make shows other digits than the phone does. The spec says the SAS "stays where it is and is reused as-is": it still lives in the protocol crate and both ends still call one function, but what goes into it changes, so record that in the spec or in ADR 0001.
- **The Device learns its proof was taken before it shows a code**, or the spec says why it need not. A one-frame acknowledgement after the proof is the obvious shape.
- **The desk says when a pairing is for a Device it already knows**, and that confirming replaces that Device's keys. `DevicePairingRequested` carries the id the row already has; the dialog has to say so.
- Update the pinned vectors (`the_code_is_the_protocol_crates_own`, `pairing_sas`'s tests) and `docs/security/05-remote-access.md` §3.

## Acceptance criteria

- [ ] Seam 1 (`crates/daemon/tests/device_wire.rs`): two pairings made with one Noise key and two hardware keys show DIFFERENT codes; the test Device's `copied_to_another_phone` is the second one
- [ ] A Device whose handshake was refused because the offer was spent shows no code
- [ ] The core and the daemon still compute the code with one function in the protocol crate, and the wasm checks pass
- [ ] The pairing dialog says when the Device is one the Workstation already trusts (pure-module test for the copy; the rendered dialog is a human test)
- [ ] The spec or ADR 0001 records the change to what the code covers
- [ ] Decision: The spec says the pairing SAS is "reused as-is", but as it is, two pairings made with one copied Noise key show the same six digits whatever hardware key each registers. What should the six digits be derived from?
  Options: A) The pairing handshake's hash (recommended: any handshake the owner's phone did not make shows other digits) B) The two static keys plus the hardware key being registered C) Leave the code as it is; add only the acknowledgement and the dialog's notice
- [ ] Human test: Pair a phone that is already paired (same install): the confirm dialog shows the "already trusts … Confirming REPLACES that device's keys" line above the trust-store line; pairing a new phone shows no such line.
