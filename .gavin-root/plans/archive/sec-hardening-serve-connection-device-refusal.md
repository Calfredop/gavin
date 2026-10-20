---
status: Done
kind: task
title: "[sec-hardening] serve_connection keeps dispatching a revoked Device's buffered requests because it never re-checks device_refusal"
parent: sec-hardening-2026-10-15.md
priority: low
complexity: moderate
labels: security, ready-for-agent
---
Part of `sec-hardening-2026-10-15.md`. A hardening note from the 2026-10-15 security audit (run-1), not a finding. Full record: entry 208 of `results/hardening-all.json` in `~/security-audit-skill/gavin/run-1/`, outside this repo; entry 136 describes the same window from the session-ownership side.

## What

A Device's connection is served by the same loop as the local socket's (`server::serve_connection`), with its identity fixed by the transport. The loop judges the Device once, when the connection registers (`device_refusal` after the entry exists). After that it relies only on the transport: a revocation shuts the connection's stream and the loop ends when its next read sees end of stream. Requests already read into the loop's `BufReader`, or handed to the near end by `remote.rs` before the carry noticed, are still authorized and dispatched after the Device was revoked.

## Why

Revocation should stop a Device at the next request, not at the next empty buffer. The window is small, but it reaches real effects: a `WriteInput` in flight can reach `device_input` after `release_device_sessions`, re-claim the session for the revoked Device, start the 30-second ownership grace and be forwarded to the desk. The `requests` thread in `remote.rs` holds up to `WAITING` (16) payloads and writes them into the near end even after the carry has ended. On Windows the pipe shutdown is weaker still (see `sec-hardening-windows-pipe-shutdown-races.md`). One check in the loop closes it on every platform.

## Where (lines as of 2026-10-16; re-read before editing)

- `crates/daemon/src/server.rs:7962` (serve_connection): the connection loop.
- `crates/daemon/src/server.rs:8060` (serve_connection): `fixed_by_transport = initial_identity.device_id.is_some()`.
- `crates/daemon/src/server.rs:8090` (serve_connection): `read_message(&mut reader)` takes the next request, from the buffer if one is already there.
- `crates/daemon/src/server.rs:8160` (serve_connection): the `authorize` gate; nothing between the read and here asks about revocation.
- `crates/daemon/src/server.rs:2513` (register_device_connection): the one existing re-check, at registration.
- `crates/daemon/src/server.rs:2534` (SessionManager::device_refusal): reads the trust store row (`admit_id`); fails closed on a store it cannot read.
- `crates/daemon/src/remote.rs:924-935` (requests): the thread that writes up to `WAITING` (`remote.rs:187`) queued payloads into the near end.

## Change

In `serve_connection`, right after a request is read and before the `Hello` branch and `authorize`: when `fixed_by_transport`, ask `manager.device_refusal(device_id)`. If it answers `Some`, write one `Response::Error` naming the refusal and `break`, so the loop ends and the guards it owns are dropped. Leave connections whose identity was not fixed by the transport alone; they have no Device to ask about, and the CLAUDE.md rule that `Hello` never replaces a transport-fixed identity is untouched.

`device_refusal` is a SQLite read, so this adds one store read per request on Device connections only (the desktop and agents never take this branch). That is the intended cost, because the store is shared with the other daemon and nothing cached here sees what it writes. If profiling shows it matters for keystroke-rate `WriteInput`, note it on the card before reaching for a cache.

## Test

In `server.rs`'s tests, beside `revoke_device_over_the_wire_drops_the_connection_and_pushes` (server.rs:13455), with a manager under a temp `$HOME` and a trust store: pair a Device, serve a connection with its identity fixed by the transport over `Stream::pair`, write two requests into the near end before the loop reads either, revoke the Device in the store between them (the store row only, without shutting the stream, so the test isolates the loop's own check), and expect the second to be answered with the refusal and the loop to return. Before the change the second request is dispatched. Run `server::tests` under a temp `HOME` (see the memory note on `require_local_token`).

## Done when

- Every request on a transport-fixed connection is refused once the store says the Device may not connect, whatever is already buffered.
- The test above exists and fails before the change; `crates/daemon/tests/device_wire.rs` still passes.
- The checks in CLAUDE.md pass for every part you touched, and you commit only your own files.
