# Companion 10: a test Device pairs through a local Relay — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The first slice of the Device wire: a test Device pairs with a real daemon through a real local Relay, and the trust store gains its row only after the desk confirms.

**Architecture:** Three new pieces around the phase-2 pairing responder, which is reused unchanged. A **Relay** (`crates/gavin-relay`, tokio) admits connections by token, matches a Device's stream to a Workstation by rendezvous id and copies binary frames between them. The **daemon** gains `remote.rs`: a supervisor thread that dials the Relay only while the trust store says remote access is on, claims each pairing stream the Relay announces, runs `pair_over` on it and answers the Device with the desk's verdict. The **Companion core** (`crates/companion-core`) is a sans-IO Noise `XXpsk3` initiator that compiles to WASM; its `test-device` feature adds the blocking transport that makes it seam 1's test Device.

**Tech Stack:** Rust; `snow` 0.10 (Noise); `tungstenite` 0.28 (blocking client); `tokio` + `tokio-tungstenite` 0.28 + `tokio-rustls` 0.26 (Relay); `rustls` 0.23 with `ring`; `rustls-native-certs` 0.8; `rcgen` 0.14 (tests only).

**Spec:** `docs/superpowers/specs/2026-09-27-companion-design.md` — sections "The Relay", "The Companion core", "Pairing and the trust store". Also `docs/security/05-remote-access.md` §3, §5, §7, `docs/adr/0001-device-key-is-two-keys.md`, `CONTEXT.md`.

## Global Constraints

- Glossary words are **Workstation**, **Device**, **Relay**, **Companion** (`CONTEXT.md`). Never "phone", "client", "proxy", "server" for those things in names or copy.
- Pairing pattern is `Noise_XXpsk3_25519_ChaChaPoly_BLAKE2s`, one string, shared by both ends.
- The pairing SAS is `protocol::pairing_sas`, reused as-is by the Device.
- Padding bucket is 256 bytes (05 §11 Q11, kept by the spec).
- The Companion core and the protocol crate (with `os` off) must check for `wasm32-unknown-unknown`.
- A widened request needs a `FEATURE_MIN_VERSION` entry **and** a `featureBlockedReason` consumer (CLAUDE.md).
- Never `pkill gavin-daemon`. Seam 1 runs an isolated daemon under a temporary `$HOME`.
- Nothing reaches `devices.sqlite` before `ConfirmPairing`.
- No attribution to an agent or model in anything that lands in the repo.

## Review Focus

1. **Two daemons, one key.** The dev and the release daemon share `devices.sqlite`, so both register under the same rendezvous id. A pairing stream must reach the daemon that holds the offer. → Relay announces to every registration; a daemon with no live offer does not claim. Test: `a_stream_is_claimed_by_the_workstation_that_wants_it` (Task 3).
2. **The desk never answers.** A Device must not wait forever, and a late Confirm must not write a row for a Device that was told the pairing lapsed. → decision deadline; the pending handshake is withdrawn when it passes. Test: `a_pairing_nobody_answers_is_withdrawn` (Task 5).
3. **The switch is turned off while connected.** The daemon must let go of the Relay within about a second. Test: `turning_remote_access_off_drops_the_relay_connection` (Task 6, seam 1).
4. **A plain `ws://` URL to a public host** would put the admission token on the network in the clear. → refused unless the host is loopback or private. Test: `a_plain_url_to_a_public_host_is_refused` (Task 1).
5. **An older app toggling the switch** must not wipe a token it has never heard of. → an absent `relay_admission` means "unchanged". Test: `an_absent_relay_admission_leaves_the_stored_one_alone` (Task 5).

---

## The wire contract (settled here, used by every task)

### Relay admission: the first frame

Every WebSocket to the Relay sends one **text** frame first, within 5 s, at most 4096 bytes. The token rides in this frame rather than in a header or the URL: a webview's `WebSocket` cannot set a header, and a token in a URL is a token in every proxy's access log. The Relay URL is therefore opaque — it is dialled exactly as typed.

