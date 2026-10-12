---
order: 40960
kind: task
title: [bug] copying from terminal tab is not working
status: Done
---
Doind cmd+c or crtl+c on selected text of a terminal’s tab is not copying the text

<!-- gavin:auto-commit -->
When the implementation is done, commit it. Commit only the files you touched — never `git add -A`. Do not push.
<!-- /gavin:auto-commit -->

Where it failed (owner, 2026-09-29): a plain shell tab on Windows/Linux.
`keyboard.ts` took copy only as macOS ⌘C, so Ctrl+C there always went to
xterm as ^C, and with no Edit menu on those platforms nothing else copied.
Now Ctrl+C with a terminal selection copies it and clears it (the next
Ctrl+C interrupts); with none it stays ^C. Ctrl+Shift+C copies and keeps
the selection. macOS is unchanged.

- [ ] Human test: On Windows or Linux, drag-select text in a plain shell tab and press Ctrl+C: it pastes into another app and the highlight clears; a second Ctrl+C with nothing selected interrupts the shell (^C); Ctrl+Shift+C copies and keeps the highlight
