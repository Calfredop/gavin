---
order: 19456
kind: task
title: Companion iOS: push notifications cannot arrive, the APNs entitlement and the extension are not wired
status: In Progress
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
- [x] A shared fixture holds the Swift and Rust formats to one another
- [x] Tapping opens the session or card; answering at the desk clears the notification; cancelling one Workstation's permission silences only that one
- [ ] Human test: an agent waits on the dev desktop; the phone's lock screen shows the decrypted text; tapping opens it; answering at the desk clears it
- [x] Decision: Beyond iOS, three links in the chain are missing: no wire request lets a Device hand its send permission to a Workstation (SetDeviceSendPermission is desk-only; a Device-scoped one means a protocol bump), nothing on the desk calls PushCompanionNotify from the live waiting set, and the desk has no Push gateway URL setting. Without them the human test cannot pass even with iOS fully wired. Build them on this card, or file them as their own cards? (Meanwhile I am doing the iOS half: entitlements, extension target, Swift decrypt with a shared fixture, token registration, tap and resolve.)
  Options: A) Build all three here (protocol bump on this card) B) File them as separate cards; this card stops at the iOS half
  Answer (2026-10-09): A) Build all three here, protocol bump included.
- [ ] Human test: On the iPhone, DEVELOPMENT_TEAM=M3DT8FPBFU scripts/device-drive.sh ios-device <udid> install signs (Xcode creates the com.gavin.companion.NotificationService App ID and turns on Push); `codesign -d --entitlements -` on the installed app shows aps-environment; the hub's Notifications row asks once on "Turn on notifications" and then reads what you answered (smoke F1)

## Progress (2026-10-09): the iOS half, uncommitted on main

**Built.**
- **Format and fixture.** `test-fixtures/companion-notify/cases.json` (13 cases: session, card with an escaped path, resolve, no target, a whole bucket of padding, an unknown field, and every refusal) is read by `notify_crypto.rs` (each case sealed again with its nonce, byte for byte), by the extension's Swift (`scripts/notify-fixture.sh`, run by `src/shell/push/fixture.test.ts` on a Mac) and by `decrypt.test.ts` for the tap link. It found a seal/open bug: a plaintext that fills its bucket exactly gets 256 pad bytes written as `0`, which `open` refused (about 1 push in 256). `unpad` now reads `0` as 256; nothing sealed before changes.
- **Xcode.** `NotificationService` is an app-extension target, built and embedded (`Embed Foundation Extensions`). `App/App.entitlements`: `aps-environment` (`development`; an App Store export re-signs it `production`) and keychain groups `$(AppIdentifierPrefix)com.gavin.companion` (first, so the Device's keys stay in the app's own group) and `…com.gavin.companion.shared`. The extension's entitlements name the shared group; `GAVIN_NOTIFICATION_FILTERING=YES` picks `NotificationServiceFiltering.entitlements` instead, once Apple grants filtering. `Info.plist` has `UIBackgroundModes: remote-notification`, `GavinKeychainGroup` and `GavinPushGateway` (`$(GAVIN_PUSH_GATEWAY)`).
- **Extension** (`NotificationService.swift`, `NotifyOpen.swift`, `Shared/SharedKeychain.swift`, `Shared/DeliveredNotify.swift`): tries each paired Workstation's key from the shared group, drops a counter at or below the highest shown under that key (kept per key, so pairing again starts over), titles the alert with the Workstation's name, writes the tap link, and replaces an earlier notification for the same item. A resolve removes the item's notification; without the filtering entitlement it shows as a passive line the hub clears. `WorkstationsPlugin` now saves into the shared group and moves records an older build saved.
- **App** (`PushPlugin.swift`, `AppDelegate.swift`): asks to notify, gets the APNs token, reports its APNs environment from the embedded profile, makes the gateway's calls natively (the gateway answers no CORS), keeps the gateway registration in the keychain, reports taps (held until the hub listens), and clears delivered notifications.
- **Hub** (`push/setup.ts`, `push/registration.ts`, `push/gateway.ts`, `push/taps.ts`, `native/push.ts`; `Hub.svelte` and `+page.svelte` wired): a Notifications row that asks only on the owner's tap and reflects the answer (smoke F1); the token registered (`POST /v1/devices`) or refreshed (`PUT …/token`) at each launch; a tap opens its Workstation on its session or card once unlocked and connected; a Workstation's notifications whose item is no longer waiting are cleared.
- **Docs.** `docs/companion-mobile.md` "Push notifications (iOS)": the paid team, the two App IDs and their capabilities, `aps-environment`, `GAVIN_PUSH_GATEWAY`, the filtering entitlement (Apple grants it on request) and the Simulator's limit. Also the shell README's "Notifications" and `push-gateway.md`'s resolved-push item.

