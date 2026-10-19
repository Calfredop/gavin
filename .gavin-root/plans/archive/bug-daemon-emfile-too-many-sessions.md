---
labels: ready-for-agent
title: [bug] Daemon hits Too many open files before the session ceiling
status: Done
priority: high
complexity: moderate
---
Reported 2026-10-19: with many sessions open, starting another made the UI unusable with `expected SessionCreated, got Error { message: "Too many open files (os error 24)" }` and a Restart-daemon CTA. Restarting the UI and closing some sessions recovered it **without** restarting the daemon.

## Root cause

macOS GUI processes inherit soft `RLIMIT_NOFILE` of **256** (`launchctl limit maxfiles` soft). `gavin-daemon` never raises it. Each live session holds ~3 PTY master FDs; plus sockets, SQLite, watchers, Relay, MCP connections. `MAX_LIVE_SESSIONS` is 256 (from `sec-fix-resource-caps`), which would need far more than 256 FDs — so `openpty` fails with raw EMFILE well before the named session-ceiling refusal.

Evidence already on this machine:
- Release daemon currently ~35 sessions / ~142 FDs (room until ~256).
- `daemon.log` already recorded EMFILE on Relay dials and `unable to open database file` (SQLite under the same limit).
- Closing sessions frees FDs → matches the recovery path.

## Fix (checklist)

- [x] At daemon startup (and ideally the Tauri host too), raise soft `RLIMIT_NOFILE` to `min(hard, kern.maxfilesperproc)` / a fixed generous floor (e.g. 8192) — before opening the socket or recovering sessions.
- [x] When `openpty` / create_session fails with EMFILE, refuse with a named error like the session ceiling (`close some sessions`) instead of the raw OS string; surface it on `DaemonRequestErrorBanner`, not as a dead connection / Restart-daemon overlay.
- [x] Revisit `MAX_LIVE_SESSIONS` relative to the raised limit (keep a margin for sockets, SQLite, Relay, watchers) so the ceiling fires before EMFILE.
- [x] Test: soft-limit a test daemon (or lower the ceiling) and assert the named refusal; assert startup raises the soft limit above 256 on unix.
- [ ] Human test: After rebuilding the app (daemon + host), open many sessions until previously you would have hit EMFILE: new sessions should keep working well past ~70 tabs, and if you somehow exhaust FDs the UI should show a dismissible banner saying close some sessions — not the full-screen Restart daemon overlay.
- [ ] Human test: After rebuilding the app (daemon + host), open many sessions until previously you would have hit EMFILE: new sessions should keep working well past ~70 tabs, and if you somehow exhaust FDs the UI should show a dismissible banner saying close some sessions — not the full-screen Restart daemon overlay.

## Out of scope

- Raising system-wide `launchctl limit maxfiles` for the user.
- Changing PTY FD multiplicity in portable-pty.
