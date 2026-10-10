---
order: 32768
kind: task
title: Companion: the phone's text size setting does nothing, and the base text is 13 px
status: Done
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

**Outcome.**
- **iOS, no native code:** `app/companion/src/companion/surfaces/textScale.ts` puts a hidden probe in `font: -apple-system-body` on the page and writes its size over 17 to the root as `--text-scale`. phone.css sets `html { font-size: calc(16px * var(--text-scale, 1)) }` and `body { font-size: 1rem }`, so every `rem` and every desktop `em` follows. Measured on the iOS 27 Simulator (Safari's WKWebView, then the shell itself): the probe is 14 px at the smallest size, 17 at the default, 28 at the first accessibility size and 53 at the largest (scale 3.118, root 49.9 px). WebKit restyles a system font the moment the setting changes, so a ResizeObserver on the probe hears it; `visibilitychange` re-reads as a fallback. The hub's layout and the bundle's both call it on mount, and since it is the page's own script it needs nothing from the bundle webview's seal.
- **Android:** WebView already follows the system font scale (the old build's hub went from 13 px to 26 px at font scale 2.0), but only because the activity was recreated, which reloads the page. Both activities now take `fontScale` in `configChanges` and set `setTextZoom(fontScale * 100)` (`SystemTextSize.java`) at creation and on a change. Measured on an emulator: 16 px goes to 32 px (not doubled to 64) and the page is not reloaded. The bundle's activity runs the same code but was not opened on the emulator.
- **px sizes:** the bundle's own field sizes went from `16px` to `max(16px, 1rem)`. The desktop components it draws had four field sizes (ComplexityTable, FallbackChainEditor, DecisionsItemRow), now `max(16px, 1rem)`, and GitCommitBox's `11px` warning, now `calc(11px * var(--text-scale, 1))`, which the desktop app never sets. The one size left fixed is ShortcutHint's 10px badge, which only appears while ⌘ is held. A `<button>` no component sizes took the browser's fixed control size (13.33 px) and never scaled: phone.css gives such a button the same size times the scale. The terminal grows with the text up to 2× (13 to 26 px, about 25 columns), because past that a full-screen program laid out for the PTY's width stops fitting (`TERMINAL_SCALE_MAX`).
- **Layout at 3.118 (headless Chrome as an iPhone 16 Pro, the real `textScale.ts` driven by a stubbed probe):** workspace list, board, card, Sessions, terminal, Rails, Git, Files, Review, Decisions, Settings, New card and the hub all stay at 402 px wide. Fixed along the way: the header's back label drew over the title (now truncates, at most 40% of the bar); Git's Fetch/Pull/Push and Changes/Branches ran off the screen, and the status letter overlapped the path; Rails' "Organize with …" ran off the screen; the hub's Workstation name squeezed to "De…" (the tag and state now wrap under it). The root cause of most of these is general: phone.css's `min-width: 44px !important` floor replaces a flex item's automatic minimum, so a `flex: 1 1 0` button shrinks below its label. Those rows now wrap with content-based flex bases. The column strip and the surface tabs still scroll sideways, as they do at the default size. Tap targets grow with their text, and the 44 px floor stays a floor. Icons and status-badge glyphs are sized in px by prop and do not scale.
- **Floor:** at the default size the smallest visible text is 11 px (the DEMO tag) on every screen swept.
- **Guards:** `seam/textScale.test.ts` holds the root, the body, the button default, the mount and the terminal's size, and lists every px font size in what the bundle draws (its surfaces, phone.css and each desktop component inside them, through `testing/textSizes.ts`). Each must be a floor that grows, or it goes on a named list with the reason. Checked to fail when a field goes back to `16px`. The shell's `surfaces/textScale.test.ts` holds the same for the hub.

**Acceptance.**
- [x] With Larger Text at the largest size, body text on every screen at least doubles from its default and nothing overflows the width
- [x] At the default size the smallest caption is at least 11 px
- [x] The scale follows changes without a restart
- [x] A guard test lists `px` font sizes in the bundle's own CSS
- [ ] Human test: set the largest text size and use the hub, the board and a terminal
