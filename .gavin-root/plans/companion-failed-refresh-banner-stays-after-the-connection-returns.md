---
order: 15360
kind: task
title: Companion: the "cannot be reached" banner and the stale view stay after the connection comes back
status: To Do
priority: medium
complexity: moderate
---
Found on 2026-10-08 by `companion-iphone-smoke-tests.md` (D2), on a physical iPhone 16 Pro. The owner's words: "it would be nice if the ui updates with net status change without having to change section or dismiss the disconnection alert".

**Measured.** A Workstation's UI was open on the Git screen of the Gavin workspace. The connection dropped (airplane mode on), the hub went `unreachable` and retried, and the UI showed `Refresh failed: The Workstation cannot be reached right now.` with a `Dismiss` button. The connection then returned: the hub logged `connected as dev-58ecf56f9cacebe4` and `ready, 215 waiting`, and the shell re-registered the bundle's `git-changed` listens (`workstationEndpoint.ts` does that on each new connection). About 98 s after that the page STILL showed the same banner, with the same Git view, until the owner dismisses it or moves to another section. The bundle is not told the connection came back, so nothing clears the banner or re-reads the data it was showing.

(Context for reading the logs: the owner left the app to toggle airplane mode in the Settings app, which backgrounds Gavin; since the Unlock ended, the shell closed and re-opened the Workstation each time, as designed in `companion-declined-face-id-leaves-the-workstation-ui-on-screen.md`. The banner above was measured on the re-opened page after the hub reconnected, and the owner saw the same thing on the first drop.)

**Why.** The channel is request and answer plus pushed events (`app/companion/README.md`, "The channel"): there is no message that says "the connection is gone" or "the connection is back". The shell answers a call during an outage with an error the bundle shows (`workstationEndpoint.ts`), and listeners are re-registered silently. Surfaces that fetch once on open (Git status, the board, the file tree) never learn they should fetch again. The desktop's `gitState` banner has no auto-clear because the desk's connection never drops.

**To do.**
- Add a connection-state message to the channel: shell to bundle, `connection` with `state: up | down` (and the reason from `hub/live.ts`: unreachable, asleep, desktop-app-not-running). It is a new type in the closed set, so negotiate it through `capabilities` as the README says ("a shell older than its bundle costs a button, never the page").
- In the bundle: on `down`, mark the open view as offline (one thin status line, see `companion-workstation-sleeps-while-its-ui-is-open.md` for the options); on `up`, clear transient connection errors (`Refresh failed: ... cannot be reached`) and re-run the open surface's load (Git `refresh`, the board's `get_board`, the file tree, the Sessions list) once, with the existing in-flight guards.
- Do not clear errors that are not about reachability (a real git failure).
- Cover with a seam test against the Demo Workstation: drop the endpoint, see the banner, restore it, see the banner cleared and one re-read on the wire.

**Acceptance.**
- [ ] After the connection returns, with no tap, the banner is gone and the open screen shows current data
- [ ] While it is down, the screen says so once (not one error per action)
- [ ] A bundle older than the shell, and a shell older than the bundle, both still work
- [ ] Human test: open Git, go offline from Control Center (which does not lock), see the offline state, go online; the view refreshes by itself