**Measured.**
- `cargo test --bin gavin-daemon notify_crypto companion_push`: 8 passed. `npm run companion-shell:test`: 349 passed (37 files). `companion-shell:check`: 0 errors, no warnings in these files. `notify-fixture.sh`: 13 of 13, and it fails a doctored table.
- Simulator Debug build and device Release build (`-sdk iphoneos`, signing off) both succeed with `NotificationService.appex` in `PlugIns/`; the simulated entitlements carry both groups and `aps-environment`.
- On an iOS 26.5 Simulator paired with an isolated daemon (temp `$HOME`, loopback Relay): the hub showed "Turn on notifications"; the tap brought up iOS's own prompt; Allow got an APNs token and the row changed. Against `gavin-push-gateway` in dry run, launch 1 logged `device … registered (ios)` / `POST /v1/devices 201`, and launch 2 `replaced its token` / `PUT …/token 204` for the same Device. The daemon, handed a gateway URL and a permission, sealed and posted 284-byte pushes with `Bearer <permission>`.
- `simctl push` of those pushes showed the gateway's placeholder: it adds a local request through `CoreSimulatorBridge` and never starts a service extension. The extension's decrypt on a lock screen needs a real APNs push to a phone.

**Open (as of the iOS half; the next section closes the first item).**
- The Decision above: no Device-to-Workstation permission handover, no desk driver, no gateway URL setting at the desk. Until those exist no Workstation holds a permission for a real phone, so the human test cannot pass. Whoever builds the desk driver: `companionNotifyDriver.ts` sends `workspaceId` and `sessionId`, but `protocol::CompanionNotifyEvent` reads `workspace_id` and `session_id` (`rename_all` renames variants, not fields), so the daemon would refuse its events. Push under the attention items' ids, which the hub clears against.
- Signing with the owner's paid team (`M3DT8FPBFU`, which holds App Store profiles) creates the `com.gavin.companion.NotificationService` App ID and turns on Push for `com.gavin.companion` in that account. That is the owner's to run, filed below.
- Filtering: request `com.apple.developer.usernotifications.filtering` from Apple for the team, then build with `GAVIN_NOTIFICATION_FILTERING=YES`.

## Progress (2026-10-09, second round): the rest of the chain, protocol v67, uncommitted on main

**Built.**
- **Handover (v67).** `Request::SetThisDeviceSendPermission { permission }`, Device-only (`remote_allows`), intercepted in `serve_connection` and stored on the connection's own Device row, as `RemoveThisDevice` is; an app/local/agent connection is refused. The daemon refuses a permission over 2048 bytes or with characters an `Authorization` header cannot carry. `DeviceInfo.notifies` and `Devices.push_gateway_url` widen the replies (`serde(default)`). `PROTOCOL_VERSION` 67, `min_version_for` 67, the band counts and serde tests updated.
- **Phone** (`push/handover.ts`, wired in `+page.svelte`, drawn in `Hub.svelte`): once notifications are on, mints one permission per paired Workstation at the gateway (`ensureWorkstationPermissions`), keeps them with the registration, and hands each over the live connection once per app run. The Notifications row lists each Workstation ("Notifies", "Set up when it connects", "Update Gavin at the desk" for one older than v67) with its own Turn off/Turn on. Turn off cancels the permission at the gateway and hands the Workstation an empty one.
- **Desk driver** (`agents/companionNotifyDriver.ts` + `companion/notifyDevices.ts`, called from `publishAttention.ts`): diffs the attention answer the phone's inbox reads, under its ids, after it holds still 3 s, from the window holding the app's duties, only with remote access on and a gateway set. Nothing is notified for what already waited when the desk opened. Fixed the wire spelling: it now sends `workspace_id`/`session_id`.
- **Gateway URL at the desk:** Settings → Remote access → Push gateway (`set_push_gateway_url`), validated by the daemon (`http(s)://` with a host), read back from `ListDevices`; the Devices panel shows "notifications on" per Device. Both behind `FEATURE_MIN_VERSION.pushGateway` (67). Both new host commands are in `lib.rs`, `commands.rs`, the Remote-role table (refused) and the bundle's desk-only list, and are classified in `commandGate.test.ts`.
- **Daemon fixes found on the way:**
  - **Counter race:** two `PushCompanionNotify` requests at once read the same counter, and the phone would drop the second as a replay. Pushes now run on one ordered worker (`queue_companion_push`), which answers once queued.
  - **No timeout:** a post could hang on a silent gateway; it now times out after 15 s.
  - **Refusal codes lost:** ureq 2 returns 4xx/5xx as `Err`, so the gateway's refusal codes never reached `map_reply` and a cancelled or expired permission was never dropped. It now reads the code out of the error.
