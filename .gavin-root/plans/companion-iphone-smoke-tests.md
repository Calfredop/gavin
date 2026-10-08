---
title: Companion on a real iPhone: smoke test lists
status: In Progress
priority: medium
---
Smoke lists for the Companion shell (`app/companion-shell/`) and its served bundle (`app/companion/`) on a physical iPhone 16 Pro (iOS 27.0) over USB, signed with the owner's team, against the owner's own Workstation. Findings are filed as their own cards (a bug as a `task`, an improvement as a `note`) and linked from the list item that found them. A BLOCKER (the app cannot launch, unlock, or reach any Workstation) stops the run and notifies the owner.

**Who does what.** `[log]` is verified by the agent from `devicectl --console` output (`[gavin-shell]`, `[gavin-unlock]`, `[gavin-hub]` lines) and needs no hands. `[you]` needs the owner's finger, face or eyes on the phone while the agent watches the log. An agent cannot tap an iPhone over USB; the Web Inspector bridge (`ios_webkit_debug_proxy`) can drive the webview but listens on every interface with no bind option, so it is not used until a loopback-only path exists.

**Ground rules.** Mutations (cards, git, files, settings, sessions) go to the **Demo Workstation**, which runs inside the app and touches nothing real. The paired Workstation (`MBP16Pro`, 195 items waiting) is read-only unless an item says otherwise, and then only in the Scratchpad workspace. Name the device by UDID `00008140-000E69260813C01C`.

**Build:** `cd app && npm run companion-shell:sync -- ios`, then `xcodebuild -project companion-shell/ios/App/App.xcodeproj -scheme App -configuration Debug -destination 'id=<udid>' -allowProvisioningUpdates DEVELOPMENT_TEAM=M3DT8FPBFU build`, `xcrun devicectl device install app`, then `devicectl device process launch --console com.gavin.companion`.

## A. Install, launch and Unlock lifecycle
- [x] A1 [log] Debug build signs with the owner's team and installs on the device
- [x] A2 [log] Cold launch reaches the hub: `hub lists N paired`, no JS error in the console
- [x] A3 [log] Keys are hardware: `backing: secure-enclave`, `softwareFallback: false`, `passcodeSet: true`
- [x] A4 [log] Foreground asks for the Unlock once, then the paired Workstation reaches `ready`
- [ ] A5 [you] Press Home, wait 5 s, reopen: the log shows a lock on background and one fresh Unlock prompt, no prompt loop (not done as a separate step; the app was backgrounded and relaunched several times and each foreground asked once. Still to do deliberately)
- [x] A6 [you] Lock the phone, unlock it, reopen: connections dropped on lock and come back after one Unlock (half seen 2026-10-08 15:12: `screen-locked: unlocked -> locked`, the hub went `locked`, then `background`, process survived. Still to see: reopen after unlocking and one fresh prompt.) (2026-10-08 15:15: lock, unlock, one prompt, `ready, 195 waiting`)
- [ ] A7 [you] Cancel the Face ID prompt: the hub stays locked and says why, nothing connects, no retry storm
- [ ] A8 [you] Control Center, the notification shade and an incoming-call banner do NOT lock the Companion
- [ ] A9 [log] Force-quit and relaunch: the pairing is still listed, keys are unchanged
- [x] A10 [log] Find out why the first console session ended with exit 0 right after `ready, 195 waiting`: crash, jetsam, or the owner swiping it away. Check the device crash logs. (2026-10-08: `idevicecrashreport` pulled no App crash and no jetsam event near 15:06 to 15:10; the newest jetsam was 12:52. Not a crash; most likely the app was closed by hand. Not reproduced.)

