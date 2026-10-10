---
order: 26624
kind: task
title: Companion: swiping the terminal does not scroll its history on a real iPhone
status: Done
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

**Confirmed on a real PTY (2026-10-08, same session).** Against the owner's real Workstation, Scratchpad workspace, `New terminal` (a real shell on the Mac, 49 columns by 45 rows), `seq 200`: two swipes by the owner (+133 px over 4.2 s, -18 px over 2.4 s), both on `xterm-screen`, 0 row changes, rows still `157 .. 200`, frame p95 18 and 19 ms, worst 29 ms. The owner reports "fails to scroll". So it is the component and the device, not the Demo's scripted terminal. Other surfaces scroll by finger without trouble on the same phone (hub inbox, Settings, board columns, board pager), which isolates it to the terminal.

**The same history IS reachable.** Wheel events dispatched at `.xterm-screen` scroll it: three `WheelEvent`s took the visible rows `157..200` to `148..191` to `139..182` and back to `157..200`. So the buffer and xterm's wheel path are fine; only the touch path is dead.

**Facts about the setup.**
- `@xterm/xterm` is `6.1.0-beta.304` (`app/package.json`). The companion README chose 6.1 because "6.0's touch scrolling is broken on iOS", and the typing-prototype comment on `companion.md` lists "touch scrolling on xterm 6.1.0-beta.304" under "Not verified until the human test". This is that test, and it fails in the real bundle on iOS 27.0.
- DOM renderer (no `<canvas>` under `.xterm`), `touch-action: auto` on every ancestor from `.xterm-screen` to `body`, nothing in the page sets a touch handler. `PhoneTerminal.svelte` only sets `touch-action` at lines 461 (`pan-x`, the quick-reply bar) and 554 (`manipulation`).
- `.xterm-viewport` has `overflow-y: scroll` but `scrollHeight == clientHeight == 630` even with 155 lines of scrollback, so the native scroll area carries no extra height; xterm 6 scrolls through its own `.xterm-scrollable-element`.
- Synthetic `TouchEvent`s dispatched from script did not scroll it either, but those are untrusted, so that proves nothing.
- Android is untested.

**Root cause (2026-10-08).** The phone never ran xterm 6.1. `app/package.json` and `app/package-lock.json` pin `@xterm/xterm` `6.1.0-beta.304` (commit `54666d10`), but `app/node_modules` in the shared checkout was never reinstalled after that commit: it held `6.0.0`, with `addon-fit` `0.11.0` and `addon-web-links` `0.12.0` (`node_modules/.package-lock.json` agrees). Those three are the only packages out of step with the lockfile. Both bundles the phone can run are built from that tree: the Demo bundle the shell embeds (`companion-shell:sync` → `companion:build`) and the bundle a Workstation serves (`stage-companion.mjs` → `companion:build`). The `companion/build` from 17:28 today carries xterm's gesture module but not 6.1's `handleTouchScroll`, so it is 6.0.0.
- 6.0.0 has no touch-to-scroll at all: its `Gesture` is only used by `widget.ts` to IGNORE targets. 6.1 adds `Gesture.addTarget(screenElement)` and `MouseService._handleTouchChange`, which feeds `Viewport.handleTouchScroll` (scrollback), or wheel reports or arrow keys when a program owns the mouse or the alt buffer. Its `_inertia` keeps dispatching changes after the finger lifts (momentum), and it `preventDefault`s the touchmove (the page does not scroll).
- The typing bench passed on the iPhone because it loaded `6.1.0-beta.304` from jsDelivr, not from this tree.
- Side effect to handle: 6.1 also `preventDefault`s the touchstart over the screen, and on a touch screen that suppresses the `click` the `.frame`'s tap handler (put the keyboard away in compose mode) listened for.

**To do.**
- Find which layer drops the touch: xterm 6.1.0-beta.304's gesture handling on iOS 27.0, or something in the bundle (the `.term` wrapper has `overflow: hidden`; the shell's webview settings; `allowsBackForwardNavigationGestures`). Bisect on the bench (`prototypes/companion-typing` on branch `prototype/companion-typing` passed its owner test on an iPhone) against the real bundle.
- Fix it, or give the terminal its own touch-to-scroll (map a vertical drag to `term.scrollLines`, with momentum), plus a visible way to jump to the bottom.
- Add the touch recorder to the repo as a device script so this can be re-measured.

