---
order: 21504
kind: task
title: Companion: pulling down the notification shade on iOS ends the Unlock and asks Face ID again
status: To Do
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

**Acceptance.**
- [ ] The notification shade does not change the Unlock, drop a connection or ask for Face ID
- [ ] Home, the app switcher and the screen locking still end the Unlock
- [ ] Control Center still does not
- [ ] Human test: pull the shade down and up three times with a Workstation open; nothing happens. Then press Home and reopen; Face ID is asked
