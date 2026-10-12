# Companion mobile: compile and run

How to build the store app (`app/companion-shell/`) for a Simulator,
emulator, device, or App Store / Play upload. Architecture and traps
live in that folder's README; this file is the operator path from a
fresh checkout to a binary.

Bundle id / application id: `com.gavin.companion`. Home-screen name:
**Gavin**.

## Prerequisites

| Tool | Why |
| --- | --- |
| Rust stable + `rustup target add wasm32-unknown-unknown` | Companion core (`scripts/core.mjs` → `companion-core.wasm`) |
| Node.js (LTS) + npm | Hub, bundle, Capacitor sync |
| Xcode (macOS) | iOS Simulator / device / archive |
| Android Studio SDK + JDK 21 | Android APK / AAB (`JAVA_HOME` or `/usr/libexec/java_home -v 21`) |
| Optional: `rsvg-convert`, ImageMagick | Only when regenerating icons (`scripts/icons.mjs`) |

Once per checkout (and after lockfile changes):

```sh
cd app && npm ci
cd companion-shell && npm ci
```

The Capacitor CLI lives in `companion-shell/node_modules`; svelte / kit /
vite resolve from `app/node_modules` by walking up.

## One-shot compile

```sh
cd app/companion-shell

# Debug, leave artefacts under --out
scripts/compile.sh ios --out /tmp/gavin-ios
scripts/compile.sh android --out /tmp/gavin-android

# Debug and install (name the device — never `booted`)
scripts/compile.sh ios --install <simulator-udid>
scripts/compile.sh android --install <emulator-serial>

# Store-shaped binaries
scripts/compile.sh ios --release --team <APPLE_TEAM_ID> --build-number 1 --out /tmp/gavin-store
scripts/compile.sh android --release --build-number 1 --out /tmp/gavin-store
scripts/compile.sh both --release --team <APPLE_TEAM_ID> --build-number 1 --out /tmp/gavin-store
```

`compile.sh` runs `npm run companion-shell:sync` (builds the Companion
UI bundle, the hub, the WASM core, then `cap sync` and embeds the Demo
Workstation). Embedded bundles and `public/` are build outputs and are
not committed — a fresh checkout always needs a sync before Xcode or
Gradle will build.

| Flag | Meaning |
| --- | --- |
| `--release` | Sync with `--release` (no dev publisher key, no probe); iOS archive / Android AAB |
| `--probe` | Embed the probe bundle (debug only; used by `scripts/probe.sh`) |
| `--install TARGET` | Debug build + install on that Simulator / emulator |
| `--team ID` | Required for iOS `--release` (`DEVELOPMENT_TEAM`) |
| `--build-number N` | iOS `CURRENT_PROJECT_VERSION` / Android `versionCodeOverride` |
| `--out DIR` | Keep the archive / `.app` / APK / AAB |

## Manual steps (same as the script)

From `app/`:

```sh
# Debug (both platforms, or pass ios / android)
npm run companion-shell:sync
# Store-shaped
npm run companion-shell:sync -- ios android --release
```

Then:

```sh
# iOS Simulator debug
cd companion-shell/ios/App
xcodebuild -project App.xcodeproj -scheme App -configuration Debug \
  -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' build

# iOS device / App Store archive
xcodebuild -project App.xcodeproj -scheme App -configuration Release \
  -destination 'generic/platform=iOS' \
  -archivePath /tmp/App.xcarchive -allowProvisioningUpdates \
  DEVELOPMENT_TEAM=<TEAM_ID> CURRENT_PROJECT_VERSION=1 archive

# Android debug APK
cd companion-shell/android && ./gradlew :app:assembleDebug
# → app/build/outputs/apk/debug/app-debug.apk

# Android Play AAB
./gradlew bundleRelease -PversionCodeOverride=1
# → app/build/outputs/bundle/release/app-release.aab
```

Or open `ios/App/App.xcodeproj` in Xcode / `android/` in Android Studio
after a sync and Run.

## Android signing

`bundleRelease` signs with the Play **upload** key from either:

- `app/companion-shell/android/keystore.properties` (gitignored):
  `storeFile`, `storePassword`, `keyAlias`, `keyPassword`, or
