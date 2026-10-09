# The Relay

The publisher's (or a self-hoster's) rendezvous service: it admits a
Workstation and a Device by token, matches them by rendezvous id, and
copies WebSocket frames between them. It never reads a frame it is
copying, keeps one, or answers one.

Source: `crates/gavin-relay`. Design: the spec's "The Relay" section
(`docs/superpowers/specs/2026-09-27-companion-design.md`) and
`docs/security/06-companion.md` §5.4. The local loopback instance the
Companion scripts drive is `app/companion-shell/scripts/devstack.mjs`.

## What it does

1. **A Workstation registers** under
   `hex(SHA-256("gavin-relay-rendezvous-v1" || its static public key))`
   and keeps that connection open for announcements only.
2. **A Device dials** with the same rendezvous id and a purpose
   (`pair` or `connect`). The Relay announces a stream id to every
   registration under that id.
3. **One Workstation claims** the stream on a second connection. The
   Relay joins the two sockets and copies binary frames until either
   side goes.
4. **Everything after the hello is Noise ciphertext.** A compromised
   Relay can drop or reorder traffic; it cannot read or forge a
   completed handshake.

Admission is the first TEXT frame (`RelayHello`), never a header or a
query string: a webview `WebSocket` cannot set headers, and a token in
the URL lands in every reverse-proxy access log.

## When you do not need one

A Device on the same network or Tailscale tailnet as its Workstation can
reach it with no Relay at all: turn on **Direct connection** in Settings →
Remote access (ADR 0009). The daemon then listens itself, on port 8445 (a
dev build on 8446), for Devices whose address is on this machine's network
or tailnet, and the pairing QR names this Mac's Tailscale and LAN addresses
with the hash of the certificate the listener serves. A Device tries those
addresses first and the Relay after them.

| | Direct connection | A Relay |
| --- | --- | --- |
| Reaches the Workstation from | the same LAN or tailnet | anywhere |
| Something to run | nothing | the Relay, with TLS and a token |
| Admission token | none | required |
| Trust in what carries it | none: Noise end to end, TLS pinned by the QR | none: Noise end to end |

Use both when the phone is sometimes away: the direct address when it
answers, the Relay when it does not. Pair again after turning Direct
connection on, so the phone learns the addresses. An address the Mac has
since given up costs the phone one short try before it moves on.

## Configuration

Environment variables. An empty value counts as unset. The Relay takes
no CLI arguments.

| Variable | Default | |
| --- | --- | --- |
| `GAVIN_RELAY_LISTEN` | `0.0.0.0:8443` | Address and port to bind. |
| `GAVIN_RELAY_TOKENS` | | Admission tokens, comma-separated. |
| `GAVIN_RELAY_TOKENS_FILE` | | A file of tokens, one a line. Combined with `GAVIN_RELAY_TOKENS` when both are set. |
| `GAVIN_RELAY_TLS_CERT` | | Certificate chain, PEM. |
| `GAVIN_RELAY_TLS_KEY` | | Matching private key, PEM. |
| `GAVIN_RELAY_TLS_TERMINATED` | | Set to `1` when a proxy in front terminates TLS. |

It will not start without at least one admission token, and it will not
start without TLS unless `GAVIN_RELAY_TLS_TERMINATED=1`. A misspelt
variable that left a Relay in the clear would put every admission token
on the wire too.

More than one token is deliberate: mint a new one, put both on the Relay,
roll every Workstation and Device over, then drop the old. The token is a
shared secret that keeps strangers off the infrastructure; Noise and the
hardware signature are what actually authenticate a Device.

## Build the image

From the repository root:

```sh
docker build -f crates/gavin-relay/Dockerfile -t gavin-relay .
# or:
crates/gavin-relay/scripts/deploy.sh build
```

