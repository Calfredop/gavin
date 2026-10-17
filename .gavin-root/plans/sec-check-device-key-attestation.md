---
order: 16384
kind: task
title: "[sec-check] Every daemon build accepts any P-256 key as a Device's hardware key: the release refusal of software-debug and unattested keys that ADR 0001 and 06 §5.7 require is not built"
status: To Do
priority: low
complexity: complex
labels: security, ready-for-human
---
Decide, then fix or close, a needs-validation lead from the 2026-10-15 security audit (run-1). It is not confirmed: the audit traced it in source but could not observe a release-profile daemon built from this tree admitting a software key, because the only release binary predated the reviewed sources and rebuilding was not allowed. Fingerprint: `crates/daemon/src/unlock.rs:registering:no-attestation-or-software-key-refusal`.

Full record: `NEEDS-VALIDATION.md` in `~/security-audit-skill/gavin/run-1/`, outside this repo. The audit card is `review-security-audit-2026-10-15.md`.

## What is wrong

ADR 0001 says a copied Noise key gets an attacker nothing, because the Device's second key is hardware-bound and signs only when the user is present. It also says a release daemon refuses an Android key unless the key attests TEE or StrongBox under Google's hardware roots (line 32), and that only a debug daemon accepts a debug build's software key (line 34). `docs/security/06-companion.md` adds (§5.1 item 6, §5.7, CT-9, and row 4 of its table) that each trust-store row records a key kind, and that a release daemon refuses a `software-debug` row on every connection, not only at pairing, because dev and release daemons on one machine share `devices.sqlite`.

None of this exists in the current tree. At pairing, unlock::registering accepts any 65-byte uncompressed P-256 point that signed the handshake hash. UnlockProof has no field for a key backing or an attestation chain. The devices table has no key-kind column. trust::judge and connect::run_responder never read the build profile. So a key from a debug shell on a Simulator or emulator, which the shell knows is `software-debug` but never sends, is stored as an ordinary hardware key. Because the trust store is shared, a pairing confirmed at the dev daemon's desk is honoured by the release daemon too. From then on, anyone holding copies of that software key and the Noise key connects as that Device from anywhere, through the Relay, with the Remote role and no presence check.

A release-built shell cannot produce a software key on an untampered OS: iOS allows the software fallback only under #if DEBUG on a Simulator (DeviceKeysPlugin.swift:113), and a non-debuggable Android shell deletes and refuses a key whose reported security level is software (DeviceKeysPlugin.java:262). So the realistic producers are debug shells on Simulators or emulators, paired through either daemon, and modified or rooted clients that lie about the key's security level, which is the case Android attestation would catch. A 2026-09 card already records the refusal as not built (`.gavin-root/plans/archive/companion-11-connect-ik-unlock.md:61`): "A release daemon does not yet refuse a software key marked as such, because nothing marks one yet." The shell now computes the mark; nothing carries it.

## Trace (lines as of 2026-10-16; re-read before editing)

- `crates/daemon/src/pairing.rs:292` (run_responder_with_keys): After the XXpsk3 handshake the daemon reads the Device's sealed proof; line 375 calls unlock::registering. This is the only place the hardware key enters.
- `crates/daemon/src/unlock.rs:78` (registering): Parses UnlockProof, decodes hardwareKey and verifies the signature with that same key. No backing, attestation or build-profile check.
- `crates/daemon/src/unlock.rs:34` (checked_key): Checks only 65 bytes and a 0x04 prefix.
- `crates/protocol/src/device_wire.rs:156` (UnlockProof): Only `signature` and an optional `hardware_key`.
- `crates/daemon/src/server.rs:3503` (confirm_pairing): Writes the pending hardware key through TrustStore::confirm_device (3517). No key kind.
- `crates/daemon/src/trust.rs:918` (confirm_device_at): Stores the key verbatim, also when a known Noise key re-pairs. The devices table (CREATE TABLE at 496, ALTERs at 529-535) has no key-kind column.
- `crates/daemon/src/connect.rs:86` (run_responder): Every later connection is accepted once unlock::connecting (172) verifies against the stored key.
- `crates/daemon/src/trust.rs:1158` (judge): Refuses only a missing hardware key. No cfg(debug_assertions) or BuildProfile branch exists in pairing, unlock, connect or judge.
- `app/companion-shell/src/shell/native/deviceKeys.ts:27` (KeyBacking) and `:81-83` (attestation chain): The shell knows the backing and, on Android, the attestation chain; neither reaches the daemon.

