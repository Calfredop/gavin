---
title: Companion: direct connection, no Relay
status: To Do
priority: medium
attachments: docs/superpowers/specs/2026-09-27-companion-design.md,docs/self-hosting-relay.md,docs/relay.md,CONTEXT.md
complexity: intricate
---
A Device reaches its Workstation directly, over the same network or a Tailscale tailnet, with no Relay to run and no admission token to copy. The Relay stays the default for a phone away from the desk; this is the zero-setup option for people who do not want to host or configure one.

This is the card the spec deferred: "The direct LAN or Tailscale listener. Relay first; direct connection is a later card on the same code path" (companion design spec, Out of Scope). Read the spec's Relay section first, so the direct path reuses the Noise handshake, Device keys and admission as they are.

**Why a listener in the daemon and not an embedded Relay.** The Relay only matches two streams and copies bytes, and everything inside is end-to-end encrypted. A direct Device needs no matching, no rendezvous id and no admission token: the pairing offer already carries the daemon's public key and a one-time secret. An embedded Relay would keep all three and add a second server to configure.

**What the 2026-10-08 hand test showed.**
- A dev desktop accepts a Relay URL only if `RelayUrl::parse_for` calls the host local. `100.64.0.0/10` counts as local; a `.ts.net` name does not, so a TLS Relay on a Tailscale name is refused by the dev app.
- The iOS shell allows `ws://` only through `NSAllowsLocalNetworking`. A phone dialling `ws://100.79.93.51:8444` never reached the Relay, and a WebSocket failure inside the webview logs nothing. Pairing over the LAN address worked.
- A direct listener meets the same iOS cleartext rule, so it should serve TLS with a certificate the Device pins from the pairing offer, not plain `ws://`.

- [ ] Write the decision as an ADR: direct listener in the daemon, not an embedded Relay; opt-in; pinned certificate in the offer; how it coexists with the Relay path. Check that nothing in ADRs 0001-0005 forbids it.
- [ ] Settle the open choices with the human: default port; which interfaces to bind (tailnet only, LAN, both); whether a setting turns it on or pairing does.
- [ ] Protocol: the pairing offer carries one or more direct addresses and the listener's pinned certificate key beside the Relay list. Decide whether this widens an existing request, which needs a `FEATURE_MIN_VERSION` entry in `app/src/lib/daemonCompat.ts` and a `featureBlockedReason` consumer on every UI surface that can produce the payload (the compat gate is per request type).
- [ ] Daemon: a listener in `crates/daemon` that accepts a Device connection through the same loop as the Relay path, with `ClientIdentity::remote` handed in by the transport and never replaced by `Hello`. Cap connections, require the first frame within a timeout, and refuse anything that is not a Device hello before any state is touched. Model the limits on the Relay's `Limits`.
- [ ] Two daemons: the dev and release daemons share one trust store, so each needs its own port and a rule for which answers a paired Device (see `remote::deference`). Test with an isolated daemon under a temp `$HOME`, the way `crates/daemon/tests/device_wire.rs` does.
- [ ] `companion-core` and the Companion shell: dial the direct address first and fall back to the Relay. Keep the core free of I/O and randomness. Add the cleartext rule for the platform only if TLS is not used.
- [ ] Address discovery: the offer is written at pairing time and a LAN address changes. Decide between listing every address, a stable Tailscale name, and Bonjour. Record what the Device does when a stored address stops answering.
- [ ] Settings → Remote access: the opt-in, the address the Device will use, a status line, and a way to turn it off that closes the port.
- [ ] If `RelayUrl::parse` changes, add the case to `test-fixtures/relay-urls/cases.json` first and keep `app/src/lib/core/remoteAccess.ts` in step. Both suites read that table.
- [ ] Tests: the daemon's `device_wire.rs` with the test Device over the direct path, a refused non-Device first frame, a connection over the cap, and a handshake timeout.
- [ ] Docs: `docs/relay.md` and `docs/self-hosting-relay.md` say when to use which, and that the direct path needs the Device and the Workstation on one network or tailnet.
- [ ] Human test: pair a real iPhone over Tailscale with no Relay running, on a network where the phone and the Mac share nothing else.
