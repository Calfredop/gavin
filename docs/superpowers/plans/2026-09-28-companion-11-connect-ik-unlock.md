# Companion 11: a paired Device connects (IK plus hardware signature) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A paired Device connects to its Workstation through the Relay: Noise `IK`, then its hardware signature over the handshake hash, and only then the Remote role — which, until ticket 12, may do one thing: remove its own Device.

**Architecture:** The Device's proof is one message, sent first on the channel **every** handshake leaves behind. At pairing it registers the hardware key and proves the Device holds it; at connection it is the Unlock's enforcement. The daemon's `remote.rs` serves a second purpose of stream, `connect`: it runs the `IK` responder (`connect.rs`), checks the trust store and the signature (`unlock.rs`), and then copies the channel's plaintext — newline-delimited `Request`/`Response` JSON, unchanged — to and from the connection loop the local socket already uses, over an in-process socket pair, with the identity fixed as `remote`. Revocation therefore drops a Device the way phase 2 built and tested it: by shutting that socket.

**Tech Stack:** Rust; `snow` 0.10 (`Noise_IK_25519_ChaChaPoly_BLAKE2s`); `ring` 0.17 (ECDSA P-256 / SHA-256, already in the tree under `rustls`); `rusqlite`.

**Spec:** `docs/superpowers/specs/2026-09-27-companion-design.md` — "The Device's keys and the Unlock", "Pairing and the trust store", "The daemon's remote transport". ADRs 0001 and 0004. `docs/research/2026-09-28-companion-device-keys.md` for what a phone's hardware emits. `docs/security/05-remote-access.md` §5 and §8.

## Global Constraints

- Glossary words are **Workstation**, **Device**, **Relay**, **Companion**, **Unlock**, **Remote role** (`CONTEXT.md`).
- The connection pattern is `Noise_IK_25519_ChaChaPoly_BLAKE2s`, one string in the protocol crate, shared by both ends.
- The hardware key is P-256. Its public half crosses the wire as the 65-byte uncompressed SEC1 point; its signatures as ASN.1 DER over SHA-256 — what `SecKeyCreateSignature(.ecdsaSignatureMessageX962SHA256)` and Android's `SHA256withECDSA` both emit.
- The Device cap is five. The ninety-day unseen expiry stays.
- Padding stays at the 256-byte bucket.
- A new column needs its own `ALTER TABLE … ADD COLUMN`, duplicate-column error swallowed, and a test against a database built by hand with the old schema.
- Every new request type gets a `min_version_for` arm and a `PROTOCOL_VERSION` bump.
- The Companion core and the protocol crate (with `os` off) must check for `wasm32-unknown-unknown`. The core never signs: the hardware does, and the shell hands the signature in.
- Never `pkill gavin-daemon`. Seam 1 runs an isolated daemon under a temporary `$HOME`.
- No attribution to an agent or model in anything that lands in the repo.

## Review Focus

1. **A `Hello` on a Device's connection.** The connection loop REPLACES the identity with whatever `Hello` resolves to, and no credential at all resolves to `local` — full reach. A Device that sent `Hello` would stop being a Device. → the transport's identity is final. Tests: `a_hello_on_a_device_connection_cannot_change_its_role`, seam 1 `a_daemon_token_presented_over_the_remote_path_is_ignored`.
2. **Revoked between the handshake and the registration.** A revocation marks the row, then shuts the connections it finds; a connection that registers a moment later is found by nobody. → the row is read again after registering. Tests: `a_connection_is_where_a_revocation_finds_it_before_its_row_is_read`, `a_device_that_is_not_trusted_is_not_adopted`.
3. **Remote access turned off with a Device connected.** The daemon lets go of the Relay; a Device's connection is part of what it lets go of. Test: seam 1 `turning_remote_access_off_drops_a_connected_device`.
4. **A row with no hardware key** (written by phase 2, or by hand). It can never pass the signature, so it is refused by name, before any signature is asked for. Tests: `a_device_with_no_hardware_key_is_told_to_pair_again`, the migration test.
5. **Two daemons, one key.** The dev and the release daemon register under one rendezvous id, and either can serve a connection. → the one with a desk in front of it goes first: a daemon with no app connected waits a moment before it claims. Test: `a_daemon_with_nobody_at_the_desk_gives_way`.

---

## The wire contract (settled here, used by every task)

### The proof: first on every channel

```text
unlock message = "gavin-device-unlock-v1" || handshake hash          (what the hardware signs)
proof          = {"signature":"<hex, DER>"}                          (connection)
               | {"signature":"<hex, DER>","hardwareKey":"<130 hex>"} (pairing)
```