```json
{"role":"workstation","v":1,"token":"…","rendezvous":"<64 hex>"}
{"role":"device","v":1,"token":"…","rendezvous":"<64 hex>","purpose":"pair"}
{"role":"stream","v":1,"token":"…","rendezvous":"<64 hex>","stream":"<32 hex>"}
```

The Relay answers in text frames:

```json
{"type":"ready"}
{"type":"incoming","stream":"<32 hex>","purpose":"pair"}
{"type":"refused","reason":"admission"}
```

- `rendezvous` = `hex(SHA-256("gavin-relay-rendezvous-v1" || daemon static public key))`.
- `purpose` is an opaque label to the Relay (it forwards the string), so a later purpose needs no Relay release.
- Refusal reasons: `admission`, `offline` (no Workstation registered), `unclaimed` (none claimed the stream in 10 s), `gone` (no such stream), `busy`, `malformed`, `version`.
- After `ready` on a `device` or `stream` connection, every frame is **binary** and copied verbatim. A text frame there ends both legs.

### Pairing stream, inside the Relay's pipe

Unchanged from phase 2: each Noise message is `u16 BE length || bytes`. After message 3 the daemon holds the stream open until the desk rules, then sends **one** transport frame and closes:

```text
frame     = u16 BE length || ciphertext            (frame length is a multiple of 256)
plaintext = u16 BE payload length || payload || zero padding
payload   = {"type":"paired","deviceId":"dev-…"} | {"type":"rejected"} | {"type":"expired"}
```

### Protocol v45

- `SetRemoteAccess` gains `relay_admission: Option<String>` — absent: unchanged; `""`: cleared.
- `Devices` gains `relay_admission_set: bool`. The token itself never returns on the socket, except inside the QR string.
- `PairingQr` gains `relayAdmission` (omitted when there is none).

---

## File structure

| File | Responsibility |
|---|---|
| `crates/protocol/src/relay.rs` (new) | The Relay wire contract: hello and reply types, rendezvous id, Relay URL rules. |
| `crates/protocol/src/device_wire.rs` (new) | The padded frame codec and `PairingVerdict`. |
| `crates/protocol/src/lib.rs` | v45; `PAIRING_NOISE_PARAMS`; public hex helpers; the widened types. |
| `crates/gavin-relay/src/server.rs` (new) | Admission, registration, matching, splice. |
| `crates/gavin-relay/src/client.rs` (new) | Blocking dial over TLS; `RelayStream: Read + Write`. |
| `crates/gavin-relay/src/main.rs` (new) | The `gavin-relay` binary: configuration from the environment. |
| `crates/companion-core/src/{lib,keys,entropy,pairing,error}.rs` (new) | The sans-IO pairing client. |
| `crates/companion-core/src/test_device.rs` (new, feature `test-device`) | The native test Device. |
| `crates/daemon/src/remote.rs` (new) | Dial supervisor; serves pairing streams. |
| `crates/daemon/src/{trust,pairing,server,main}.rs` | Token storage; verdict frame; decision channel; supervisor start. |
| `crates/daemon/tests/device_wire.rs` (new) | Seam 1. |
| `app/src-tauri/src/session.rs`, `app/src/lib/core/*` | The admission-token field, its gate, and copy that no longer says "nothing dials". |

---

### Task 1: The wire contract in the protocol crate

**Files:** Create `crates/protocol/src/relay.rs`, `crates/protocol/src/device_wire.rs`. Modify `crates/protocol/src/lib.rs`.

**Produces:**
- `protocol::PAIRING_NOISE_PARAMS: &str`
- `protocol::hex_encode(&[u8]) -> String`, `protocol::hex_decode(&str) -> anyhow::Result<Vec<u8>>`
- `protocol::relay::{RELAY_WIRE_VERSION, MAX_HELLO_BYTES, PURPOSE_PAIR, RelayHello, RelayReply, RefusalReason, rendezvous_id, RelayUrl, RelayUrlError}`; `RelayUrl::parse(&str) -> Result<RelayUrl, RelayUrlError>`
- `protocol::device_wire::{FRAME_BUCKET, MAX_PAYLOAD, pad, unpad, PairingVerdict}`
- `Request::SetRemoteAccess { enabled, relay_url, relay_admission }`, `Response::Devices { …, relay_admission_set }`, `PairingQr::relay_admission`, `PROTOCOL_VERSION = 45`

