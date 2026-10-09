---
order: 26624
kind: task
title: Companion: redesign the Workstations hub so "Waiting on you" stops crowding out everything else, and fix its spacing
status: Done
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

**Outcome.**

*Built on the recommended answer to each decision below, while they wait:* the full list is its own screen, Workstations stay a vertical list, and the Demo keeps a one-line card, last, once a real one is paired. Each alternative is a small change in `Hub.svelte` / `hub/workstations.ts`; answer and it gets switched.

*Spacing, measured* (headless WebKit, 402x874, the hub mounted with a 210-item fixture; `getBoundingClientRect` on every visible target). Before: nine local numbers and no scale. Rows padded 14px, Pair and the notes 16px, the header 12px. Section headings sat 18px over their rows and 6px under, and the keys panel was 20 over 24. **Every inbox row and Workstation row touched the next (gap 0, a hairline between two targets: 134 adjacent pairs under 8px)**, Pair started 16px under the Demo row, and Unlock sat 12px from its own text. After: one scale, `--space-half/1/2/3/4` = 4/8/16/24/32px in `companion/src/companion/surfaces/phone.css`. Cards and buttons sit 8px apart, sections 24px apart, there is a 16px gutter, and the bottom inset plus 24px at the foot. 0 pairs under 8px on the hub, locked, three-Workstation and list screens; every target is 44px or more.

*Layout* (`Hub.svelte`): the Unlock banner first, `position: sticky` at the top, with a primary `Unlock`. Then the hub's own lines, then a card per Workstation (state, `N waiting` pill, `Try now`, the summary only when it says what to do), then a full-width `Pair a Workstation`. Then `210 waiting on you`, the totals per kind (`60 human tests · 60 rails stopped · …`), the first 3 items (two lines at most), and `Show all 210`, then `Device keys` closed behind a `<details>`. With 210 items everything through `Show all` is on the first screen. That is 7 live targets and 58 DOM nodes, against 213 and 1,297 before.

*Full list* (`InboxList.svelte` over `hub/inboxView.ts`): a back control to the Workstations, kind filters with counts, and grouping by Workstation then workspace. The list is windowed: entries have fixed heights read off hidden probes (so they follow the text size), and only those within a screen of the view are drawn. It holds 27 live rows at most for 210 and for 1,000 items. Scrolling it at 90 px/frame in WebKit gave p50 17 ms and a worst frame of 26–29 ms; that is desktop WebKit, not the iPhone. A tap 50,000px down still lands on its exact item through the unchanged `openItem`. Visit failures and `Opening…` show over the list too, so a tap there is never silent.

*Not here:* workspace headings need the desk to send `workspaceName`. The shell reads it as an optional field and heads by it; an id is no heading, so today the workspaces group with no heading. Filed as `companion-attention-items-carry-workspace-name.md`, since it touches protocol, daemon and host. The back gesture does not leave the list on either platform (no `@capacitor/app`; iOS swipe off), the same as the pairing sheet.

*Guards:* `surfaces/hub.test.ts` renders the hub (`svelte/server`): the section order, a capped and a short and an empty inbox, the full list grouped and filtered with a bounded row count at 5,000 items, and the locked layout with its sticky banner. `surfaces/spacing.test.ts` checks that every padding/margin/gap in the hub's four components is on the scale and that each container of several targets keeps a step between them. A stray `12px` makes it fail. `hub/inboxView.test.ts` covers the totals, the preview, the grouping and the windowing. To draw components in the shell's vitest, `vite.config.js` inlines `@lucide/svelte` and lets `.css?raw` through, as the bundle's does, and `svelte.config.js` skips the style preprocess under vitest (vitest 1's vite 5 config breaks vite 6's `preprocessCSS`; there is no postcss or `<style lang>`, so it changes nothing).

**Acceptance.**
- [x] With 200+ inbox items, from the top of the hub one tap opens a Workstation, one tap starts pairing, and a locked Workstation's `Unlock` is visible without scrolling
- [x] The inbox shows a count and per-kind totals, and the full list is one tap away and still lands on each item's card or terminal
- [x] The measured gaps between the hub's tap targets are at least 8 px and follow one scale; targets are at least 44 px
- [ ] Scrolling the full list holds 60 fps on the iPhone (worst frame under 33 ms), with a bounded number of live rows
- [x] `companion-shell` tests cover the section order, the capped and expanded inbox, and the locked layout; the README's hub description is updated
- [ ] Human test: on the phone with a long inbox, the hub reads at a glance; open a Workstation, pair, and Unlock without scrolling; spacing feels right
- [ ] Decision: Where does the full Waiting-on-you list live once the hub leads with the Workstations? (The hub always keeps a one-line count with per-kind totals.)
  Options: A) Hub shows the summary + first 3 items; 'Show all 210' opens the list on its own screen with a back button, kind filter and grouping (recommended) B) Collapsed section on the hub: summary + first 5, 'Show all' expands in place C) Bottom sheet over the hub
- [ ] Decision: With three or more Workstations, do they stay a vertical list or become a horizontal strip at the top of the hub?
  Options: A) Vertical list of compact cards, whatever the count: the state words (Desktop app not running) need the width (recommended) B) Horizontal swipeable strip once there are 3 or more
- [ ] Decision: Does the Demo Workstation keep its row once a real Workstation is paired?
  Options: A) Keep it, last and compact: one line, no description (recommended) B) Move it to a small 'Open the Demo Workstation' link at the foot of the hub C) Hide it once any Workstation is paired
- [ ] Human test: On the iPhone with a long inbox (debug build after companion-shell:sync): the hub reads at a glance; open a Workstation, Pair, and (after backgrounding) Unlock without scrolling; spacing feels right; Show all scrolls smoothly to the bottom and an item there lands on its card
