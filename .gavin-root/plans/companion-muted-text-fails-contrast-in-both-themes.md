---
order: 34816
kind: task
title: Companion: the muted text colour fails contrast in light and dark, on top of 9 to 11 px sizes
status: To Do
priority: medium
complexity: simple
---
Found on a physical iPhone 16 Pro (iOS 27.0) by `companion-iphone-smoke-tests.md` (E5), on the owner's real Workstation, measured over the Web Inspector.

**Method.** For every visible leaf text node, foreground against the nearest opaque background, WCAG relative luminance contrast, under `data-theme="light"` and `"dark"` (flipped locally on the page and restored, nothing sent to the Workstation). WCAG AA asks 4.5:1 for text under about 18 px.

| screen | text | light | dark | size |
|---|---|---|---|---|
| Git changes | the folder prefix of every file row (`.gavin-root/plans/`) | 3.54:1 | 2.90:1 | 11.4 px |
| Sessions | `WORKSPACE AGENT`, `PAGE 1`, `AGENTS`, `· gavin` | 3.54:1 | 2.90:1 | 8.9 to 10.6 px |
| Board | the count badges (`16`, `34`, `7`) | down to 2.37:1 | 3.03:1 | 9.8 px |

12 of 63 visible text items on the Git screen, 9 of 31 on Sessions and 2 or 3 of 84 on the Board fail. The common thread is the dimmed text colour `rgb(102, 102, 102)` (`#666`); on white that is 5.7:1 on its own, so the light-theme failures come from a second dimming (opacity or a lighter token) stacked on small caps captions. The hub (`capacitor://localhost`) has no failures in either theme (32 items, 0 low).

These are the same captions the `companion-touch-targets-and-small-text-sweep.md` card lists as under 11 px. Small and low-contrast together is what makes a phone in daylight unreadable.

**To do.**
- Find the muted-text token in `app/src/lib/ui/theme.css` (the desktop's; the bundle imports it) and the opacity applied on top in the Git row, Sessions list and board badge components; give the phone at least 4.5:1 in both themes, ideally by changing the token for everyone, since the desktop has the same ratios at 11 px.
- Raise captions to 11 px or more (shared with the sweep card; do them together).
- Add a theme-contrast guard: a unit test that computes the ratio of each text token pair in `theme.css` against its surface for both themes and fails under 4.5:1 for small text.

**Acceptance.**
- [ ] The Git folder prefixes, Sessions captions and Board badges measure 4.5:1 or better in both themes
- [ ] A test holds every text token pair
- [ ] The hub stays at 0 failures
- [ ] Human test: outdoors or at low brightness, the secondary text is readable