One padded frame, the Device's first after the handshake's last message.

### Pairing, as changed

Message 3's payload is still the Device's name. Then the proof, carrying `hardwareKey`; the daemon verifies the signature against that key before the desk is asked anything. `Paired` gains the notification key, minted by the daemon when the desk confirms:

```json
{"type":"paired","deviceId":"dev-…","notificationKey":"<64 hex>"}
```

A Device refuses to start against a QR whose `protocolVersion` is below 46.

### Connection

Relay purpose `connect`. Prologue `gavin-device-connect-v1`.

```text
Device → Workstation   IK message 1  (e, es, s, ss)
Workstation → Device   IK message 2  (e, ee, se)
Device → Workstation   proof
Workstation → Device   {"type":"connected","deviceId":"dev-…"}
                     | {"type":"refused","reason":"not-paired"|"revoked"|"stale"|"pair-again"|"unlock"|"busy"}
```

After `connected`, both directions are a stream of bytes — newline-delimited `Request` / `Response` JSON — cut into padded frames wherever the sender likes. A frame that does not open ends the connection.

### Protocol v46

- `Request::RemoveThisDevice` — a Device deletes its own row; the only request the Remote role may make until ticket 12.
- A `Hello` on a connection whose transport fixed its identity is answered `HelloAck { role: "remote" }`, no `server_proof`, and changes nothing.

---

## File structure

| File | Responsibility |
|---|---|
| `crates/protocol/src/device_wire.rs` | `CONNECT_NOISE_PARAMS`, the unlock message, `UnlockProof`, `ConnectVerdict`, `Paired`'s notification key. |
| `crates/protocol/src/relay.rs` | `PURPOSE_CONNECT`. |
| `crates/protocol/src/lib.rs` | v46, `RemoveThisDevice`. |
| `crates/companion-core/src/channel.rs` (new) | Sealing and opening padded frames; assembling them out of bytes. |
| `crates/companion-core/src/connect.rs` (new) | The sans-IO `IK` initiator, and `PairedWorkstation`. |
| `crates/companion-core/src/pairing.rs` | The proof after message 3. |
| `crates/companion-core/src/test_device.rs` | The software P-256 key; `connect`; a Relay that meddles. |
| `crates/daemon/src/unlock.rs` (new) | Verifying a proof against a hardware key. |
| `crates/daemon/src/connect.rs` (new) | The `IK` responder over `Read + Write`. |
| `crates/daemon/src/trust.rs` | Two columns, the cap, deletion, admission by id. |
| `crates/daemon/src/pairing.rs` | Reads the proof; hands on the hardware key. |
| `crates/daemon/src/server.rs` | `RemoveThisDevice`, the fixed identity, adoption of a Device's connection. |
| `crates/daemon/src/remote.rs` | Serves `connect` streams. |
| `crates/daemon/tests/device_wire.rs` | Seam 1. |

---

### Task 1: The wire contract

**Files:** Modify `crates/protocol/src/{device_wire,relay,lib}.rs`.

**Produces:**
- `device_wire::{CONNECT_NOISE_PARAMS, CONNECT_PROLOGUE, HARDWARE_KEY_BYTES, NOTIFICATION_KEY_BYTES, unlock_message, UnlockProof, ConnectVerdict, ConnectRefusal}`
- `UnlockProof { signature: String, hardware_key: Option<String> }` with `to_bytes` / `from_bytes`
- `PairingVerdict::Paired { device_id: String, notification_key: String }`
- `relay::PURPOSE_CONNECT`
- `Request::RemoveThisDevice`, `PROTOCOL_VERSION = 46`, `PAIRING_MIN_VERSION = 46`

- [x] Tests first: `the_unlock_message_is_pinned`, `a_proof_round_trips_with_and_without_a_key`, `a_request_is_not_a_proof`, `a_connect_verdict_round_trips`, `a_refusal_this_build_has_never_heard_of_is_a_value`, `a_paired_verdict_carries_the_notification_key`, `the_connection_pattern_is_ik_on_the_pairing_suite`; in `lib.rs`, `remove_this_device_names_nobody_and_is_gated_at_46`, the variant in `one_of_every_request_variant` and the version assert at 46.
- [x] Implement; `cargo test -p protocol`, `--no-default-features`, and the wasm check.

### Task 2: The Companion core

**Files:** Create `crates/companion-core/src/{channel,connect}.rs`. Modify `pairing.rs`, `error.rs`, `entropy.rs`, `lib.rs`.

