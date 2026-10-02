---
order: 23552
kind: task
title: Companion 22: the Unlock and a live Workstations hub
status: Done
labels: ready-for-agent
parent: companion.md
complexity: complex
---
Blocked by: companion-21-shell-pairs.md, companion-14-attention-request.md

Part of `companion.md`. Read the spec (sections "The Device's keys and the Unlock" and "The Companion shell"), ADR 0004 and ticket 02's findings first.

## What to build

**The Unlock (ADR 0004):**
- One biometric or passcode authentication, when the Companion comes to the foreground, unlocks the connections to every paired Workstation.
- The Unlock ends when the app goes to the background or the phone locks. Control Center and call banners do not end it.
- Reconnects while the app is in front do not prompt, using ticket 02's parameters.

**The live hub:**
- Each Workstation shows its state: ready, desktop app not running, or asleep (inferred from the Relay).
- The combined attention inbox gathers every Workstation's attention request, each item labelled with its Workstation.
- Tapping an item opens its Workstation. Landing on the exact target arrives with ticket 23.

## Acceptance criteria

- [x] Pure-module tests for the Unlock lifecycle and for merging the inbox
- [x] A Workstation that is unreachable, or whose desktop app is not running, shows that state and adds nothing to the inbox

When done, file a human test: unlock once and see two Workstations connect; background the app and see it locked; open Control Center and see it still unlocked; drop the network and see it reconnect without a prompt; the inbox shows items from both Workstations, labelled.

## Plan

Branch `companion/phone` (worktree `.gavin-worktrees/companion-phone`), mostly under `app/companion-shell/`.

