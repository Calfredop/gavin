---
order: 20480
kind: task
title: Remote access: the pairing handshake and the phase-2 protocol
status: Done
parent: feat-remote-access-phase-2.md
complexity: intricate
---
Second task of [feat-remote-access-phase-2](./feat-remote-access-phase-2.md), after [the trust store](./remote-access-trust-store.md); read that card, the store, and `docs/security/05-remote-access.md` §3 ("The ceremony", "What the QR carries", "What it must not carry"), §4 and §7 ("Phase 2 additions") first.

**The handshake, as a library.** A module the daemon can run over any byte stream (`crates/daemon/src/pairing.rs`, or inside `trust.rs` if it stays small): the responder side of `Noise_XXpsk3_25519_ChaChaPoly_BLAKE2s` (the `snow` crate; the PSK slot is yours to pick — say which and why) with the one-time pairing secret as the pre-shared key. The initiator sends its static public key and a device name inside the handshake; both sides derive a six-digit short authentication string from both static keys (a KDF over the two public keys, sorted, truncated to six decimal digits — write the exact derivation down, the phone must reproduce it). The library takes `Read + Write` plus the store, and is tested against an in-process initiator (a `snow` `Builder` on the other end of `Stream::pair()` or an `std::io` pipe): a correct PSK reaches the SAS, a wrong PSK fails, an expired secret is refused before the handshake starts, and nothing is written to `devices.sqlite` until confirmation.

**The protocol bump** (`crates/protocol`, one `PROTOCOL_VERSION` bump, a `min_version_for` arm for every new variant, `authorize` arms that allow `app` only — `agent` and `remote` get `Forbidden`):

- `BeginPairing` → `PairingOffer { qr, expires_at }` — mints a one-time secret with a two-minute expiry. The QR payload is the daemon's static public key, the secret, the rendezvous address(es) from the store's remote-access settings (may be empty in this phase) and the protocol version, and nothing else: §3's "must not carry" list is a test.
- `ConfirmPairing { device_id }` → `Ok` — writes the row; before it the device does not exist. `RejectPairing { device_id }` discards the pending handshake (§3 has no reject; the Settings dialog needs one).
- `ListDevices` → `Devices { devices }`, `RevokeDevice { device_id }`, `RevokeAllDevices` (rotates the key), `SetRemoteAccess { enabled, relay_url }` — stored and inert: nothing dials or listens in this phase.
- Pushes to `app` connections: `DevicePairingRequested { device_id, name, sas }`, `DeviceConnected`, `DeviceDisconnected`. When no `app` connection is live at the moment a confirmation is needed, the daemon refuses the pairing with "open gavin on the desktop" — the human keeps the wheel.
- Not in this phase: `GrantInput` / `RevokeInputGrant` (§10 puts grants in phase 5).

The bump is invisible to older clients by construction (new request TYPES), but the app's gate needs an entry — `FEATURE_MIN_VERSION.remoteAccess` in `app/src/lib/core/daemonCompat.ts` — whose `featureBlockedReason` consumers are the settings task's surfaces. Add the entry here, leave the consumers to that task, and note in the commit that the entry is dead until it lands (CLAUDE.md). `gavin-mcp` uses none of this.

Tests: the handshake tests above; a `protocol` test that every new variant has a `min_version_for` arm at the new version; a `server` test that `agent` and `remote` identities get `Forbidden` on each new request and `app` does not; the "must not carry" test on the QR payload; an in-process test that drives `BeginPairing` → handshake → `DevicePairingRequested` on an app connection → `ConfirmPairing` → the row exists, and the same ending in a reject. `cargo test -p protocol`, `cargo test -p gavin-daemon -- --test-threads=4`. Commit only the files you touched. The bump takes effect only after a rebuild and daemon restart — the human's call — and every running `gavin-mcp` fails closed until it is rebuilt too; say so in the commit body.
