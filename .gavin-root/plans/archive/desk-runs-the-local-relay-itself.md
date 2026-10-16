---
kind: task
title: Desk runs the local Relay itself
parent: companion-local-relay-and-direct-without-collision.md
---
Read the parent card, `companion-local-relay-and-direct-without-collision.md`, and the answer under its decision "which daemon owns the desk-run Relay when release and dev both run?". That answer decides the ownership step below. If it is still unanswered, stop and say so. Read ADR 0009, `crates/gavin-relay/src/main.rs` and `docs/companion-mobile.md` "Pair with a local Relay" (the manual steps this replaces).

Build the option **"Run a Relay on this Mac"** in Settings → Remote access, beside the Relay URL. This covers the parent's §1.2, §1.3 and §2.1:

- **Who runs it.** The daemon runs it, not the app window. The daemon outlives the window, which is why the Relay dial lives there (`remote.rs` header). It starts `gavin-relay` while the option and remote access are both on, and stops it when either goes off. Ship `gavin-relay` as a sidecar beside gavin-daemon and gavin-mcp; the memories `project_release_signing_and_sidecars` and `project_external_bin_breaks_cargo_test` describe the externalBin traps. A dev build runs `target/debug/gavin-relay`.
- **Port.** `protocol::relay::RELAY_DEFAULT_PORT` (8443) unless it is taken. Never `DIRECT_PORT_RELEASE`, `DIRECT_PORT_DEV` or `GAVIN_DIRECT_PORT`, and never a port something already listens on. Write the picker as a pure function with unit tests. `RelayUrl::refuse_direct_listener` (protocol) already refuses a URL that names a direct port on this machine. The picker must never produce one.
- **Process.** Bind `0.0.0.0:<port>` with `GAVIN_RELAY_TLS_TERMINATED=1`: `RelayUrl::parse` allows `ws://` to this network only. Point `GAVIN_RELAY_TOKENS_FILE` at a `0600` file in the data dir.
- **Token (§2.1).** The desk mints the token (CSPRNG, `getrandom`) and stores it in the trust store as `relay_admission`, with a marker that the desk generated it. Use a new META key rather than a column; if a column is needed, read CLAUDE.md on `CREATE TABLE IF NOT EXISTS` migrations. The desk writes the token to the token file and dials with it. Nobody copies a token by hand.
- **URL.** The desk fills in `ws://<LAN address>:<port>` itself; `direct::addresses` finds the default route's address. When DHCP renumbers the Mac, it fills the URL in again and says so.
- **Ownership.** Both daemons share `devices.sqlite`, so only one of them runs the process. The other dials the same URL and token from the store. Implement the option the decision chose.
- **§1.3.** Explain the macOS firewall prompt for `gavin-relay` in Settings. Until the prompt is answered, the phone and the daemon both time out with nothing said.
- **Status.** A line saying whether the desk's Relay is running, on which port, and why not when it is not.
- **Protocol.** A new request, or a widened `SetRemoteAccess`, needs a `PROTOCOL_VERSION` bump, a `FEATURE_MIN_VERSION` entry and a `featureBlockedReason` consumer on the Settings control (CLAUDE.md, "The compat gate is per request TYPE").
- **Tests.** Unit tests for the port picker, the token file's `0600` mode and the ownership rule. `crates/daemon/tests/device_wire.rs` pairs a Device through the desk-run Relay.

When done, tick §1.2, §1.3 and §2.1 on the parent, and file the parent's human test once the refresh task is done too.
