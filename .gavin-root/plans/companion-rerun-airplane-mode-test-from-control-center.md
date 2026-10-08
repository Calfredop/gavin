---
order: 22528
kind: task
title: Re-run the airplane-mode test on the iPhone from Control Center
status: To Do
priority: low
complexity: simple
---
Follow-up to `companion-iphone-smoke-tests.md` item D2. The first run on 2026-10-08 (17:53 to 17:56) was not clean: airplane mode was toggled from the Settings app, which backgrounds Gavin, so the shell ended the Unlock and closed and re-opened the Workstation (by design, see `companion-declined-face-id-leaves-the-workstation-ui-on-screen.md`) instead of letting an open UI ride out an outage.

**Run it again, with a phone on USB and the Workstation Ready.**
1. Hub, MBP16Pro, Gavin workspace, Git screen.
2. Control Center (it does not lock; D8/A8 in the smoke card shows it logs no event), airplane mode ON. Do not open Settings.
3. After about 20 s, tap Fetch. Expect an error, once.
4. Airplane mode OFF from Control Center. Do not tap. Wait up to 40 s.
5. Read the hub console (`xcrun devicectl device process launch --console`) and the page: did the hub reconnect with no Face ID, were the `git-changed` listens re-registered, did the banner clear (it does not today: `companion-failed-refresh-banner-stays-after-the-connection-returns.md`), is the data current?

**Record** on the smoke card the log lines and what the screen said, then tick D2. If `companion-failed-refresh-banner-stays-after-the-connection-returns.md` has landed, the banner should clear and the view refresh by themselves; tick that card's Human test as well.

**Acceptance.**
- [ ] The run above is done from Control Center only
- [ ] The result is on the smoke card, D2 ticked or failed with evidence
