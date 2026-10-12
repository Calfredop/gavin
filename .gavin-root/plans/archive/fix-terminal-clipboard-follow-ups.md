---
kind: plan
title: Terminal clipboard follow-ups
status: Done
---
Found while fixing `done/bug-copying-from-terminal-tab-is-not-working.md`.

- [x] macOS: ⌘C/⌘V on a terminal page are claimed for the terminal even when the focused tab is a card, file or board tab, so text selected there never copies
- [x] Windows/Linux: paste into a terminal (Ctrl+V reaches the shell as ^V); and the app's paste writes raw text, skipping the bracketed paste xterm does itself
- [x] OSC 52: a program that copies by escape sequence (Claude Code over SSH, tmux, vim) copies nothing, because gavin's xterm has no handler for it

Checked in WebKit with the real `keyboard.ts`, `clipboard.ts` and
`terminalRegistry.ts` over a real xterm, on each platform's path. ⌘C on
a card tab's selected text reached the Edit menu's copy. Ctrl+Shift+V
(and Ctrl+V on Windows) pasted `ESC[200~echo one\recho two ESC[201~`,
while Linux Ctrl+V still sent ^V. An OSC 52 write reached the clipboard,
and a `?` query got no reply.

- [ ] Human test: On Windows and on Linux, copy two lines of text elsewhere and press Ctrl+Shift+V in a plain shell tab: both lines appear at the prompt without running; on Windows plain Ctrl+V does the same, on Linux Ctrl+V does not paste
- [ ] Human test: In a Claude Code session running over SSH on a remote host, drag-select text: Claude Code says "sent … via OSC 52" and the text pastes into a local app
