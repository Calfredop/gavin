# Self-hosting the Relay

The Relay matches a Workstation's daemon with a Device and copies bytes
between them. Everything inside is end-to-end encrypted, so the Relay is
never trusted with content: the worst a hostile or broken one can do is
drop, replay or alter traffic and cause a failed connection, never a wrong
answer. What it does hold is the admission token, which is why it is worth
running yourself and why the image you run should be one you can check.

Source: `crates/gavin-relay`. Design: "The Relay" in
`docs/superpowers/specs/2026-09-27-companion-design.md`.

Notifications keep working through your own Relay at no cost: the Push
gateway is a separate service, reached directly by the Device and the
daemon, and does not depend on which Relay carries the session.

**You may not need one.** If your phone is always on the same network as
your Mac, or both are on one Tailscale tailnet, turn on **Direct
connection** in Settings → Remote access instead: the daemon listens for
your Devices itself, and there is nothing to host, no token to mint and no
certificate to renew. The direct path needs the Device and the Workstation
on one network or tailnet; a Relay is what reaches the Mac from anywhere
else. The two work side by side: a Device tries the direct address first
and the Relay after it. See `docs/relay.md`, "When you do not need one".

## 1. Get the image, by digest

Every release publishes two images to GitHub's container registry:

- `ghcr.io/calfredop/gavin-relay`
- `ghcr.io/calfredop/gavin-push-gateway`

The release notes list each one's **digest**. Use it:

```
docker pull ghcr.io/calfredop/gavin-relay@sha256:<digest from the release notes>
```

**Pin by digest, never by tag.** A tag is a pointer that whoever holds the
registry can move; a digest *is* the content, so a pinned image cannot
change under you. The tag on the registry page (`v1.2.3`) is a label for
reading, and nothing here relies on it. When you update, take the new
digest from the new release's notes, verify it (next section), and change
the one line that names it.

## 2. Verify the signature

