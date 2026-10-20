---
kind: task
title: Refresh the token without stranding a phone
parent: companion-local-relay-and-direct-without-collision.md
---
Read the parent card, `companion-local-relay-and-direct-without-collision.md`. This task needs the nested task "Desk runs the local Relay itself" done first: its token file and its process are what Refresh rewrites and reloads. If that task has not landed, stop and say so. This covers the parent's §3.2, §3.3 and §3.4.

- **Refresh for the desk's own Relay (§3.2).** Add a "Refresh token" button. It mints a new token (CSPRNG), rewrites the Relay's token file (`0600`), and makes the Relay take it. Today `gavin-relay` reads its tokens once, at start (`crates/gavin-relay/src/main.rs`). Add a reload, by SIGHUP or by watching the file, rather than restarting it: a restart drops every carried stream. The daemon then dials with the new token.
- **Refresh for a Relay someone else runs.** Refresh means "paste the new one": the existing admission field. Say so beside it.
- **Phones keep working (§3.3).** This is the preferred option the card names. During a grace window the token file holds both the old and the new token. Before the old one is retired, the new one is pushed over each live Device connection. That is a new message on the Device wire: a protocol bump, the core, and the shell storing it as `relayAdmission` through `app/companion-shell/src/shell/hub/paired.ts` (merge with any uncommitted long-press work there; do not overwrite it). When the window ends the old token is removed. A phone that was offline the whole window gets a visible "pair again" on its hub, through the per-path failure line `connection/paths.ts` builds. It must never fail silently.
- **What Settings shows (§3.4).** Whether a token is held, when it was set, and whether the desk generated it. Never the token itself. "When it was set" is a new META key beside `relay_admission`. `ListDevices` grows an optional field for it, and the app shows nothing when an older daemon leaves it out.
- **Compat.** A new pushed message and any widened request need the `PROTOCOL_VERSION` bump, `FEATURE_MIN_VERSION` entry and `featureBlockedReason` consumer CLAUDE.md describes.
- **Tests.** Unit tests for the grace window: both tokens are accepted inside it, only the new one after it, and the push happens before the old token is retired. In `crates/daemon/tests/device_wire.rs`, refresh while a Device is connected and check that it stays connected and reconnects with the new token.

Tick §3.2 to §3.4 on the parent when done.
