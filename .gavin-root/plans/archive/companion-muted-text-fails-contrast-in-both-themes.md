---
order: 34816
kind: task
title: Companion: the muted text colour fails contrast in light and dark, on top of 9 to 11 px sizes
status: Done
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

**Outcome.**
- **Which it was:** no opacity anywhere. `--text-subtle` was the token: #888 on white is exactly the 3.54:1 measured, and #666 on #1e1e1e the 2.90:1 (#666 is the light theme's `--text-muted`, which is why it looked like the common thread). The Board's 2.37:1 was the shown column's count taking its tone from `--accent`, a fill (#4a9eff on the #eee strip); its 3.03:1 in dark was `--text-subtle` on `--surface-sunken`.
- **Tokens, for everyone:** every text role now clears 4.5:1 on every `--surface-*` of its theme, including the tints. The hardest surface is the one nearest the text: #ddd (selected) in light, #3a3a3a (overlay, selected) in dark, which is where a modal's captions sit. Dark: `--text-muted` #999 to #bbb, `--text-subtle` #666 to #a6a6a6. Light: `--text-muted` #666 to #444, `--text-subtle` #888 to #5e5e5e. Two more roles were under on one surface each and moved a step: light `--accent-text` (#4a6a8a to #42617e, was 4.16:1 on selected) and dark `--danger-text` (#e08a8a to #e69696, was 4.43:1 on overlay). Done by retuning the primitives grey-7, grey-9, blue-2 and red-4, which nothing else reads except blue-2 (dark `--border-accent`, light `--accent-hover`, both a shade darker now). The cost: muted and subtle sit closer together than before in both themes, because a 4.5:1 floor on #3a3a3a leaves only #a3a3a3 to #eee for three steps of text.
- **Now, computed from theme.css (light / dark):** Git folder prefix and Sessions captions 6.48 / 6.85; Board count 5.59 / 7.15; shown In Progress count 5.58 / 7.03; shown Done count 8.53 / 8.97. Worst pair anywhere: subtle on selected, 4.77 / 4.67.
- **Text on fills:** the Board's count takes `--accent-text`/`--success-text` (`--tab-tone-text`), and the underline keeps the vivid fill. The hub's "Waiting on you" and "Human test" label was `--accent` too (2.75:1 on white); the hub measured clean only because nothing was waiting. It is `--accent-text` now. The desktop components the phone draws had the same problem: `DecisionsItemRow` (picked option and primary action in `--accent`), `GitCommitBox` (the pushed warning in `#b8860b`, 3.25:1 on white), `FallbackChainEditor` (all dark-theme literals: `#ccc` labels are 1.6:1 on white), `IconButton`'s coloured tones under the pointer and when active (`--accent`, `--danger`, `--success`, `--warning`; the variant's background or border still marks hover), and dead `#f87171`/`#fbbf24` fallbacks in `CustomsEditor`. All on text roles now.
- **Captions:** already 11 px or more from the sweep card's 16 px root (`phone.css`): Sessions captions 11 px, Board counts 12 px.
- **Guards:** `seam/themeContrast.test.ts` (bundle suite, the one that can read theme.css as text) parses theme.css, follows every role to its colour per theme and fails on any text role under 4.5:1 against any surface; it also walks the bundle's surfaces and every desktop component they import and fails on any `color:` that is not a text role, directly or through a custom property the component sets. `shell/surfaces/textColours.test.ts` holds the hub the same way. Shared reader: `app/companion/src/companion/testing/textColours.ts`. Checked to fail against the committed theme.css: 27 pairs, including the 3.54, 2.90 and 3.03 above.
- **Left out, on its own card:** `--text-inverted` (white on the accent, warning and success fills, 1.9 to 2.75:1 in dark, 2.75:1 for accent in light) and 127 literal or fill text colours in 28 desktop-only components, mostly the setup wizard: `theme-text-on-fills-and-literal-colours-contrast.md`.

**Acceptance.**
- [x] The Git folder prefixes, Sessions captions and Board badges measure 4.5:1 or better in both themes (computed from the tokens they are drawn in, not re-measured on the iPhone; the human test is that)
- [x] A test holds every text token pair (`--text-inverted` is on a fill, not a surface, and is held by the follow-up card)
- [x] The hub stays at 0 failures (its text takes only text roles, held by its own guard)
- [ ] Human test: outdoors or at low brightness, the secondary text is readable
- [ ] Human test: On the desktop, in light and dark, secondary text (captions, hints, folder prefixes) still reads as a step below primary text now that muted and subtle sit closer together
