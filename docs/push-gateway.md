# The Push gateway

The publisher's service that delivers the Companion's notifications through
Apple (APNs) and Google (FCM). It is the only holder of the publisher's push
credentials, and it holds nothing else of value: it never sees plaintext, it
never logs a payload, and a copy of its database authenticates as nobody.

Source: `crates/push-gateway`. Design: the spec's "The Push gateway" and
"Notifications" sections (`docs/superpowers/specs/2026-09-27-companion-design.md`).

## How a notification travels

1. **The Device registers** its APNs or FCM token with the gateway and gets
   back a Device id and a Device secret.
2. **The Device mints one send permission per Workstation** and hands it to
   that Workstation over their encrypted channel. The permission names the
   Device, not its token, so it survives the token changing.
3. **The Workstation's daemon posts ciphertext** with the permission. The
   ciphertext is sealed with the notification key that Workstation and Device
   agreed at pairing; the gateway cannot read it.
4. **The gateway checks the permission** (signature, expiry, not cancelled),
   **spends one push of the Device's allowance**, and hands the bytes to Apple
   or Google exactly as they arrived.
5. **The phone decrypts before anything is shown**: the iOS Notification
   Service Extension, or the Android app handling a data message.

## HTTP API

All bodies are JSON unless noted. Every refusal is
`{"error": "<code>"}` with the status below; clients branch on the code.

### `POST /v1/devices` — register a Device

```json
{"platform": "ios", "token": "<APNs token, hex>", "environment": "production"}
{"platform": "android", "token": "<FCM registration token>"}
```

`environment` is iOS only: `production` (the default) or `development` for a
development-signed build, whose tokens come from the APNs sandbox. Android
ignores it.

`201 {"device_id": "<32 hex>", "device_secret": "<base64url>"}`. The secret
is shown once; the gateway keeps only its hash. Register once per install.

A token belongs to one Device. Registering a token another Device holds (a
reinstall on the same phone gets the same token back) removes the older
Device and cancels its permissions: the old install's keys are gone, so
nothing sent to it could be decrypted anyway.

### `PUT /v1/devices/{device_id}/token` — a newer token

`Authorization: Bearer <device_secret>`, body `{"token": "…", "environment": "…"}`.
`204`. Every permission the Device has minted keeps working. The Companion
should call this whenever Apple or Google hand it a new token, and on every
launch.

### `DELETE /v1/devices/{device_id}` — unregister

`Authorization: Bearer <device_secret>`. `204`. Cancels every permission the
Device minted.

### `POST /v1/devices/{device_id}/permissions` — mint a send permission

`Authorization: Bearer <device_secret>`, no body.
`201 {"permission_id": "<32 hex>", "permission": "v1.….…", "expires_at": <unix seconds>}`.

