---
kind: task
title: Companion 07: Push gateway service
status: To Do
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

- [ ] Invalid, expired or cancelled permissions are refused
- [ ] The per-Device rate limit holds
- [ ] Ciphertext is forwarded byte for byte, and payloads never appear in logs
- [ ] Replacing a token keeps existing permissions working
- [ ] It runs as a configured Docker image, and its configuration is documented
