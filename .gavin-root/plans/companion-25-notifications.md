---
kind: task
title: Companion 25: end-to-end encrypted notifications
status: To Do
labels: ready-for-agent
parent: companion.md
complexity: intricate
---
Blocked by: companion-07-push-gateway.md, companion-22-unlock-live-hub.md, companion-14-attention-request.md

Part of `companion.md`. Read the spec (sections "Notifications" and "The Push gateway") first.

## What to build

- **Deciding.** The desktop app decides what to notify: the attention-inbox triggers, a rail stopping, and "resolved" when an item is handled.
- **Sending.** The daemon encrypts each payload with that Device's notification key, agreed at pairing in ticket 11, and posts it to the Push gateway with the Device's send permission.
- **Registering.** The shell registers its push token with the gateway, and hands each Workstation its send permission.
- **Showing.** The phone decrypts before display: a Notification Service Extension (a native target) on iOS, a data message on Android. Tapping deep-links to the session or card.
- **Cancelling.** Cancelling one Workstation's permission silences only that Workstation.

## Acceptance criteria

- [ ] Pure-module tests for the triggers and the resolved events
- [ ] Seam 1 with a fake gateway: the daemon posts ciphertext that decrypts, with the Device's key, to the right item
- [ ] Cancelling one Workstation's permission leaves the others working

When done, file a human test: an agent waits on the dev desktop; the phone's lock screen shows the decrypted text; tapping opens the session; answering at the desk clears the notification.
