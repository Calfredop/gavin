---
title: Restart the daemon from Settings
status: Done
priority: medium
---
# Restart the daemon from Settings

Today the only way to restart `gavin-daemon` from inside the app is the
connection-error overlay's "Restart daemon & retry" button — which you can
only reach when the app has already failed to connect. When the daemon is
running but stale (a rebuilt binary, a wedged watcher), there is no way in
short of quitting the app and `pkill`ing by hand.

Add it to Settings, and make it actually reconnect rather than telling the
human to relaunch.

## Why the existing command isn't enough

`session::restart_daemon` already kills and respawns the daemon, but it
returns `false` — "relaunch needed" — whenever the app is already
bootstrapped. That is not a shortcut, it is a real constraint:
`bootstrap()` publishes the connections with `app_handle.manage(...)`, and
Tauri's `manage` will not replace state of a type it already holds. So the
app keeps writing to the dead socket.

The way through is to stop trying to replace the state and swap what is
*inside* it: `DaemonConnection.writer` is already an `Arc<Mutex<UnixStream>>`
and `CommandConnection` is a `Mutex<UnixStream>`, so a reconnect can
assign a fresh stream into both without any new managed state.

## What a restart costs the human

Worth being blunt in the confirm dialog, because it is not obvious:
`SessionManager::recover()` does not reattach to the old PTYs — they die
with the daemon. It **spawns a fresh shell** per non-exited registry record
and marks it restored. So every running agent is stopped and replaced by a
bare shell at its cwd.

## Design

**Rust.** Split `bootstrap()`'s tail into a reusable `attach_and_relay()`
(re-`Attach` every session id, spawn the reader thread) so the restart path
and the cold path can't drift. `restart_daemon`'s already-bootstrapped
branch becomes a real reconnect:

1. raise a `Reconnecting` flag (new managed `AtomicBool`)
2. kill + respawn, connect both streams, verify the protocol version
3. assign the new streams into the existing `DaemonConnection` /
   `CommandConnection` mutexes
4. re-`Attach` every session id and start a fresh reader thread
5. drop the flag, return `true`

The flag exists for one reason: the OLD reader thread notices its socket
close and emits `daemon-error`, which would flash the connection-error
overlay over a restart the human asked for. It must stay silent while the
flag is up.

**Frontend.** A reconnect leaves the daemon with no gavin watchers — they
are per-connection, registered by `WatchGavinRoot`, and the daemon that
held them is gone. Without re-arming them the Plans/Kanban/Orchestration
tabs go quietly dead, which is exactly the failure the fs-sync card just
fixed. `gavinState.watchRootedWorkspaces` is guarded by a one-shot
`watchedOnce`, so it needs a way to re-arm.

Settings gets a new section with the button, a `ConfirmPrompt` spelling out
the session cost, and inline success/failure feedback.

## Steps

- [x] rust: `ConnectionEpoch`; the reader thread stays silent while it is up
- [x] rust: extract `attach_and_relay()` from `bootstrap()`, used by both paths
- [x] rust: `restart_daemon` reconnects in place and returns true
- [x] rust: tests for the extracted pieces
- [x] re-arm the gavin root watches after a reconnect (done in Rust, not the
      frontend — that is where the new connection exists)
- [x] frontend: `restartDaemonInPlace()` action in layoutState, with tests
- [x] frontend: Settings section + ConfirmPrompt + result feedback
- [x] `cargo test --workspace` + `npm test` + `svelte-check` green, clippy clean
- [x] verify against a real daemon: restart, sessions come back, tree pushes resume

## Verified

The exact protocol sequence `reconnect()` performs, driven against a real
`gavin-daemon` on an isolated socket (`HOME` override, so the running app
was never touched):

```
protocol version              9
before: session               7668a38a  attached
before: tree push             ['ws3']
before: pty output            BEFORE_MARKER seen

--- restart ---
old stream                    closes; relay thread exits (epoch keeps it quiet)
after: protocol verified      9
after: session recovered      yes  status=working
after: SessionRestored push   yes
after: pty output resumes     AFTER_MARKER seen
after: tree watch re-armed    ['ws3']
after: live tree push         161 ms  plans=['alpha.md', 'beta.md']
```

The button itself still wants a human click — the Rust half only reaches a
running app after `npm run tauri dev` rebuilds it, and the dev session in
flight belongs to the human.

## If the reconnect fails

`restart_daemon` returns the error and the Settings section renders it
beside the button. The app is then disconnected with no overlay: the epoch
has already moved on, so the old relay thread stays silent, and there is no
new one. That is deliberate — pressing Restart again simply retries, which
is a better place to be than a modal overlay over an app whose windows,
plans and git all still work.
