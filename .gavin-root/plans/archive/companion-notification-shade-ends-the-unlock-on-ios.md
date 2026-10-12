---
order: 21504
kind: task
title: Companion: pulling down the notification shade on iOS ends the Unlock and asks Face ID again
status: Done
priority: medium
complexity: moderate
---
Found on 2026-10-08 by `companion-iphone-smoke-tests.md` (A8), on a physical iPhone 16 Pro (iOS 27.0), debug build, with the Companion unlocked and a Workstation connected.

**Spec.** `app/companion-shell/src/shell/unlock/unlock.ts` (ticket 02's "Brief interruptions"): the Unlock ends on the app going to the background and on the phone locking, and does NOT end on Control Center, the notification shade, a call banner or the prompt itself; those are `interrupted` and change nothing. The shell README says the same.

**Measured.** The owner pulled down Control Center, then the notification shade. The hub's unlock log (`[gavin-unlock]`, page clock):
- Control Center: no event at all. Correct.
- Notification shade: 540.6 s `background: unlocked -> locked (background)` and `[gavin-hub] ws-b8b62138dff5ea6a: locked`; 541.7 s `foreground: locked (background) -> unlocking`; 542.2 s `prompt-succeeded` (Face ID again, 0.5 s); connections dropped and rebuilt (`connecting`, `connected`, `ready, 210 waiting`). The shade again at 550.0 s: the same five lines. The owner's words: "pulling down control center does not lock, but notification panel does".

So on iOS 27.0 the shade reaches the web layer as a `background` phase, a second or so long, and the Companion drops every connection and asks for Face ID. That makes the shade, which the owner uses constantly, cost a prompt and a reconnect each time (and, now that the shell leaves a paired Workstation when the Unlock ends, it also throws the owner out of an open Workstation back to the hub).

**Where to look.** The native side raises `phase: background` from `DeviceKeysPlugin.swift` (iOS observes `didEnterBackground` and `protectedDataWillBecomeUnavailable`). The shade on iOS 16 and later presents the Lock Screen's notification list over the app; depending on the OS it may deliver `didEnterBackground`/`sceneDidEnterBackground` or only `willResignActive`. Find which notification fires for the shade (log it natively) and compare with the real Home/app-switcher cases, which must still end the Unlock.

**To do.**
- Log the native lifecycle notifications with timestamps for: Home, app switcher, screen lock, Control Center, notification shade, an incoming call banner, Face ID prompt.
- Pick the signal that separates the shade from a real background (for example the scene's `activationState` / `UIApplication.applicationState`, `isProtectedDataAvailable`, whether the app is still the foreground scene), or a very short grace period for a background that returns within about a second without the screen locking. State the security trade-off of any grace period in the code comment; a grace period must never apply to the screen locking.
- Keep `unlock.test.ts` honest: add the shade as an `interrupted` case if the fix is in the TS layer.

**Fix (2026-10-08).** No public signal tells the shade from Home: both are `didEnterBackground` then `willEnterForeground`, with the app and its scene `background` alike. So `DeviceKeysPlugin.swift` believes a background only once it has lasted `briefBackground` (2 s): until then the Unlock stays held and the web layer hears nothing, neither the background nor the foreground after it. A background task keeps the app running so the Unlock ends on time, and coming back checks the elapsed time (`CLOCK_MONOTONIC`, which counts while the phone sleeps) in case the timer was starved. `protectedDataWillBecomeUnavailable` (the lock) ends it at once, grace or none. The open question is when iOS posts that: if only when the data protection keys go, some seconds after the lock, a lock gets the same 2 s, and coming back inside them means unlocking the phone first. The trade-off is in the `briefBackground` comment. Verified on an iOS 27.0 Simulator: away 0.5 s gives "back after 0.5 s; the Unlock is kept" and no web event; away 6 s ends it 2.05 s after the background. Every lifecycle notification is now logged as `[gavin-lifecycle]` (time, app and scene state, protected data, brightness), natively and, in a debug build, in the web console beside `[gavin-unlock]`. The TS rule is unchanged: the shade never reaches it. Research doc table updated.

**Acceptance.**
- [ ] The notification shade does not change the Unlock, drop a connection or ask for Face ID
- [ ] Home, the app switcher and the screen locking still end the Unlock
- [ ] Control Center still does not
- [ ] Human test: pull the shade down and up three times with a Workstation open; nothing happens. Then press Home and reopen; Face ID is asked
- [ ] Human test: On the iPhone with a debug build and a Workstation open, do Home, the app switcher, the screen lock, Control Center, the shade (a glance and a 5 s read), a call banner and the Face ID prompt; in the web console, the shade glance shows "back after … s; the Unlock is kept", Home and switching apps (away more than 2 s) end the Unlock, and the lock shows "the phone is locking" — note how long after the lock's didEnterBackground it comes
