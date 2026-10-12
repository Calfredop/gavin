---
order: 20480
kind: task
title: Companion 18: signed Docker images and self-hosting docs
status: Done
labels: ready-for-agent
parent: companion.md
complexity: simple
---
Blocked by: companion-10-pair-through-relay.md, companion-07-push-gateway.md

Part of `companion.md`. Read the spec (sections "The Relay" and "The Push gateway") and `docs/RELEASING.md` first.

## What to build

- **Signed images.** The release pipeline builds the Relay and Push gateway images, signs them, and publishes them by digest.
- **Self-hosting docs** for the Relay: admission token configuration, TLS, and pinning by digest.

## Acceptance criteria

- [x] Both images are signed, and the signatures can be verified
- [x] The self-hosting doc is written
- [x] The release notes list the digests