- [x] `crates/companion-wasm`: the connection calls (`connect-start`, `connect-receive`, `connect-prove`, `connect-send`), one connection per instance, with the core's own dials; native tests against a `snow` Workstation
- [x] `src/shell/core/`: the connection calls, tested against the real `.wasm`
- [x] `src/shell/connection/`: dial the first Relay that answers, `IK`, a silent signature through the Unlock, then a live `Connection` (request, close, dropped); the attention request and a tolerant reading of its answer; outcomes named for the hub (asleep = the Relay says `offline`, unreachable, refused, locked, the Unlock lapsed)
- [x] `src/shell/unlock/`: the Unlock lifecycle as a pure module (foreground prompts once; background and screen lock end it; interruptions and the prompt's own lifecycle do not; the Android auth window lapsing asks again without dropping live connections)
- [x] `src/shell/hub/`: live state per Workstation, reconnect backoff, attention polling, and the combined inbox (only a ready Workstation adds items, each labelled), pure; the live hub that runs connections off the Unlock, tested with fakes
- [x] Native: `DeviceKeys` gains `unlock` (one prompt, held: the `LAContext` on iOS, the auth window on Android), `signUnlocked` (never prompts), `lock`, and a `lifecycle` event; ends the Unlock natively on background and lock (iOS `didEnterBackground` / `protectedDataWillBecomeUnavailable`; Android the app's last started activity across both processes, and `SCREEN_OFF`)
- [x] Hub UI: each Workstation's state, the combined inbox, the Unlock banner; tapping an item opens its Workstation (the landing is companion-23's)
- [x] Node end-to-end: two Workstations (two dev stacks), one Unlock, both connect, the inbox labels items from both; a Workstation whose desktop app is absent shows it and adds nothing; a dropped stream reconnects without a second prompt
- [x] Builds on a Simulator and an emulator; a scripted Unlock run where feasible
- [x] README, suites, human test filed
- [ ] Human test: With a debug build on an iPhone (and on an Android phone), paired with two Workstations whose desktop apps are running with something waiting (pairing as in app/companion-shell/README.md, "Pairing"): open the Companion and confirm once — both Workstations turn Ready and "Waiting on you" lists items from both, each labelled with its Workstation; pull down Control Center (and let a call banner show) — still unlocked, nothing reconnects; airplane mode on for ten seconds, then off — the Workstations read Unreachable and come back Ready with no second Face ID or fingerprint prompt; press Home and come back — it asks again before anything reconnects; lock the phone and unlock it — it asks again; quit the desktop app on one Workstation — it reads "Desktop app not running" and its items leave the inbox.

## Outcome

Uncommitted on `companion/phone` (worktree `.gavin-worktrees/companion-phone`). The shell README's new section "The Unlock and the live hub" has the design.

- **The core's connection in the shell.** `companion-wasm` gains `connect-start`/`-receive`/`-prove`/`-send` (one connection per instance, like a pairing); the dials are the core's own (`connect::connect_dials`, now what `PairedWorkstation::relay_dials` answers too). `src/shell/core/core.ts` carries them.
- **The connection** (`src/shell/connection/`): the first Relay that answers carries `IK`; the proof is signed under the Unlock with no prompt; then `GetAttention` (API version 1) over the daemon's protocol, read tolerantly (unknown fields ignored, an unknown kind kept as `other`, an unknown target dropped). Outcomes named for the hub: a Relay saying `offline` is **asleep**; no Relay, or a drop, is **unreachable**; revoked / not paired / stale / pair-again is **pair again** and is not retried until the next Unlock.
- **The Unlock** (`src/shell/unlock/unlock.ts`, pure): foreground asks once (not with nothing paired); background and screen lock end it and drop everything; interruptions and the prompt's own lifecycle do not; a reconnect is not an Unlock event at all. Android's auth window lapsing asks again and keeps the open connections; a lapse within a minute of the owner confirming locks with the reason instead of asking forever (a loop the tests found).
- **The live hub** (`src/shell/hub/liveHub.ts`, `unlockedHub.ts`): one connection per Workstation while unlocked, asks every 15 s (which also finds a dead connection), reconnects from 1 s doubling to 30 s with no prompt. `hub/inbox.ts` merges only ready Workstations' items, each labelled; `hub/workstations.ts` shows Ready, Desktop app not running, Asleep, Unreachable, Locked, Connecting, Pair again. The hub template gains the Unlock line and button and the "Waiting on you" list; tapping an item routes to its Workstation, and until companion-23 can open a paired one the hub says so.
- **Native** (`DeviceKeys`): `unlock` (iOS holds the evaluated `LAContext` with `interactionNotAllowed`; Android opens the key's auth window), `signUnlocked` (never prompts; `locked` / `unlock-expired`), `lock`, `unlockState`, and a `lifecycle` event. Ended natively on iOS `didEnterBackground` / `protectedDataWillBecomeUnavailable`, on Android by `AppForeground` (the shell's activity and the bundle's, in `:bundle`, counted together, with a 700 ms settle) and `SCREEN_OFF`.
- **Proof.**
  - Shell vitest 207 pass (Unlock lifecycle 16, inbox 6, live hub 14, Unlock driving the hub 8, connection 17, attention 6, core 11 against the real `.wasm`, …); `companion-shell:check` 0 errors; `companion-shell:build` ok. `cargo test -p companion-core -p companion-wasm` 61 + 18; `device_wire` 43; `companion-core` checks for `wasm32-unknown-unknown`.
  - `hub.e2e.ts` (in `scripts/pair.sh node`), against two real daemons each behind a real `gavin-relay`: one phone paired with both; one Unlock, both ready, inbox labelled from both; a dropped stream back with no prompt; an item cleared at the desk leaves; a desktop app that quits shows so and adds nothing; remote access off reads asleep and adds nothing; background locks, foreground asks again. 7 pass.
  - `scripts/hub.sh ios` (iPhone 17, iOS 26.5, a Simulator of this card's own, deleted after) and `scripts/hub.sh android emulator-5594 --pin 1234` (API 36): fresh install paired with two Workstations; one prompt, both Ready with 2 and 1 waiting; another app in front locks both; back in front asks again and both answer. Passed on both; screenshots checked.
  - Android by hand: opening the Demo's bundle and coming back keeps the Unlock; Home from inside the bundle ends it; back through the app switcher with the bundle on top asks over the bundle and unlocks.
- **Choices made.** After a first pairing the hub shows "Locked. Unlock to connect" with a button, rather than raising a second prompt by itself. A launch carrying a scripted pairing code does not start the Unlock, so the pairing's prompt is the only one.
- **Not verified here:** Control Center and a call banner (neither can be raised on a Simulator or emulator), a real network drop, a real Secure Enclave or StrongBox key under a held Unlock (ticket 02's open device tests), and Android's one-hour window lapsing for real. The human test covers them.
