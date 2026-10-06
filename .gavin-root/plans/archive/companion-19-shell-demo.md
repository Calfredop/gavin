---
kind: task
title: Companion 19: Companion shell with the Demo Workstation
status: Done
labels: ready-for-agent
parent: companion.md
complexity: complex
---
Blocked by: companion-09-web-bundle-demo.md

Part of `companion.md`. Read the spec (section "The Companion shell"), ADRs 0002 and 0005 (with its "Store compliance" section), and the store research first.

## What to build

The store app: a Capacitor project for iOS and Android, styled the desktop's way.

- **The hub.** The Workstations hub lists the Demo Workstation.
- **The bundle webview.** Picking the Demo Workstation opens the Companion web bundle from ticket 09 (embedded in the binary for the demo) in a **separate webview with no Capacitor bridge**, rendered full-screen inside the app's own navigation.
- **The shell side of the channel.** It checks the origin, carries the closed message set, and reaches only that bundle's own Workstation (here, the demo).
- **External links** open in the system browser. Nothing else navigates.

## Acceptance criteria

- [x] It builds and runs on the iOS Simulator and an Android emulator
- [x] A probe proves a plugin call from the bundle webview fails
- [x] A channel message from another origin is dropped

When done, file a human test: on a phone, open the Demo Workstation from the hub, browse its board, and return to the hub, without anything opening a browser.

## Plan

Built to the spike's measured conditions (`docs/research/2026-09-28-companion-device-keys.md` §4, on branch `spike/companion-device-keys`): never an iframe in the shell's webview; the channel checks frame and origin natively; an app-local origin per Workstation; on Android the bundle runs in its own app process.

- [x] Scaffold `app/companion-shell/`: its own package.json (Capacitor 8.5.2 only; svelte resolves from `app/`), capacitor.config, a static SvelteKit hub with `$lib`, `$companion` and `$shell`; `companion-shell:*` scripts
- [x] `shellChannel.ts` + tests: origin gate (dropped), the closed set, `capabilities` answered by the shell, invoke/listen/unlisten to the one bound Workstation, open-external (web links only) and return-to-hub as the shell's acts, nothing after close
- [x] `hub/workstations.ts` + `visit/visit.ts` + tests: the hub's list, each Workstation's bundle origin, a visit wiring the native view to a shell channel and pacing the demo, token-guarded
- [x] The hub UI, styled with the desktop's theme and the bundle's header
- [x] iOS: bundle view controller (custom-scheme origin over the embedded bundle, own data store, navigation policy, `gavinChannel` main-frame + origin gate), the BundleView plugin, the iOS 27 prompt shim
- [x] Android: bundle activity in `:bundle` (data-dir suffix, intercepted https origin, `addWebMessageListener` + main-frame check, navigation block), a Messenger service carrying the channel to the plugin
- [x] Sync script: build bundle + hub, `cap sync`, embed the bundle; a debug-only probe bundle
- [x] Probe scripts for the Simulator and the emulator: a plugin call from the bundle fails; a message from another origin is dropped
- [x] Build and run on the iOS Simulator and an Android emulator: hub → board → back
- [x] README, CI, CLAUDE.md checks; file the human test
- [ ] Human test: On an iPhone and an Android phone (install steps under "Putting it on a phone" on this card): open the Demo Workstation from the Workstations hub, open a workspace's board and swipe its columns, then go back to the hub with the Workstations button (and on Android also with the system back gesture), without anything opening a browser; the hub is not a blank page on iOS 27.

## Where it landed

`app/companion-shell/` on branch `companion/phone`, uncommitted. Its README has the layout, the commands, a per-platform table of how the bundle webview is sealed, and the traps.

- **Hub** (`src/`, SvelteKit static, the desktop's theme and the bundle's `PhoneHeader`) lists the Demo Workstation. The shell hosts the Demo Workstation itself, fresh per visit and paced by the shell.
- **Shell's end of the channel**: `src/shell/channel/shellChannel.ts` (origin gate, the bundle's closed `MESSAGE_TYPES`, `capabilities`/`open-external`/`return-to-hub` answered by the shell, `invoke`/`listen`/`unlisten` to the visit's one Workstation) and `src/shell/visit/visit.ts` (one visit at a time, by session number). 42 vitest tests.
- **iOS**: `BundleViewController` (plain `WKWebView`, `gavin-bundle://<workstation>` scheme handler over `Bundles/<workstation>`, a CSP with inline scripts hashed at serve time, `gavinChannel` accepted only from the main frame at its origin, a data store per Workstation, navigation blocked, tapped web links to Safari), `BundleViewPlugin`, `ShellViewController`.
- **Android**: `BundleActivity` in `android:process=":bundle"` (intercepted `https://<workstation>.bundle.gavin.invalid`, `addWebMessageListener` + main-frame check, same CSP), the channel crossing processes through `BundleChannelService`/`BundleChannel` (Messenger), `BundleViewPlugin`.
- **Probe**: `scripts/probe.sh ios <udid>` / `android <serial>`. Passed all 8 checks on the iOS 26.5 and 27.0 Simulators and an API 36 emulator, and on Android confirmed the bundle ran in its own process. From inside the bundle webview: every Capacitor plugin-call route throws (no `Capacitor`, `webkit.messageHandlers.bridge` or `androidBridge`); a channel message from a sandboxed (opaque-origin) frame and from a subframe of the bundle's own origin is dropped natively, and none reached the Workstation; fetch to the internet, the shell's origin and another Workstation's origin fail, as does a WebSocket; navigation away and `window.open` do nothing. The shell's origin gate has its own unit test (`shellChannel.test.ts`).
- **Found on the way**: the spike's iOS 27 prompt shim did nothing where the spike put it, because Capacitor replaces the user content controller of the configuration `webViewConfiguration(for:)` returns. The shell adds it in `webView(with:configuration:)`, and the hub loads on iOS 27.0. The spike's findings doc (on `spike/companion-device-keys`) still names the old place.
- **Known limits**: a message crosses Android's process boundary as one Binder transaction (about 1 MB; companion-23's large answers will need chunking); Android's back gesture returns to the hub rather than going back inside the bundle; the first open on a cold emulator takes seconds.

**Putting it on a phone** (for the human test), from `app/`: `cd companion-shell && npm ci && cd .. && npm run companion-shell:sync`.
- iPhone: open `app/companion-shell/ios/App/App.xcodeproj`, target **App** → Signing & Capabilities → your Team, pick the phone, Run.
- Android: `cd companion-shell/android && JAVA_HOME=$(/usr/libexec/java_home -v 21) ./gradlew :app:assembleDebug`, then `adb -s <serial> install -r app/build/outputs/apk/debug/app-debug.apk`.