Mint one per Workstation and hand it over the encrypted channel. A
permission lasts `GAVIN_PUSH_PERMISSION_TTL_DAYS` (90 by default, the trust
store's unseen-Device expiry); mint a fresh one before it runs out and cancel
the old. A Device may hold 64 live permissions.

### `DELETE /v1/devices/{device_id}/permissions/{permission_id}` — cancel

`Authorization: Bearer <device_secret>`. `204`, or `404 permission_not_found`
if this Device has no live permission by that id. Cancelling one
Workstation's permission silences that Workstation and no other.

### `POST /v1/push` — deliver ciphertext (the Workstation's call)

`Authorization: Bearer <permission>`, body: **the ciphertext, raw bytes**, any
content type, 1 to 2048 bytes. The gateway never parses it.

`202` once Apple or Google accepted it. Refusals, in the order they are
checked:

| Status | Code | Meaning for the daemon |
| --- | --- | --- |
| 401 | `permission_invalid` | Not a permission this gateway signed. Drop it. |
| 401 | `permission_expired` | Drop it; the Device mints a new one when it next connects. |
| 401 | `permission_cancelled` | The Device cancelled it or unregistered. Drop it. |
| 400 | `empty_payload` | |
| 413 | `payload_too_large` | Over 2048 bytes. |
| 429 | `rate_limited` | The Device's allowance is spent; `Retry-After` says when the next push fits. |
| 404 | `device_unreachable` | Apple or Google said the Device's token is dead. Keep the permission: it works again once the Device registers a new token. |
| 502 | `upstream_rejected` | Apple or Google refused this push for good. Do not retry it. |
| 503 | `upstream_unavailable` | Throttled, down, or the gateway's credentials failed. Worth retrying later. |

The limit of 2048 bytes keeps base64 plus the envelope under the 4096-byte
payload cap APNs and FCM both enforce. It is eight of the Companion's
256-byte padding buckets.

### Other answers

- `401 device_unauthorized`: an unknown Device id, or a missing or wrong
  secret. The two are indistinguishable on purpose.
- `400`: `bad_json`, `unknown_platform`, `bad_token`, `unknown_environment`.
- `422 platform_unavailable`: this gateway has no credentials for that platform.
- `409 too_many_permissions`.
- `GET /healthz` answers `200 ok`.

## What reaches Apple and Google

**iOS** (`POST https://api.push.apple.com/3/device/<token>`, or the sandbox
host for a `development` token): an alert with `mutable-content`, so iOS
wakes the Notification Service Extension, which decrypts `c` and replaces the
placeholder text. The placeholder is what shows if the extension cannot run
in time, so it says nothing about the Workstation.

```json
{"aps": {"alert": {"title": "Gavin", "body": "Something on your Workstation changed."},
         "mutable-content": 1, "sound": "default"},
 "c": "<base64 of the ciphertext>"}
```

Headers: `apns-push-type: alert`, `apns-priority: 10`, `apns-topic` set to
the configured bundle id, and `apns-expiration` 24 hours out.

**Android** (FCM HTTP v1 `messages:send`): a data message with no
`notification` block, so Android draws nothing by itself.

```json
{"message": {"token": "<token>", "data": {"c": "<base64 of the ciphertext>"},
             "android": {"priority": "HIGH", "ttl": "86400s"}}}
```

`c` is standard base64 with padding. Decoding it yields exactly the bytes the
Workstation posted.

## Configuration

Environment variables. An empty value counts as unset. An unknown
`GAVIN_PUSH_*` variable stops the gateway at startup, so a misspelling cannot
silently switch a platform off. `*_FILE` variables name files, so the
credentials can be mounted as Docker secrets.

| Variable | Default | |
| --- | --- | --- |
| `GAVIN_PUSH_LISTEN` | `0.0.0.0:8080` | Address and port to serve plain HTTP on. |
| `GAVIN_PUSH_DATA_DIR` | `/data` | Holds `push-gateway.sqlite` and, by default, the permission key. |
| `GAVIN_PUSH_PERMISSION_KEY_FILE` | `$GAVIN_PUSH_DATA_DIR/permission.key` | The key permissions are signed with: base64 of at least 32 bytes. Created with a random key on first start. |
| `GAVIN_PUSH_PERMISSION_TTL_DAYS` | `90` | How long a permission lasts. |
| `GAVIN_PUSH_RATE_BURST` | `30` | Pushes one Device may receive at once… |
| `GAVIN_PUSH_RATE_PER_HOUR` | `240` | …and the rate its allowance refills at (here, one every 15 seconds). |
| `GAVIN_PUSH_DELIVERY` | `live` | `live` sends through Apple and Google. `dry-run` verifies and accounts for everything, delivers nothing, and never contacts Apple or Google. |
| `GAVIN_PUSH_APNS_KEY_FILE` | | The APNs auth key (`AuthKey_XXXXXXXXXX.p8`). |
| `GAVIN_PUSH_APNS_KEY_ID` | | Its key id. |
| `GAVIN_PUSH_APNS_TEAM_ID` | | The Apple developer team id. |
| `GAVIN_PUSH_APNS_TOPIC` | | The Companion's bundle id. |
| `GAVIN_PUSH_FCM_SERVICE_ACCOUNT_FILE` | | A Google service account key (JSON) with permission to send through Firebase Cloud Messaging. |

The four APNs variables go together: all four or none. `live` needs APNs,
FCM or both. A platform without credentials refuses registrations with
`422 platform_unavailable`.

## Running it

Build from the repository root:

```sh
docker build -f crates/push-gateway/Dockerfile -t gavin-push-gateway .
```

A dry run, for development:

```sh
docker run --rm -p 8080:8080 -v gavin-push-data:/data \
  -e GAVIN_PUSH_DELIVERY=dry-run gavin-push-gateway
```

Live, with the credentials mounted read-only:

```sh
docker run -d --name gavin-push-gateway -p 8080:8080 \
  -v gavin-push-data:/data \
  -v /srv/gavin-push/secrets:/run/secrets:ro \
  -e GAVIN_PUSH_APNS_KEY_FILE=/run/secrets/AuthKey.p8 \
  -e GAVIN_PUSH_APNS_KEY_ID=ABC123DEFG \
  -e GAVIN_PUSH_APNS_TEAM_ID=TEAM123456 \
  -e GAVIN_PUSH_APNS_TOPIC=<the Companion's bundle id> \
  -e GAVIN_PUSH_FCM_SERVICE_ACCOUNT_FILE=/run/secrets/fcm-service-account.json \
  gavin-push-gateway
```

The image runs as an unprivileged user (uid 10001), which must be able to
read the mounted credential files.

- **TLS.** The gateway serves plain HTTP. Daemons and Devices reach it over
  HTTPS, so put it behind a TLS-terminating proxy or load balancer, and do not
  publish port 8080 to the internet directly.
- **One instance.** The database is SQLite, and the rate limiter lives in
  memory, so it runs as a single instance. A restart forgets rate-limit state
  and nothing else.
- **`/data` is a volume** holding the database and the permission key. Losing
  the database cancels every permission. Losing or replacing the key
  invalidates every permission ever issued. Either one means every Device
  mints its permissions again.
- **Shutdown.** `docker stop` (SIGTERM) finishes the requests in flight and
  exits.
- **Housekeeping.** Every hour it drops expired permissions, and Devices that
  have had no permissions and no activity for the permission lifetime.

## Logs

One line per request (method, route template, status, milliseconds) on
standard error, plus one line per event: a Device registered, replaced its
token, minted or cancelled a permission, or a push's outcome with its byte
count and Apple's or Google's reason code. Lines carry Device and permission
ids and never a payload, a push token, a Device secret or a permission. The
suite checks this.

## Not yet settled

- **"Resolved" pushes on iOS.** An item handled at the desk should leave the
  phone. Every push is a visible alert today, and an extension that decrypts
  a "resolved" message has no sanctioned way to show nothing. Ticket 25 decides
  between a background push type and the notification-filtering entitlement.
- **Registration abuse on a public instance.** Anyone can register a Device.
  The permission cap bounds what one Device can store, but nothing bounds how
  many Devices one caller registers. A per-address limit belongs in front of
  the public instance.
