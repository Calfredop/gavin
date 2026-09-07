---
attachments: /Users/coalpila/Library/Mobile Documents/com~apple~CloudDocs/Screenshots/Screenshot 2026-09-07 alle 10.52.40.png
order: 3072
kind: task
title: [ui/bug] card modal
status: Done
---
Card modal is all messed up, check screenshot please

— nothing was wrong in CardDetailModal.svelte. The dev server was serving
some other component's raw `.svelte` file in place of its compiled CSS
(vite-plugin-svelte's cache misses after `vite-cache-guard.sh` restarts
the server in-process), and WebKit does not discard that file: it
error-recovers into the component's `<style>` block and applies those
rules **unscoped, app-wide**. MainAgentPanel's
`.head { display: flex; align-items: center; text-transform: uppercase }`
is what put the modal's head in a row, in capitals, with the title over
the file path — reproduced pixel-for-pixel in a WKWebView probe. Fixed at
the source in `app/vite-svelte-style-cache.js`; takes effect after the
next dev-server restart.

<!-- gavin:auto-commit -->
When the implementation is done, commit it. Commit only the files you touched — never `git add -A`. Do not push.
<!-- /gavin:auto-commit -->