- [x] Tests first, in each new module: `the_rendezvous_id_is_pinned` (a fixed key to a fixed 64-hex id), `a_hello_round_trips_in_kebab_case`, `a_reply_this_build_has_never_heard_of_is_a_value`, `a_secure_url_is_accepted_for_any_host`, `a_plain_url_to_a_public_host_is_refused`, `a_plain_url_to_loopback_or_a_private_address_is_accepted`, `a_url_with_no_scheme_or_another_scheme_is_refused`, `a_padded_frame_is_a_multiple_of_the_bucket_on_the_wire`, `padding_round_trips_every_length_up_to_the_cap`, `a_payload_over_the_cap_is_refused`, `a_frame_whose_length_field_lies_is_refused`, `a_verdict_round_trips`.
- [x] In `lib.rs`: `a_set_remote_access_with_no_token_is_what_an_older_app_sends`, `a_devices_reply_with_no_token_flag_is_what_an_older_daemon_sends`, `the_qr_carries_the_admission_token_when_there_is_one`; move the version assert to 45.
- [x] Run `cargo test -p protocol`, watch them fail, implement, watch them pass.
- [x] Run `cargo test -p protocol --no-default-features` and `cargo check -p protocol --no-default-features --target wasm32-unknown-unknown`.

### Task 2: The Companion core

**Files:** Create `crates/companion-core/`. Modify root `Cargo.toml` (member).

**Consumes:** Task 1.

**Produces:**
- `companion_core::Entropy::from_bytes(Vec<u8>)`
- `companion_core::DeviceKeys::generate(Entropy) -> Result<DeviceKeys, CoreError>`, fields `private`, `public`; `DeviceKeys::from_private(&[u8])`
- `companion_core::pairing::PairingClient::start(offer: &PairingQr, keys: &DeviceKeys, device_name: &str, entropy: Entropy) -> Result<(PairingClient, Vec<u8>), CoreError>`
- `PairingClient::receive(&mut self, bytes: &[u8]) -> Result<Vec<PairingEvent>, CoreError>`
- `enum PairingEvent { Send(Vec<u8>), CompareCode { sas: String }, Finished(PairingVerdict) }`
- `companion_core::pairing::relay_dials(offer: &PairingQr) -> Result<Vec<RelayDial>, CoreError>`; `RelayDial { url: String, hello: RelayHello }`

- [x] Tests first, against a `snow` responder written out in the test module: `the_client_reaches_the_code_the_responder_computes`, `bytes_delivered_one_at_a_time_reach_the_same_code`, `a_workstation_with_another_key_is_abandoned_before_the_secret_is_used`, `a_wrong_secret_is_refused_by_the_responder`, `a_verdict_frame_finishes_the_pairing`, `entropy_that_runs_out_is_an_error_not_a_weak_key`, `the_dial_carries_the_token_and_the_rendezvous_the_qr_names`.
- [x] Implement. `snow` with `default-features = false` and only `use-chacha20poly1305`, `use-blake2`, `use-curve25519`: no OS random source is linked, and the resolver's RNG is the `Entropy` the caller supplied.
- [x] `cargo check -p companion-core --target wasm32-unknown-unknown`; add that step to the `wasm` job in `.github/workflows/ci.yml`.

### Task 3: The Relay

**Files:** Create `crates/gavin-relay/`. Modify root `Cargo.toml`.

**Consumes:** Task 1.

**Produces:**
- `gavin_relay::server::{RelayConfig, Tls, RunningRelay, RelayStats}`; `RunningRelay::start(RelayConfig) -> anyhow::Result<RunningRelay>`, `.local_addr()`, `.stats()`, stops on drop
- `gavin_relay::client::{DialOptions, RelayConnection, RelayStream, DialError}`; `client::dial(url, &RelayHello, &DialOptions) -> Result<RelayConnection, DialError>`; `RelayConnection::next_reply(&mut self, wait: Duration) -> Result<Option<RelayReply>, DialError>`; `.ping()`; `.into_stream() -> RelayStream`; `RelayStream::stay_alive(wait) -> io::Result<bool>`, which a caller holding a stream open without reading it must call, or the Relay drops the leg for silence

