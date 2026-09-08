---
order: 12288
title: [sec] webview defence in depth: CSP, opener scope, host-side confirm
status: Done
priority: medium
complexity: complex
---
**Severity:** Medium — defence in depth; no path into the page was demonstrated (AS-07: DOMPurify on both `{@html}` sinks, OSC 52 off, no title plumbing). Finding **R5** in `docs/security/README.md` (sources AS-01, AS-05, AS-09 in `02-app-surface.md`). The report lives on branch `sec/review-2026090801` until merged.

**The problem.** `"csp": null` in `tauri.conf.json`, and every `#[tauri::command]` is reachable from any in-page script; every destructive confirmation lives in `dialog.ts` on the frontend, so a script in the page skips them all — including `restart_daemon`, which kills the shared daemon; `opener:allow-open-path` is scoped to `/**` and `**`. One sanitiser or WebKit bypass in rendered agent or repo content is total host compromise with nothing behind it.

**The fix.**

- [x] A CSP: `default-src 'self'`, `script-src 'self'` (the SvelteKit SPA should need no inline script; if it does, use Tauri's nonce/hash injection rather than `'unsafe-inline'`), `style-src 'self' 'unsafe-inline'` only if the CodeMirror/xterm styles require it, `img-src 'self' data:`, `connect-src ipc: http://ipc.localhost`. Verify in the running app (WKWebView, not a browser) that terminals, the editor, and the markdown preview still render.
- [x] `opener:allow-open-path` scoped to the open workspace roots (a capability with a runtime-set scope, or a host command that checks the root set before calling `open`); keep `opener:default` for URLs but confirm `open_url` is limited to `http(s)`.
- [x] A host-side confirmation token for `restart_daemon`, `workspace_delete`, `trash_entry`, `delete_card_file`, and `kill_session`: the host mints a nonce when it draws the in-app dialog, the command requires it, and a call without one is refused. `askConfirm` keeps its API.
- [x] A unit test that lists every command name and asserts the destructive set is exactly the gated set, so a new destructive command fails the test until classified.

**What landed, and the three judgement calls in it.**

- The CSP is `app.security.csp` in `tauri.conf.json`, which Tauri applies
  only to EMBEDDED assets — under `tauri dev` the document comes from vite
  and carries no policy at all (`AppManager::get_asset` is the only place
  the header is attached; `devCsp` travels the same path). So the dev app
  mirrors the same policy **report-only** (`vite-dev-csp.js`, derived from
  tauri.conf.json so the two cannot drift): violations show in the console
  and nothing is blocked. `script-src` is the one directive only a bundle
  exercises — dev relaxes it because tauri-codegen hashes the two inline
  bootstrap scripts for the bundle and cannot for HTML vite serves.
  **Owner check, in a bundled build:** terminals, the file editor, the
  markdown preview, and that `invoke` is not falling back to postMessage
  (a console warning names it).
- `opener` now holds no path permission at all — `allow-open-path` (`/**`,
  `**`) AND `opener:default`'s unscoped `allow-reveal-item-in-dir` both
  went, replaced by `open_path_externally`/`reveal_path_externally`, which
  answer against the open workspace roots. **Consequence:** "Open Folder in
  Finder" on a terminal tab whose cwd is a rail's WORKTREE now refuses —
  worktrees are siblings of the repo root (`defaultWorktreePath`), so they
  are outside it. That is the same boundary `read_file_for_viewer` already
  drew in `sec-fix-host-path-guard`, and `extra_contexts` is the widening
  lever, but it is a real narrowing worth a look.
- `restart_daemon` is gated, and its two unprompted routes — the
  connection-error overlay's "Restart daemon & retry" and the compat
  banner's Restart — now **ask first**. Both branches of the command run
  `pkill -x gavin-daemon` against a daemon shared with every other window,
  so all four routes to it agree now. `kill_session` is deliberately NOT
  gated, and `commandGate.test.ts` records why.

**What stays open.** The prompt is still drawn in the page, so a script
that runs there and knows gavin can call `open_confirmation`,
`answer_confirmation(true)` and the command, drawing nothing. AS-05's
silent bypass is narrowed (argument-bound, single-use, and the confirm is
now a precondition rather than a convention), not closed; closing it needs
the dialog drawn by the host in a webview the page cannot script, at which
point only the minting authority changes. `confirm_gate.rs`'s module
comment says this at length.

<!-- gavin:auto-commit -->
When the implementation is done, commit it. Commit only the files you touched — never `git add -A`. Do not push.
<!-- /gavin:auto-commit -->