**Fix (2026-10-08, uncommitted on main).**
- `app/node_modules` reinstalled from the lockfile (`npm install` in `app/`, 3 packages changed, lockfile untouched): xterm `6.1.0-beta.304`, addon-fit `0.12.0-beta.301`, addon-web-links `0.13.0-beta.301`. This also moves the DESKTOP's own terminals from 6.0.0 to 6.1, which commit `54666d10` meant to do and never did; the desk's dev server picks it up on its next restart.
- `app/companion/check-install.mjs` (+ `check-install.test.mjs`): `companion:build` and `companion:dev` now refuse while any installed package differs from `app/package-lock.json`, naming each one. `companion-shell:sync` and `stage-companion.mjs` both build through `companion:build`, so neither can ship a stale tree again. Proven: against a 6.0.0 install it lists the three xterm packages and exits 1.
- `PhoneTerminal.svelte`: the frame's tap is now `use:tap` (new in `press.ts`), pointer events with the same 10 px slop as `press`, nothing prevented. Compose: a tap on the terminal still puts the keyboard away. Raw: a tap gives the terminal the keyboard back (6.0 did that through xterm's mousedown, which 6.1 no longer sends for a touch). A tap on the Latest pill is left to the pill.
- The touch recorder is in the repo: `app/companion-shell/scripts/touch-recorder.sh <udid> on|report|clear`, `touch-recorder.js` (the recorder, one expression) and `webview-eval.py` (USB through usbmuxd, no port). README section "The touch recorder".
- No own touch-to-scroll was written: 6.1's gesture already gives drag, momentum and no page scroll, and the Latest pill was already the way to the bottom.

**Measured, headless Chromium at 393x852 with trusted CDP touches (not WebKit, not the phone).** The same Demo bundle built twice in a detached worktree, the recorder on, `seq 200` in the Scratchpad shell, rows `156 .. prompt` at the start:

| build | slow drag down | slow drag up | flick down | flick up |
|---|---|---|---|---|
| xterm 6.0.0 (what the phone had) | 0 rows | 0 rows | 0 rows | 0 rows |
| xterm 6.1.0-beta.304 + this fix | 23 changes, to `133 .. 178` | 23, back to `156 .. prompt` | 13 (5 after the lift), to `128 .. 173` | 13 (5 after the lift), back |

Every swipe: page not scrolled, frame p95 17 ms, worst 17 ms, none over 33 ms. Also on the fixed build: the Latest pill appears once scrolled, a tap on it returns to `156 .. prompt` and keeps the compose field focused; a drag on the compose field is not taken by the terminal (none of its touchmoves cancelled); compose tap blurs the field (6.1 without the fix: field stays focused); raw tap focuses the terminal (6.1 without the fix: nothing focused). `companion:test` 708 passed, `companion:check` 0 errors (no warnings in the changed files), `companion:build` ok. The desktop against 6.1, since the reinstall moves it too: `npm test` 7703 passed (2 skipped), `npm run check` 0 errors.

**Not verified here.** Anything on the iPhone itself: the phone was not on USB, and the app installed on it still embeds the 6.0.0 Demo bundle. Text selection inside the terminal (xterm's touch selection was not exercised). Android.

**Acceptance.**
- [ ] A one-finger vertical swipe on the terminal scrolls its history on the iPhone, in both directions, with momentum, without scrolling the page
- [ ] The touch recorder shows row changes for each swipe and no frame over 33 ms
- [ ] Selecting text and the compose bar still work
- [ ] Human test: after `npm run companion-shell:sync -- ios`, reinstalling the debug build on the iPhone and restarting the desk app (it restages its bundle), swipe through `seq 200` in a Scratchpad terminal both ways, flick, tap Latest to return to the bottom, and check the compose field and text selection still work
