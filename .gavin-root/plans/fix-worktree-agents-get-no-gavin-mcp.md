---
order: 15360
kind: task
title: "[fix] Agents in a fresh gavin worktree get no gavin_* tools"
labels: bug
status: To Do
---
Have the daemon tell every session it spawns WHICH `gavin-mcp` to run, by
exporting `GAVIN_MCP` beside the `GAVIN_SESSION_*` variables it already sets.
The `scripts/gavin-mcp` launcher reads `GAVIN_MCP` first, so every agent then
runs the binary from the same build that launched it: in any worktree, on
either machine, with no version skew.

## What goes wrong (seen 2026-09-26)

- gavin's own checkout names the relative launcher `scripts/gavin-mcp` in
  `.mcp.json`, `.cursor/mcp.json`, `.gemini/settings.json` and
  `opencode.json` (fed453d5). The launcher tries `$GAVIN_MCP`,
  `~/Applications` and `/Applications/Gavin.app/Contents/MacOS/gavin-mcp`,
  then `<this checkout>/target/release|debug/gavin-mcp`, then PATH
  (scripts/gavin-mcp; scripts/gavin-mcp.cmd on Windows keeps the same
  order).
- On a machine with no installed Gavin — the Mac, running only the dev
  stack — a freshly cut worktree has no `target/`, so the launcher finds
  nothing and the agent's MCP client connects to no server. The rail
  "main thread perf" started its first agent in
  ../gavin-perf-main-thread-commands before anyone had built gavin-mcp
  there, and that agent ran its whole turn with no gavin_* tools: it could
  not name its tab or file its card Done. The client does not retry until
  someone runs `/mcp` in that tab. Workaround used: `cargo build -p
  gavin-mcp` inside the worktree (~55 s).
- Other workspaces are unaffected: `resolve_mcp_binary_path`
  (app/src-tauri/src/agent_setup.rs:1371) writes an ABSOLUTE path there.
- An installed Gavin closes the gap but not safely. `gavin-mcp` already
  follows `GAVIN_SESSION_SOCKET` to the daemon that spawned the session
  (crates/gavin-mcp/src/main.rs:168), so it reaches the right daemon. But
  an installed release older than the dev daemon fails closed on version
  skew, and the launcher prefers it over the dev build.

## Fix

1. In `PtySession::spawn` (crates/daemon/src/pty.rs, next to
   `GAVIN_SESSION_SOCKET` at :201-203, whose comment already names this
   problem for the socket), export `GAVIN_MCP` as the `gavin-mcp` beside
   the daemon's own `current_exe()`, with `EXE_SUFFIX`, the way
   `resolve_mcp_binary_path` and `daemon::resolve_daemon_binary_path` do.
   Set it only when that file exists, and skip it rather than fail — the
   way the socket is skipped. In `target/debug` and in the app bundle the
   two binaries ship side by side.
2. Cursor passes env explicitly, not by inheritance: add
   `"GAVIN_MCP": "${env:GAVIN_MCP}"` to the `JsonServersStdio` env block
   (agent_setup.rs:1483-1487), then regenerate `.cursor/mcp.json` so
   `the_repos_own_committed_configs_name_the_launcher` still passes
   byte-for-byte. Check whether Gemini, opencode and Claude Code inherit
   the agent's environment for their MCP child. If any of them does not,
   it needs the same entry.
3. Update the launcher comments in scripts/gavin-mcp and
   scripts/gavin-mcp.cmd: `GAVIN_MCP` is now normally set by the daemon,
   not only by a developer overriding.

Trade-off: the daemon's `GAVIN_MCP` wins over a worktree's own build, so
someone iterating on gavin-mcp in a worktree must set `GAVIN_MCP` to their
build explicitly. The launcher comment should say so.

## Verify

- A pty.rs test in the style of the existing `GAVIN_SESSION_SOCKET` one
  (it prints the variable from inside the PTY, around :844): `GAVIN_MCP`
  names an existing file beside the daemon binary.
- An agent_setup.rs test that the Cursor entry carries the `GAVIN_MCP`
  interpolation.
- In the running app: cut a fresh worktree with no `target/`, open a
  terminal tab in it and run `scripts/gavin-mcp` with an `initialize`
  request on stdin. It should answer, and an agent launched there should
  list the gavin_* tools.