- [x] Tests first (`crates/gavin-relay/tests/relay.rs`, plain `ws://127.0.0.1`): `bytes_written_by_one_end_arrive_at_the_other`, `a_connection_without_the_admission_token_is_refused`, `a_connection_with_the_wrong_token_is_refused`, `a_device_with_no_workstation_is_told_it_is_offline`, `a_stream_nobody_claims_is_refused`, `a_stream_is_claimed_by_the_workstation_that_wants_it`, `a_first_frame_that_is_not_a_hello_is_refused`, `a_silent_connection_is_dropped_at_the_deadline`, `a_text_frame_on_a_spliced_stream_ends_both_legs`, `a_relay_refuses_to_start_without_a_token`, and one over TLS with an `rcgen` certificate: `a_tls_relay_is_reached_by_a_client_that_trusts_its_certificate`.
- [x] Implement server, client, binary.

### Task 4: The trust store holds the admission token

**Files:** Modify `crates/daemon/src/trust.rs`.

- [x] Tests first: `a_store_that_was_never_told_has_no_relay_admission`, `the_relay_admission_survives_a_reopen_and_the_switch`, `a_blank_relay_admission_reads_back_as_none`, `revoke_all_rotates_the_key_and_leaves_the_settings_alone`, `a_store_from_before_the_token_reads_it_as_absent` (a database built by hand with the phase-2 rows).
- [x] Implement: `RemoteAccess::relay_admission`, one more `trust_meta` key. No migration: `trust_meta` is key/value.

### Task 5: The daemon answers the Device, and takes the token

**Files:** Modify `crates/daemon/src/pairing.rs`, `crates/daemon/src/server.rs`.

**Produces:**
- `pairing::send_verdict<S: Write>(stream, &mut snow::TransportState, &PairingVerdict) -> anyhow::Result<()>`
- `SessionManager::pair_over_awaited(stream) -> anyhow::Result<(PairingHandshake, Receiver<PairingDecision>)>`
- `SessionManager::withdraw_pairing(device_id)`, `SessionManager::has_pairing_offer() -> bool`
- `SessionManager::remote_wake() -> Arc<remote::Wake>` — what `remote.rs` waits on

- [x] Tests first: `a_confirmed_pairing_tells_whoever_is_waiting`, `a_rejected_pairing_tells_whoever_is_waiting`, `a_new_offer_ends_the_wait_for_the_old_one`, `a_pairing_nobody_answers_is_withdrawn`, `an_absent_relay_admission_leaves_the_stored_one_alone`, `an_empty_relay_admission_clears_it`, `the_device_list_says_whether_a_token_is_set_and_never_what_it_is`, `the_qr_carries_the_stored_admission_token`, and in `pairing.rs` `a_verdict_reaches_the_initiator_in_one_padded_frame`.
- [x] Implement.

### Task 6: The daemon dials, and seam 1

**Files:** Create `crates/daemon/src/remote.rs`, `crates/daemon/tests/device_wire.rs`, `crates/companion-core/src/test_device.rs`. Modify `crates/daemon/src/main.rs`, `crates/daemon/Cargo.toml`.

- [x] Seam 1 tests first, against the real binary under a temporary `$HOME`, a TLS Relay with an `rcgen` certificate the daemon trusts through `SSL_CERT_FILE`, and the test Device:
  - `a_test_device_pairs_through_the_relay_and_the_row_appears_only_after_the_desk_confirms`
  - `a_rejected_pairing_leaves_no_row_and_tells_the_device`
  - `a_relay_connection_without_the_admission_token_is_refused`
  - `with_remote_access_off_the_daemon_dials_nothing`
  - `turning_remote_access_off_drops_the_relay_connection`
  - `a_wrong_secret_fails_the_handshake`
