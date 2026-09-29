---
order: 5120
title: Show Gavin's own memory in the task manager
status: In Progress
complexity: moderate
---
The task manager lists only the daemon's sessions, so it cannot answer "how much of this is Gavin itself?". Asked after a "Gavin is using ~20 GB" scare. That figure turned out to be 17 GB of session trees (a dev stack, 17 agents, an e2e run) plus about 1.2 GB of Gavin: the webview at ~1.1 GB, the host at 45 MB and the daemon at 73 MB.

Measure Gavin's own processes as physical footprint (`proc_pid_rusage` `ri_phys_footprint`, which is Activity Monitor's Memory column), not RSS. The webview's RSS was 181 MB against a 1000 MB footprint.

- App: this process.
- Interface: the `com.apple.WebKit.*` helpers. They are launchd children, not ours, so they are identified by sharing this process's *responsible* pid and by starting after it. The lookup is `responsibility_get_pid_responsible_for_pid`, resolved via dlsym so a macOS without it degrades to "not measured" instead of failing to launch.
- Daemon: the pid the command connection's peer names, measured without its sessions.

Plan:

- [x] Host: `gavin_memory` in `app/src-tauri/src/memory.rs`. Async plus spawn_blocking, macOS only; `None` elsewhere.
- [x] Rust tests: helper-name filter, own footprint, a non-daemon pid refused, no helpers found for a test process.
- [x] TS: `backend.gavinMemory`, plus `gavinLine`/`gavinNote` in `sessionsManager.ts` with tests.
- [x] Modal: poll beside the session list and render a "Gavin" line above the watchman line, which is relabelled "Related to Gavin".
- [x] Checks: cargo test -p app (549 pass), npm test (6478 pass), npm run check (0 errors), npm run build. commandGate.test.ts classifies `gavin_memory` as ordinary. A probe against the live app matched footprint(1): app 40 MB, interface 3 helpers 278 MB, daemon 78 MB, with Fork's helpers excluded.
- [x] Human test: open Task manager (sidebar footer). Under the grid, a "Gavin: … — app … · interface … · daemon …" line should sit above the "Related to Gavin: watchman …" line, with the numbers roughly matching Activity Monitor's Memory column for Gavin, com.apple.WebKit.* and gavin-daemon. Its hover should explain each part.
  Result (2026-09-28): passed
