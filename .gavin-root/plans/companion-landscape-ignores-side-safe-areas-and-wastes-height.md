---
kind: task
title: Companion in landscape: content ignores the side safe areas and the chrome leaves a quarter of the screen for work
status: To Do
priority: medium
complexity: moderate
---
Found on a physical iPhone 16 Pro (iOS 27.0) by `companion-iphone-smoke-tests.md` (E1, E4), debug build, the owner's real Workstation, the Gavin workspace's Git screen, phone turned sideways.

`Info.plist` lists `UIInterfaceOrientationLandscapeLeft` and `LandscapeRight` under `UISupportedInterfaceOrientations`, so landscape is a supported orientation, not an accident.

**Measured over the Web Inspector (viewport 874x402 CSS px, DPR 3).**
- `env(safe-area-inset-*)` is `top 0, right 62, bottom 20, left 62`. The Dynamic Island and the rounded corners live in those 62 px bands.
- Content ignores them. The leftmost visible controls start at x=0 (`Changes` tab) and x=8 (file rows `?` and `M`); the rightmost end at x=874 (`Branches` tab) and x=866 (the `+` stage buttons). The page's header and tab bands are full width, `x[0,874]`. So on the side with the Island, the first controls and the first characters of file rows sit under it or the corner radius, and on the other side the stage buttons sit in the corner.
- Vertical space: `HEADER.bar [0,49]`, `DIV.tabs [49,94]`, `DIV.head [94,142]`, then the Git toolbar and `HEADER.section-head [244,288]`; the scrolling list, `DIV.changes`, is `[244,402]`: **158 px** for 1,987 px of content. About 61% of the screen height is chrome, so one or two file rows are visible at a time.
- No horizontal overflow, nothing cut off at 402 px height otherwise, no zoom. Portrait is fine (see the other smoke findings).

**To do.**
- Apply the side insets to the bundle's page frame (`padding-left/right: max(env(safe-area-inset-left), 0px)` on the root layout in `app/companion/`, and the same in the hub in `app/companion-shell/src/`), so every surface, fixed bar and sheet respects them. Check `viewport-fit=cover` pages that position `fixed` elements (the New card sheet, dialogs) too.
- In landscape, collapse the chrome: fold the workspace header and the surface strip into one row (a compact bar), hide the Git toolbar's secondary row, or make the header scroll away with the list; aim for at least about 60% of the height for the working area.
- Add landscape cases to the guard tests where they can run (a 874x402 viewport with insets 0/62/20/62 in the bundle's seam tests) and note in the README which screens are expected to work sideways. If landscape is judged not worth the work for v1, lock the phone to portrait in `Info.plist` and say so; that is an acceptable answer, but decide it.

**Acceptance.**
- [ ] In landscape no text or control starts or ends inside the 62 px side insets, on the hub and on every bundle surface
- [ ] The working area on Git, Board, Files and Sessions is at least about 60% of the screen height
- [ ] Or: the app is locked to portrait and the README says so
- [ ] Human test: turn the phone sideways on the Git, Board and terminal screens; nothing is under the Island or the corners and a list shows several rows
