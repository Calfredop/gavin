---
order: 32768
kind: task
title: "[fix] open_workspace_window deadlocks on Windows as a sync command"
labels: bug, windows
parent: perf-main-thread-command-audit.md
status: Done
---
`open_workspace_window` (app/src-tauri/src/workspace_window.rs:93) builds a
`WebviewWindow` inside a synchronous command. Tauri documents that this
DEADLOCKS on Windows.

## Evidence (2026-09-26)

- tauri-2.11.5 src/webview/webview_window.rs:58 and :115: "On Windows, this
  function deadlocks when used in a synchronous command and event
  handlers" (a WebView2 issue).
- The comment at workspace_window.rs:131 says "A tauri command runs on a
  worker thread" — not true for a plain `fn` command, which runs on the
  main thread. The AppKit chrome it then applies is hopped onto the main
  thread on purpose (setWantsLayer off-main blanks the window), so that
  part must stay.
- macOS: fine, ~100–300 ms. Windows port: likely a hang the first time a
  workspace window opens.

## Fix

Make it `async` (Tauri's documented remedy), keep the AppKit calls hopped
onto the main thread via `run_on_main_thread`, and fix the comment. Check
the other window-building paths the same way.

## Verify

On Windows (the Windows port card's machine): open a workspace window from
the sidebar; it opens without hanging. On macOS: the window still gets
rounded corners and the title-bar double-click.

- [ ] Human test: On Windows, with a build of perf/main-thread-commands: right-click a workspace in the sidebar → Open in New Window; the window opens and the app keeps responding (no hang)
- [ ] Human test: On macOS, with a build of perf/main-thread-commands: Open in New Window on a workspace; the new window is not blank, has rounded corners, and double-clicking one of its edges extends that edge to the screen edge

## Done (2026-09-26, uncommitted on perf/main-thread-commands)

- `open_workspace_window` is now `pub async fn` (`State<'_, …>`), so it runs
  on a runtime worker instead of the main thread; the AppKit chrome is still
  hopped via `run_on_main_thread`, and the comment now says why (an async
  command runs on a runtime worker).
- The only window builder in `app/src-tauri` — no other command or event
  handler builds one.
- Guard: `mainThreadCommands.test.ts` › "building a window" finds every
  `WebviewWindowBuilder`/`WindowBuilder`/`WebviewBuilder` in src-tauri and
  fails unless it sits inside an async command, and pins the main-thread hop
  for the chrome. Red on the old `fn`, green after.
- Checks: `cargo test -p app` (workspace_window), `npm test` (6789 passed),
  `npm run check` (0 errors). A Windows `cargo check --target
  x86_64-pc-windows-msvc` of the app crate does not get past `ring`'s build
  script on a Mac, so the Windows side is proven only by the human test above.
