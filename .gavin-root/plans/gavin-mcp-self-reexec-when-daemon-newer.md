---
kind: task
title: [feat] gavin-mcp re-execs itself when the daemon is newer, instead of failing closed
status: To Do
priority: medium
complexity: moderate
---
The compat work's phase-2 leftover. `crates/gavin-mcp/src/main.rs` (`SocketTransport::connect`, the `VersionBand::DaemonNewer` arm) still hard-errors — "the gavin daemon is newer than this gavin-mcp … restart this Claude Code session" — under a comment saying phase 2 replaces it with a self re-exec. Every agent session on the machine loses its `gavin_*` tools the moment the daemon is rebuilt, and gets them back only by restarting the session. Design: `docs/superpowers/specs/2026-08-24-daemon-version-compat-ota-design.md` §3 ("gavin-mcp self re-exec") and Task 3 of `docs/superpowers/plans/2026-08-24-ota-updates.md`. Read both before writing anything; the spec records the options it rejected.

The shape the spec asks for:

1. On `DaemonNewer`, exec `std::env::current_exe()` — the binary at that path has already been replaced by the rebuild or the update, so the new process speaks the daemon's version. Same argv, same environment, plus a marker (`GAVIN_MCP_REEXEC=1`) so a second `DaemonNewer` after a re-exec is the hard error it is today, never a loop.
2. The buffered-stdin case (spec §3, detail 2): the MCP transport reads stdin, and any bytes consumed before the version check are lost to the new process. Either run the check before the first stdin read, or carry the buffered bytes across. The test the spec asks for on this case must exist and pass.
3. Windows has no `exec()`: spawn the new binary with inherited stdio, wait, and exit with its code, so the MCP client sees one process's stdio either way. Say so in a comment, and test the marker logic on every platform.
4. One line to stderr saying which version re-execed into which, so a session's transcript shows what happened.

Tests: the marker guard (a re-execed process that still sees `DaemonNewer` errors rather than re-execing again), the buffered-stdin case, and the `DaemonTooOld` arm unchanged. `cargo test -p gavin-mcp`. Commit only the files you touched. CLAUDE.md's "gavin-mcp fails closed on version skew" paragraph becomes wrong when this lands — update it in the same commit.
