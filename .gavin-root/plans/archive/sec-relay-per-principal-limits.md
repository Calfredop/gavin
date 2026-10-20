---
labels: security
kind: task
title: [sec] gavin-relay: per-principal connection ceilings and per-Workstation byte budgets
status: Done
priority: low
complexity: moderate
---
Implement per-principal and per-Workstation limits in gavin-relay. Filed from `sec-check-relay-per-principal-limits.md` (option C, 2026-10-19): docs now name proxy-level controls for any shared instance; build these in-process limits when a publisher-run public Relay is actually planned.

Fingerprint that motivated the work: `gavin-relay/server/shared-slot-pool-without-per-principal-or-bandwidth-limit`.

## Build

Extend `Limits` with the new ceilings and budgets, read them from `GAVIN_RELAY_*` variables in `crates/gavin-relay/src/main.rs` (documented in its header table and in `docs/relay.md`'s limits table), and enforce them in:

- `serve_counting` — per source address, before TLS
- `workstation` — per admission token (registration / connection ceiling across rendezvous ids)
- `copy` — per rendezvous or per stream byte or rate budget; an over-budget stream is ended, not throttled silently

## Trace (re-read before editing; lines as of 2026-10-16)

- `crates/gavin-relay/src/main.rs:77` — `limits: Limits::default()`; make configurable from env.
- `crates/gavin-relay/src/server.rs:54-87` — `Limits` today: global `connections` (4096) and per-rendezvous caps only.
- `crates/gavin-relay/src/server.rs:320` (`serve_counting`) — one process-wide semaphore; at the ceiling the socket is dropped unread.
- `crates/gavin-relay/src/server.rs:391` (`handle`) — slot held through TLS/WS/hello for up to `hello_deadline` (5 s) before the token check.
- `crates/gavin-relay/src/server.rs:508` (`workstation`) — cap is per rendezvous id; ids are any 64 lowercase hex the peer picks (`crates/protocol/src/relay.rs:122-124`).
- `crates/gavin-relay/src/server.rs:646` (`copy`) — frames up to 128 KiB forwarded with no byte or rate budget, only counted.

## Regression tests (`crates/gavin-relay`)

1. A `RunningRelay` with `Limits { connections: 4, .. }` where one token holder registers under 4 distinct rendezvous ids, and a fifth, legitimate Workstation's socket must be served (today a fifth open socket is closed unread once the global pool is full — the new per-token / per-source ceilings must leave room for other principals, or the global pool must not be the only gate that starves them).
2. A stream that copies past its budget is ended.

## Docs after the change

Update `docs/security/06-companion.md`, `docs/self-hosting-relay.md` and `docs/relay.md` so they describe what gavin-relay enforces in-process, and keep the front-proxy guidance for anything still outside those knobs.

## Done when

- The named regression cases are tests in `crates/gavin-relay`, fail before the change and pass after it.
- `GAVIN_RELAY_*` knobs are documented in `main.rs` and `docs/relay.md`.
- No doc still promises a limit that nothing enforces.
- Checks in CLAUDE.md pass for every part you touched.
- Commit only your own files.