**Produces:**
- `PairingClient::start(offer, keys, hardware_key: &[u8], device_name, entropy)`; `PairingEvent::Prove { message }`; `PairingClient::prove(&mut self, signature: &[u8]) -> Result<Vec<PairingEvent>, CoreError>`
- `connect::PairedWorkstation { workstation_key, relays, relay_admission, device_id, notification_key }`, `PairedWorkstation::from_pairing(&PairingQr, &PairingVerdict)`, `.relay_dials()`
- `connect::ConnectClient::{start, receive, prove, send}`; `ConnectEvent::{Send, Prove, Connected, Refused, Message}`

- [x] Tests first, against a `snow` responder written out in the test module: pairing — `the_proof_follows_message_three_and_carries_the_hardware_key`, `no_code_is_shown_before_the_proof_is_made`, `an_offer_from_an_older_workstation_is_refused`; connect — `the_client_is_connected_once_the_workstation_says_so`, `a_refusal_ends_the_connection_and_says_why`, `a_workstation_with_another_key_cannot_read_the_first_message`, `a_message_two_altered_on_the_way_fails_the_handshake`, `a_frame_altered_on_the_way_is_an_error_not_a_message`, `a_frame_delivered_twice_is_an_error_not_a_second_message`, `a_message_cut_across_frames_arrives_whole`, `nothing_is_read_while_the_hardware_is_signing`.
- [x] Implement; wasm check.

### Task 3: The trust store

**Files:** Modify `crates/daemon/src/trust.rs`.

**Produces:** `DEFAULT_DEVICE_CAP = 5`; `Device::{hardware_key, notification_key}`; `Registration`; `confirm_device(device_id, &Registration)`; `TrustStore::remove(device_id) -> bool`; `admit_id`; `Admission::NoHardwareKey`.

- [x] Tests first: `the_store_holds_five_devices_and_refuses_the_sixth`, `a_phase_two_trust_store_gains_the_hardware_key_column` (built by hand), `a_device_with_no_hardware_key_is_told_to_pair_again`, `pairing_again_replaces_both_keys`, `removing_a_device_deletes_only_its_own_row`, `a_removed_device_is_unknown_and_frees_its_slot`.
- [x] Implement.

### Task 4: Pairing registers the hardware key

**Files:** Create `crates/daemon/src/unlock.rs`. Modify `pairing.rs`, `server.rs`.

- [x] Tests first: `unlock.rs` — `a_signature_by_the_registered_key_verifies`, `a_signature_by_another_key_is_refused`, `a_signature_over_another_handshake_is_refused`, `a_key_that_is_not_a_point_is_refused`; `pairing.rs` — `a_pairing_without_a_proof_fails`, `a_proof_signed_by_another_key_fails_the_pairing`; `server.rs` — `a_confirmed_pairing_stores_the_hardware_key_and_mints_a_notification_key`; seam 1 — `a_pairing_whose_proof_does_not_verify_asks_the_desk_nothing`.
- [x] Implement.

### Task 5: The Remote role, fixed by the transport

**Files:** Modify `crates/daemon/src/server.rs`.

**Produces:** `SessionManager::adopt_device(self: &Arc<Self>, device_id) -> anyhow::Result<Result<Stream, ConnectRefusal>>`; `SessionManager::remove_device`.

- [x] Tests first: `a_hello_on_a_device_connection_cannot_change_its_role`, `a_remote_identity_may_remove_itself_and_nothing_else`, `a_device_removing_itself_loses_its_row_and_every_connection_it_holds`, `removing_this_device_from_a_connection_that_is_no_device_is_an_error`, `a_device_that_is_not_trusted_is_not_adopted`, `a_device_holds_no_more_connections_than_the_ceiling`, `a_daemon_with_nobody_at_the_desk_gives_way`.
- [x] Implement.

### Task 6: The daemon serves connections, and seam 1

**Files:** Create `crates/daemon/src/connect.rs`. Modify `remote.rs`, `main.rs`, `Cargo.toml`, `tests/device_wire.rs`, `crates/companion-core/src/test_device.rs`.

