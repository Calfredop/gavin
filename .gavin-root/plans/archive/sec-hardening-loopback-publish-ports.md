---
status: Done
kind: task
title: "[sec-hardening] The push gateway docs and the Relay's deploy.sh publish the plain-HTTP ports 8080 and 8443 on every interface"
parent: sec-hardening-2026-10-15.md
priority: low
complexity: simple
labels: security, ready-for-agent
---
Part of `sec-hardening-2026-10-15.md`. A hardening note from the 2026-10-15 security audit (run-1), not a finding. Full record: entries 212 and 213 of `results/hardening-all.json` in `~/security-audit-skill/gavin/run-1/`, outside this repo.

## What

Two deployment instructions publish a cleartext port on every host interface when a proxy on the same host is meant to be its only client:

- `docs/push-gateway.md` gives both docker run examples `-p 8080:8080`, three paragraphs above its own instruction not to publish port 8080 to the internet directly.
- `crates/gavin-relay/scripts/deploy.sh run` defaults `--publish` to `8443:8443`. That is right when the Relay holds its own certificate, and wrong when the env file sets `GAVIN_RELAY_TLS_TERMINATED=1`: then 8443 is plain WebSocket and only the proxy should reach it. `docs/relay.md:127` passes `--publish 127.0.0.1:8443:8443` for that case, but a run without the flag gets every interface.

## Why

A port the proxy is supposed to front, reachable directly, carries bearers and admission tokens in cleartext on that hop. It also bypasses anything the proxy enforces: `docs/push-gateway.md:232-235` puts the per-address registration limit in front of the public instance, and a caller who reaches 8080 directly never meets it. On the Relay side the exposure is smaller, because `RelayUrl::parse` already refuses a public `ws://` URL, so no correctly configured client dials the plain port; it is still a token-gated cleartext port nobody needs open.

## Where (lines as of 2026-10-16; re-read before editing)

- `docs/push-gateway.md:179` (dry run) and `:186` (live): `-p 8080:8080`.
- `docs/push-gateway.md:200-202`: "do not publish port 8080 to the internet directly".
- `crates/gavin-relay/scripts/deploy.sh:43` (run): `publish="8443:8443"`; `--publish` overrides it at :48, and the value reaches `docker run -p` at :62.
- `docs/relay.md:127` and `:134`: the loopback form already used for the proxy case. `docs/relay.md:179` and `docs/self-hosting-relay.md:137` publish 8443 on every interface for a Relay holding its own certificate, which is correct and stays.

## Change

In `docs/push-gateway.md`, change both examples to `-p 127.0.0.1:8080:8080` and add one line under the live example: a proxy on another host publishes on the address that host reaches, never `0.0.0.0` on a public interface.

In `deploy.sh run`, leave `publish` empty until the arguments are read. If `--publish` was not given, default to `127.0.0.1:8443:8443` when the env file has a `GAVIN_RELAY_TLS_TERMINATED=1` line, and to `8443:8443` otherwise. Print which one was chosen beside the existing `running …` line, so an operator who expected the other one sees it. Update the usage text to say so.

Out of scope: `compose.dev.yaml` publishes the dev Relay and the dry-run gateway on every interface on purpose, so a phone on the LAN can reach them (entries 189 and 219 cover it). Leave it unless you are changing the dev stack anyway.

## Test

There is no harness for `deploy.sh`. Check it by hand with a stub: put a `docker` script first on `PATH` that prints its arguments, then run `deploy.sh run --env-file <file>` once with a file containing `GAVIN_RELAY_TLS_TERMINATED=1` (expect `-p 127.0.0.1:8443:8443`), once without it (expect `-p 8443:8443`), and once with `--publish 0.0.0.0:9000:8443` (expect that value). Record the three outputs under a dated "## Comments" heading on this card. `shellcheck crates/gavin-relay/scripts/deploy.sh` stays clean.

## Done when

- Neither docker run example in `docs/push-gateway.md` publishes 8080 on every interface.
- `deploy.sh run` with a TLS-terminated env file and no `--publish` binds 8443 on loopback only, an explicit `--publish` still wins, and the three stub runs are recorded on the card.
- The checks in CLAUDE.md pass for every part you touched, and you commit only your own files.

## Comments

### 2026-10-19 — deploy.sh stub runs

With a stub `docker` first on `PATH` that prints its arguments:

1. env file with `GAVIN_RELAY_TLS_TERMINATED=1`, no `--publish` → `-p 127.0.0.1:8443:8443` and `running … publish 127.0.0.1:8443:8443`
2. env file without that line → `-p 8443:8443` and `running … publish 8443:8443`
3. `--publish 0.0.0.0:9000:8443` with a TLS-terminated env file → `-p 0.0.0.0:9000:8443` (explicit wins)

`shellcheck` is not installed on this machine; the script changes are a small case of the existing pattern.
