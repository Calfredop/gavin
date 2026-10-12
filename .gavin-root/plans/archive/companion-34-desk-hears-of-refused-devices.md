---
order: 33792
kind: task
title: Companion 34: the desk is told when a Device is refused
status: Done
parent: companion.md
priority: medium
complexity: moderate
---
Blocked by: companion-11-connect-ik-unlock.md. Best done with or just after companion-15-devices-panel.md, which builds the surface it belongs on.

Part of `companion.md`. Found by the independent review of ticket 11. Read `crates/daemon/src/connect.rs` (`Refused`), `crates/daemon/src/remote.rs` (`refusal`, `note`, `LogBudget`) and `crates/daemon/src/trust.rs` (`Admission`) first.

## The problem

Since ticket 11 the daemon refuses a paired Device's connection for one of six reasons, and tells the Device which. It tells the desk nothing. What it knows goes to `daemon.log`, at most twelve lines a minute.

One of those refusals matters more than the rest. A connection that completes the `IK` handshake with a paired Device's Noise key and then fails its hardware signature is, by ADR 0001's own reasoning, evidence that the Noise key has been copied: the handshake proves someone holds the key, and the signature proves it is not the phone. The human should hear of that at the desk, and has a button for it — Revoke.

The others are worth showing too. A Device the human revoked that is still trying, a Device gone stale, a row from before hardware keys existed: each is a row in the Devices list with something to say for itself.

## What to build

- The daemon keeps, per Device, the last refusal and when (in memory is enough; it is a fact about the recent past, not the trust store's).
- The desk reads it with the Device list and is told when it changes. A new push is a new `Response` variant, which an older app cannot parse: gate what is sent on what the app's `Hello` says it speaks, or carry it on a field of an existing reply.
- The Devices panel shows it on the Device's row, through the badge vocabulary in `ui/indicators.ts`. A failed proof against a row that is otherwise good is shown as what it is, with Revoke beside it.
- Refusals of keys the store has never seen are not the desk's business and stay in the log.

## Acceptance criteria

- [ ] Seam 1 (`crates/daemon/tests/device_wire.rs`): after `copied_to_another_phone` is refused, the desk's read of that Device says a proof failed and when; after a revoked Device is refused, it says that
- [ ] An app older than the bump is sent nothing it cannot parse (tested)
- [ ] Unit tests for the pure module's copy
- [ ] A `FEATURE_MIN_VERSION` entry with a `featureBlockedReason` consumer on the surface that shows it