- env: `GAVIN_ANDROID_UPLOAD_KEYSTORE`, `…_STORE_PASSWORD`,
  `…_KEY_ALIAS`, `…_KEY_PASSWORD`.

Without either, Gradle still produces an AAB and Play refuses it.
`scripts/store-submit.sh` walks through making the keystore the first
time. Each Play upload needs a higher `versionCode`
(`-PversionCodeOverride` / `--build-number`).

## Store submission

```sh
app/companion-shell/scripts/store-submit.sh
```

Wizard: pin the publisher public key, App ID / Play app, upload key,
build both binaries, upload, paste listing text from `store/`. What the
stores are sent must describe **this** build — see `store/README.md`.

Release rules that matter before you archive:

- Sync with `--release` so no dev key goes in. A store build trusts only
  the key `src/shell/bundle/publisherKey.ts` pins; while that is `null`
  only the Demo Workstation opens.
- Publisher key custody: `docs/RELEASING.md` ("The Companion bundle key")
  — seed never on a machine that runs agents.
- iOS privacy manifest: `ios/App/App/PrivacyInfo.xcprivacy` (ITMS-91053).
- iOS icon must stay opaque.

## Push notifications (iOS)

The app (`com.gavin.companion`) asks to notify from the hub's
Notifications row, registers its APNs token with the Push gateway, and
embeds a Notification Service Extension
(`com.gavin.companion.NotificationService`) that opens each push with the
paired Workstation's notification key before iOS shows it. How a push
travels is [`push-gateway.md`](push-gateway.md); the shell's side is its
README's "Notifications".

**End to end.** Four things have to be in place for a phone to be
notified:

1. At the desk, Settings → Remote access → **Push gateway** names where
   the daemon posts (the daemon refuses a URL that is not `http(s)://` with
   a host). Remote access must be on.
2. On the phone, the hub's Notifications row is turned on (iOS asks once),
   which registers the APNs token with that same gateway.
