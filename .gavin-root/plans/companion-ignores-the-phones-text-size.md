---
order: 32768
kind: task
title: Companion: the phone's text size setting does nothing, and the base text is 13 px
status: To Do
priority: medium
complexity: moderate
---
Found on a physical iPhone 16 Pro (iOS 27.0) by `companion-iphone-smoke-tests.md` (E4, large Dynamic Type), requested by the owner as a layout check.

**Measured.** Computed styles read over the Web Inspector on the hub (`capacitor://localhost`) and on an open Workstation's UI (`gavin-bundle://...`), before and after the owner set Settings, Accessibility, Display & Text Size, Larger Text to the largest accessibility size (Larger Accessibility Sizes on):

| | before | after |
|---|---|---|
| root `font-size` | 13 px | 13 px |
| body | 16 px, `monospace` | 16 px, `monospace` |
| hub title (`h1`) | 13 px | 13 px |
| hub section caption (`h2`) | 9.75 px | 9.75 px |
| bundle caption | 8.94 px | 8.94 px |
| buttons | 11 to 11.4 px | 11 to 11.4 px |
| `-webkit-text-size-adjust` | 100% | 100% |

Nothing changed, in either webview. The layout also did not change (no overflow, same 402x874 viewport). So a person who needs larger text on their phone gets the same 9 to 13 px interface as everyone else. WKWebView only follows Dynamic Type for text that opts in (a system font style such as `font: -apple-system-body`, or an explicit `-apple-system` size keyword); the pages use fixed `rem`/`px` on a 13 px root, the desktop's dense scale, and explicitly set `text-size-adjust: 100%`.

**This is the product's accessibility floor.** It is also the reason the captions in `companion-muted-text-fails-contrast-in-both-themes.md` and `companion-touch-targets-and-small-text-sweep.md` are so small: the phone inherits a desktop type scale.

**To do.**
- Give the shell and the bundle a phone type scale: a base size that follows the system text size. On iOS the clean route is reading the content size category natively (`UIApplication.shared.preferredContentSizeCategory`, with `UIContentSizeCategory.didChangeNotification`) and handing a scale factor to the web layer, which sets the root font size (`html { font-size: calc(13px * var(--text-scale)) }`); or `font: -apple-system-body` as the root on iOS, which WKWebView scales. Android: `WebSettings.setTextZoom` follows the system font scale; check it too.
- Make every component's size relative to the root (`rem`) so the scale reaches all of it; flag any `px` text sizes in `app/companion/` and the desktop components it imports (they are the ones that will not scale).
- Re-run the layout sweeps at the largest scale: lists must wrap, not overflow (`DIV.strip`, the surface tabs, the Git rows, the quick-reply bar), and tap targets must grow with the text.
- Decide the floor: no text under 11 px at the default size (shared with the sweep card).

**Acceptance.**
- [ ] With Larger Text at the largest size, body text on every screen at least doubles from its default and nothing overflows the width
- [ ] At the default size the smallest caption is at least 11 px
- [ ] The scale follows changes without a restart
- [ ] A guard test lists `px` font sizes in the bundle's own CSS
- [ ] Human test: set the largest text size and use the hub, the board and a terminal
