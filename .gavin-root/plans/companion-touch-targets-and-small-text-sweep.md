---
order: 24576
kind: task
title: Companion: sweep touch targets under 44 px and text under 11 px
status: To Do
priority: medium
complexity: moderate
---
Found on a physical iPhone 16 Pro (iOS 27.0, 402x874 CSS px, DPR 3), debug build, Demo Workstation, by `companion-iphone-smoke-tests.md` (E3). Measured with an inspector script that lists every visible `button, a, [role=button], [role=tab], input, select, textarea, summary, [onclick]` and its bounding box, per screen. Apple's guidance is 44x44 pt.

**Under 44 px (width x height), by screen**
- Surface strip, every workspace screen: `Git` tab 41 wide.
- Board: `New card` 99x40, `PRD` 67x40, a count control `3` 34x20; the column-tab strip (`div.strip`) is 409 px wide on a 402 px screen, so the `Blocked` tab is clipped by 7 px and the strip scrolls.
- Card page: the `COLUMN` select 374x29.
- Terminal: quick-reply chips 159x36, `Esc` 41x36, `^C` 35x36.
- Git: every stage and unstage button 40x32, `Stage all` 79x36, `Unstage all` 91x36, the commit `Summary` field 378x37.
- Files, file page: `Formatted` 106x34, `Plain` 72x34, `Edit` 64x34.
- Settings: the eight colour swatches 32x32, number inputs 44x32.
- Every confirm dialog (`AppDialog`): `Cancel` and the action button are 26 px tall: seen on End session and on Reset rail. Checklist rows are fine (the whole `label` is 374x45; only the 22 px box itself is small).
- Rail editor and New card sheet selects: 29 to 37 px tall.
- End-session confirm (terminal, a destructive choice): `Cancel` and `End session` are both 26 px tall, side by side.
- Git commit box: the `Amend` checkbox input is 20x20 (check the label around it).
- Add a workspace: breadcrumb `/` 18x44, `demo` 37x44.

The bundle README says `GitFileRow` actions are shown "at a fingertip's size", `ColourPicker`'s swatches and `FallbackChainEditor`'s controls are "fingertip-sized" and `FileEditor`'s mode switch is "thumb-sized". They measure 32 to 40 px here, so either the media query that grows them does not match inside the bundle webview or the target is a different number. Find out which.

**Text under 11 px** (computed `font-size`, visible): section captions such as `WORKSPACE`, `TERMINAL`, `STAGE 1`, `UNSTAGED`, `TASK`, `TITLE`, `COLUMN`, `PROMPT`, `DEMO`, `WORKSPACE AGENT` at 8.9 px; counts and hints at 9.4 to 9.8 px; workspace paths, `To Do`, `New card`, `PRD`, `Esc`, `^C` and tab labels at 10.6 px. That is at or below what iOS draws for its smallest captions.

**To do.**
- Decide the targets (44 px minimum, or a padded hit area where the visible control must stay small) and fix the rows above; check whether the phone media query reaches the desktop components inside the bundle.
- Raise the smallest captions to 11 px or more, and make sure Dynamic Type / `-webkit-text-size-adjust` is not fighting the sizes.
- Add a guard test in the bundle suites that fails on a visible interactive element under 44 px at a 402 px width (allow-list the exceptions).

**Acceptance.**
- [ ] The inspector audit lists no visible interactive element under 44 px on board, card, Sessions, terminal, Git, Files and Settings
- [ ] No visible caption under 11 px
- [ ] The guard test holds that
- [ ] Human test: thumb through each surface; nothing needs a second try
