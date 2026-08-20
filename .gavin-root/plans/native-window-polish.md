---
title: Native window polish (text selection, title-bar + edge double-click)
status: In Progress
priority: medium
---
# Native window polish

Make the custom-chrome window behave like a native macOS window while
keeping `decorations: false` and the CSS traffic lights.

## Why
- App-wide `user-select: none` in `+page.svelte` is unprefixed; WKWebView
  only honors `-webkit-user-select`, so chrome text is selectable.
- `TitleBar.svelte` calls `startDragging()` on every mousedown, so the
  second click of a double-click starts a native drag and nothing zooms.
- Borderless windows get native edge *drag* resize from AppKit, but not
  the native double-click-an-edge-to-expand gesture.

## Steps
- [x] Text selection: prefixed `none` on `html, body`; opt-in `text` for
      inputs/textarea/contenteditable, xterm, CodeMirror, FileEditor
      markdown, CardDetailModal body preview
- [x] Title bar double-click: drop `data-tauri-drag-region` (built-in
      maximize would double-fire), drag only on `detail === 1`, act on
      `mouseup` with `detail === 2` and an unmoved cursor (Tauri's own
      macOS semantics)
- [x] Honor System Settings "Double-click a window's title bar to":
      Rust command reading `NSUserDefaults` `AppleActionOnDoubleClick`
      (Maximize / Fill -> toggleMaximize, Minimize -> minimize, None ->
      nothing); pure TS mapper with tests
- [x] Edge double-click: `NSEvent` local monitor in `mac_window.rs`;
      `clickCount == 2` within ~6px of a frame edge expands that edge to
      `screen.visibleFrame`, corners expand both, Option expands the
      opposite edge too; swallow the handled click. Pure geometry fn
      with Rust unit tests
- [x] Automated verification: `npm run check` (0 errors), `vitest` (463
      pass, 12 new), `cargo test` edge_expand (13 pass, mutation-checked),
      `cargo build` clean, app launches with the monitor installed
- [ ] Manual verification (needs a human -- synthetic clicks are blocked
      without Accessibility permission): chrome text not selectable;
      terminal / editor / markdown / inputs selectable; double-click the
      title bar zooms and un-zooms; double-click each edge and a corner,
      with and without Option, extends to the screen edge

## If the edge gesture does nothing
The monitor relies on AppKit dispatching the second mousedown of an
edge double-click through `sendEvent:` after the first click's resize
tracking ends. If it never fires, the fallback is a thin in-DOM edge
strip in `+page.svelte` calling `setPosition`/`setSize` with the same
`edge_expand` geometry.
