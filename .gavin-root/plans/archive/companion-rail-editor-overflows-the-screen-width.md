---
order: 21504
kind: task
title: Companion rail editor: the Add-a-card dropdown is wider than the screen and the page scrolls sideways
status: Done
priority: medium
complexity: simple
---
Found on a physical iPhone 16 Pro (iOS 27.0, 402 CSS px wide), Demo Workstation, `atlas-api` workspace, Rails, then `Edit` on a rail, by `companion-iphone-smoke-tests.md` (B5).

**Measured with the inspector.**
- `div.scroll` (the editor's vertical scroller) is 494 px wide inside a 402 px column: `scrollWidth 494`, `clientWidth 402`. It scrolls sideways.
- The offender is `select.pick`, the `Add a card…` dropdown, 469 px wide, its right edge at x=494: 92 px of it is off the screen. A second dropdown, `as a new stage into stage …`, is 352 px wide. Both are 29 px tall.
- `Rail name` (the title input of the rail) is 38 px tall and its computed `font-size` is **13px**: iOS zooms the whole page into any input under 16 px when it takes focus, and the zoom does not recover (see `companion-compose-field-zooms-the-page-on-ios.md`, which covers the same sweep). So tapping the rail name will magnify the screen.

**To do.**
- Let the pick controls shrink to the column (`min-width: 0`, `max-width: 100%`, `width: 100%` in the editor's `.pick` rule in the Rails surface, `app/companion/src/companion/surfaces/`), and stack the label above the control at phone width. Long option text (card titles) should truncate in the closed select, not widen it.
- Raise the `Rail name` input to 16 px and every control in that editor to a 44 px target.
- Add the editor to the guard tests: no horizontal overflow at 402 px, no input under 16 px.

**Acceptance.**
- [x] The rail editor does not scroll sideways at 402 px with long card titles in the lists
- [x] Focusing `Rail name` does not zoom the page
- [x] Add, group, move and delete controls are 44 px
- [ ] Human test: open Rails, Edit, add a card from the dropdown on the phone

**Done (2026-10-08).** Each editor select sits in a `.choice` box that takes the column (`min-width: 0`, `max-width: 100%`) and is itself `width: 100%`, `nowrap` + `ellipsis`, and `appearance: none` with its own chevron: WebKit sizes a native select to its font and ignored the 44px `min-height` that was already there, which is why the phone measured 29px. The group's mode select drops under the stage label; the move/remove tools stay beside it. `Rail name` is 16px and 44px. Measured in WebKit at 402x874 with a 100-character title in the picker: scroller and page 402/402, both pickers 352x44, mode select 340x44, every control in the editor 44px tall. Guard: `app/companion/src/companion/surfaces/railEditorFit.test.ts` (fails 7 of 8 on the old source); the stylesheet reader it shares with `seam/fieldFontSize.test.ts` moved to `testing/styleRules.ts`.
