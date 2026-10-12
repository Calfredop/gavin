---
complexity: complex
kind: task
title: "Companion shell: trust the direct listener's pinned certificate natively"
parent: companion-direct-listener.md
---
Finish the Companion's half of the direct listener (ADR 0009, `docs/adr/0009-a-device-can-reach-its-workstation-directly.md`): a phone dials its Workstation's own TLS listener first, trusting only the certificate the pairing QR pinned, and falls back to the Relay.

**Already done** (on the parent card, uncommitted in the shared tree; read the code before adding to it):

- `companion-core`: `pairing::relay_dials` and `connect::connect_dials` put the QR's `direct` addresses first. Each `RelayDial` carries `pin` (the SHA-256 of the listener's certificate DER, lowercase hex, `protocol::relay::certificate_pin`) and an empty admission token. The Relays come after, as before. `PairedWorkstation` keeps `direct` and `direct_pin`. The core does no I/O and draws no randomness of its own.
- `companion-wasm`: `connect-start` takes `direct` and `directPin`, and every dial is `{ url, hello, pin }`.
- The shell's TypeScript: `KeptWorkstation` and `PairedWorkstation` keep `direct` and `directPin`, and a record kept before v69 still reads. `connection.ts` and `pairing.ts` pass `dial.pin` to `open(url, timeoutMs, pin)`, wait at most `DIRECT_DIAL_MS` (4 s) on a direct address, and then try the Relay. `webSocketOpener(Socket, trustPinned?)` calls `trustPinned(url, pin)` before it opens a pinned dial. Given no `trustPinned`, it refuses the dial as unreachable. **So today every direct dial falls through to the Relay**: nothing passes a `trustPinned` yet.

**What is left:**

1. **Native trust for one pin.** The webview's WebSocket refuses a self-signed certificate, and the shell has to tell the platform which one to accept.
   - **iOS.** Add a plugin method the web layer calls as `trustPinned(url, pin)`, which records host:port → pin. Capacitor's `WebViewDelegationHandler` asks plugins through `handleWKWebViewURLAuthenticationChallenge`. Accept a `NSURLAuthenticationMethodServerTrust` challenge for that host and port only when SHA-256 of `SecCertificateCopyData(leaf)` equals the pin, and give every other challenge default handling. Run no default trust evaluation and no host-name check: the certificate is self-signed P-256 for `gavin-workstation`, and nobody checks its dates.
   - **First prove the route exists.** Check that WebKit sends a WebSocket's server-trust challenge to the navigation delegate. The Simulator is enough: run an isolated daemon the way `crates/daemon/tests/device_wire.rs` does, with `GAVIN_DIRECT_PORT` set, or use the devstack. If WebKit does not route the challenge, dial direct addresses through a native socket instead (`URLSessionWebSocketTask` with a pinning delegate), behind the same `OpenRelaySocket` shape.
   - **Android.** Check whether Android's WebView raises `onReceivedSslError` for a WebSocket at all. If it does not, use a native socket there as well. OkHttp is not bundled, so adding it is a dependency decision for the human (`gavin_request_human`).
2. **Wire it in.** `src/routes/+page.svelte` (the live hub's `webSocketOpener`) and `src/shell/pairing/phonePairing.ts` pass the native `trustPinned`.
3. **No cleartext rule.** The direct path is TLS, so do not widen `NSAllowsLocalNetworking` or Android's network security config for it.
4. **Then the parent's human test:** pair a real iPhone over Tailscale with no Relay running.

The suites to keep green are `cd app && npm run companion-shell:test && npm run companion-shell:check`, and `scripts/probe.sh` for the webview seal.
