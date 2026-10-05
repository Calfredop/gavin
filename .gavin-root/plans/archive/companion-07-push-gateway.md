---
kind: task
title: Companion 07: Push gateway service
status: Done
labels: ready-for-agent
parent: companion.md
complexity: complex
---
Blocked by: none (can start immediately)

Part of `companion.md`. Read the spec (sections "The Push gateway" and "Notifications") and `CONTEXT.md` first.

## What to build

The Push gateway: a new service in the Rust workspace, beside the Relay, shipped as a Docker image. It holds the publisher's APNs and FCM credentials and nothing else of value.

- **Registration.** A Device registers its push token and receives a **signed send permission per Workstation**. A newer token replaces an older one, and a Device can cancel a permission.
- **Delivery.** A Workstation's daemon posts ciphertext plus the permission. The gateway verifies the permission, rate-limits per Device, and forwards the ciphertext untouched: as a mutable-content push on iOS, and a data message on Android.
- **Never plaintext.** It never logs or inspects payloads.

## Acceptance criteria (seam 4: the HTTP API, with a fake Apple/Google sender)

- [x] Invalid, expired or cancelled permissions are refused
- [x] The per-Device rate limit holds
- [x] Ciphertext is forwarded byte for byte, and payloads never appear in logs
- [x] Replacing a token keeps existing permissions working
- [x] It runs as a configured Docker image, and its configuration is documented

## Done (2026-09-28, branch `companion/services`, uncommitted)

- **Where:** `crates/push-gateway` (the `gavin-push-gateway` workspace member, lib + bin), its `Dockerfile`, `docs/push-gateway.md` (the API, what reaches Apple and Google, every `GAVIN_PUSH_*` variable, running the image), and a **Send permission** entry in `CONTEXT.md`.
- **Seam 4:** `crates/push-gateway/tests/api.rs`, 20 tests over real HTTP. The real APNs and FCM senders point at a fake Apple and a fake Google, which verify the ES256 provider token, the RS256 assertion and the bearer token. There are also 22 unit tests. Mutating byte forwarding, the log or the rate limit each turns its test red.
- **Docker:** built and run. In dry-run mode, register, grant and push work, and a permission survives a restart on the same volume. The process runs as uid 10001, and the key and database are 0600. In live mode with junk credentials, APNs answered `InvalidProviderToken` and Google's OAuth answered 400. That proves the image's TLS roots, HTTP/2 to APNs and reason parsing. The publisher's real `.p8` and service account were not tried: none are here.
- **For 25:** the daemon posts RAW ciphertext (1 to 2048 bytes) to `POST /v1/push` with `Authorization: Bearer <permission>`, and branches on the refusal codes in the doc. `404 device_unreachable` means keep the permission. The shell registers once, PUTs its token on every launch, mints one permission per Workstation, and renews before `expires_at` (90 days). Open: "resolved" on iOS. Every push is a visible mutable-content alert today, so pick a background push type or the filtering entitlement.
- **For 17:** `GAVIN_PUSH_DELIVERY=dry-run` is the sandboxed gateway. It never contacts Apple or Google.
- **For 18:** `docker build -f crates/push-gateway/Dockerfile .` from the repo root. The base images are pinned by tag, not yet by digest.

