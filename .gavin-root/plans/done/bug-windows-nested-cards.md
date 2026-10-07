---
order: 16384
kind: task
title: [bug] windows nested cards
status: Done
---
Executing nested cards makes the Gavin open new windows when using Cursor as coding agent on Windows. This eventually leads to a crash.

<!-- gavin:auto-commit -->
When the implementation is done, commit it. Commit only the files you touched — never `git add -A`. Do not push.
<!-- /gavin:auto-commit -->

## What was found (2026-10-07)

Reported on the installed release, Cursor Agent CLI, a non-gavin project:
the extra windows show Gavin's own UI in the same state as the main one,
pile up while agents run with nobody touching anything, and the app
eventually crashes.

- Nothing in the app opens a window on its own: `open_workspace_window` is
  reached only from the sidebar menu and the hub's window button, and a
  WebView2 `window.open` is refused (no `on_new_window` handler, so wry
  marks it handled).
- So each "window" is a second `Gavin.exe`. Task Manager's Processes tab
  groups them under one "Gavin" row, and a new instance loads the shared
  config, so it looks like the same app. macOS refuses a second copy of a
  running bundle by itself; Windows has no such rule and gavin had no
  guard. Each copy runs its own rail scheduler over the same
  `orchestration.sqlite`, so every extra copy can launch the same steps
  again -- the crash.
- What starts the copies could not be seen from this machine: no gavin
  code launches `Gavin.exe`, the installer adds nothing to PATH, and gavin
  installs no Cursor hooks.

## Fix

- [x] `app/src-tauri/src/single_instance.rs`: the first instance holds a
      named mutex per build (`Local\gavin-app`, `Local\gavin-app-dev`, so
      the dev app and a release install still run side by side -- why it
      is not `tauri-plugin-single-instance`, which keys on the shared
      identifier). A later launch raises the running window and exits
      before Tauri builds anything. Called first in `lib.rs`'s `run`.
- [x] Each refused launch appends one line to
      `%LOCALAPPDATA%\gavin\second-launch.log`: args, cwd, and the chain
      of parent processes -- which names whatever is starting the copies.
- [x] Windows half compile-checked for `x86_64-pc-windows-msvc` in a
      scratch crate with the same `windows` features (a planted type error
      fails it, so the arm is really checked); pure parts unit-tested.

- [ ] Human test: On Windows, with a build containing this fix, run nested cards with Cursor as the agent: no extra Gavin windows appear, the app does not crash, and if `%LOCALAPPDATA%\gavin\second-launch.log` exists its lines name the process that tried to start Gavin -- paste them on this card.
- [ ] Human test: On Windows, with Gavin running, launch it again from the Start menu: no second app opens and the running Gavin window comes to the front; the dev app (`start-dev-win.ps1`) still starts while the installed one runs.