3. Each paired Workstation is handed the phone's send permission when it
   connects (protocol v67; the hub's row says "Notifies" once it holds one,
   and the desk's Devices panel says "notifications on"). A Workstation
   older than v67 cannot take one, and the hub says to update Gavin at the
   desk. Each row has its own Turn off.
4. The desk notifies what newly waits on the human: whatever enters the
   attention answer a phone's inbox reads, once it has held still for 3
   seconds, from the window holding the app's duties
   (`app/src/lib/companion/notifyDevices.ts`). What already waited when the
   desk opened is not notified again.

**The Apple team.** Signing needs a paid Apple Developer Program team. A
personal (free) team cannot use the Push Notifications capability, and the
App target's entitlements carry `aps-environment`, so automatic signing with
a personal team refuses the build.

**The App IDs.** Automatic signing (`-allowProvisioningUpdates`, as
`device-drive.sh` and `compile.sh` pass it) registers the second App ID and
turns the capability on the first time it signs with the team:

| App ID | Capabilities |
| --- | --- |
| `com.gavin.companion` | Push Notifications |
| `com.gavin.companion.NotificationService` | none; Notification Filtering once Apple grants it (below) |

Both targets also name the keychain group
`$(AppIdentifierPrefix)com.gavin.companion.shared`, where the paired
Workstations' records live so the extension can read their keys on a locked
phone. That needs no capability: every profile allows groups under its
team's prefix.

**`aps-environment`.** `App/App.entitlements` says `development`, which is
what a development-signed build is given. An App Store export re-signs with
the distribution profile, which says `production`, and that is what ships.
The app tells the gateway which APNs its token came from by reading its own
embedded provisioning profile; an App Store or TestFlight install has none,
and is `production`.

**Which gateway.** A build registers with the gateway its
`GAVIN_PUSH_GATEWAY` build setting names (`GavinPushGateway` in
`Info.plist`), and the hub says "this build names no Push gateway" without
one. Pass it to `xcodebuild`, e.g.
`GAVIN_PUSH_GATEWAY=https://push.example`. For a phone to receive anything
the gateway must be `live`, with an APNs key from the same team and
`GAVIN_PUSH_APNS_TOPIC=com.gavin.companion`. The dev compose's gateway is a
dry run: it registers Devices and delivers nothing.

**The filtering entitlement.** "Resolved" pushes, for an item dealt with at
the desk, need `com.apple.developer.usernotifications.filtering` before the
extension may show nothing. Apple grants it to a team on request
(developer.apple.com/contact/request/notification-service). Until then a
build signs without it: a resolve still removes the item's notification,
and shows itself as a passive line (no sound, the screen stays dark) that the
hub clears once it is open. Once it is granted, build with
`GAVIN_NOTIFICATION_FILTERING=YES`, which signs the extension with
`NotificationServiceFiltering.entitlements` and tells it that it may filter.
A build asking for it before the grant does not sign.

**On a Simulator.** An Apple silicon Simulator registers with APNs and gets
a token, so asking, the token and the gateway registration can all be run
there. `simctl push` cannot test the extension: it adds the payload as a
local request and never starts the extension, so what shows is the
gateway's placeholder. The extension's open is held to the daemon's seal by
`scripts/notify-fixture.sh` on a Mac; seeing it decrypt on a lock screen
takes a real APNs push to a phone. What happens after the extension can be
run there, though: a `simctl push` payload carrying the keys the extension
writes (`gavin.link`, `gavin.ws`, `gavin.item`, beside `aps`) is what the
app sees once a real push is opened, so a tap on it opens its Workstation
where the link points, and the hub clears it once that Workstation stops
waiting on its item.

## Pair with a local Relay

For a phone on your LAN against a desktop on this Mac:

1. Deploy or run a Relay the phone can reach — see [`relay.md`](relay.md)
   (dev cleartext section, or a real `wss://` host).
2. Desktop Settings → Remote access on, URL + admission token, Pair a
   device.
3. Scan the QR from the Companion.

Scripted end-to-end (loopback Relay + temp daemon):

```sh
scripts/pair.sh node
scripts/pair.sh ios <simulator-udid>
scripts/pair.sh android <emulator-serial> --pin <pin>
```

## Drive a physical iPhone

```sh
DEVELOPMENT_TEAM=<TEAM_ID> scripts/device-drive.sh ios-device <udid>   # build, install, launch, inspector
scripts/device-drive.sh ios-device <udid> dom                         # hub text + buttons
scripts/device-drive.sh ios-device <udid> click "<label>"
```

Over USB, through Web Inspector: a real phone has no `simctl` to tap with.
The phone must be unlocked and trusted, with Developer Mode and Settings →
Apps → Safari → Advanced → Web Inspector on, and Gavin in front. Face ID
cannot be scripted: an Unlock on a phone waits for its owner.

**Never `ios_webkit_debug_proxy` for this.** It has no bind option and
listens on every interface, macOS firewall or not, so a debug build's
webview — the Device's Noise key, a live Workstation connection — answers
anyone on the LAN. `device-drive.sh`'s inspector binds 127.0.0.1, refuses a
foreign Host or Origin, and stops itself unless the Mac's LAN addresses are
refused; `dom`, `click` and `eval` open no port at all. See the shell
README's "A physical iPhone".

## Related scripts

| Script | Job |
| --- | --- |
| `scripts/compile.sh` | Sync + compile (+ optional install) |
| `scripts/sync.mjs` | What `companion-shell:sync` runs |
| `scripts/store-submit.sh` | App Store + Play internal testing wizard |
| `scripts/probe.sh` | Seal checks on Simulator / emulator |
| `scripts/keys.sh` | Device-keys plugin on Simulator / emulator |
| `scripts/notify-fixture.sh` | The extension's open against the daemon's seal (macOS) |
| `scripts/pair.sh` / `hub.sh` | Pairing and live-hub e2e |
| `scripts/device-drive.sh` | Install on, and drive, a physical iPhone over USB |
| `scripts/devstack.mjs` | Local Relay + isolated daemon |
| `crates/gavin-relay/scripts/deploy.sh` | Relay image / systemd helper |

## Related docs

- Shell architecture and traps: `app/companion-shell/README.md`
- Store listing copy: `app/companion-shell/store/README.md`
- Relay deploy: [`relay.md`](relay.md)
- Desktop release + Companion bundle key: [`RELEASING.md`](RELEASING.md)
