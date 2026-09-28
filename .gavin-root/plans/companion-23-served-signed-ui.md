---
kind: task
title: Companion 23: served, signed Workstation UI
status: To Do
labels: ready-for-agent
parent: companion.md
complexity: intricate
---
Blocked by: companion-22-unlock-live-hub.md, companion-13-desktop-answers-forwarded.md, companion-09-web-bundle-demo.md

Part of `companion.md`. Read the spec (sections "The Workstation UI bundle" and "The Companion shell") and ADR 0005 (with its "Store compliance" section) first.

## What to build

**The first real end-to-end build.**

**On the desktop side:**
- The desktop build also builds the Companion web bundle and signs it, with a bundle-signing key separate from the updater's.
- It ships the bundle inside the desktop app and serves it to Devices over the encrypted channel.

**On the shell side:**
- It fetches the bundle and verifies it against the pinned publisher key. Debug builds also trust a dev key generated on the developer's machine; store builds refuse unsigned and self-built bundles.
- It caches bundles by content hash.
- It runs the bundle in the bridge-less webview, with `invoke` and `listen` travelling the channel, through forwarding, to the desktop app.
- Tapping an inbox item lands on its session or card.

## Acceptance criteria

- [ ] A bundle with a bad signature is refused, and a store build refuses a dev-key bundle (tested)
- [ ] An unchanged hash is a cache hit, and a Workstation upgrade fetches the new bundle
- [ ] Navigation outside the app-local origin is blocked

When done, file a human test: on a phone, open the dev Workstation, see its real board, move a card, and watch it move at the desk.
