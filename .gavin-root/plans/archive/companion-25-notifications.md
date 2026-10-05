---
kind: task
title: Companion 25: end-to-end encrypted notifications
status: Done
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

- [x] Pure-module tests for the triggers and the resolved events
- [x] Seam 1 with a fake gateway: the daemon posts ciphertext that decrypts, with the Device's key, to the right item
- [x] Cancelling one Workstation's permission leaves the others working
- [ ] Human test: An agent waits on the dev desktop; the phone's lock screen shows the decrypted notification text; tapping opens the session; answering at the desk clears the notification.

When done, file a human test: an agent waits on the dev desktop; the phone's lock screen shows the decrypted text; tapping opens the session; answering at the desk clears the notification.

## Done (2026-09-28, branch `companion/services`)

- **Decide:** `app/src/lib/agents/companionNotify.ts` (+ driver) — attention-inbox triggers, rail stops, human tests, and resolved diffs; unit-tested.
- **Send:** `crates/daemon/src/{notify_crypto,companion_push}.rs` — ChaCha20-Poly1305 seal, padded buckets, POST `/v1/push` via ureq; Seam 1 with `FakeGateway` decrypts to the item; cancel-one permission leaves the other working. Trust store holds `notification_key`, `send_permission`, `notify_counter`, and the Push gateway URL. Protocol v44: `PushCompanionNotify`, `SetPushGatewayUrl`, `SetDeviceSendPermission`.
- **Register:** `app/companion-shell/src/shell/push/permissions.ts` — mint/renew/cancel per Workstation.
- **Show:** decrypt contract + deep links in `shell/push/decrypt.ts`; iOS NSE stub at `ios/App/NotificationService/NotificationService.swift` (filtering entitlement for resolve). Native ChaCha open and Xcode target wiring still need the store shell's push entitlements before the human test can pass.
- **Open:** notification keys at pairing are ticket 11; wiring the desk driver into live inbox signals wants ticket 14's waiting-item shape on the wire.
