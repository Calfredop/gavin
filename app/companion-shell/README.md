# `app/companion-shell/` — the Companion shell

The store app: a Capacitor project for iOS and Android (ADR 0002). It holds
the Workstations hub and hosts each Workstation's UI bundle — for now the
Demo Workstation's, embedded in the binary. Read the spec's "The Companion
shell" section and ADR 0005's "Store compliance" first; `CONTEXT.md` has the
words. The bundle it runs is `app/companion/` (its README has the channel's
message set).

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

From `app/`:

```
npm run companion-shell:test    # vitest: the shell's channel, visits, the probe's verdict
npm run companion-shell:check   # svelte-check, the desktop's library included
npm run companion-shell:build   # the hub, in companion-shell/build
npm run companion-shell:sync    # both builds, then `cap sync` and the embedded bundles
npm run companion-shell:dev     # the hub in a browser on :1440 (it cannot open a Workstation there)
```

`companion-shell:sync -- ios` (or `android`) syncs one platform; `--probe`
embeds the probe bundle on iOS too (see below). Then open
`ios/App/App.xcodeproj` in Xcode or `android/` in Android Studio and run, or
build from a terminal the way `scripts/probe.sh` does.

The embedded bundles (`ios/App/App/Bundles/`, `android/app/src/*/assets/bundles/`)
and the hub copied into each project (`public/`) are build outputs and are
not committed: a fresh checkout needs a sync before either project builds.

## The probe

```
scripts/probe.sh ios <simulator-udid>
scripts/probe.sh android <emulator-serial>
```

Builds a debug app with the probe bundle (`probe/`) embedded, launches it to
open the probe the way a Workstation's bundle opens, and prints the verdict
(`src/shell/probe/probe.ts`). From inside the bundle webview the probe calls
a Capacitor plugin every way Capacitor's own JS does, speaks on the channel
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

## How the bundle webview is sealed

| | iOS | Android |
|---|---|---|
| origin | `gavin-bundle://<workstation>`, a `WKURLSchemeHandler` | `https://<workstation>.bundle.gavin.invalid`, answered in `shouldInterceptRequest` |
| files | only the Workstation's folder under `Bundles/`; nothing outside it | only `assets/bundles/<workstation>/`; every other request refused (403) |
| bridge | none: a plain `WKWebView` | none: a plain `WebView`, no `addJavascriptInterface` anywhere |
| channel | `gavinChannel` script-message handler; accepted only from the main frame at the bundle's origin | `addWebMessageListener` with the bundle's origin; accepted only from the main frame |
| policy | a Content-Security-Policy on every page: `connect-src 'self'`, scripts only its own files and its own inline scripts (hashed at serve time) | the same policy (`BundleFiles.policy`, kept in step with `BundleSchemeHandler.policy`) |
| navigation | only its own origin; a tapped web link opens in the system browser; `window.open` opens nothing | the same |
| storage | a data store per Workstation (iOS 17+; one visit's before) | the `:bundle` process's own data directory, per origin |
| process | WebKit's own content process per webview | `BundleActivity` in `android:process=":bundle"`, the channel crossing to the shell's process through `BundleChannelService` |

Anything refused natively is reported to the shell's web layer by origin
alone (the `dropped` event), never by content.

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
  first WebView.

## What is here, and what is not

The hub lists the Demo Workstation and opens its embedded bundle. The
Device's keys (companion-20), pairing (companion-21), the Unlock and a live
hub (companion-22), and served, signed, cached bundles (companion-23) are the
cards that follow.
