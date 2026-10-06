---
order: 24576
kind: task
title: Companion 23: served, signed Workstation UI
status: Done
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

- [x] A bundle with a bad signature is refused, and a store build refuses a dev-key bundle (tested)
- [x] An unchanged hash is a cache hit, and a Workstation upgrade fetches the new bundle
- [x] Navigation outside the app-local origin is blocked

When done, file a human test: on a phone, open the dev Workstation, see its real board, move a card, and watch it move at the desk.

## Plan

Design, held to the spec and ADR 0005: the bundle is a plain ustar tar of `app/companion/build`, hashed (SHA-256) and signed (Ed25519 over a domain-separated hash) by the desktop build, embedded in the desktop host, and served through the daemon in chunks the Device asks for; the shell verifies and unpacks it in the Companion core (one Rust verifier, wasm and native), the native side stores the files by hash and serves them at the Workstation's app-local origin; `invoke`/`listen` reach the live hub's connection to that Workstation; an inbox item's target rides the channel's `capabilities` answer as an optional `landing`.

- [x] `protocol::companion_bundle`: manifest, signing message, verifier, ustar reader, chunk cap; `GetCompanionBundle`/`CompanionBundle`/`ForwardBundle`/`BundleResult` (v56 on this branch; renumbered at the merge), gated and walked
- [x] Daemon: a Device's ask forwarded to the desktop like attention; `device_wire.rs` proves manifest, chunks, a signed bundle reassembled, and the desktop-absent state
- [x] Desktop: `stage-companion.mjs` builds, packs and signs (release key from `GAVIN_BUNDLE_SIGNING_KEY`, else a dev key made on this machine); `build.rs` embeds what is staged; `forwarding.rs` answers `ForwardBundle`
- [x] Companion core: `bundle-open` (verify under the trusted keys, unpack) in `companion-wasm`, carried by `src/shell/core/core.ts`
- [x] Shell: `src/shell/bundle/` — read the manifest, fetch in chunks, trust (publisher key always; dev key in debug builds only), the cache decision (hit by hash; a changed hash fetches), all pure and tested
- [x] Shell: the connection carries pushes; the live hub lends a visit its connection; `workstationEndpoint` turns `invoke`/`listen`/`unlisten` into `InvokeDesktop`/`ListenDesktop`/`UnlistenDesktop` and desktop events into `event`s, re-listening after a reconnect
- [x] Shell: the visit fetches, verifies, installs and opens a paired Workstation's bundle, saying where it is; landing rides `capabilities`; the bundle lands on the card (or the card running the session)
- [x] Native: `BundleView` gains `installed`/`install`/`prune`/`devPublisherKey`; `open` takes the bundle to serve (embedded name or hash); iOS and Android serve a cached bundle from the hash folder; the dev key is a debug build's only
- [x] Release: preflight checks the bundle key's public half against the pinned one; `scripts/bundle-key.mjs`; READMEs, RELEASING, CONTEXT
- [x] Proof: cargo suites, shell and bundle vitest, checks and builds; the probe on a Simulator; the Node end-to-end against a real daemon serving a real signed bundle
- [ ] Human test: On a phone with a debug Companion paired with this dev Workstation (app/companion-shell/README.md, "Pairing"), the dev desktop app running (tauri dev, which stages and signs the bundle) with remote access on: unlock, tap the Workstation — it should say "Fetching its UI…" then open its real workspace list; open a workspace and see its real board; at the desk move a card to another column and watch it move on the phone; go back to the hub, tap an inbox item and land on its card, outlined, in its column; close and reopen the Workstation — it opens at once from the cache.
- [ ] Decision: The Companion bundle's publisher key does not exist yet: run `node app/src-tauri/companion-key.mjs generate` on a machine that runs no agents, keep the seed as the GAVIN_BUNDLE_SIGNING_KEY secret, and pin the printed public key in app/companion-shell/src/shell/bundle/publisherKey.ts (docs/RELEASING.md, "The Companion bundle key"). Until then a store build of the Companion trusts no key and refuses every bundle, and the release preflight refuses to build — deliberately. Who makes it, and when?
  Options: A) I will generate and pin it myself before the App Store build B) Generate it in a session and pin it, and I will move the seed into the secret C) Leave it null until the early store review card (companion-24)

## Outcome

Uncommitted on `companion/phone` (worktree `.gavin-worktrees/companion-phone`), 66 files. The shell README's new section "Served bundles" has the design; `docs/RELEASING.md` "The Companion bundle key" has the key custody.

