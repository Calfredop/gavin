---
order: 10752
title: [fix] the daemon's own git spawns open a console window when the daemon has none
labels: windows
status: Done
priority: high
complexity: moderate
---
Reported 2026-09-17: the installed Gavin on the second Windows machine
still opens a window for every rail step.

## What was checked here

Every rail step is a `CreateSession` with a command line, run as
`sh.exe -c <line>` under ConPTY (`pty.rs`). Reproduced that exact spawn
outside the daemon (a scratch portable-pty program started with
`CREATE_NO_WINDOW`, like the release daemon) and sampled visible top-level
windows at 200 ms while each shape ran: `agent.cmd`, `powershell -File
cursor-agent.ps1`, the bundled-node rewrite, `claude`, a `cd . && ...`
chain, and the Cursor TUI itself through both shim shapes. Zero new
windows in every case; the TUI drew inside the PTY. So on a daemon that
owns a console the PTY path opens nothing, and the shim rewrite (94c60c7,
3b92154) is not what is missing.

What DOES open a window per step is the daemon's own `git`:
`update_session_repo_mapping` runs `git rev-parse --show-toplevel` on
every new session (`server.rs`), and a new repo root starts a poller that
runs `git status` at once and every 180 s. Those `Command::new("git")`
sites (`git_status.rs` x3, `git --exec-path` in `shell.rs`) set no
creation flags, so they inherit the daemon's console -- and a daemon
with NO console gives each of them a new one, which is a window. The
09-10 fix (fix-release-app-console-windows-on-windows.md) put
`CREATE_NO_WINDOW` on the APP's spawn of the daemon and left this
"defense in depth" item unticked. That fix never reaches a daemon the
fixed app did not start: the daemon outlives the app by design, the
installer does not stop it, MIN_COMPATIBLE_VERSION is 5 so the new app
adopts a daemon from any build since 09-10 and only greys features out,
and a daemon started by hand from a terminal loses its console when that
terminal closes.

## Fix

- [x] `crates/daemon/src/program.rs`: `CREATE_NO_WINDOW` and
      `command(program) -> Command`, the daemon-side twin of the app's
      `program::command`, with the same flag-contract test and the same
      real-child `GetConsoleProcessList` proof (polled: a child joins the
      console after `CreateProcess` returns, and the first sample missed
      it).
- [x] Route `git_status.rs` (`resolve_repo_root`, `head_sha`,
      `run_git_capture`) and `shell.rs` (`git_exec_path`) through it.
- [x] Lint test: no `Command::new(` in non-test daemon code outside
      `program.rs`, so a new spawn site cannot reopen this. The scan is a
      function of its own, tested against a fixture so the
      `#[cfg(test)]` cut is proved rather than assumed.
- [x] `main.rs` logs `gavin-daemon console: attached` or `none (each
      child gets a hidden one)` at startup, so the daemon log on the
      other machine can answer the question this card could not.
- [ ] Human, on the other machine: `Get-Process gavin-daemon | Select
      Path, StartTime` against the app's install time. A daemon older than
      the app is the state above; Restart daemon in Settings (or a reboot)
      ends it, and the windows should stop before this fix even ships
      there. After the next install the daemon log's console line says
      which state it was in.

`cargo test -p gavin-daemon -- --test-threads=4 program:: git_status::
shell::`: 57 passed. Done 2026-09-17; uncommitted in the shared tree.
