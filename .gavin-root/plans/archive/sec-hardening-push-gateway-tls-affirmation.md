---
status: Done
kind: task
title: "[sec-hardening] The push gateway starts in plain HTTP on a public address with no TLS affirmation, unlike the Relay's GAVIN_RELAY_TLS_TERMINATED"
parent: sec-hardening-2026-10-15.md
priority: low
complexity: simple
labels: security, ready-for-agent
---
Part of `sec-hardening-2026-10-15.md`. A hardening note from the 2026-10-15 security audit (run-1), not a finding. Full record: entries 191, 211 and 216 of `results/hardening-all.json` in `~/security-audit-skill/gavin/run-1/`, outside this repo.

## What

`gavin-push-gateway` always serves plain HTTP. Its default listen address is `0.0.0.0:8080`, and its image sets the same. Nothing at startup asks the operator to say that something in front of it terminates TLS. The Relay refuses to start in that state: with no certificate it needs `GAVIN_RELAY_TLS_TERMINATED=1`, or it exits with a message naming both options.

## Why

Every request a Device or a Workstation makes to the gateway carries a bearer: a Device secret on registration and token calls, a send permission on `POST /v1/push`. A gateway that comes up on a public address with no proxy in front carries them in cleartext. Today the only control is a sentence in `docs/push-gateway.md` ("put it behind a TLS-terminating proxy"). No in-repo client sends a bearer over `http://` unless the owner configures an `http://` gateway URL, which is why this is hardening and not a finding.

## Where (lines as of 2026-10-16; re-read before editing)

- `crates/push-gateway/src/config.rs:95` (Config::from_env): `listen` defaults to `0.0.0.0:8080`. No TLS variable exists; `KNOWN` (config.rs:30-43) lists every accepted `GAVIN_PUSH_*` name, and `check_names` (config.rs:74) refuses any other.
- `crates/push-gateway/src/main.rs:24` (run): reads the config and binds `config.listen` with no further check.
- `crates/push-gateway/Dockerfile:37`: the image sets `GAVIN_PUSH_LISTEN=0.0.0.0:8080`, so inside a container the bind is always non-loopback.
- `crates/gavin-relay/src/main.rs:53-70` (tls): the Relay's guard, the pattern to copy.
- `docs/push-gateway.md:151` (variable table), `:179` and `:186` (docker run examples), `:200-202` (the TLS paragraph).
- `compose.dev.yaml:31-42`: the dev stack's dry-run gateway, which would need the new variable too.

## Change

Add `GAVIN_PUSH_TLS_TERMINATED` to `config.rs` (a `pub const`, an entry in `KNOWN`, and a `tls_terminated: bool` on `Config`). In `from_env`, refuse to build a config whose `listen` address is not loopback unless the variable is `1`, with a message in the Relay's words: "gavin-push-gateway: it serves plain HTTP — set GAVIN_PUSH_TLS_TERMINATED=1 if a proxy in front of it terminates TLS, or listen on 127.0.0.1". A loopback bind needs nothing, so `cargo run` on a laptop is unchanged.

Then add `-e GAVIN_PUSH_TLS_TERMINATED=1` to both docker run examples, a row to the variable table, and `GAVIN_PUSH_TLS_TERMINATED: "1"` to the dev stack's gateway, with a comment like the Relay's above it. Say in the TLS paragraph that an existing deployment must add the variable before it upgrades, or the new image will not start.

## Test

In `config.rs`'s tests module (config.rs:190): `from_env` with `LISTEN=0.0.0.0:8080` and no TLS variable is an error naming `GAVIN_PUSH_TLS_TERMINATED`; the same with the variable `1` is Ok; `LISTEN=127.0.0.1:8080` with no variable is Ok; and `check_names` accepts the new name. The existing default-config test (config.rs:202 asserts `0.0.0.0:8080`) has to change with it.

## Done when

- A non-loopback listen without `GAVIN_PUSH_TLS_TERMINATED=1` fails at startup with a message naming the variable, and a loopback listen still starts with no extra setting.
- The tests above are in `config.rs`, and the refusal case fails before the change.
- `docs/push-gateway.md` and `compose.dev.yaml` set the variable wherever they bind publicly, and the docs say an upgrade needs it.
- The checks in CLAUDE.md pass for every part you touched, and you commit only your own files.
