---
order: 18432
kind: task
title: Companion hub: a Workstation that comes back is noticed up to 30 s late, with no way to retry now
status: Done
priority: low
complexity: simple
---
Found on 2026-10-08 by `companion-iphone-smoke-tests.md` (D4), on a physical iPhone 16 Pro. The owner's words: the device "still showed asleep for 30-40s then came back".

**Measured (hub console).** With Remote access off at the desk the hub retried `asleep` Workstation `ws-b8b62138dff5ea6a` after 1, 2, 4, 8, 16 and then 30 s (`trying again in ... ms`). After Remote access was turned back on, the next attempt came up to 30 s later: `connecting`, `connected as dev-58ecf56f9cacebe4`, `ready, 213 waiting`. No Face ID prompt. This is the documented backoff in `app/companion-shell/README.md` ("reconnects a drop from 1 s, doubling to 30 s"), so it works as designed; the cost is that someone watching the phone while they fix the desk waits half a minute after it is fixed.

**To do.**
- Reset the backoff to 1 s when the owner acts: opening the app (foreground with an Unlock already held), tapping the Workstation's row, or a pull to refresh on the hub. Keep the cap for the unattended case.
- Give an `asleep`, `unreachable` and `desktop-app-not-running` row a `Try now` action (the hub shows `Pair again` for a refused Workstation; model it the same way).
- Keep the Relay load in check: a manual retry is rate limited (one per few seconds) and does not reset the cap's count for the background loop.

**Acceptance.**
- [x] Tapping the row, or foregrounding the app, retries within about a second
- [x] The unattended loop still backs off to 30 s and does not spin
- [x] A test in `liveHub.test.ts` covers the reset and the rate limit
- [ ] Human test: turn Remote access off and on at the desk; tapping `Try now` brings the Workstation back at once
