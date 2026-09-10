---
order: 16384
title: [fix] the app crate's tests kill whatever gavin-daemon is running
status: To Do
priority: high
complexity: moderate
---
`cargo test -p app` takes the machine's daemon down, every session with it.
Found 2026-09-10 while rebuilding the stable install: the stable daemon was
alive at 15:49, a full `cargo test -p app --release` ran a few minutes
later, and the next launch found nothing listening. It had happened once
before the same afternoon and been misread as the human quitting the app.

## Why

`stop_running_daemon` in `app/src-tauri/src/daemon.rs` asks over the wire
first and, when nothing answers, falls back to `kill_running_daemons`, which
is `taskkill /F /IM gavin-daemon.exe` on Windows and `pkill -x gavin-daemon`
elsewhere -- by NAME, because there is nothing else to address the daemon
by. `stop_is_content_when_nothing_is_listening` calls it on a socket in a
fresh tempdir, so the polite half fails by design and the fallback runs
against the real machine. `stop_asks_over_the_wire_and_returns_once_nothing_answers`
reaches the same fallback whenever `wait_until_gone` loses its 300 ms race
with the fake listener's teardown.

CLAUDE.md's "never pkill gavin-daemon" is exactly this, and the suite does
it on every run. It is the same kill that makes Restart daemon in one app
take the other app's daemon
([issue-stable-and-dev-apps-share-one-state-dir.md](./issue-stable-and-dev-apps-share-one-state-dir.md)).

## Fix

- [ ] Address the daemon by the process that owns the endpoint, not by
      name. Windows: `GetNamedPipeServerProcessId` on a connected pipe
      handle. Unix: the peer pid of a connected stream (`SO_PEERCRED` on
      Linux, `LOCAL_PEERPID` on macOS), or the pid the daemon writes
      beside its socket. Then `TerminateProcess` / `kill(pid)` that one
      process. A daemon on another socket is never touched, which is also
      what a stable and a dev daemon side by side need.
- [ ] When the endpoint has no owner (nothing listening, no pid), there is
      nothing to kill: return Ok without the by-name sweep. That is what
      `stop_is_content_when_nothing_is_listening` should be asserting.
- [ ] A test that proves the fallback cannot reach a daemon it did not
      connect to: bind a listener on a tempdir socket in-process, call
      `stop_running_daemon` on a DIFFERENT tempdir socket, and check the
      listener is still there.
- [ ] Until this lands: do not run `cargo test -p app` (or `--workspace`)
      on a machine whose daemon holds sessions you want. Agents developing
      gavin inside gavin will hit this on every full run.
