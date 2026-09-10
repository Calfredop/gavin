---
order: 13312
kind: task
title: [issue] the stable and dev apps share one daemon and one config.json
status: To Do
---
Every Gavin on this machine resolves the same state: the pipe name is hashed
from `%LOCALAPPDATA%\gavin` (`protocol::resolve_app_support_dir`, no
override of any kind), the three SQLite files sit beside it, and
`config.json` comes from Tauri's `app_config_dir`, keyed by the identifier
`com.gavin.app`. A release install and the dev tree therefore share a
daemon, a board, an orchestration store, and the workspace list.

Found while setting up
[chore-stable-release-install-on-windows.md](./chore-stable-release-install-on-windows.md).
The shared-daemon model is the one CLAUDE.md already describes, and it
mostly works: the launcher leaves an existing daemon alone, and an app
newer than its daemon degrades through `featureBlockedReason`. What it
cannot survive:

- Restart daemon in either app, and the connection overlay's restart. The
  fallback is `taskkill /F /IM gavin-daemon.exe`, by name, so pressing it
  in the dev app takes the stable daemon and every session with it. The
  app crate's own tests reach the same fallback:
  [fix-app-tests-kill-the-running-daemon.md](./fix-app-tests-kill-the-running-daemon.md),
  whose kill-by-owner-pid fix removes this bullet too.
- A dev daemon newer than the stable app. `classify` in `session.rs`
  answers "the gavin daemon is newer than this app" and the stable app
  fails closed, so whoever starts the dev daemon first locks the stable
  app out until it is restarted.
- Config drift. A dev build that widens `config.json` writes a shape the
  stable build then reads.

The decision to make, and it is a design call rather than a patch: whether
a build can be pointed at its own state. The obvious route is an
environment override honoured by `resolve_app_support_dir` (which the
daemon, the app and `gavin-mcp` all go through) plus a separate identifier
for the config dir. The catch is inheritance: a PTY spawned by the stable
daemon inherits the override, so every `gavin-mcp` in those tabs, and any
dev app launched from them, lands on the stable daemon again unless the
launcher strips it. That is the same shape as
[issue-launcher-env-leaks-into-sessions.md](./issue-launcher-env-leaks-into-sessions.md)
and wants settling with it. Until then the rule is operational: keep the
stable daemon up before starting the dev app, and never restart the daemon
from the dev app.
