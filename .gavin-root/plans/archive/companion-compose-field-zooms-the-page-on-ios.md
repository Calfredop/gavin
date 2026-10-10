---
order: 12288
kind: task
title: Companion: focusing the terminal's compose field zooms the page and it stays zoomed
status: Done
priority: high
complexity: simple
---
Found on a physical iPhone 16 Pro (iOS 27.0), debug build, Demo Workstation, by `companion-iphone-smoke-tests.md`.

**What happens.** Open any terminal in Sessions and focus the compose field (`aria-label="Line to send"`, a `<textarea>` in `app/companion/src/companion/surfaces/PhoneTerminal.svelte` near line 321). The field's computed `font-size` is **13px** (the stylesheet uses `0.8125rem` for it). iOS zooms the page into any text field under 16px when it takes focus. Measured over the Web Inspector:
- before focus: `visualViewport.scale = 1`, layout 402x874
- with the keyboard up: `scale = 1.2313` (exactly 16/13), visible area 326x388
- after blur, keyboard closed: `scale` STILL `1.2313`, visible area 326x710 of 402x874, `innerHeight` 710 instead of 874. The zoom does not recover on its own.

So the first time someone types in a terminal the whole bundle is left magnified and cropped until they pinch it back. The bundle's README already says text fields are kept at 16px "so iOS does not zoom into a field" for `GitCommitBox` and `CodeMirrorView`; the terminal compose field was missed.

**Fix.**
- Make the compose `<textarea>` (and any other text input in the bundle) at least `16px` on touch devices. Sweep every `input`, `textarea` and `select` in `app/companion/` and in the desktop components it imports: an audit on the Demo found `Terminal input` (xterm's hidden textarea, 11px) and `Line to send` (13px) under 16px on this screen alone.
- Belt and braces: add `maximum-scale=1` to the viewport meta in `app/companion/src/app.html` ONLY if the owner accepts losing pinch zoom (it is an accessibility cost); otherwise leave it out.
- Add a guard test that fails when a bundle text field computes under 16px at a phone width, next to the existing seam tests.

**More fields under 16 px, found later the same day.** The rail editor's `Rail name` input computes `13px` (Rails, Edit); see `companion-rail-editor-overflows-the-screen-width.md`. The Git commit `Summary` and `Description`, the New card sheet's title, prompt and both selects, and the CodeMirror editor measure 16 px and are fine. A sweep of every screen is still the right fix.

**Reproduce.** `npm run companion-shell:sync -- ios`, install on a device, open the Demo Workstation, atlas-api, Sessions, "session store", tap the compose field, then dismiss the keyboard. Reset a stuck zoom with a viewport-meta toggle (`maximum-scale=1`, then back).

**Why `1rem` was 13px.** The compose field's own rule already said `font-size: 1rem` with a comment promising 16px. The root is the desktop's bare `font-family: monospace` (`$lib/ui/theme.css`), which a browser sizes at its fixed-pitch default, 13px, so `rem` is 13px in the bundle and no floor at all.

**Done (2026-10-08).** `app/companion/src/companion/surfaces/phone.css` puts one floor under every typed `input`, `textarea` and `select` the bundle draws, its own and the desktop components': `max(16px, 1em) !important`, on every screen (no media query), xterm's hidden input included (it never reads its own font size; raw mode focuses it). The compose field's own `1rem` is gone. `seam/fieldFontSize.test.ts` holds that the floor is 16px+, important, outside any media query, leaves out only untyped inputs, reaches every kind of field in the bundle's and `$lib`'s sources, and that nothing shipped (`$lib`, the bundle, `theme.css`, `xterm.css`) declares an important font size that could out-rank it; mutated four ways, it fails each time. Vitest empties every `.css` import, `?raw` too, so `companion/vite.config.js` now lets `.css?raw` through. `maximum-scale=1` left out: the floor removes the cause, and pinch zoom stays.

Measured in Chrome, the Demo in a 402x874 frame, over 16 screens (app settings and its agent tabs, a custom agent's editor, New card, the card page, the rail editor, the terminal in compose and raw, Git changes and branches, workspace settings): 223 fields; every text, number, `textarea` and `select` 16px (`Rail name`, `Line to send` and `Terminal input` included); only checkboxes and the colour swatch stay at the UA's 13.3px, and iOS does not zoom for those. With the rule removed, the `ComplexityTable` fields fall to 10.6px wherever `pointer: coarse` does not match. CodeMirror is contenteditable, not a field: it keeps `CodeMirrorView`'s own coarse-pointer 16px, since flooring its content alone would misalign it with the line-number gutter.

**Acceptance.**
- [ ] Focusing the compose field leaves `visualViewport.scale` at 1 with the keyboard up and after it closes (only the phone can show this; desktop Chrome never zooms on focus. The field now computes 16px, which is the cause removed: see the human test)
- [x] No `input`, `textarea` or `select` in the bundle computes under 16px at 402px width, except xterm's hidden input
- [x] A test holds that
- [ ] Human test: on the phone, tap into the compose field, type, send, dismiss the keyboard; the page is not magnified