- [x] Implement `remote.rs` and the test Device; start the supervisor from `main.rs::serve`.

### Task 7: The desk's settings

**Files:** Modify `app/src-tauri/src/session.rs`, `app/src/lib/core/{backend.ts,remoteAccess.ts,daemonCompat.ts,GlobalSettingsView.svelte}` and their tests.

- [x] Tests first in `remoteAccess.test.ts` and `remoteAccessSurfaces.test.ts`: the token draft's save rule, the gate reading `FEATURE_MIN_VERSION.relayAdmission`, a Relay URL hint that mirrors `RelayUrl::parse`, and Pair a device offered only when a Device could pair, the copy.
- [x] Implement; batch the two `src-tauri` edits into one save.

### Task 8: Records

- [x] `docs/security/05-remote-access.md`: §7's `PairingQr` shape and a note that phase 3's first slice has landed.
- [x] `CLAUDE.md`: the two new crates under "What this repo is".
- [x] Full checks: `cargo test --workspace`, `cd app && npm test && npm run check && npm run build`.

---

## After review

An independent review of the finished diff found no path that pairs a Device without the desk's confirm and none that writes the store early, and eight defects. All were reproduced as failing tests first and then fixed:

| Finding | Fix | Test |
|---|---|---|
| The secret was not single-use for handshakes in flight, and a late handshake cleared whatever offer was current | The offer is re-checked and taken under its lock at completion | `a_secret_is_spent_by_the_first_handshake_to_complete`, `a_handshake_on_a_replaced_offer_is_refused_and_leaves_the_new_one_alone`, `a_handshake_that_outlives_its_offer_is_refused`; seam 1 `a_secret_pairs_one_device` |
| A change to the shared trust store by the other build's daemon was never noticed | `remote.rs` re-reads the store every two seconds | seam 1 `a_change_made_by_another_daemon_is_followed` |
| A read timeout longer than the Relay's keepalive never fired, so silent peers pinned every stream slot | `RelayStream` reads against a deadline; `HANDSHAKE_READ` is ten seconds | `a_read_gives_up_at_its_timeout_however_often_the_relay_asks_after_it`; seam 1 `devices_that_say_nothing_do_not_keep_the_owner_from_pairing` |
| Turning remote access off left pairing streams open and confirmable | The wait on the desk ends when the dial stops being wanted | seam 1 `a_device_half_way_through_pairing_is_let_go_when_remote_access_is_turned_off` |
| The stored token was presented to whatever Relay URL was saved next | A changed URL with no token forgets the stored one | `a_new_relay_url_does_not_inherit_the_old_relays_token` |
| The Rust URL rule and its TypeScript mirror disagreed on some inputs | Both tightened, and both held to `test-fixtures/relay-urls/cases.json` | `every_case_in_the_shared_table_is_judged_as_the_table_says` and its twin in `remoteAccess.test.ts` |
| A Confirm landing as the wait gave up could leave a row and a Device told "expired" | Withdrawal is by ticket and reports whether it happened; if not, the desk's answer is waited for | `a_confirm_that_lands_as_the_wait_gives_up_is_a_pairing`, `a_stale_waiter_cannot_withdraw_a_newer_pairing` |
| The section's copy and Pair a device were untrue against a v44 daemon | `FEATURE_MIN_VERSION.relayDial`, read by `transportNote` and `pairingUnavailable` | `remoteAccess.test.ts`, "against a daemon that does not dial" |

Also from the review: `Limits::silence` had no test (now `a_workstation_that_stops_answering_is_dropped` and two beside it), the wait's deadline was only ever exercised by hand (now `a_pairing_nobody_answers_in_time_lapses_and_cannot_be_confirmed_after`), and "Revoke all" left an offer naming the old key outstanding (now `revoke_all_ends_the_pairing_in_progress`).

Left for their own cards: `companion-31-gate-confirm-pairing.md` (a script in the app's origin can run the whole ceremony) and `companion-32-relay-status-at-the-desk.md` (the desk cannot see whether the dial worked).