- **Docs:** `companion-mobile.md` "End to end" (the four steps), the shell README, `push-gateway.md`, and `security/06-companion.md` §5.6 (the hand-over; resolved via filtering).

**Measured.**
- Rust: protocol 227; daemon 1089 unit (under a temp `$HOME`: this Mac's require-local-token switch otherwise fails ~50 `server::tests` as `Forbidden local`), `device_wire` 59 including the new seam test over a real Relay, 86+1 gavin-mcp, companion-core 61; host `cargo check` plus 46 command-table tests.
- JS: desk 7830, bundle 866, shell 359 (including the 10 hand-over tests); `check` clean for desk, bundle and shell; all three builds succeed.
- **Simulator, iOS 26.5, isolated daemon, real `gavin-push-gateway` in dry run:**
  1. Pairing, then Unlock.
  2. "Turn on notifications", and iOS's prompt is allowed.
  3. The gateway logged `registered (ios)` and `granted permission`; the daemon's `ListDevices` said `notifies: true`; the hub read "Workstation · Notifies".
  4. `PushCompanionNotify` led to `push on permission … to ios device …: delivered, 284 bytes` (`POST /v1/push 202`).
  5. Turn off: `cancelled permission`, the daemon said `notifies: false`, and the next push posted nothing.
  6. Turn on: `granted permission` (a new one) and `notifies: true` again.

**Still open.**
- The two human items below: signing with a paid team on the iPhone, and the companion-25 lock-screen test. The decrypt on screen needs a real APNs push: a `live` gateway with the team's APNs key (`GAVIN_PUSH_APNS_*`, topic `com.gavin.companion`), and the phone built with `GAVIN_PUSH_GATEWAY` pointing at it.
- The running dev daemon is still v66: it needs a rebuild and restart before the desk can take a phone's permission. That is the owner's call.
- `companionNotify.ts`'s `companionWaitingFromSignals` is no longer called (the driver diffs the attention answer). Left in place; delete it once nobody wants it.

## Progress (2026-10-09, third round): taps never reached the hub; fixed, and the rest of what follows a push run on a Simulator

**Found.** No tap on a notification ever reached the hub, and a notification arriving with the app in front showed nothing. `AppDelegate` makes `PushTaps` the notification centre's delegate, but Capacitor's bridge takes it over as it loads (`ios.handleApplicationNotifications` defaults to on). Its own `NotificationRouter` hands pushes to a `pushNotificationHandler` that only Capacitor's push plugin registers, so it answered `[]` to `willPresent` and dropped `didReceive`. Measured before the fix: two pushes with the app in front showed no banner and never reached the shade; a tap from the background left the hub's log without `notification tapped`. The second round's tap check tapped the gateway's placeholder, whose link is the hub, so landing on the hub looked right.

**Fixed.** `capacitor.config.ts` sets `ios.handleApplicationNotifications: false` (Capacitor's own doc for that key: "Set to false if you want to use your own UNUserNotificationCenter"). `push/taps.test.ts` holds it, and the shell README's Notifications says why.

**Measured after the fix.** iOS 26.5 Simulator, isolated daemon (temp `$HOME`, loopback Relay), desk serving the staged bundle. Each push is a `simctl push` carrying the keys the extension writes (`gavin.link`, `gavin.ws`, `gavin.item`), since `simctl push` never runs the extension:
- **In front:** the banner shows.
- **Warm tap** (`…/session/s-t1?workspace=ws-1`, on a page whose focused session is `s-t2`): `notification tapped`, the bundle fetched, and the Workstation opened on `s-t1`'s terminal.
- **Cold tap** (app not running): the tap launched it, Face ID asked, and once connected it landed on `s-t1`.
- **Answering at the desk:** t1 and t2 were both in the shade; once the desk stopped waiting on t2, the next attention poll left only t1's notification.
- **One Workstation off:** two desks, the real `gavin-push-gateway` in dry run, and the app built with `GAVIN_PUSH_GATEWAY`. Each Workstation got its own permission and both said `notifies: true`; a push from each was `delivered, 284 bytes` on its own permission. Turn off on the first: the gateway `cancelled permission` for that one, desk 0 said `notifies: false` and desk 1 still `true`; the next push was delivered on desk 1's permission only. The rows read "Off / Turn on" and "Notifies".
- **Not run live:** a card link (the same path; the fixture and `decrypt.test.ts` cover the link), and a resolve push removing its notification (that is the extension, which needs a real phone).
- **Suites:** shell 360 (one new), `companion-shell:check` 0 errors.
- `docs/companion-mobile.md` now says which part of the chain a Simulator can run this way.

**Still open.** The two human tests above. A real phone also needs this fix, so build from this tree.
