---
order: 16384
kind: task
title: [bug] npx not found error
status: Done
---
During init wizard users are facing this issue:
npx was not found on PATH

App was installed via compiled dmg. Test user agent said:
Quel path lo aggiunge la shell (hook di mise). Gavin avviato dal Dock / dal DMG eredita tipicamente solo qualcosa tipo:
/usr/bin:/bin:/usr/sbin:/sbin
quindi non vede mise.
Per questo nel terminale npx funziona e in Gavin no: mise attiva Node solo nella shell, non per le app aperte dal Dock
___
Let’s to fix then let’s add a fallback of common npx places anyhow with also “where npx” and manual npx path input (to be shown on final fail only)

<!-- gavin:auto-commit -->
When the implementation is done, commit it. Commit only the files you touched — never `git add -A`. Do not push.
<!-- /gavin:auto-commit -->

- [ ] Human test: On a Mac whose Node comes only from mise (or nvm), install the DMG build, launch it from the Dock, and run the init wizard: the Playwright step shows "Node.js (npx) found" and the Matt Pocock's skills Install works. Then rename npx out of reach and confirm that only then does the "Use this npx" path field appear, and that pasting the `command -v npx` path fixes it.
