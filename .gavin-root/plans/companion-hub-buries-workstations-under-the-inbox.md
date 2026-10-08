---
kind: task
title: Companion hub: the Workstations list and Pair a Workstation sit 35 screens below a long inbox
status: To Do
priority: medium
complexity: moderate
---
Found on a physical iPhone 16 Pro (iOS 27.0) by `companion-iphone-smoke-tests.md` (item C1/C2), with the owner's real Workstation connected (195 items waiting).

**What happens.** The hub (`app/companion-shell/src/`) is one scroller, `div.scroll`, holding in order: `WAITING ON YOU` (the combined inbox), `WORKSTATIONS`, then the debug `Device keys` panel. With 195 items the inbox is 26,000 px tall (`scrollHeight` 27,063 against `clientHeight` 763, about 35 screens), so the `WORKSTATIONS` heading is at y=26,687 and the rows that OPEN a Workstation (`MBP16Pro`, `Demo Workstation`) and `Pair a Workstation` are at y=26,724 to 26,886. A flick takes seconds to get there. The only way into a Workstation's UI without scrolling the whole inbox is to tap an inbox item. All 195 rows are in the DOM at once (1,238 nodes); scrolling stayed smooth (worst frame 28 ms), so this is about reach, not speed.

**Why it matters.** Opening a Workstation, pairing a new one and finding a Workstation that is asleep or unreachable are the hub's primary jobs. A person with a busy desk will see a list of hundreds of items and nothing else.

**To do.**
- Put the Workstations on top (a compact row per Workstation with its state and count), with the inbox under it; or give the inbox a collapsed cap ("Show 12 of 195") with a way to expand; or make the Workstations a sticky header.
- Consider grouping the inbox by Workstation and kind with counts, since 195 individual rows is not scannable on a phone.
- Keep `Pair a Workstation` reachable without scrolling.
- Update `companion-shell` tests that read the section order, and the README's hub description.

**Acceptance.**
- [ ] With 195 inbox items, opening a Workstation and starting a pairing each take one tap from the top of the hub
- [ ] The inbox is still fully reachable and still lands on its card or terminal
- [ ] Scrolling stays smooth with the full list
- [ ] Human test: on the phone with a long inbox, open a Workstation without scrolling
