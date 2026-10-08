---
order: 29696
kind: task
title: Companion: redesign the Workstations hub so "Waiting on you" stops crowding out everything else, and fix its spacing
status: To Do
priority: high
complexity: complex
---
The owner's report, after using the hub on a physical iPhone 16 Pro with their real Workstation: the `WAITING ON YOU` list eats the rest of the hub's features, and the spacing of the buttons is really poor. Found during `companion-iphone-smoke-tests.md`. This is the umbrella for the hub's layout; `companion-hub-buries-workstations-under-the-inbox.md` is its first slice (reachability of the Workstations list and `Pair a Workstation`) and `companion-touch-targets-and-small-text-sweep.md` covers tap sizes and tiny type across the whole bundle. Do not redo those; sequence this card after or around them.

**What the hub is today** (`app/companion-shell/src/shell/surfaces/Hub.svelte` over `hub/inbox.ts`, `hub/workstations.ts`, `hub/live.ts`; measured on 402x874 CSS px, DPR 3, safe area 62 px top and 34 px bottom, debug build). One scroller (`div.scroll`, 763 px visible, 27,063 px of content with 195 items, 210 later the same day, still growing) holding, in order:
1. header: the `Workstations` title (top 78 px, under the notch)
2. `WAITING ON YOU`: the combined inbox, one row per item from every Workstation, rendered all at once (about 400 buttons and links in the scroller, 1,238 DOM nodes in total). Row kinds seen: `Human test`, `Decision`, `Rail stopped`, each with the Workstation name and the item's text; the Human test texts run to several lines, so row heights vary a lot. The `Rail stopped` rows sit at a 63 px pitch.
3. `WORKSTATIONS`: a row per paired Workstation with its state and count, the Demo Workstation, `Pair a Workstation`
4. `Device keys` (debug builds): `Create keys`, `Sign`, `Delete keys` on one row

So the primary jobs (open a Workstation, see that one is asleep or locked, pair another, Unlock) are below the inbox, at y=26,687 and beyond. While locked, the `Locked. Unlock to connect to your Workstations.` line and its `Unlock` button sit in the Workstations section, also far below.

**Spacing: not measured yet.** I measured structure, scrolling and tap sizes (no visible control in the hub is under 44 px) but not the gaps. The owner finds the button spacing poor. First step is to measure it and name what is wrong: the gap between the Workstation rows and `Pair a Workstation` (rows at y=26,724, 26,789 and 26,886 where the Demo row is taller than the paired one), between the three Device-keys buttons, between section headings and the first row, the `Unlock` button against its text, and whether adjacent targets have at least 8 px between them.

**What to build.**
- **Lead with the Workstations.** A compact card or row per Workstation at the top: name, state (Ready, Locked, Asleep, Desktop app not running, Unreachable, Pair again), the waiting count, one tap to open. The locked banner and `Unlock` button become part of that top block (sticky when locked), not a line far down.
- **Give the inbox a summary, not a dump.** A one-line `210 waiting on you` with counts per kind (Decisions, Human tests, Rails stopped, Agents waiting), opening the list on its own screen or a bottom sheet, or capped here ("Show 5 of 210"). Group by Workstation then workspace, filter by kind, and keep a long item's text to two lines with the rest on the card it lands on.
- **Keep the list cheap.** Virtualize or window it so 1,000 items do not mean 1,000 live buttons; keep landing on the item's card or terminal exactly as `onOpenItem` does.
- **One spacing scale.** Pick a scale (8 pt steps), apply it to section gaps, row gaps, button groups and the safe areas, and use the desktop's design tokens rather than local numbers; at least 8 px between adjacent tap targets and 44 px targets.
- **Debug panel out of the way.** `Device keys` collapsed behind a disclosure, or its own screen, in debug builds; never in the way of Pair.
- Pairing, Unlock, the notice line (`unlockNotice`) and the pull to refresh all stay reachable without scrolling.

**Decisions to put to the owner before building** (use `gavin_request_human` kind decision): is the inbox a separate screen, a sheet, or a collapsed section; do Workstations stay a vertical list or become a horizontal strip when there are three or more; does the Demo Workstation keep its row once a real one is paired.

**Acceptance.**
- [ ] With 200+ inbox items, from the top of the hub one tap opens a Workstation, one tap starts pairing, and a locked Workstation's `Unlock` is visible without scrolling
- [ ] The inbox shows a count and per-kind totals, and the full list is one tap away and still lands on each item's card or terminal
- [ ] The measured gaps between the hub's tap targets are at least 8 px and follow one scale; targets are at least 44 px
- [ ] Scrolling the full list holds 60 fps on the iPhone (worst frame under 33 ms), with a bounded number of live rows
- [ ] `companion-shell` tests cover the section order, the capped and expanded inbox, and the locked layout; the README's hub description is updated
- [ ] Human test: on the phone with a long inbox, the hub reads at a glance; open a Workstation, pair, and Unlock without scrolling; spacing feels right
