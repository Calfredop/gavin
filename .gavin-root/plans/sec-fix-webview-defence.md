---
order: 12288
title: [sec] webview defence in depth: CSP, opener scope, host-side confirm
status: To Do
priority: medium
complexity: complex
---
**Severity:** Medium — defence in depth; no path into the page was demonstrated (AS-07: DOMPurify on both `{@html}` sinks, OSC 52 off, no title plumbing). Finding **R5** in `docs/security/README.md` (sources AS-01, AS-05, AS-09 in `02-app-surface.md`). The report lives on branch `sec/review-2026090801` until merged.

**The problem.** `"csp": null` in `tauri.conf.json`, and every `#[tauri::command]` is reachable from any in-page script; every destructive confirmation lives in `dialog.ts` on the frontend, so a script in the page skips them all — including `restart_daemon`, which kills the shared daemon; `opener:allow-open-path` is scoped to `/**` and `**`. One sanitiser or WebKit bypass in rendered agent or repo content is total host compromise with nothing behind it.

**The fix.**

- [ ] A CSP: `default-src 'self'`, `script-src 'self'` (the SvelteKit SPA should need no inline script; if it does, use Tauri's nonce/hash injection rather than `'unsafe-inline'`), `style-src 'self' 'unsafe-inline'` only if the CodeMirror/xterm styles require it, `img-src 'self' data:`, `connect-src ipc: http://ipc.localhost`. Verify in the running app (WKWebView, not a browser) that terminals, the editor, and the markdown preview still render.
- [ ] `opener:allow-open-path` scoped to the open workspace roots (a capability with a runtime-set scope, or a host command that checks the root set before calling `open`); keep `opener:default` for URLs but confirm `open_url` is limited to `http(s)`.
- [ ] A host-side confirmation token for `restart_daemon`, `workspace_delete`, `trash_entry`, `delete_card_file`, and `kill_session`: the host mints a nonce when it draws the in-app dialog, the command requires it, and a call without one is refused. `askConfirm` keeps its API.
- [ ] A unit test that lists every command name and asserts the destructive set is exactly the gated set, so a new destructive command fails the test until classified.

<!-- gavin:auto-commit -->
When the implementation is done, commit it. Commit only the files you touched — never `git add -A`. Do not push.
<!-- /gavin:auto-commit -->
