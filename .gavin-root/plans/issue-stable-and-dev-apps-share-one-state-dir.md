---
order: 13312
kind: task
title: [issue] the stable and dev apps share one daemon and one config.json
labels: windows
status: In Progress
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

## Settled 2026-09-11: separate daemons, one body of work

The decision the card asked for, and it went the other way from the route
the card proposed. An environment override was the obvious shape, and the
owner's requirement rules it out along with the whole idea of two
independent Gavins:

> The very important thing is that I don't lose any work on both build
> types. At the moment I am working on release build and any work done
> here should be found/synced to debug and vice versa, without killing the
> daemon of the other. The baseline is that only one build at a time will
> be running.

So: **nothing is duplicated, therefore nothing needs syncing. Only the
things that name a RUNNING DAEMON split.** The state directory stays one
directory; a `BuildProfile` in `protocol` (`cfg!(debug_assertions)`)
suffixes four file names and nothing else.

- **Splits**: `daemon.sock` → `daemon-dev.sock` (and with it the hashed
  pipe name, which is what makes two daemons possible at all),
  `daemon.token`, `daemon.log`, `registry.sqlite`. The registry is not
  tidiness: it is the only store holding `pid`/`orphan_pid`, and
  `SessionManager::recover` probes those at every startup — shared, a dev
  daemon would list the release app's live agents as orphans offering to
  end them and respawn a bare shell for each.
- **Stays shared**: `kanban.sqlite`, `orchestration.sqlite`,
  `config.json`, `require_local_token`. One board, one set of rails, one
  workspace list, one settings file, found by both builds because they are
  the same files.
- **No environment variable decides state**, so the card's inheritance
  catch has nothing to catch. `issue-launcher-env-leaks-into-sessions.md`
  is therefore settled *with* this one rather than by it.

Bullet 1 of this card was already closed by the kill-by-owner-pid fix on
[fix-app-tests-kill-the-running-daemon.md](./done/fix-app-tests-kill-the-running-daemon.md).
Bullet 2 (a dev daemon newer than the stable app) goes by construction —
neither app can see the other's endpoint. **Bullet 3, config drift, is
deliberately left standing**: one `config.json` is exactly what "settings
sync both ways" means, and a dev build that widens it writes a shape the
release build reads and rewrites. That trade was made knowingly.

Design: `docs/superpowers/specs/2026-09-11-per-build-daemon-isolation-design.md`
Plan: `docs/superpowers/plans/2026-09-11-per-build-daemon-isolation.md`

## Steps

- [x] `BuildProfile` + `profile_file_name` in `protocol`; `socket_path` and
      `daemon_token_path` through them; fix the two tests that hardcode
      `daemon.sock` (`daemon/src/main.rs:74`, `daemon/tests/shutdown.rs:53`)
- [x] Split `registry.sqlite`; pin `kanban.sqlite` and
      `orchestration.sqlite` as literals so the split cannot widen by
      accident
- [x] Split `daemon.log` behind a `daemon_log_path` compiled on every
      platform
- [x] `PtySession::spawn` exports `GAVIN_SESSION_SOCKET`, surviving both
      scrub loops — the workspace's MCP config names ONE `gavin-mcp`, so a
      debug one can land in a release tab
- [x] `gavin-mcp` prefers the injected endpoint, falls back to its own
- [x] Launcher scripts probe their own pipe tag
      (`gavin-daemon-dev-sock` is not matched by `*gavin-daemon-sock*`,
      but the reverse would be); CLAUDE.md amended
- [ ] Owner, in the running app: quit the release app, run
      `scripts/start-dev-win.ps1`, confirm two daemons on two pipes with
      the release one's sessions intact
