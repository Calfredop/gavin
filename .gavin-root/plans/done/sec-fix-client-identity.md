---
order: 6144
title: [sec] client identity and roles on the daemon socket
status: Done
priority: high
complexity: intricate
---
**Severity:** Critical for a remote client, High for an agent gavin runs; the accepted same-user boundary otherwise. Finding **R1** in `docs/security/README.md` (sources DP-01, DP-02, DP-06, AG-03, AG-04, AG-08, AG-09; design in `docs/security/05-remote-access.md`, phase 1). The report lives on branch `sec/review-2026090801` until merged.

**The problem.** Every connection to `daemon.sock` is equal: no peer-credential check, no token, no role. A session id is the only capability, so any holder of the socket — including an agent over `gavin-mcp` — can spawn a shell, attach to and type into sessions it did not open, write another workspace's cards by absolute path, forge run rows the scheduler trusts, and shut the daemon down. A same-user process that binds the socket path first is "the daemon" to the app.

**The fix** — phase 1 of the remote-access design, worth having with no mobile app:

- [x] Read `docs/security/05-remote-access.md` sections 4, 7 and 10 (phase 1) and `01-daemon-protocol.md` "What the daemon would need to gain"; keep the message names they propose unless there is a reason.
- [x] `bind_server` mints a daemon token at startup, stored `0600` under the app-support dir; the app reads it when it launches or finds the daemon.
- [x] A `Hello` first request on a connection: token (or none), declared client kind, and the workspace/card scope a launch is handing out. The reply carries a server proof so the app can tell the real daemon. Peer uid via `getpeereid`/`LOCAL_PEERCRED` is the floor on every connection.
- [x] A `ClientIdentity` with a role (`local`, `agent`) on the connection and an exhaustive `authorize(role, &Request)` in `server.rs::handle_connection`, so a new variant fails to compile until it is classified. `agent` is refused `CreateSession`, `Shutdown`, `EndOrphan`, `SetOrchestration`, `SetRootConfigField`, the `*ByRoot` family, and any session or path outside its scope.
- [x] Agents get the token beside `GAVIN_SESSION_ID` at launch (`pty.rs`, `session.rs`), scoped to the workspace and card they were launched for; `gavin-mcp` presents it and takes the `agent` role.
- [x] Untokened local connections keep full reach behind a `require_local_token` switch that defaults off, so nothing breaks the day this lands; the compat gate: `Hello` is a new request TYPE, so an older daemon answers `Unknown` — the app treats that as "no identity yet", never as a failure.
- [x] Protocol bump with a `FEATURE_MIN_VERSION` entry and a real consumer in the UI (the Settings switch), per `CLAUDE.md`.

<!-- gavin:auto-commit -->
When the implementation is done, commit it. Commit only the files you touched — never `git add -A`. Do not push.
<!-- /gavin:auto-commit -->
