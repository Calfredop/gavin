---
order: 17408
kind: note
title: cargo test -p app kills the running daemon
labels: memory
---
`cargo test -p app` (and so `cargo test --workspace`) kills whatever `gavin-daemon` is running on the machine, every session with it.

Why: `stop_is_content_when_nothing_is_listening` calls `stop_running_daemon` on an empty tempdir socket, and its fallback is `taskkill /F /IM gavin-daemon.exe` / `pkill -x gavin-daemon`, by name. Until fix-app-tests-kill-the-running-daemon.md lands, run the app suite only when the daemon holds nothing you need.
