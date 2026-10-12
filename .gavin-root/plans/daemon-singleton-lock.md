---
kind: task
title: Daemon singleton lock
parent: tbdeveloped-enforce-mcp-and-relay-singletons.md
complexity: complex
---
Give gavin-daemon a per-build kernel lock so that a second copy of the same build cannot touch anything.

Today a second daemon only finds out that the socket is taken at `bind_server`, the last step of `serve()`. Before that point it has already done all of these:
- run `Registry::open`, which bumps the generation;
- run `recover()`, which marks the live daemon's sessions interrupted and spawns stray shells;
- swept every Playwright browser;
- resumed Headroom;
- overwritten `daemon{,-dev}.token`, so the app loses its role on its next redial.

On top of that, two daemons starting at once can unlink each other's socket in `Listener::bind_at`.

- **Take the lock first.** Before `Registry::open` in `serve()` (`crates/daemon/src/main.rs`), open `app_support_dir()/profile_file_name("daemon","lock",BuildProfile::current())` and call `File::try_lock()` on it. That is std, works on unix and Windows, and `headroom/install.rs` already uses it. Hold the handle for the whole process lifetime, and write this pid into the file.
- **Refuse cleanly.** If the lock is held, print one line naming the holder's pid to the log and exit non-zero. Do it before opening any store, recovering, sweeping browsers, resuming Headroom or minting the token.
- **Keep the existing check.** Leave `bind_server`'s `is_listening` check in place. The unlink in `Listener::bind_at` is safe now that it only runs under the lock; say so in its comment.
- **Restart path.** In `app/src-tauri/src/daemon.rs`, `stop_running_daemon` (used by `reconnect_swapping`) must wait after Shutdown or SIGTERM until the old pid has actually exited, bounded at about 5 s, before `connect_or_spawn` spawns. Otherwise the new daemon hits the lock and exits, and the app reconnects to the dying one. Check whether `crates/daemon/src/bridge.rs`'s own `connect_or_spawn` needs the same treatment.
- **Tests.**
  - Add an integration test under `crates/daemon/tests/` with a temp `$HOME`: start one daemon, then a second. The second must exit non-zero, and the registry generation, `daemon-dev.token` and `playwright-browsers-dev.json` must all be unchanged.
  - Add a test that a restart does not race the lock.
- **Limits.** No protocol bump. The change takes effect only after a rebuild and a daemon restart, which is the owner's call. Never pkill a daemon to test this; use temp HOMEs.
