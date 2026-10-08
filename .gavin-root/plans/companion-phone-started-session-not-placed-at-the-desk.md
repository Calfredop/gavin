---
order: 22528
kind: task
title: Companion: a terminal started from the phone does not appear as a tab at the desk
status: To Do
priority: high
complexity: complex
---
Found on 2026-10-08 by `companion-iphone-smoke-tests.md` (C10), on a physical iPhone 16 Pro paired with the owner's own Workstation `MBP16Pro`, desk app open and the hub at Ready.

**What happened.** On the phone: workspace `Scratchpad` (the real one: `no folder`, `no pages` in the workspace list), Sessions, `New terminal`. A real shell opened on the phone (`coalpila ➜ ~`, 49 columns by 45 rows) and ran `seq 200`. The Sessions list shows it under `STARTED FROM THIS PHONE`, which the bundle README names as the fallback shown "until [the desk] places it". The owner looked at the desktop Gavin app and said NO tab for it appeared on the workspace's Agents page. The Sessions screen promised the opposite: "Start one above; the desk shows it too."

**What the code says should happen.** `app/src/lib/core/devicesState.ts` line 145 calls `placeDeviceStartedSession(workspaceId, started.sessionId)` for each started session in a Device's presence; `layoutState.ts` line 3822 applies `devicePresence.ts` `placeDeviceSession`, which returns null (a silent no-op) if the workspace is not in `data.workspaces` or the session is already showing, otherwise `addToAgentsPage`. Protocol/daemon side: companion-16, `presence.rs`.

**Not known (investigate first).**
- Whether the daemon recorded the session in this Device's presence (`started`), and whether the desk window received that push. Another session fixed a bug the same day where the desk's forwarding thread died, so the desk may have been out of the loop for pushes (`project_forwarding_dies_on_interleaved_push`, fix uncommitted on main, daemon half needs a restart). Re-test after that lands and the daemon restarts before blaming placement.
- Whether `Scratchpad` having no pages and no folder matters (it is held, but check `addToAgentsPage` on a workspace with zero pages; the Demo's Scratchpad has one page and the Demo has no desk to test against).
- Which window handles it: the placing code runs in a desk window, and `runsRailsFor`-style gating may pick a different one than the one the owner was watching.
- Whether the owner was looking at the right workspace and window.

**To do.**
- Reproduce with the daemon log from the other session's fix (`daemon-dev.log`, `forwarding:` lines) open, in a workspace that has a page, and again in Scratchpad.
- Add a log line where the desk receives a Device presence push and where it decides not to place.
- If the desk is out of the loop, the phone should say so instead of "the desk shows it too".
- Cover the case in a test: workspace with zero pages, workspace not held, a second push.

**Acceptance.**
- [ ] A terminal started from the phone appears as a labelled tab on the workspace's Agents page at the desk, in a workspace with a page and in one with none
- [ ] When the desk cannot place it, the phone's Sessions screen says so
- [ ] A test covers the zero-page and not-held cases
- [ ] Human test: start a terminal from the phone, see its tab at the desk, end it from the phone and see the tab go
