---
order: 28672
kind: task
title: Companion: when a Workstation goes asleep while its UI is open, nothing tells you
status: To Do
priority: medium
complexity: moderate
---
Found on 2026-10-08 by `companion-iphone-smoke-tests.md` (D4), on a physical iPhone 16 Pro paired with the owner's real Workstation.

**Observed (hub console, 17:48 to 17:50).** The owner was INSIDE the Workstation's UI (`BundleView open`) and turned Remote access off at the desk. The hub's state for it went `unreachable` -> `trying again in 1000 ms` -> `asleep` (the Relay has not heard from it), retrying at 2, 4, 8, 16 and 30 s, every attempt `asleep`. Nothing on the phone changed in front of the owner: the Workstation's UI stayed up with its last data, and the owner was not taken anywhere ("when I disabled remote access I wasnt kicked out"). The only close was the owner leaving later. Tapping anything that needs the Workstation fails with `Refresh failed: The Workstation cannot be reached right now.` (seen with the Unlock ended; the same path).

So a person inside a Workstation that has gone away gets stale screens and per-action errors, with no single place that says "this Workstation is asleep, I am trying again". The hub row says `Asleep` and `Its Relay has not heard from it: it is asleep, or remote access is off at the desk.`, but only if they leave to look.

**This is a design choice, not an obvious bug.** Related decision already taken by the owner today: when the Unlock ends, a paired Workstation's UI closes and the phone returns to the hub (`companion-declined-face-id-leaves-the-workstation-ui-on-screen.md`). Sleep and a Wi-Fi blip are different: leaving would throw people out of work on every flaky network, and the bundle keeps its place and its drafts if it stays.

Options:
- A. Stay, and show a persistent banner inside the bundle: `MBP16Pro is asleep. Trying again.` with the reason, turning into `Reconnected` and fading. Needs a channel message from the shell to the bundle (a closed, versioned set; `capabilities` negotiates it) and a bundle-side banner.
- B. Stay for a while (say 60 s), then return to the hub with the row showing why.
- C. Leave at once, like the lock.

**To do.** Get the owner's choice (a Decision is filed on this card), then build it with a pure rule in `app/companion-shell/src/shell/` tested like `unlock/leaveOnLock.ts`, covering `asleep`, `unreachable`, `desktop-app-not-running` and a plain drop, each with its own wording from `hub/live.ts`.

**Acceptance.**
- [ ] A visible, honest state inside the Workstation's UI (or a return to the hub) within a few seconds of the Workstation going away
- [ ] Reconnecting clears it without the owner doing anything
- [ ] The wording for asleep vs unreachable vs desktop-app-not-running is kept apart
- [ ] Human test: turn Remote access off at the desk with the Workstation open; the phone says so; turn it on; it recovers
- [ ] Decision: When a paired Workstation goes asleep or unreachable while its UI is open on the phone, what should the Companion do?
  Options: A) A) Stay, with a persistent banner inside the UI saying it is asleep and retrying B) B) Stay for about 60 s, then return to the hub with the reason C) C) Return to the hub at once, like the lock
