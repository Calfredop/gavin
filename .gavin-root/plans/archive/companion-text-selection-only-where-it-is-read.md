---
order: 6144
kind: task
title: Companion: turn text selection off on controls and chrome, keep it where text is read
status: Done
priority: low
---
On a phone, a press that lasts a moment too long on a button, a card, a tab or a header starts a text selection (and on iOS the callout), not the control's own gesture. The hub's Workstation cards already opt out (`Hub.svelte`, `.cards > li`: `-webkit-touch-callout: none; user-select: none`, done with the long-press removal on `companion-remove-paired-workstation.md`). Do the rest of the Companion the same way, in both webviews: the shell (`app/companion-shell/src`) and the bundle (`app/companion/src`, which draws the desktop's own components behind the remote shim).

Rule: selection OFF on things a person presses — buttons, list rows and cards that open something, tabs, headers, toolbars, sheets' chrome, inbox items, the Unlock banner. Selection ON wherever text is there to read or copy: terminal output (xterm keeps its own selection, so don't touch it), card bodies, markdown and file views, agent messages, error lines a person might paste somewhere, the pairing code, input fields.

- Decide where the default goes: probably `user-select: none` + `-webkit-touch-callout: none` on the phone's root, with `user-select: text` opted back in on the readable surfaces. That is less to keep right than marking every control, but a new readable surface added later would come out unselectable. Pick one and say why in the commit.
- The desktop shares these components through the bundle: scope the rule to the phone (the bundle's own root or a phone-only class), never the desktop's Tauri window, where selecting a card's text is wanted.
- A source-grep guard in the style of `surfaces/textColours.test.ts`, so a new phone surface can't quietly come back selectable (or unselectable, for a readable one).
- Check on a physical iPhone with `scripts/device-drive.sh`: a long press on a control raises no selection or callout, and text in a card body or a file view still selects and copies.

- [ ] Human test: On the iPhone with a build at fe4b5920 or later: long-press a hub Workstation card, a surface tab, a session row and a board card. None should start a selection or the callout. Then long-press a card's Body text and a file's markdown view: the text should select and Copy should work.
