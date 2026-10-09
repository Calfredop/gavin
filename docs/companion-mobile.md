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
| `scripts/pair.sh` / `hub.sh` | Pairing and live-hub e2e |
| `scripts/device-drive.sh` | Install on, and drive, a physical iPhone over USB |
| `scripts/devstack.mjs` | Local Relay + isolated daemon |
| `crates/gavin-relay/scripts/deploy.sh` | Relay image / systemd helper |

## Related docs

- Shell architecture and traps: `app/companion-shell/README.md`
- Store listing copy: `app/companion-shell/store/README.md`
- Relay deploy: [`relay.md`](relay.md)
- Desktop release + Companion bundle key: [`RELEASING.md`](RELEASING.md)