Each image is signed by the release workflow, keylessly, with
[cosign](https://github.com/sigstore/cosign): there is no signing key to
trust or to have leaked. The signature says *this exact digest was built
and pushed by `release.yml` in `Calfredop/gavin` on a `v*` tag*, and is
recorded in Sigstore's public transparency log.

```
cosign verify \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  --certificate-identity-regexp '^https://github.com/Calfredop/gavin/\.github/workflows/release\.yml@refs/tags/v' \
  ghcr.io/calfredop/gavin-relay@sha256:<digest>
```

It prints the signature's claims and exits 0 only when the digest is signed
by that identity. Check the digest against the release notes too: a
signature proves who built an image, and the notes (which you fetched from
the release page, not the registry) are what tell you *which* image is the
one you meant to run. Fork the repository and you verify against your own
`owner/repo` and your own release workflow instead.

The command above is the one `release.yml` runs against each image after
signing it, so a release whose signature does not verify this way is a red
job rather than a published image.

## 3. Admission tokens

The Relay refuses to start without at least one. Every daemon and Device
that uses your Relay presents one, and one that does not hold a token is
refused before any bytes are copied: an open Relay is free infrastructure
for strangers.

| Variable | |
|---|---|
| `GAVIN_RELAY_TOKENS` | Tokens, separated by commas. |
| `GAVIN_RELAY_TOKENS_FILE` | A file of tokens, one a line. Prefer this: a token in the environment shows up in `docker inspect` and in process listings. |

Both may be set; the Relay accepts the union. Make a token long and random:

```
openssl rand -base64 32
```

Several tokens let you rotate: add the new one, move each of your
Workstations and Devices to it (Settings → Remote access on the desktop),
then remove the old one and restart the Relay.

A Workstation enters the token in **Settings → Remote access**, beside the
Relay's URL. The Device receives it in the pairing offer, so you type it
once.

## 4. TLS

The Relay will not start in the clear by accident. Choose one:

**The Relay terminates TLS itself.** Mount the certificate chain and key
(PEM) and name them:

```
GAVIN_RELAY_TLS_CERT=/run/secrets/relay-cert.pem
GAVIN_RELAY_TLS_KEY=/run/secrets/relay-key.pem
```

Setting one without the other is a startup error. Renew the certificate
and restart the Relay.

**A proxy in front terminates TLS** (Caddy, nginx, a cloud load balancer).
Tell the Relay so, and it serves plain WebSocket to the proxy:

```
GAVIN_RELAY_TLS_TERMINATED=1
```

Keep the plain port off the public internet: it should be reachable only
from the proxy, because everything it carries, the admission token
included, is unencrypted on that hop. The proxy must pass WebSocket
upgrades through and must not close an idle connection sooner than the
Relay's 20-second keepalive ping (most proxies default to a minute or more).

If the Relay is shared between tenants (or exposed on the public
internet), configure those same proxy or load-balancer controls for
fairness and cost: a per-source-IP concurrent-connection ceiling, a
connection-rate limit, and bandwidth shaping. gavin-relay itself only
caps open sockets in total and registrations per rendezvous id; it does
not meter bytes and does not bound how many rendezvous ids one admission
token may hold. Without the proxy limits, one peer can fill the socket
pool (including during the 5 s pre-admission hello window) and copy
unlimited traffic. Caddy's `max_conns` / rate-limit modules, nginx
`limit_conn` / `limit_req` / `limit_rate`, and the equivalent knobs on a
cloud load balancer all cover this; pick values that fit how many
Workstations and Devices you expect per client address.

Either way the URL you give the desktop app is `wss://your.host[:port]`. A
release build of the desktop app takes only `wss://` for a Relay that is not
on your own network; `ws://` is accepted for loopback and LAN addresses,
because it would otherwise send the token across the internet in the clear.
The rule is `protocol::relay::RelayUrl::parse`.

## 5. Run it

```
docker run -d --name gavin-relay --restart unless-stopped \
  --read-only --cap-drop ALL --security-opt no-new-privileges \
  -p 8443:8443 \
  -v /etc/gavin-relay:/run/secrets:ro \
  -e GAVIN_RELAY_TOKENS_FILE=/run/secrets/tokens \
  -e GAVIN_RELAY_TLS_CERT=/run/secrets/relay-cert.pem \
  -e GAVIN_RELAY_TLS_KEY=/run/secrets/relay-key.pem \
  ghcr.io/calfredop/gavin-relay@sha256:<digest>
```

The image runs as an unprivileged user (uid 10001), listens on
`GAVIN_RELAY_LISTEN` (`0.0.0.0:8443` unless you change it), and writes no
files (rendezvous state is in memory): there is nothing to back up, and replacing the container with a new
digest is the whole update. The Relay logs to stderr.

The files under `/etc/gavin-relay` must be readable by uid 10001.

Point a Workstation at it in **Settings → Remote access** (Relay URL and
admission token) and pair a Device as usual.

## The Push gateway

Running your own is optional: the Companion uses the publisher's gateway
by default, and it is the only holder of Apple's and Google's push
credentials, which a self-hoster cannot have. Its image is signed and
listed by digest in the same way, and `docs/push-gateway.md` covers its
configuration.

## Limits

gavin-relay itself enforces (`Limits` in `crates/gavin-relay/src/server.rs`,
overridable with `GAVIN_RELAY_*` — see `docs/relay.md`):

- a process-wide open-socket ceiling and a per-source-address ceiling
  (both before TLS; at the ceiling the socket is closed unread);
- Workstation registration caps per rendezvous id and per admission token
  (across rendezvous ids);
- waiting Devices per rendezvous id;
- an optional per-stream byte budget (`GAVIN_RELAY_BYTES_PER_STREAM`; an
  over-budget stream is ended, not throttled);
- hello / claim / keepalive / silence / write deadlines and a 128 KiB
  frame cap.

A shared or public instance should still put **connection-rate** limits
and any bandwidth shaping that is not a per-stream byte budget on the
front proxy (Caddy, nginx, or a load balancer) — beside the TLS-termination
notes above. Per-IP concurrent connections can be set in the proxy as well
as, or instead of, `GAVIN_RELAY_CONNECTIONS_PER_SOURCE`.
