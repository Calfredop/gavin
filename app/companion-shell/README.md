# `app/companion-shell/` — the Companion shell

The store app: a Capacitor project for iOS and Android (ADR 0002). It holds
the Workstations hub and hosts each Workstation's UI bundle — the Demo
Workstation's, embedded in the binary, and each paired Workstation's own,
served by it and run only once its signature checks (below, "Served
bundles"). Read the spec's "The Companion shell" section and ADR 0005's
"Store compliance" first; `CONTEXT.md` has the words. The bundle it runs
is `app/companion/` (its README has the channel's message set).

**Operator guides:** compile and store builds in
[`docs/companion-mobile.md`](../../docs/companion-mobile.md)
(`scripts/compile.sh`); Relay deploy in
[`docs/relay.md`](../../docs/relay.md).

Two webviews, and the line between them is the point:

- **The shell's own webview** is a Capacitor webview. It shows only the hub,
  which ships in the binary (`src/`), and it is where the shell's end of the
  channel and the Demo Workstation run.
- **The bundle webview** is a plain webview the shell makes itself, with no
  Capacitor bridge. A Workstation's bundle runs there, full-screen over the
  hub, and its one outlet is the channel.

The bundle webview is built to the conditions the device-keys spike measured
(`docs/research/2026-09-28-companion-device-keys.md` §4, on branch
`spike/companion-device-keys`): never an iframe in the shell's webview, since
Capacitor's iOS bridge answers every frame; the channel checked natively for
frame and origin; an app-local origin per Workstation; and on Android a
process of its own.

## Why it has a package.json

The Capacitor CLI refuses to run without one beside it. It lists Capacitor
and nothing else: svelte, kit and vite resolve from `app/node_modules` by
walking up, so the hub is compiled by the desktop's own svelte, like the
bundle. `tsconfig.json` sets `typeRoots: []` because the CLI brings
`@types/node` into this folder's `node_modules`, and the desktop's library,
checked here as the hub imports it, is written for a page with no node types.

## Commands

Once, and after the lockfile changes:

```
cd app/companion-shell && npm ci
```

One-shot sync + native compile (debug or `--release`):

```
scripts/compile.sh ios|android|both [--release] [--install <udid-or-serial>] …
```

From `app/`:

```
npm run companion-shell:test    # vitest: the channel, visits, pairing, the core, the Unlock, the live hub, served bundles, the probe's verdict
npm run companion-shell:check   # svelte-check, the desktop's library included
npm run companion-shell:build   # the hub and the Companion core, in companion-shell/build
npm run companion-shell:sync    # both builds, then `cap sync`, the embedded bundles and the dev key's public half
npm run companion-shell:dev     # the hub in a browser on :1440 (it cannot open a Workstation there)
```

`:test`, `:build` and `:dev` first build the Companion core for
`wasm32-unknown-unknown` (`scripts/core.mjs`), so they need cargo and
`rustup target add wasm32-unknown-unknown`.

`companion-shell:sync -- ios` (or `android`) syncs one platform; `--probe`
embeds the probe bundle on iOS too (see below); `--release` leaves the dev
key's public half out (see "Served bundles"). Then open
`ios/App/App.xcodeproj` in Xcode or `android/` in Android Studio and run, or
build from a terminal the way `scripts/probe.sh` does.

The embedded bundles (`ios/App/App/Bundles/`, `android/app/src/*/assets/bundles/`)
and the hub copied into each project (`public/`) are build outputs and are
not committed: a fresh checkout needs a sync before either project builds.

## Store builds

`scripts/store-submit.sh` walks the owner through a submission: the App
Store with manual release, and Play internal testing (companion-24). What
the stores are sent — review notes, description, listing, Play icon — is in
`store/`, whose README says why it must describe the build and not the plan.

- **Release sync.** `companion-shell:sync -- ios android --release`, so no
  dev key goes in. A store build trusts only the key `publisherKey.ts` pins,
  and while that is null it opens the Demo Workstation and nothing else.
- **Android signing.** `bundleRelease` signs with the Play upload key named
  in `android/keystore.properties` (gitignored: `storeFile`, `storePassword`,
  `keyAlias`, `keyPassword`), or in `GAVIN_ANDROID_UPLOAD_KEYSTORE`,
  `…_STORE_PASSWORD`, `…_KEY_ALIAS`, `…_KEY_PASSWORD`. Without either it
  builds an unsigned AAB, which Play refuses. `-PversionCodeOverride=N` sets
  the versionCode, which must rise with every upload.
- **Privacy manifest.** `ios/App/App/PrivacyInfo.xcprivacy` declares the App
  target's own `UserDefaults` reads. App Store Connect refuses an upload that
  reads a required-reason API no manifest declares (ITMS-91053), so native
  code that starts reading a new one declares it there too.
- **Icons and launch images** are drawn from the desktop's
  `app/src-tauri/icons/icon.svg` by `scripts/icons.mjs` (needs `rsvg-convert`
  and `magick`). The PNGs are committed; run it again when the icon changes.
  The iOS icon must stay opaque: App Store Connect refuses one with alpha.

## The probe

```
scripts/probe.sh ios <simulator-udid>
scripts/probe.sh android <emulator-serial>
```

Builds a debug app with the probe bundle (`probe/`) embedded, launches it to
open the probe the way a Workstation's bundle opens, and prints the verdict
(`src/shell/probe/probe.ts`). From inside the bundle webview the probe calls
a Capacitor plugin every way Capacitor's own JS does -- the bundle view's and
the Device's keys' -- speaks on the channel
from a frame of another origin and from a subframe, fetches the network, the
shell's origin and another Workstation's, opens a WebSocket, calls
`window.open`, and navigates away. Every check must pass, the device log
must show no plugin call reaching the shell, and on Android the bundle must
have run in its own process.

The probe is a debug build's only. On Android it lives in the `debug` source
set. On iOS resources have no per-configuration folder, so the probe is
embedded only by a sync with `--probe` and removed by every sync without it;
the native side also refuses to open it outside a DEBUG build.

Name devices by UDID or serial, never `booted`: other sessions on this Mac
boot simulators of their own.

## The touch recorder

```
scripts/touch-recorder.sh <iphone-udid> on       # in the open bundle
# ...the human swipes the terminal...
scripts/touch-recorder.sh <iphone-udid> report
```

What a finger on the terminal did, measured in the page of a debug build on
a physical iPhone, one line per swipe: rows redrawn, how many after the
finger lifted (momentum), the visible rows before and after, whether the
page scrolled instead, and frame times. `touch-recorder.js` is the recorder
itself, one expression any inspector can evaluate; `webview-eval.py`
carries it over USB through the Mac's usbmuxd and opens no port. Synthetic
`TouchEvent`s prove nothing here (they are untrusted), which is why this
needs a finger.

## How the bundle webview is sealed

| | iOS | Android |
|---|---|---|
| origin | `gavin-bundle://<workstation>`, a `WKURLSchemeHandler` | `https://<workstation>.bundle.gavin.invalid`, answered in `shouldInterceptRequest` |
| files | one bundle's folder — embedded under `Bundles/`, or the cache's `bundles/<hash>/` — and nothing outside it | the same: `assets/bundles/<name>/`, or `<noBackupFilesDir>/bundles/<hash>/`; every other request refused (403) |
| bridge | none: a plain `WKWebView` | none: a plain `WebView`, no `addJavascriptInterface` anywhere |
| channel | `gavinChannel` script-message handler; accepted only from the main frame at the bundle's origin | `addWebMessageListener` with the bundle's origin; accepted only from the main frame |
| policy | a Content-Security-Policy on every page: `connect-src 'self'`, scripts only its own files and its own inline scripts (hashed at serve time) | the same policy (`BundleFiles.policy`, kept in step with `BundleSchemeHandler.policy`) |
| navigation | only its own origin; a tapped web link opens in the system browser; `window.open` opens nothing | the same |
| storage | a data store per Workstation (iOS 17+; one visit's before) | the `:bundle` process's own data directory, per origin |
| process | WebKit's own content process per webview | `BundleActivity` in `android:process=":bundle"`, the channel crossing to the shell's process through `BundleChannelService` |

Anything refused natively is reported to the shell's web layer by origin
alone (the `dropped` event), never by content.

## The Device's keys

The `DeviceKeys` plugin (`ios/App/App/DeviceKeysPlugin.swift`,
`android/…/DeviceKeysPlugin.java`, driven through
`src/shell/native/deviceKeys.ts`) holds the Device's two keys (ADR 0001;
the parameters are `docs/research/2026-09-28-companion-device-keys.md`'s).
It is registered on the shell's own bridge and no other, so no bundle can
reach it; the probe tries.

| | iOS | Android |
|---|---|---|
| hardware key | Secure Enclave P-256, `[.privateKeyUsage, .userPresence]`, `WhenPasscodeSetThisDeviceOnly` | Keystore P-256 in StrongBox, else the TEE; an auth window of one hour for a strong biometric or the device credential; unlocked device required; attested |
| Noise key | 32 bytes in a generic-password item, `WhenPasscodeSetThisDeviceOnly`, never synchronised | 32 bytes sealed by a Keystore AES-GCM key, in `noBackupFilesDir`; backup and device transfer off in the manifest |
| sign | asks for the owner, then signs `"gavin-device-unlock-v1" \|\| hash`, the hash exactly 32 bytes | the same, with a `BiometricPrompt` |
| refused | no passcode; no Secure Enclave | no screen lock; a key that comes out software |
| Simulator, emulator | a debug build uses a software key marked `software-debug` | a debug build keeps the emulator's software key, marked the same |
| reinstall | the first launch deletes what an earlier install left in the keychain | an uninstall takes the keys with it |

The public half of the hardware key is what pairing registers. The Noise
key's private half goes only to the shell's web layer, for the Companion
core, which also derives its public half: neither iOS below Safari 18.4 nor
Android below API 33 has X25519 outside it.

`sign` prompts every time: it is pairing's. Connections sign under the
Unlock instead (below): `unlock` asks once and holds it, `signUnlocked`
never asks. The auth window (one hour, ticket 02's recommendation) is
baked into each key when it is made.

A debug build shows a keys panel under the Workstations: create the keys,
sign a test handshake, delete them. `scripts/keys.sh` runs the same plugin
through the keys check (`src/shell/keys/keysCheck.ts`) on a Simulator or an
emulator, answers the prompt, and verifies the signature the way the daemon
does:

```
scripts/keys.sh ios <simulator-udid> [--strict]
scripts/keys.sh android <emulator-serial> [--strict] [--pin <pin>]
```

`--strict` refuses a software key, as a release build does. On iOS the
script enrols Face ID on the Simulator and answers with a matching face. On
Android an emulator with no screen lock is refused for having no passcode;
set one with `adb -s <serial> shell locksettings set-pin <pin>` and pass it
as `--pin`.

## The shell's end of the channel

`src/shell/channel/shellChannel.ts`, one per visit (`src/shell/visit/visit.ts`):

- **Origin.** A message from any origin but the bundle's is dropped, again,
  after the native check.
- **The closed set.** Only the types in the bundle's `MESSAGE_TYPES` are
  carried; anything else is answered `unsupported` or dropped. Only `result`
  and `event` come back from a Workstation.
- **Capabilities** are the shell's to answer: the set it carries and the
  one Workstation it reaches.
- **One Workstation.** `invoke`, `listen` and `unlisten` go to the visit's
  Workstation and nowhere else. `open-external` (web links only) and
  `return-to-hub` are the shell's own acts and never reach a Workstation.

The Demo Workstation is the bundle's own (`app/companion/src/companion/demo`),
made fresh for each visit and paced by the shell, exactly as the bundle's
README says a shell-hosted demo is.

## The Companion core

`crates/companion-wasm` is the Companion core (`crates/companion-core`)
as this layer calls it: a plain C ABI with JSON across it, built by
`scripts/core.mjs` into `static/companion-core.wasm` (a build output, not
committed) with the workspace's `companion-wasm` profile. It imports
nothing. `src/shell/core/core.ts` compiles it once, the first time a
pairing needs it, and instantiates it afresh for every exchange, so a trap
ends one pairing and nothing else. The wire -- the handshake, framing,
the six digits, the Relay's hello and its replies -- is computed there by
the Rust the daemon and the test Device run; the TypeScript only carries
bytes. The page's CSP allows `'wasm-unsafe-eval'` for it, and `ws:` and
`wss:` for the Relays; the core dials `ws://` only to this machine or
this network (`protocol::relay::RelayUrl`).

## Pairing

"Pair a Workstation" under the hub (`src/shell/pairing/`):

1. **Scan.** The `QrScanner` plugin: on iOS a full-screen AVFoundation
   scanner of the shell's own; on Android Google's code scanner, which
   runs the camera in Google Play services and hands back only the code,
   so the app holds no camera permission. Both read QR codes and nothing
   else.
2. **Keys.** Refused on a phone that cannot be a Device; the keys are made
   at the first pairing and are the same for every Workstation after it.
3. **The core reads the code** before anything is dialled: a code that
   is not one, or a Workstation too old to pair with, costs no connection.
4. **The Relay.** The first one the code names that answers `ready` to the
   hello carries the stream (the webview's own WebSocket,
   `pairing/relaySocket.ts`).
5. **Sign.** After the handshake the hardware key signs its hash, which
   prompts for Face ID or a fingerprint; the proof carries the hardware
   public key, which is what pairing registers.
6. **Compare.** The six digits show once the Workstation has taken the
   proof, in two groups of three like the desk's.
7. **Keep.** `paired` from the desk leaves a record in the `Workstations`
   store, named "Workstation" (then "Workstation 2", …) and renamable on
   the spot; the hub lists it above the Demo Workstation, and connects to
   it once the Companion is unlocked. Opening its UI is companion-23's.

The records are the web layer's JSON, opaque to the native side, each
holding that Workstation's notification key:

| | iOS | Android |
|---|---|---|
| where | a keychain item a Workstation, `AfterFirstUnlockThisDeviceOnly`, never synchronised | one file in `noBackupFilesDir`, sealed by a Keystore AES-GCM key |
| why readable while locked | the notification service extension will open pushes on a locked phone | the same, for the FCM handler |
| gone with | the Device's keys (`deleteKeys`, and the first launch after a reinstall) | the Device's keys, and an uninstall |

### The scripted pairing

```
scripts/pair.sh node
scripts/pair.sh ios <simulator-udid> [--relay-host <ip>]
scripts/pair.sh android <emulator-serial> --pin <pin>
```

Both pair with a Workstation on this Mac: `scripts/devstack.mjs` starts
`gavin-relay` on loopback (plain `ws://`, which a Relay URL may be only
because it is loopback) and a `gavin-daemon` under a temporary `$HOME`,
and plays the desk on its two connections. `node` runs the shell's own
pairing module and the real core in Node (`src/shell/pairing/pairing.e2e.ts`):
a pairing the desk confirms, one it declines, and a spent code. `ios`
installs a fresh debug app, launches it with the code in place of a scan
(`-GavinPairCode`, base64), answers the Face ID prompt, lets the desk
confirm only if the phone's digits are its own, and then launches the app
again: the hub must still list the Workstation. It uninstalls the app
first, keys and pairings with it. `android` does the same on an emulator,
reaching the Relay through `adb reverse` and answering the prompt with
the screen-lock PIN. `--relay-host` puts the Relay on a LAN address
instead of loopback, which is what a real phone dials.

**Cleartext on Android.** A dev Relay is `ws://`, and Android refuses
cleartext unless the app's network security config allows it. A release
build allows it to loopback only; a debug build to any host
(`src/debug/res/xml/network_security_config.xml`), so a phone can pair
with a dev Relay on the LAN. The core still refuses `ws://` to a host that
is not on this machine or this network, either way.

To pair a real phone with the dev desktop by hand: run a Relay the phone
can reach (`GAVIN_RELAY_LISTEN=0.0.0.0:8443 GAVIN_RELAY_TOKENS=<token>
GAVIN_RELAY_TLS_TERMINATED=1 target/debug/gavin-relay`), set remote access
at the desk to `ws://<this Mac's LAN address>:8443` with that token, and
press Pair a device there, and scan its code. The phone asks for
local-network access the first time, and macOS's firewall asks whether
`gavin-relay` may accept incoming connections: until it is allowed, the
phone and the daemon both time out on it.

`ws://` is what a dev Relay speaks, and each platform has to let it
through: iOS by `NSAllowsLocalNetworking` (App Transport Security),
Android by a debug build's network security config (below). Both follow
the core's rule, `ws://` only to this machine or this network.

## Traps

- **Capacitor 8.5.2 hangs on a blank page on the iOS 27.0 Simulator.** Its
  bridge asks two questions through a synchronous `prompt()` WebKit never
  delivers. `ShellViewController` answers them from a document-start script,
  and that script must be added in `webView(with:configuration:)`: Capacitor
  replaces the user content controller of the configuration
  `webViewConfiguration(for:)` returns, so a script added there is dropped.
- **`xcrun simctl terminate` hangs when the app is not running.** Launch with
  `--terminate-running-process` instead.
- **A message crosses Android's process boundary as one Binder transaction**,
  so a single message is bounded by Binder's buffer (about 1 MB). The demo's
  are far below it; a paired Workstation's large answers will need chunking
  (companion-23).
- **Android's back gesture closes the bundle** and returns to the hub; the
  channel has no message for going back inside a bundle.
- **The first open on a cold emulator takes seconds**: a new process and its
  first WebView. The first open of a paired Workstation takes the fetch
  as well; after that its bundle is in the cache.
- **A debug build logs every plugin answer**, the Noise key's included:
  Capacitor's own bridge logging, on in debug builds only. A release build
  logs nothing of it.
- **A Simulator always reports a passcode**, Face ID enrolled or not, so the
  no-passcode refusal can only be seen on an emulator (or a phone). Without
  Face ID enrolled the prompt is a passcode sheet that takes any code.
- **Two hyphens in a row end an XML comment** and fail the Android resource
  build, as they fail codesign on a plist.
- **A desk that stops its Relay the moment it confirms** cuts off the
  verdict on its way to the phone, which then reports that the
  Workstation stopped waiting. `scripts/devstack.mjs` holds the stack
  until the phone says how the pairing ended.
- **UserDefaults reads a launch argument that looks like a property list
  as one**, so the scripted code travels as base64.
- **A fresh Simulator's first boot takes minutes** after `simctl boot`
  returns, and `simctl listapps` or `get_app_container` hang until it is
  done: wait with `xcrun simctl bootstatus <udid>` before a script.
- **The shell's activity is `singleTask`**, so launching it -- the
  launcher icon, or `am start` -- clears a bundle above it; the app
  switcher brings the bundle back as it was. Either way the Unlock asks,
  over whichever is in front.
- **Android draws the passcode screen black in a screenshot** (a secure
  window): a black `screencap` during the Unlock is the prompt.
- **A WebView WebSocket that Android refused says so only to the page's
  console** (`net::ERR_CLEARTEXT_NOT_PERMITTED`), not to logcat. A debug
  build's WebView can be asked directly: `adb -s <serial> forward
  tcp:9333 localabstract:webview_devtools_remote_<pid>`, then the page's
  DevTools socket from `http://127.0.0.1:9333/json`.

## Served bundles

ADR 0005: a paired Workstation's UI is a bundle built from the same
commit as its desktop app, signed by the publisher, shipped inside the
desktop app and served to the phone over its connection; the shell runs
it only once the signature checks against a key it pins. The contract —
the archive (a plain ustar tar), the manifest, the signing message, the
chunk cap — is `crates/protocol/src/companion_bundle.rs`, and
`test-fixtures/companion-bundle/` pins the desktop's Node packer and
signer (`app/src-tauri/companion-bundle.mjs`), the Rust verifier and the
core in the shell to one another.

**Opening a paired Workstation** (`src/shell/bundle/`, `visit.ts`):

1. **Ask** (`GetCompanionBundle`, API version 1) over the live hub's
   connection to it — the same connection the hub asks what is waiting
   on. The answer is the manifest: the archive's SHA-256 (also the name
   it is cached under), its size, an Ed25519 signature and the key it
   verifies under. A desktop that carries no bundle says so; a desktop
   that is not running is the same state as for attention.
2. **Trust** (`trust.ts`), on the manifest alone, before a byte is
   fetched: the signer must be a key this build trusts. A **store build**
   trusts the pinned publisher key (`publisherKey.ts`) and nothing else.
   A **debug build** also trusts the dev key made on the developer's
   machine, whose public half the native side hands over only in a DEBUG
   build (`BundleView.devPublisherKey`). Until a publisher key is pinned
   a store build trusts no key at all, and refuses every bundle, saying
   so.
3. **Cache** (`bundle.ts`): a hash the native store already holds
   (`BundleView.installed`) opens at once. A Workstation that upgraded
   names a new hash, which is fetched; the old one is pruned once every
   paired Workstation's last-seen bundle is known (`store.ts`).
4. **Fetch** (`fetch.ts`): the archive a chunk at a time, 256 KiB each,
   base64 in the daemon's own protocol, through the daemon's forwarding
   to the desktop app that embeds it. A desktop that changes its bundle
   mid-fetch is caught by the manifest every answer carries.
5. **Verify and unpack**, in the Companion core (`bundle-open`): the
   archive is the one the manifest names and the signature checks under
   one of the trusted keys, then the files come out — base64, which is
   what the native store takes. A bad signature, an untrusted key or a
   changed archive is refused in the verifier's own words, and nothing
   is installed.
6. **Install** (`BundleView.install`): the native side writes the files
   into a folder beside the cache and moves it into place in one step,
   under the hash, checking every path again; a bundle half installed
   is never served. iOS keeps the cache under `Library/Application
   Support/bundles/`, excluded from backup; Android under
   `noBackupFilesDir/bundles/`. `open` then names the hash, and the view
   serves that folder at the Workstation's own origin exactly as it
   serves an embedded one.

The hub shows each step under the Workstation's name while it opens.

**The channel to a paired Workstation** (`visit/workstationEndpoint.ts`):
`invoke` becomes `InvokeDesktop` on the connection and its
`DesktopResult` the `result`; `listen` becomes `ListenDesktop` once per
event name and a desktop event the daemon pushes (`DesktopEvent`) an
`event` to each listener of that name; `unlisten` ends the wire's listen
with the last listener. A call made while the connection is down is
answered with an error the bundle shows, never dropped, and every event
still listened for is listened for again when the connection comes back
— the daemon keeps a listen per connection. The connection itself hands
pushes to whoever listens (`Connection.onPush`); with nobody listening
they wait for the next request to pass over, as before.

**Landing.** Tapping an inbox item opens its Workstation with the item's
workspace and target in the channel's first `capabilities` answer
(`landing`), once. The bundle opens that workspace's board on the card
the item names — or the card whose agent is the session it names — and
outlines it.

**The dev key.** `app/src-tauri/stage-companion.mjs` (run by every
`tauri dev` and `tauri build`) makes an Ed25519 key under gavin's data
directory the first time it needs one (`companion-dev-bundle-key.json`,
beside the daemon's databases, one per machine), and signs the dev
desktop's bundle with it; `scripts/sync.mjs` embeds its public half —
on Android in the `debug` source set, on iOS under `Bundles/`, where
`--release` leaves it out and the native side reads it only in a DEBUG
build. Never the seed. A release desktop is signed with the publisher
key instead (`docs/RELEASING.md`, "The Companion bundle key").

```
GAVIN_E2E=1 npx vitest run src/shell/bundle/bundle.e2e.ts   # also in scripts/pair.sh node
```

runs the shell's own modules and the real core in Node against a real
daemon behind a real Relay (`scripts/devstack.mjs`), whose desk serves a
bundle the desktop's packer and signer made: fetched in chunks, verified,
installed, then a cache hit; refused by a store build's trust and with a
bad signature; fetched again after an upgrade; and the channel's `invoke`
and `listen` over the same connection, through forwarding, to the desk —
a layout-saving command refused by the daemon's table on the way.

## The Unlock and the live hub

ADR 0004: one Face ID, fingerprint or passcode, when the Companion comes
to the front, unlocks the connections to every paired Workstation, until
the app goes to the background or the phone locks. The parameters are
ticket 02's (`docs/research/2026-09-28-companion-device-keys.md`).

- **Native** (`DeviceKeys`): `unlock` asks once and holds it -- on iOS the
  evaluated `LAContext`, set to never show anything again; on Android the
  hardware key's auth window, which the prompt opened -- and
  `signUnlocked` signs each connection's handshake under it without a
  prompt. The native side ends it itself on background and lock (iOS
  `didEnterBackground` and `protectedDataWillBecomeUnavailable`; Android
  the app's last started activity stopping, and `SCREEN_OFF`), never on
  losing the focus (Control Center, the shade, a call banner, the prompt
  itself), and tells the web layer as a `lifecycle` event, with coming
  back to the front. On iOS 27 the shade backgrounds the app while it is
  down, so the iOS side believes a background only once it has lasted two seconds
  (`briefBackground`, whose comment weighs what that costs); the screen
  locking does not wait. A debug build logs every lifecycle notification
  as `[gavin-lifecycle]`, natively and in the web console.
- **Android's "in front"** spans two processes: the shell's activity and a
  bundle's, in `:bundle`. `AppForeground` counts both -- the bundle's
  start and stop cross over the channel -- and decides "background" 700 ms
  after the last one stops, so opening a Workstation's UI is not leaving
  the app.
- **The rule** is `src/shell/unlock/unlock.ts`, pure: what asks, what
  connects, what drops everything. A reconnect is not an event there at
  all. Android's auth window closing (`lapsed`) asks again while the
  connections already open stay; a lapse within a minute of the owner
  confirming is the hardware refusing, and locks with the reason rather
  than asking forever.
- **The connections** are `src/shell/connection/`: the first Relay that
  answers carries `IK`, the proof is signed under the Unlock, and then the
  attention request (`GetAttention`, API version 1) over the daemon's own
  protocol. A Relay that answers `offline` makes the Workstation *asleep*
  (or remote access is off at the desk); one that cannot be reached, or a
  connection that drops, *unreachable*.
- **The live hub** (`src/shell/hub/liveHub.ts`) keeps one connection per
  paired Workstation while the Unlock allows it, asks what is waiting
  every 15 s (which also finds a connection a dead network left open),
  and reconnects a drop from 1 s, doubling to 30 s, with no prompt. A
  Workstation that refused this Device for good (revoked, removed, unseen
  ninety days) is not tried again until the next Unlock. The owner need
  not wait out the 30 s: an asleep, unreachable or desktop-app-not-running
  row offers `Try now`, and tapping it -- or coming back to the app with
  the Unlock still held -- dials (or asks) at once. At most once in 3 s,
  and a try that fails leaves the unattended loop where it was, so a
  phone tapped again and again does not dial its Relay from 1 s again.
- **The inbox** (`src/shell/hub/inbox.ts`) is every ready Workstation's
  items, each labelled with its Workstation. One that is locked,
  connecting, asleep, unreachable, or whose desktop app is not running
  adds nothing. Tapping an item opens its Workstation, once a paired one
  can be opened (companion-23); until then the hub says so.

`src/shell/hub/unlockedHub.ts` wires the two to the plugin; the page only
draws them. A debug build logs each step (`[gavin-unlock]`, `[gavin-hub]`).

```
scripts/pair.sh node                               # includes src/shell/hub/hub.e2e.ts
scripts/hub.sh ios <simulator-udid> [--screenshots <dir>]
scripts/hub.sh android <emulator-serial> --pin <pin> [--screenshots <dir>]
```

`hub.e2e.ts` runs the shell's own modules and the real core in Node
against two Workstations (`scripts/devstack.mjs`, twice): one Unlock
connects both, the inbox labels both, a dropped connection comes back
without a prompt, a desk item dealt with leaves, a desktop app that quits
and a Workstation that leaves its Relay show so and add nothing, and
background locks. `hub.sh` pairs a fresh debug install with two
Workstations (`devstack.mjs hub`), then launches it: the Unlock must ask
once and both answer ready; another app in front must lock both; back in
front it must ask again and both answer again.

## What is here, and what is not

The hub lists the paired Workstations, live while unlocked, with the
combined inbox, and the Demo Workstation; it opens the Demo's embedded
bundle and each paired Workstation's served one. The Device's keys
(companion-20), pairing (companion-21), the Unlock and the live hub
(companion-22), and served, signed, cached bundles with landing on an
inbox item (companion-23) are here. What the bundle can do once open is
the bundle's own README's: a board to read, with the rest of the surfaces
(companion-26 to -30) still to come. Notifications and the Push gateway
are not here either.