- [x] Seam 1 tests first (the card's six criteria, and the review focus):
  - `a_paired_device_connects_and_is_given_the_remote_role`
  - `pairing_through_the_relay_registers_the_hardware_key`
  - `a_device_that_sends_no_signature_gets_no_request_answered`
  - `a_copied_noise_key_on_another_phone_is_refused`
  - `a_relay_that_alters_the_handshake_causes_it_to_fail`
  - `a_relay_that_replays_a_recorded_connection_is_given_nothing`
  - `a_frame_the_relay_repeats_or_alters_ends_the_connection_unanswered`
  - `revoking_a_device_drops_its_live_connection_and_leaves_the_others`
  - `after_revoke_all_an_old_devices_ik_is_refused`
  - `a_sixth_device_is_refused`
  - `a_device_removing_itself_deletes_only_its_own_row`
  - `a_daemon_token_presented_over_the_remote_path_is_ignored`
  - `turning_remote_access_off_drops_a_connected_device`
  - `a_device_unseen_for_ninety_days_is_told_to_pair_again`
- [x] Implement `connect.rs`, the `connect` purpose in `remote.rs`, the test Device's `connect`.

### Task 7: Records

- [x] `docs/security/05-remote-access.md`: phase 3's second slice, and the `IK` half of the proof it owed.
- [x] `CLAUDE.md`: which daemon serves a connection when two share a key, and that an identity the transport fixed is final.
- [x] Full checks: `cargo test --workspace`, the two wasm checks, `cd app && npm test && npm run check && npm run build`.

---

## After review

An independent review of the finished diff found no way for a connection that came through the Relay to have a request answered without a signature verified against the stored key, and none for a Device's connection to change its role. It found the defects below, all in what happens after a connection is accepted and in what a peer can hold on to. Each was reproduced as a failing test first, and each test was shown to fail again with its fix taken out.

| Finding | Fix | Test |
|---|---|---|
| A Device that asked to be removed and hung up before it was answered kept its other connections, with no row for the desk to revoke | The Device's connections are shut whether or not the answer could be written | `a_device_that_asks_to_be_removed_and_hangs_up_loses_its_other_connections` |
| A revocation made by the OTHER daemon sharing the trust store never dropped a connection this one was carrying | A connection's row is read again for as long as it is carried, on the poll that reads the settings | seam 1 `a_revocation_made_by_another_daemon_drops_the_live_connection` |
| One frame of thousands of requests wedged the connection's threads for good: the copy blocked writing requests while the loop blocked writing replies, and neither hang-up nor the switch released it | Nothing in `carry` waits on the connection loop; what the Device sent is handed over by a thread of its own, and a Device that sends without reading is given up on | seam 1 `a_great_many_requests_in_one_frame_are_each_answered` |
| The handshake's timeout was per read, so four peers trickling a byte at a time held every place there was, indefinitely, and a connection can be asked for at any time | One deadline for the handshake and the proof (`Within`); connections being let in have places of their own, apart from the pairings' | `a_handshake_has_one_deadline_however_slowly_it_arrives`, `connections_being_let_in_do_not_take_the_places_pairing_needs`; seam 1 `peers_that_trickle_a_handshake_are_given_up_on`, `streams_that_connect_and_say_nothing_do_not_keep_the_owner_from_pairing` |
| A revoked Device pairing again did not count against the cap: five, one revoked and replaced, and the revoked one back made six | The revive path asks for room when the row it revives is revoked | `a_revoked_device_pairing_again_takes_a_slot_like_any_other`; seam 1 `a_sixth_device_is_refused` |
| Pairing again left connections that were proved under the keys it replaced | Confirming a pairing shuts the Device's connections | `pairing_again_drops_the_connections_made_under_the_old_keys` |
| The test for review focus 2 revoked before adopting, and would have passed with the row read first | A test that holds the two apart with the trust store's own lock | `a_connection_is_where_a_revocation_finds_it_before_its_row_is_read` |
| A unit test read a socket once and expected a whole frame | It reads until the core makes something of what arrived | `a_request_in_the_proofs_place_is_refused_and_not_read_as_a_request` |
| Types that hold the notification key derived `Debug` | Hand-written, without the key | `a_device_does_not_print_its_notification_key`, `a_pairing_decision_does_not_print_the_notification_key`, `a_paired_verdict_does_not_print_the_notification_key` |
| The core kept whatever arrived while the hardware was signing, without limit | Two frames' worth, and then the exchange is over | `what_arrives_while_the_hardware_is_signing_is_bounded` |
| Every refused or failed stream was a line in the log, and anything the Relay admits can ask for one | Twelve lines a minute, and a count of what went unsaid | `what_refused_connections_write_to_the_log_is_bounded` |

Left for their own cards:

- `companion-33-pairing-code-covers-the-handshake.md` — the six digits are derived from the two Noise keys alone, so a pairing made with a copied Noise key and another hardware key shows the code the owner's phone shows. It carries a Decision for the owner, because the spec says the SAS is reused as it is.
- `companion-34-desk-hears-of-refused-devices.md` — a failed proof against a paired Device's row is evidence of a copied key, and reaches only the log.

Known and accepted: a reply from the daemon waits at most one tick of `carry` (5 ms on a connection that is carrying something, 50 ms on one that is not), because the dial is blocking I/O on one socket. That is a floor on latency for the terminals ticket to measure, not a defect of this one.