## What the audit could not observe

- A release daemon built from this tree admitting the test Device's software key, at pairing and on later connections, and admitting a row a debug daemon wrote into the same store. Source shows identical admission logic in both profiles; it was not run.
- Whether a software-debug Device row coexists with a release daemon on the owner's machine (a Simulator or emulator debug shell paired through either daemon, with remote access on), and whether its keys can be copied by anyone who is not already a same-user process (for example from a backup of ~/Library/Developer/CoreSimulator or an emulator image).
- Whether a modified Android client or rooted OS that falsely reports TEE or StrongBox is in the owner's threat model. Only attestation stops that one.

## The decision

- [ ] Decision: Build the release refusal ADR 0001 and 06 §5.7 describe, or amend both documents to record the accepted residual?
  Options: A) Build all of it: the key kind on the wire, a key_kind column, a release-only refusal at pairing and on every connection, and Android attestation verified against Google's hardware roots. B) Build the key kind and the release-only refusal now, and record attestation as an accepted residual until a later card. C) Amend ADR 0001 and 06 §5.7 to record that any daemon accepts any key, and why.

## After the answer

- **A or B.** UnlockProof gains `key_kind` (serde default, so an older Device omits it) and, for A, the Android attestation chain. The devices table gains `key_kind TEXT` through its own `ALTER TABLE devices ADD COLUMN`, beside the existing ones at trust.rs:529-535, never only in the CREATE TABLE. registering returns the kind with the key, confirm_device_at stores it, and judge refuses a `software-debug` row when `BuildProfile::current()` is Release, on every connection, as §5.7 says; a debug daemon keeps accepting it. Decide and write down what a NULL kind means: rows paired before this change, and Devices whose shell predates the field. Refusing them strands every phone already paired; accepting them keeps the residual for those rows. For A, verifying the chain means parsing X.509 and the Android KeyDescription extension and pinning Google's roots in the daemon; if that turns out bigger than the rest, split it into its own card and do B here. The Companion shell and companion-core send the new field. Regression tests: a `pre_v*` trust-store test against a devices table built by hand with the old schema gets the column; in `crates/daemon/tests/device_wire.rs`, a test Device that declares `software-debug` pairs and connects against a debug daemon, and the same admission path with the profile forced to Release refuses it at pairing and on connect (expose the profile to judge as a parameter so the release branch is testable from a debug build). For A, a chain that does not attest TEE or StrongBox is refused.
- **C.** In ADR 0001, replace the promises in the Consequences bullets at lines 32 (Android attestation) and 34 (only a debug daemon accepts the software key) with what is true: every daemon accepts any P-256 key that signs the handshake hash; the shells refuse to create a software key outside debug builds; a debug shell's software key paired through either daemon is honoured by both, since they share `devices.sqlite`. In `docs/security/06-companion.md` §5.1 item 6, §5.7, CT-9 and row 4 of the table, record the residual: "A Device paired from a debug shell on a Simulator or emulator holds a software key that any daemon, release included, accepts. Anyone who copies that key and the Device's Noise key can connect as that Device from anywhere, with no presence check. A modified client that misreports its key's backing is not detected, because no daemon checks Android attestation." Add one sentence telling the owner to revoke Simulator and emulator Devices from Settings before they rely on a release install.

## Done when

- The decision above is ticked, with the chosen option and the reason under a dated "## Comments" heading.
- For A or B: the regression cases named above are tests in the touched crates, they fail before the change and pass after it, the new column has its own `ALTER TABLE` with a `pre_v*` test, and the checks in CLAUDE.md pass for every part you touched.
- For B or C: ADR 0001 and 06 §5.7 say what the code does, including what stays accepted.
- You commit only your own files.
