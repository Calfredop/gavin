---
order: 30720
kind: task
title: "[perf] Restart daemon runs the whole reconnect on the main thread"
labels: bug
parent: perf-main-thread-command-audit.md
status: Done
---
`restart_daemon` (app/src-tauri/src/session.rs:2402) and `stop_daemon`
(:2444) stop, respawn and reconnect the daemon on the main thread. Explicit
actions only, so lower priority — but the worst case is unbounded.

## Evidence (2026-09-26)

- `stop_running_daemon` (app/src-tauri/src/daemon.rs:253-269): Shutdown +
  300 ms read, 300 ms for the socket to go, SIGTERM, 300 ms more — ~0.9 s
  worst.
- Then `reconnect` (session.rs:2476-2555): `connect_or_spawn` polls up to
  3 s (daemon.rs:30-55) while the new daemon's `recover()` respawns a shell
  per surviving record before it binds; `verify_daemon_protocol` via
  `send_command` with NO read timeout (:2681-2702); Hello on both
  connections; an `Attach` per session; a `WatchGavinRoot` per workspace.
  From the error overlay it is a full `bootstrap` (:4509-4659), including
  `CreateSession` per stale tab.
- Typical ~0.3–0.7 s (estimate), ~3.9 s then an error, unbounded if the new
  daemon accepts but never answers.

## Fix

Both `async`: spend the confirm-gate token first on the async side, then
the rest in `spawn_blocking` with a moved `app_handle`. The ordering risk
is real: today the main-thread block quietly serialises everything around
the connection swap (session.rs:2514-2519). Once async, keystrokes and
command-connection calls interleave with the swap, and a command that hits
the dead stream silently reconnects via `send_command_reconnecting` —
possibly to the new daemon before Hello/version probe, as `local` with a
stale compat verdict. So: a "restarting" state that makes commands fail
fast (or holds the command lock across the swap), a guard against two
concurrent restarts, and `restartDaemonInPlace`
(app/src/lib/core/layoutState.ts:1587) should set `status: "connecting"`
like `retryConnect` (:1567) so terminals stop taking input.

## Verify

Restart daemon from Settings while typing in a terminal: the window stays
live, input is refused (not lost into the old socket) until reconnected.

## Done (2026-09-26, uncommitted on perf/main-thread-commands for the rail's commit step)

- `restart_daemon` and `stop_daemon` are `async`: the token is spent first,
  then `DaemonRestart::claim` refuses a second restart or a stop while one
  runs, then the work goes to `spawn_blocking`.
- The command lanes already refused requests mid-swap (`begin_swap`). The
  streaming connection now does too: `with_writer` refuses `write_input`,
  `resize_session`, `snapshot_session` and `watch_gavin_root` on the local
  daemon for the whole reconnect ("the gavin daemon is restarting").
- The unbounded case is now bounded: the probe and both `Hello`s run under
  a 10 s read deadline (`HANDSHAKE_DEADLINE`), in `bootstrap` too, lifted
  before the relay takes the stream. A silent daemon is reported as "took
  the connection but never answered", not as "too old".
- NOT done as written: `restartDaemonInPlace` does not set
  `status: "connecting"`. That status swaps the whole window for the
  Connecting… overlay, unmounting Settings and its outcome note mid-restart,
  which is what two `restartDaemonInPlace` tests forbid. The host-side
  refusal stops the input without it.
- Known consequence: a rail launch that lands in the restart window now
  fails with "restarting" and may stall its rail (before, it queued behind
  the frozen main thread). The restart interrupts every agent anyway.

- [ ] Human test: After a rebuild: Settings → Restart daemon while typing in a terminal — the window stays live (no beachball, Settings shows Restarting…), keystrokes typed mid-restart do not appear, and typing works again in the recovered shell once the button returns
