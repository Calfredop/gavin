---
order: 12288
title: [feat] remote access, phase 2: pairing, trust store, revocation UI
status: Done
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

- [x] [Trust store: `trust.rs`, `devices.sqlite`, the daemon's static key, revocation that drops live connections](./remote-access-trust-store.md)
- [x] [Pairing handshake and the protocol bump: Noise XX+PSK as a library, `BeginPairing` … `SetRemoteAccess`, the three pushes](./remote-access-pairing-handshake.md)
- [x] [Settings: the Remote access section, gated on the daemon version with a real consumer](./remote-access-settings-panel.md)
- [x] Run the three proofs end to end against a debug daemon isolated under a temporary `LOCALAPPDATA` (on Windows the state directory is `%LOCALAPPDATA%\gavin`, so a temporary `$HOME` alone does not isolate it): pair, revoke one, revoke all. Confirm the "must not" with `netstat -ano` (or `lsof -i`) before and after enabling remote access: no new listener, no outbound dial.
- [x] Fold what changed into `docs/security/05-remote-access.md` (§3, §7, §10) — every message shape the implementation settled, and the two corrections above if they held.
- [x] Checks, one crate at a time: `cargo test -p protocol`, `cargo test -p gavin-daemon -- --test-threads=4`, `cargo test -p app`, `cd app && npm test && npm run check`. Commit only the files you touched.

The three tasks are free-standing cards so each gets its own agent and its own status; they run in sequence on the rail, in the order above, because each builds on the one before. This card's own run is the last stage: the proofs, the spec, the ticks.

## How the last stage went

**The proofs.** Split across the two places phase 2 can actually be observed, because
there is no transport: a live daemon has no byte stream to run a handshake over, and a
local client cannot present a `device_id`.

Against a **debug daemon under a temporary `LOCALAPPDATA`** (its own
`gavin-daemon-dev-sock-*` pipe, beside the untouched release one), driven as `app` over
the real pipe: `main.rs` opens `devices.sqlite` in the state directory and it is *not*
split per build; `SetRemoteAccess` stores and reads back; the QR carries exactly
`daemonPublicKey` / `secret` / `rendezvous` / `protocolVersion`, expires in 120s, and
contains neither the live daemon token nor the word "token"; `ConfirmPairing` for a
device that never shook hands is refused and writes nothing; `RevokeAllDevices` rotates
the key so a fresh `BeginPairing` carries a different public key on a second connection
too, and leaves the settings alone. **The "must not" holds**: `netstat -ano` has no TCP
or UDP row owned by the daemon's pid, before enabling remote access, after enabling it,
or after the whole ceremony.

The handshake half is cargo's, in-process: `the_pairing_ceremony_writes_a_device_only_
after_confirmation`, `revoking_a_device_drops_its_live_connection_and_leaves_the_others`
and `revoke_all_devices_rotates_the_key_and_drops_every_device_connection` — 27 `trust`
/ `pairing` tests and 14 server ones, all green.

**Two words in §10's "proves" line were wrong**, and are now corrected in the spec
rather than quietly worked around: the handshake is not "over the Unix socket" (it is
not on this protocol at all), and phase 2 cannot prove a device "fails `IK`" when no
`IK` handshake exists until phase 3. **Phase 3 still owes that half** — an old device's
`IK` against a rotated key, refused.

**Both corrections in this card held.** No grant request landed, and the handshake is a
library over `Read + Write` whose seam is `SessionManager::pair_over`.

**Checks** (commit `39574d54`): `protocol` 116/3 — the three are the known Windows reds,
all Linux XDG socket-path tests. `gavin-daemon` 618/11 — ten are the pre-existing
`gavin::tests` fs-watcher reds (that file has zero diff against `main`) and the eleventh,
`reattaching_after_detach…`, passes three times out of three alone, so it is the known
parallelism flake. `cargo test -p app` 526/0. `npm test` 284 files / 6250 tests, `npm run
check` 0 errors, `npm run build` clean.