Pin a production deploy by digest (`docker buildx imagetools inspect`
or the registry's digest after push), not by a floating tag — the spec's
self-host story is a signed image pinned by digest.

Without Docker, from the repository root:

```sh
cargo build --release --locked -p gavin-relay
# binary: target/release/gavin-relay
```

## Mint an admission token

```sh
crates/gavin-relay/scripts/deploy.sh token
```

Put the printed value in the Relay's env and in each Workstation's
Settings → Remote access → admission token. The QR carries it to the
phone at pairing; it never comes back over the daemon socket.

## Run it

### Behind a TLS-terminating proxy (recommended)

The Relay speaks plain WebSocket; Caddy / nginx / a load balancer
terminates TLS and upgrades `/` (or whatever path you mount) to the
container. Clients dial `wss://relay.example.com`.

```sh
# /etc/gavin-relay/env  (mode 0600)
GAVIN_RELAY_LISTEN=0.0.0.0:8443
GAVIN_RELAY_TOKENS=<the token>
GAVIN_RELAY_TLS_TERMINATED=1
```

```sh
crates/gavin-relay/scripts/deploy.sh run \
  --env-file /etc/gavin-relay/env \
  --publish 127.0.0.1:8443:8443
```

Or with Docker directly:

```sh
docker run -d --name gavin-relay --restart unless-stopped \
  -p 127.0.0.1:8443:8443 \
  --env-file /etc/gavin-relay/env \
  gavin-relay
```

Publish only on loopback when the proxy sits on the same host. Do not
expose port 8443 to the internet without TLS in front.

**Caddy sketch** (WebSocket upgrade is automatic):

```caddy
relay.example.com {
  reverse_proxy 127.0.0.1:8443
}
```

**nginx sketch:**

```nginx
location / {
  proxy_pass http://127.0.0.1:8443;
  proxy_http_version 1.1;
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection "upgrade";
  proxy_set_header Host $host;
  proxy_read_timeout 3600s;
}
```

Keep the idle timeout above the Relay's silence deadline (60 s) and
well above a laptop sleep cycle if you can — a short proxy idle cut is
indistinguishable from "unreachable" on the phone.

### With the Relay holding the certificate

```sh
# /etc/gavin-relay/env
GAVIN_RELAY_LISTEN=0.0.0.0:8443
GAVIN_RELAY_TOKENS=<the token>
GAVIN_RELAY_TLS_CERT=/run/secrets/fullchain.pem
GAVIN_RELAY_TLS_KEY=/run/secrets/privkey.pem
```

```sh
docker run -d --name gavin-relay --restart unless-stopped \
  -p 8443:8443 \
  -v /etc/gavin-relay/certs:/run/secrets:ro \
  --env-file /etc/gavin-relay/env \
  gavin-relay
```

The image runs as uid 10001; the mounted cert files must be readable by
that user. The daemon and the Companion core trust the platform root
store (and `SSL_CERT_FILE` when set), so a Let's Encrypt or other public
CA certificate Just Works; a private CA needs to be in that store on
every Workstation and phone that dials it.

### systemd (binary, no Docker)

```sh
crates/gavin-relay/scripts/deploy.sh print-unit
# → install as /etc/systemd/system/gavin-relay.service
```

```sh
sudo useradd --system --no-create-home --shell /usr/sbin/nologin gavin-relay
sudo install -m 0755 target/release/gavin-relay /usr/local/bin/gavin-relay
sudo install -d -m 0750 -o root -g gavin-relay /etc/gavin-relay
# write /etc/gavin-relay/env (0640, group gavin-relay)
sudo systemctl daemon-reload
sudo systemctl enable --now gavin-relay
```

### Dev / LAN (cleartext, phones on the same network)

Only for a developer's machine. `ws://` to a public host is refused by
the core; loopback and private ranges are allowed.

```sh
GAVIN_RELAY_LISTEN=0.0.0.0:8443 \
GAVIN_RELAY_TOKENS=<token> \
GAVIN_RELAY_TLS_TERMINATED=1 \
target/debug/gavin-relay
```

At the desk: Remote access on, Relay URL `ws://<this Mac's LAN IP>:8443`,
same token. Allow `gavin-relay` through the macOS firewall when asked.
A debug Android build allows cleartext to any host; a release build
allows it only to loopback. Pairing from a real phone is also covered
in `app/companion-shell/README.md` ("The scripted pairing").

## Point a Workstation at it

In the desktop app, Settings → Remote access:

1. Turn remote access **on**.
2. Relay URL: `wss://relay.example.com` (no path required; a path is
   fine if your proxy mounts one — the hello is a frame, not a URL).
3. Admission token: the value the Relay was started with.
4. Save. The daemon re-reads settings every two seconds and dials while
   the switch is on.
5. Pair a device — the QR carries the URL and the token.

A URL the daemon will not dial (bad host, `ws://` to a public host, …)
is refused in the Settings hint before it is saved; the rule is
`protocol::relay::RelayUrl::parse`, mirrored in
`app/src/lib/core/remoteAccess.ts`.

## Verify

```sh
# The process is up and said so:
docker logs gavin-relay
# → gavin-relay listening on 0.0.0.0:8443 (TLS terminated in front)

# From a Workstation with remote access on: Pair a device, scan with
# the Companion. Matching six-digit codes and a confirmed pairing mean
# both legs reached the Relay and the Noise handshake completed.

# Wrong token → the Relay answers refused/admission and drops.
# No Workstation registered → a Device is told offline.
```

There is no health HTTP endpoint: the Relay is WebSocket-only. A
load-balancer probe that opens TCP to the listen port is enough to know
the process is bound; admission still needs a real hello.

## Limits (fixed for now)

| Limit | Value |
| --- | --- |
| Hello deadline (accept → first frame) | 5 s |
| Claim deadline (Device waits for a Workstation) | 10 s |
| Keepalive ping | every 20 s |
| Silence before drop | 60 s |
| Write deadline per frame | 30 s |
| Registrations per rendezvous | 4 |
| Waiting Devices per rendezvous | 16 |
| Open sockets | 4096 |
| Max copied frame | 128 KiB |

Public-instance per-Workstation bandwidth caps are not env-configurable
yet; self-hosters sharing one Relay among their own machines are fine
at these defaults.

## Operations notes

- **Stateless.** Restarting drops every live splice; Workstations
  re-register and Devices reconnect through the live hub's backoff.
  Nothing durable lives on the Relay.
- **One token rotation.** Add the new token beside the old
  (`GAVIN_RELAY_TOKENS=old,new` or two lines in the file), restart,
  update every Workstation, then remove the old.
- **Revoke all at the desk** rotates the Workstation key and therefore
  the rendezvous id. Old Devices cannot find it; they must re-pair.
  The Relay does not need a restart for that.
- **Shutdown.** `docker stop` / SIGTERM finishes cleanly.
- **Logs.** One listen line at start; accept failures on stderr. It
  never logs an admission token or a frame payload.
- **Do not** put the admission token in the Relay URL. The URL is what
  proxies log; the token rides in the hello.

## Related

- Direct connection, and why it is a listener in the daemon and not an
  embedded Relay: [`adr/0009-a-device-can-reach-its-workstation-directly.md`](adr/0009-a-device-can-reach-its-workstation-directly.md)

- Local stack and scripted pairing: `app/companion-shell/README.md`
- Companion compile and store builds: [`companion-mobile.md`](companion-mobile.md)
- Push notifications (separate service): [`push-gateway.md`](push-gateway.md)
- Deploy helper: `crates/gavin-relay/scripts/deploy.sh`
