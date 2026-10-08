---
kind: task
title: Companion: focusing the terminal's compose field zooms the page and it stays zoomed
status: To Do
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

**Reproduce.** `npm run companion-shell:sync -- ios`, install on a device, open the Demo Workstation, atlas-api, Sessions, "session store", tap the compose field, then dismiss the keyboard. Reset a stuck zoom with a viewport-meta toggle (`maximum-scale=1`, then back).

**Acceptance.**
- [ ] Focusing the compose field leaves `visualViewport.scale` at 1 with the keyboard up and after it closes
- [ ] No `input`, `textarea` or `select` in the bundle computes under 16px at 402px width, except xterm's hidden input
- [ ] A test holds that
- [ ] Human test: on the phone, tap into the compose field, type, send, dismiss the keyboard; the page is not magnified