- **The contract** is `protocol::companion_bundle` (no OS parts, wasm-checked): a plain ustar tar of the built bundle, a camelCase manifest (SHA-256, size, Ed25519 over `"gavin-companion-bundle-v1" || hash`, the signer), the verifier, the reader (refuses links, extended headers and any path that leaves the folder), and 256 KiB chunks base64. `test-fixtures/companion-bundle/` pins the desktop's Node packer and signer (`app/src-tauri/companion-bundle.mjs`, Node's `crypto` only) to the Rust reader and verifier: the same files pack to the same archive, and the Node signature equals the Rust one.
- **The wire** (v56 on this branch; `main` and `companion/wire` gave 56..58 to other work, so the merge renumbers it as the Device wire's five were): `GetCompanionBundle { version, offset, length }` → `CompanionBundle { state, manifest?, offset, data }`, forwarded to the desktop as `ForwardBundle` → `BundleResult`. Gated by type, walked everywhere a request variant is, allowed to the Remote role. The bundle API has its own version and grows by optional fields, so no FEATURE_MIN_VERSION entry is owed.
- **The desktop build** stages before the app: `stage-companion.mjs` (in `beforeDevCommand` and `beforeBuildCommand`) builds `app/companion`, packs, signs and writes `src-tauri/companion/bundle.{tar,json}` (gitignored); `build.rs` embeds them into `$OUT_DIR`, and embeds `None` when nothing is staged so `cargo test --workspace` on a clean checkout still builds; `forwarding.rs` answers `ForwardBundle` from `companion_bundle::answer`. Two keys: the publisher's seed (`GAVIN_BUNDLE_SIGNING_KEY`; `companion-key.mjs generate|public`) and a dev key made once per machine under gavin's data dir (`companion-dev-bundle-key.json`). `--release` without the secret signs with the dev key and says so; the release preflight derives the secret's public half and refuses unless it is the one `publisherKey.ts` pins — and refuses while the pin is null.
- **The core** gains `bundle-open` (verify under the trusted keys, unpack; files out base64 for the native store). **The shell** (`src/shell/bundle/`): manifest read tolerantly and checked before any fetch; trust = the pinned publisher key, plus the dev key only when the native side says debug build; cache by hash with a per-Workstation last-seen memory for pruning; chunked fetch that catches a mid-fetch upgrade. **The connection** now hands pushes to listeners (`onPush`), **the live hub** lends a visit its connection (`connectionSource`), and `visit/workstationEndpoint.ts` turns `invoke`/`listen`/`unlisten` into `InvokeDesktop`/`ListenDesktop`/`UnlistenDesktop` and `DesktopEvent` into `event`s, re-listening after a reconnect. The visit readies the bundle before the view opens (the hub shows each step) and hands an inbox item's target over in `capabilities.landing`, once; the bundle (`state/workstation.ts`, `PhoneBoard`) lands on the card, or the card whose agent is the session, and outlines it.
- **Native**: `BundleView` gains `installed`/`install`/`prune`/`devPublisherKey`, `open` takes `bundle` (an embedded name or a hash); iOS caches under `Library/Application Support/bundles/<hash>` (staged beside, moved into place, excluded from backup), Android under `noBackupFilesDir/bundles/<hash>` with `BundleFiles.Source` over assets or a folder; the dev key's public half is embedded by `sync.mjs` (Android `debug` source set; iOS `Bundles/`, left out by `--release`, read only in DEBUG).
- **Proof.** `cargo test --workspace --no-fail-fast`: 2194 passed, 0 failed (`device_wire` 45, with the chunked fetch, the cut chunk and the absent desktop). Shell vitest 241 (bundle 19, endpoint 6, visits 17, live hub 15, unlocked hub 9, connection 18, core 13 against the real `.wasm`); bundle vitest 266; app vitest 7323 (two pre-existing failures untouched by this work: the `mainThreadCommands` guard on forwarding.rs's test builder, and a `session.rs` emit split across lines); checks 0 errors; builds ok. `GAVIN_E2E=1`: 16 pass, `bundle.e2e.ts` against a real daemon and Relay with the desk serving a really signed bundle. `scripts/probe.sh` on an iPhone 17 Simulator and a Pixel emulator: every check passes, navigation away still blocked, the bundle in its own process on Android.
- **Not here.** Moving a card from the phone: the board is still read-only (companion-27), so the human test moves the card at the desk and watches the phone. Chunking a single invoke answer across Android's Binder limit (about 1 MB): a board answer is far below it; the README's trap stands for companion-26's terminals. The publisher key: null until the human makes it (decision filed).
