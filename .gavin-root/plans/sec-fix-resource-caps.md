---
order: 9216
kind: task
title: [sec] resource caps on sessions, connections, and scans
status: To Do
priority: low
complexity: moderate
---
**Severity:** Low. Finding **R8** in `docs/security/README.md` (sources DP-05 in `01-daemon-protocol.md`, SC-10 in `04-supply-chain.md`). The report lives on branch `sec/review-2026090801` until merged.

**The problem.** The daemon has no ceiling on sessions, connections, or threads (one thread per connection in `server.rs::serve`); a hostile repo's plan files are read uncapped on every rescan of the `.gavin*` watcher, and symlinked directories are followed out of the repo. The socket reader caps a line at 1 MiB (`MAX_LINE_BYTES`); `gavin-mcp`'s stdin reader has no cap, though its only peer is the agent that launched it.

**The fix.** In `crates/daemon`: a session ceiling and a connection ceiling (generous — hundreds — refused with a named error, so the app can banner it rather than hang); a per-file size cap in the `.gavin*` scan mirroring `MAX_PRD_BYTES`, with an oversize file reported as a warning in the tree rather than read; no following of a symlinked directory whose canonical path leaves the watched root (a symlinked file is fine). In `crates/gavin-mcp`, the same 1 MiB line cap on stdin. Tests: a scan over a fixture with an oversize card and an out-of-root symlink, and the ceilings refusing the N+1th. Nothing here changes a request's shape.

<!-- gavin:auto-commit -->
When the implementation is done, commit it. Commit only the files you touched — never `git add -A`. Do not push.
<!-- /gavin:auto-commit -->
