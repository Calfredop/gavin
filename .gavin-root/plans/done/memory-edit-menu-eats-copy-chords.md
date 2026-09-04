---
kind: note
labels: memory
title: The macOS Edit menu eats ⌘C/⌘X/⌘V before the page sees them
status: Done
---
A text chord that macOS also owns cannot be implemented on `keydown`. Tauri gives the app a default Edit menu, and its Cut/Copy/Paste items validate as ENABLED even when the caret is collapsed, so `NSApplication.sendEvent` hands ⌘C/⌘X/⌘V to the menu's key equivalent and the page's `keydown` never fires. Hang such behaviour off the `copy`/`cut`/`paste` DOM events instead — the menu's `copy:` action does dispatch them, cancellable, with a writable `clipboardData` — and listen in the BUBBLE phase so CodeMirror and xterm, which answer on their own nodes without stopping propagation, are already visible in `defaultPrevented`.

Why: the terminal's ⌘C in `keyboard.ts` is a belt-and-braces path that this makes largely unreachable on macOS; `lineClipboard.ts` is the worked example. Measured with a throwaway Swift WKWebView probe that calls `webView.perform("copy:")` and `validateUserInterfaceItem` — no synthetic key events and nothing on the human's screen.
