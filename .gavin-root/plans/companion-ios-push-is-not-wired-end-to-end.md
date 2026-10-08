---
order: 20480
kind: task
title: Companion iOS: push notifications cannot arrive, the APNs entitlement and the extension are not wired
status: To Do
priority: medium
complexity: complex
---
Found on 2026-10-08 by `companion-iphone-smoke-tests.md` (F1 to F3), checking what a debug build on a physical iPhone 16 Pro can receive. `companion-25-notifications.md` is archived as Done, but its last acceptance box (the human test: lock screen shows the decrypted text, tap opens the session, answering at the desk clears it) is unticked, and its Done note says the native decrypt and the Xcode wiring "still need the store shell's push entitlement".

**Measured.**
- `codesign -d --entitlements` on the signed debug app (team `M3DT8FPBFU`): only `application-identifier`, `com.apple.developer.team-identifier` and `get-task-allow`. No `aps-environment`, so APNs cannot deliver anything to it.
- `ios/App/App/Info.plist` has no `UIBackgroundModes` with `remote-notification`; there is no `*.entitlements` file in `ios/App/App/`.
- `ios/App/NotificationService/NotificationService.swift` exists, but `App.xcodeproj/project.pbxproj` has zero references to `NotificationService`: it is not a target, so it is never built or embedded. Its `didReceive` is a pass-through placeholder ("Until the keychain + ChaCha20-Poly1305 path is linked, leave the publisher's generic placeholder"), so even if wired it would show the generic text, not the decrypted one.
- The web layer has `shell/push/permissions.ts` and `decrypt.ts` with unit tests, and the daemon has `notify_crypto.rs`/`companion_push.rs` with a fake gateway; the README says "Notifications and the Push gateway are not here either".

So on iOS the pieces are tested in isolation and nothing connects them: a phone can be paired and unlocked and will never get a notification, and the Settings promise (F1: the permission prompt) cannot even be reached.

**To do.**
- Add the Push Notifications capability and `aps-environment` (development for debug, production for release) and `UIBackgroundModes: remote-notification` to the App target; register for remote notifications and hand the token to `shell/push/permissions.ts`.
- Add the Notification Service Extension target to `App.xcodeproj`, embedded in the app, with the shared keychain access group the stub's header describes, and the notification-filtering entitlement the resolve path needs (Apple grants that one on request; say so on the card and in `docs/companion-mobile.md`).
- Implement the extension's decrypt: ChaCha20-Poly1305 with each Workstation's notification key, counter check, deep link. Match `crates/daemon/src/notify_crypto.rs` byte for byte; add a fixture shared with the Rust tests (as `test-fixtures/` does elsewhere).
- Say in `docs/companion-mobile.md` which Apple team and which App ID capabilities a debug build needs, since a personal team cannot use push.
- Run the human test from `companion-25`.

**Acceptance.**
- [ ] A debug build signed by a paid team carries `aps-environment` and registers a token with the Push gateway
- [ ] The extension is a built, embedded target and decrypts a gateway push for a paired Workstation on the lock screen
- [ ] A shared fixture holds the Swift and Rust formats to one another
- [ ] Tapping opens the session or card; answering at the desk clears the notification; cancelling one Workstation's permission silences only that one
- [ ] Human test: an agent waits on the dev desktop; the phone's lock screen shows the decrypted text; tapping opens it; answering at the desk clears it