## B. Demo Workstation (safe for writes)
- [x] B1 [you] Hub: open the Demo Workstation; it opens with no pairing and no network (opened over the inspector's click; bundle webview is `gavin-bundle://demo/`)
- [x] B2 [you] Workspace list shows two projects and the Scratchpad; the gear opens the Workstation's settings; surface strip scrolls sideways and counts waiting agents on Sessions (two projects plus Scratchpad, gear, six surfaces; tab strip 7 px wider than the screen so Blocked/Settings clip and scroll; see Findings)
- [ ] B3 [you] Board: columns render, a card opens as a page, closing returns to its column; move a card; tick a checklist item; file a new card; open the PRD (board pager snaps (x mandatory), card page opens, column dropdown 29 px tall; still to do: move a card, tick a checklist item, new card, PRD)
- [ ] B4 [you] Card: answer a Decision, pass and fail a Human test; Archive and Restore; the phone has no Run button where the desk would show one it cannot run
- [ ] B5 [you] Rails: Start, Pause, Resume, Reset; a card moved to Done moves its rail on; Edit adds and removes a stage (Start ran the idle rail and moved its card to In Progress; Pause gave Resume and Reset; still to do: Resume, Reset, Edit, card to Done)
- [ ] B6 [you] Sessions: New terminal, compose `ls` (paste then Enter), an empty line sends a bare Enter (compose sent `seq 200` and the agent answered; typed by script, not by thumb. Compose focus zooms the page: companion-compose-field-zooms-the-page-on-ios.md)
- [x] B7 [you] Sessions: an agent asking a numbered menu offers digit quick replies; Esc and ^C stay pinned while the bar scrolls sideways (numbered menu gave digit chips; tapping 1 sent it and the agent answered `Redis it is`; Esc and ^C pinned while chips scroll sideways. Chips 36 px tall)
- [ ] B8 [you] Raw mode: Esc, Tab, latched Ctrl, arrows, the More row; the soft keyboard resizes the terminal and the PTY is told the new size
- [ ] B9 [you] Terminal: touch scrolling through history, text selection and copy, pinch does not zoom the page (FAILED: one-finger swipes on the terminal reach `xterm-screen` but move nothing; wheel events do scroll it. companion-terminal-touch-scroll-does-nothing-on-ios.md. Selection and copy not tried)
- [ ] B10 [you] Git: stage and unstage, a file's diff page, commit, create a branch, switch, merge after the question, Push; refusals read in git's words (stage moved files, commit raised the branch from up-1 to up-2; stage buttons are 40x32; still to do: unstage, diff page, branches, merge, push)
- [ ] B11 [you] Files: open a markdown file and a code file, edit, autosave; a picture says it cannot be shown; the edit appears as a change in Git (opened README.md, Formatted/Plain/Edit mode switch is 34 px tall, CodeMirror text is 16 px; still to do: edit and see it in Git, picture refusal)
- [ ] B12 [you] Settings: workspace settings and the Agents hub tabs (This agent, Customs, Complexity, Fallback, Pause); a failed write is said on the screen (Settings opened and scrolled by thumb: 2,798 px, bounce, momentum, worst frame 28 ms, owner confirms it looks fine; colour swatches are 32x32; no setting written yet)
- [x] B13 [you] Add a workspace: browse from the home folder, add `code/weather-station`, it appears in the list (weather-station added via `Add as it is`; the setup question appeared first)
- [ ] B14 [you] Return to the hub from inside the bundle; reopening starts the Demo fresh

## C. Paired Workstation, read-only
- [ ] C1 [log] Hub row shows the Workstation ready, with the same waiting count as the desk's attention inbox (BLOCKED 2026-10-08 16:05: the row reads `Desktop app not running` and stays so across 40 s of polling, although `target/debug/Gavin` (pid 17949, up 1h32) is running and the daemon that dials the phone's Relay (pid 18197, ws://192.168.68.125:8445) is up with 29 clients on daemon-dev.sock. At 15:06 to 15:15 the same row was `ready, 195 waiting`. Unknown whether the desk window was closed or the desk is not attached to that daemon; this Mac denies the accessibility query that would tell)
- [ ] C2 [you] The combined inbox lists items labelled with the Workstation name; the count matches the desk
- [ ] C3 [log] First open of the Workstation's UI shows each step (ask, trust, fetch, verify, install); the signature checks against the dev key; no step errors
- [ ] C4 [log] Second open is a cache hit: no fetch
- [ ] C5 [you] Tapping an inbox item lands on its card or terminal, outlined, once
- [ ] C6 [you] The workspace list, board columns and card counts match the desk
- [ ] C7 [you] Open a real session's terminal without typing: history is there, it scrolls, the desk's tabs and layout are unchanged afterwards
- [ ] C8 [log] Opening and leaving surfaces sends no layout-saving command (`set_workspaces_state`, `set_file_tabs`, `set_board_tabs`, `set_card_tabs`) and never starts a rail
- [ ] C9 [you] Scratchpad workspace only: file a note card, see it on the desk, archive it from the phone
- [ ] C10 [you] Scratchpad workspace only: start a terminal, run `ls`, see it as a tab on the desk's Agents page, end it from the phone

## D. Resilience
- [ ] D1 [you] Wi-Fi off, then on: the Workstation reads unreachable, then reconnects within about 30 s with no prompt
- [ ] D2 [you] Airplane mode during an open bundle: calls answer with an error the bundle shows, none are dropped silently; events resume on reconnect
- [ ] D3 [you] Quit the desktop app: the hub says its desktop app is not running and adds no inbox items; restarting it brings them back (seen by accident 2026-10-08 ~16:00: hub row read `Desktop app not running - It is on, but Gavin's desktop app is not running there, so nothing can answer.` and the inbox read `Nothing is waiting on you.`; the message and the empty inbox are right for that state. Cause not known, see the BLOCKED note)
- [ ] D4 [you] Turn remote access off at the desk: the Workstation reads asleep; on again, it reconnects
- [ ] D5 [you] Mac sleeps and wakes: the phone recovers without a restart
- [ ] D6 [you] Switch Wi-Fi to cellular (Relay must be reachable): see whether a LAN-only dev Relay is unreachable and how that reads

## E. Layout and feel (the owner's judgement)
- [ ] E1 [you] Notch and home indicator clear the hub and the bundle; no content under the Dynamic Island
- [ ] E2 [you] The soft keyboard never covers the compose field or a text field; text fields do not zoom the page
- [ ] E3 [you] Touch targets are thumb-sized in Git rows, the surface strip, the Agents hub and the settings
- [ ] E4 [you] Landscape and a large Dynamic Type setting do not break the hub or the bundle
- [ ] E5 [you] Light and dark appearance both read correctly
- [ ] E6 [you] The compose bar's Send button matches Gavin's styling (the typing prototype's one reported problem)

## F. Notifications (companion-25)
- [ ] F1 [you] Settings, Notifications: the phone asks for permission once and the hub reflects the answer
- [ ] F2 [you] With the app in the background, an agent at the desk reaching "waiting on you" produces a notification, readable on a locked phone
- [ ] F3 [log] Find out whether a debug build signed with this team can receive pushes at all (APNs entitlement, push gateway reachable); if not, say so

## G. Pairing from scratch (needs the owner at the desk; adds a second pairing)
- [ ] G1 [you] Desk: Settings, Remote access, Pair a device shows a QR; the phone scans it, the camera permission prompt reads sensibly
- [ ] G2 [you] The phone and the desk show the same six digits; confirm at the desk; the Workstation appears on the hub
- [ ] G3 [you] Decline at the desk: the phone says so and nothing is stored
- [ ] G4 [you] Revoke the Device at the desk: the phone shows it was refused and does not retry until the next Unlock
- [ ] G5 [log] The scripted pairing (`-GavinPairCode`) works on a device (`pair.sh ios` was written for the Simulator)

## Findings
- `companion-hub-says-desktop-app-not-running-with-the-app-open.md` (BUG, high): the owner confirmed the desk window is open and the hub still reads `Desktop app not running`; the daemon has three ways to say it and no macOS log of which. Also: a test daemon (pid 77252) has run since Oct 5 under /tmp.
- `companion-hub-buries-workstations-under-the-inbox.md` and `companion-touch-targets-and-small-text-sweep.md` carry the hub-layout and tap-size measurements above.
- BLOCKED (list C): see C1. Needs the owner to look at the desktop Gavin window. List C stays unrun until the hub row reads Ready.
Cards filed from this run are linked here as they are found.

- `companion-terminal-touch-scroll-does-nothing-on-ios.md` (BUG, urgent): a one-finger swipe on a terminal does not scroll its history; wheel events do. The owner called this crucial.
- `companion-compose-field-zooms-the-page-on-ios.md` (BUG, high): the compose field is 13 px, iOS zooms to 1.23x on focus and the zoom stays after the keyboard closes.
- Measured but not yet carded (batch into one UI card): hub puts the Workstations list and Pair a Workstation 35 screens below a 195-item inbox (y=26,687 of 27,063); touch targets under 44 px: card Column dropdown 29, quick-reply chips 36, Esc and ^C 36, stage buttons 40x32, Stage all 36, Formatted/Plain/Edit 34, New card and PRD 40, colour swatches 32x32; labels at 8.9 to 10.5 px (section captions, counts, hints); the board's column-tab strip is 409 px wide on a 402 px screen.
- Scrolling measured: hub inbox (27,063 px, 195 rows in the DOM), Settings (2,798 px) and the board pager are smooth; worst frame 28 ms and none over 33 ms. Tooling note: `pymobiledevice3 webinspector js-shell --url` NAVIGATES the page to that URL, so it reloads the hub.

- Driving path found 2026-10-08: `pymobiledevice3 webinspector` (venv in the session scratchpad, `pip install pymobiledevice3`) reaches the shell webview over USB through the Mac's own usbmuxd, and its `cdp` server defaults to `--host 127.0.0.1`, so it opens no LAN port. `js-shell` takes piped input. It lists a page only while the phone is unlocked and Gavin is in front ("try to unlock the page" otherwise). The bundle webview (`gavin-bundle://`) was not listed while the owner said they were "inside the workstation"; unconfirmed whether it was open.
- BLOCKED 2026-10-08 15:17: the phone auto-locked (`screen-locked`, then `background`), so the inspector sees no page. The owner must unlock, open Gavin, and set Settings, Display & Brightness, Auto-Lock to Never for the run; each background or lock also ends the Unlock and needs Face ID again.
- `companion-device-inspector-loopback-only.md` (improvement, found 2026-10-08): `ios_webkit_debug_proxy` listens on every interface, so driving a physical phone's webview exposed it on the LAN; needs a loopback-only path.
