---
title: [feat] remote access, phase 2: pairing, trust store, revocation UI
status: To Do
priority: medium
complexity: intricate
---
Phase 2 of `docs/security/05-remote-access.md` §10. Phase 1 — client identity and roles on the local socket — landed as `917bcc2` ([sec-fix-client-identity](./archive/sec-fix-client-identity.md)): `Hello` / `HelloAck` / `Forbidden`, `ClientIdentity`, the exhaustive `authorize`, the daemon token, the session token, and the `require_local_token` switch (which also settles §11 Q1). This phase makes a phone a device the daemon knows, with nothing yet for it to connect through.

**What lands** (§10): `crates/daemon/src/trust.rs` and `devices.sqlite`; daemon static-key generation; the phase-2 requests and pushes from §7; the Noise `XX`+PSK pairing handshake as a library the daemon can run over any byte stream; the Settings panel's Remote access section (toggle, relay URL, Pair a device with QR and SAS, device list with Revoke, Revoke all).

**What it proves**: a test client driving the pairing handshake in-process ends up in `devices.sqlite` only after `ConfirmPairing`; a revoked device's live connection drops; "Revoke all" rotates the key and every prior device fails `IK`.

**What it must not do**: open a listener or dial a relay. Remote access "on" with no transport is a store with rows in it and nothing to serve — the panel says so in its own words.

**Two corrections to the spec, decided here so the three tasks agree.** §7 lists `GrantInput` / `RevokeInputGrant` among the phase-2 additions, but §10 lands grants in phase 5 with the input path; §10 wins, so no grant request in this phase. And §3's "the phone connects over the transport in §5" has no transport to connect over yet: the handshake is a library exercised over an in-process byte stream in tests, with the seam phase 3's `remote.rs` will feed documented in the code.

Read the spec's §3, §4, §7 and §10 before starting any task below, and `crates/daemon/src/server.rs` (`ClientIdentity`, `resolve_hello`, `authorize`) — that is the gate every new request gets classified in.

## Checklist

- [ ] [Trust store: `trust.rs`, `devices.sqlite`, the daemon's static key, revocation that drops live connections](./remote-access-trust-store.md)
- [ ] [Pairing handshake and the protocol bump: Noise XX+PSK as a library, `BeginPairing` … `SetRemoteAccess`, the three pushes](./remote-access-pairing-handshake.md)
- [ ] [Settings: the Remote access section, gated on the daemon version with a real consumer](./remote-access-settings-panel.md)
- [ ] Run the three proofs end to end against a debug daemon isolated under a temporary `LOCALAPPDATA` (on Windows the state directory is `%LOCALAPPDATA%\gavin`, so a temporary `$HOME` alone does not isolate it): pair, revoke one, revoke all. Confirm the "must not" with `netstat -ano` (or `lsof -i`) before and after enabling remote access: no new listener, no outbound dial.
- [ ] Fold what changed into `docs/security/05-remote-access.md` (§3, §7, §10) — every message shape the implementation settled, and the two corrections above if they held.
- [ ] Checks, one crate at a time: `cargo test -p protocol`, `cargo test -p gavin-daemon -- --test-threads=4`, `cargo test -p app`, `cd app && npm test && npm run check`. Commit only the files you touched.

The three tasks are free-standing cards so each gets its own agent and its own status; they run in sequence on the rail, in the order above, because each builds on the one before. This card's own run is the last stage: the proofs, the spec, the ticks.
