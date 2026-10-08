---
kind: task
title: Companion: swiping the terminal does not scroll its history on a real iPhone
status: To Do
priority: urgent
complexity: complex
---
Found on a physical iPhone 16 Pro (iOS 27.0), debug build, Demo Workstation, by `companion-iphone-smoke-tests.md` (items B9 and C7). The owner called terminal scrolling crucial.

**What happens.** Open the Scratchpad workspace's shell in Sessions and run `seq 200`. The screen shows lines 157 to 200; the other 155 lines are scrollback. Swiping on the terminal does NOTHING. A touch recorder on the page (capture-phase `touchstart/move/end`, a `MutationObserver` on `.xterm-rows`, and `requestAnimationFrame` timing) caught four real swipes by the owner, all targeting `div.xterm-screen`:

| swipe | moves | distance | row changes | frame p95 / worst |
|---|---|---|---|---|
| 1 | 39 | -142 px | 0 | 18 / 26 ms |
| 2 | 8 | -127 px | 0 | 17 / 18 ms |
| 3 | 10 | +186 px | 0 | 17 / 18 ms |
| 4 | 19 | +1 px | 0 | 17 / 30 ms |

The visible rows stayed `157 .. 200` throughout. The page did not scroll either (`scrollingElement.scrollTop` 0). So the touches arrive, nothing consumes them, and frames are not the problem.

**The same history IS reachable.** Wheel events dispatched at `.xterm-screen` scroll it: three `WheelEvent`s took the visible rows `157..200` to `148..191` to `139..182` and back to `157..200`. So the buffer and xterm's wheel path are fine; only the touch path is dead.

**Facts about the setup.**
- `@xterm/xterm` is `6.1.0-beta.304` (`app/package.json`). The companion README chose 6.1 because "6.0's touch scrolling is broken on iOS", and the typing-prototype comment on `companion.md` lists "touch scrolling on xterm 6.1.0-beta.304" under "Not verified until the human test". This is that test, and it fails in the real bundle on iOS 27.0.
- DOM renderer (no `<canvas>` under `.xterm`), `touch-action: auto` on every ancestor from `.xterm-screen` to `body`, nothing in the page sets a touch handler. `PhoneTerminal.svelte` only sets `touch-action` at lines 461 (`pan-x`, the quick-reply bar) and 554 (`manipulation`).
- `.xterm-viewport` has `overflow-y: scroll` but `scrollHeight == clientHeight == 630` even with 155 lines of scrollback, so the native scroll area carries no extra height; xterm 6 scrolls through its own `.xterm-scrollable-element`.
- Synthetic `TouchEvent`s dispatched from script did not scroll it either, but those are untrusted, so that proves nothing.
- Android is untested.

**To do.**
- Find which layer drops the touch: xterm 6.1.0-beta.304's gesture handling on iOS 27.0, or something in the bundle (the `.term` wrapper has `overflow: hidden`; the shell's webview settings; `allowsBackForwardNavigationGestures`). Bisect on the bench (`prototypes/companion-typing` on branch `prototype/companion-typing` passed its owner test on an iPhone) against the real bundle.
- Fix it, or give the terminal its own touch-to-scroll (map a vertical drag to `term.scrollLines`, with momentum), plus a visible way to jump to the bottom.
- Add the touch recorder to the repo as a device script so this can be re-measured.

**Acceptance.**
- [ ] A one-finger vertical swipe on the terminal scrolls its history on the iPhone, in both directions, with momentum, without scrolling the page
- [ ] The touch recorder shows row changes for each swipe and no frame over 33 ms
- [ ] Selecting text and the compose bar still work
- [ ] Human test: swipe through `seq 200` output on the phone and flick back to the bottom
