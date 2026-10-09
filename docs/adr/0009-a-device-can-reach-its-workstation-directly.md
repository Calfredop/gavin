# A Device can reach its Workstation directly, through a listener in the daemon

The Companion spec shipped the Relay first and deferred the direct path: "Relay first; direct connection is a later card on the same code path" (spec, Out of Scope). `docs/security/05-remote-access.md` §5 had already chosen the shape: "direct connection (LAN, Tailscale) as the same code path minus the relay." Hosting a Relay is setup that a person who keeps their phone on the same network or tailnet as their Mac should not need.

A hand test on 2026-10-08 showed the constraints. A phone pairing over the LAN address with `ws://` worked. A phone dialling `ws://` to the Mac's Tailscale address never connected: iOS allows cleartext only through `NSAllowsLocalNetworking`, and a WebSocket that fails inside the webview logs nothing. Android release builds allow cleartext only to loopback. A direct path that the phone can actually use therefore has to be TLS.

We decided:

- **The daemon listens. It does not embed a Relay.** A Relay matches two streams, registers Workstations under a rendezvous id and admits peers by token. A direct Device needs none of that, because the pairing offer already carries the daemon's key and a one-time secret. The listener (`crates/daemon/src/direct.rs`) accepts a TLS WebSocket and reads the same first frame a Device sends a Relay (`RelayHello::Device`), so the Device has one way to dial. The listener refuses a hello for any key but its own as `offline`, answers `ready`, and hands the stream to the same serving the Relay's streams get. A pairing goes to `pair_over_awaited`. A connection goes to Noise `IK`, the hardware signature, and `adopt_device`, which serves it with `ClientIdentity::remote` handed in by the transport, never replaced by `Hello`. The admission token is the Relay's, and the direct hello carries none.
- **It is opt-in.** A "Direct connection" switch in Settings → Remote access, stored in the trust store, takes effect only while remote access is on. Turning either off closes the port and drops what it carried, within the store poll the Relay dial already uses (two seconds).
- **TLS, with a certificate the Device pins from the offer.** The daemon mints a self-signed P-256 certificate once and keeps it in `devices.sqlite` beside its static key. The pairing QR carries the certificate's SHA-256 (`directPin`) beside the direct addresses (`direct`). A Device trusts that certificate on those addresses and nowhere else: no CA, no host name. Noise already authenticates the Workstation. TLS is there for the platforms' cleartext rules and to keep the hello off the network, and the pin keeps the exception to one certificate. "Revoke all" mints a new certificate along with the new key, since every Device that pinned the old one has to pair again anyway.
- **Addresses are fixed at pairing, and the Relay is the fallback.** The QR lists `wss://` URLs for this machine's Tailscale address and the address of its default route, Tailscale first, followed by the Relay as before. The Device dials the direct addresses first, each with a short timeout, and then the Relays. An address that stops answering costs one short timeout, and the Device keeps the list it was given until it pairs again.
- **Only nearby peers, within limits like the Relay's.** The listener accepts connections only from loopback, private, link-local and Tailscale (`100.64.0.0/10`) addresses: the rule `protocol::relay` uses to call a host local. Its limits copy the Relay's `Limits`: a cap on open sockets, a deadline for the first frame, one deadline for the whole handshake, and the same pairing and connecting ceilings the Relay's streams draw on. Anything that is not a Device hello is refused before any state is touched.
- **Each daemon has its own port.** The dev and release daemons share one trust store, so they share the switch and the certificate. Each binds its own port: 8445 for a release build and 8446 for a dev build. The QR names the port of the daemon whose desk drew it, so a Device reaches that daemon directly. Through the Relay, `remote::deference` decides as before.

The port, the peers the listener admits, and what turns it on were defaults when this was written. They wait on the human on the card `companion-direct-listener`.

## Considered options

- **An embedded Relay in the daemon.** Rejected. It keeps matching, the rendezvous id and the admission token, and adds a second server to configure, to serve a peer that needs none of them.
- **Plain `ws://` with a cleartext exception.** Rejected. iOS cannot scope an ATS exception to an address range, and `NSAllowsLocalNetworking` did not cover the Tailscale address in the hand test. Android's network security config cannot express a range either.
- **Trust any certificate on the direct path, since Noise authenticates anyway.** Rejected. It would put an accept-anything trust handler in the shell, one misplaced condition away from covering the Relay and bundle fetches.
- **A publicly trusted certificate from `tailscale cert`.** Rejected. It needs HTTPS turned on for the tailnet and the Tailscale CLI on the Mac, and it does nothing for a LAN-only user.
- **Bonjour, so a Device finds a moved address.** Deferred. A webview cannot browse for services, and a native browser is a store release. Tailscale addresses do not change, and a LAN that renumbers falls back to the Relay.
- **A stable Tailscale name instead of an address.** Deferred. Learning it needs the Tailscale CLI, and a node's address is already stable.

## Consequences

- The Companion shell needs a native hook that accepts the pinned certificate for a direct address. On iOS that is Capacitor's `handleWKWebViewURLAuthenticationChallenge`. Whether WebKit routes a WebSocket's server-trust challenge there is checked on a phone, and if it does not, the shell dials through a native socket instead.
- With the macOS firewall on, the daemon is asked once whether to allow incoming connections.
- The pairing QR grows by the addresses and a 64-character pin.
- `docs/relay.md` and `docs/self-hosting-relay.md` say when the direct path is enough: the Device and the Workstation on one network or one tailnet.
