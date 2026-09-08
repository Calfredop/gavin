---
kind: task
title: Memory probe and fleet memory store
parent: issue.md
complexity: moderate
---
Give the app one place that knows how much memory the machine and the fleet are using.

**Host side.** A new `app/src-tauri/src/memory.rs` modelled on `agent_usage.rs`, registered in `lib.rs` and reached from `backend.ts`:

- `system_memory`: total bytes, free percent (`kern.memorystatus_level`), pressure as normal / warn / critical (`kern.memorystatus_vm_pressure_level` 1 / 2 / 4), swap used (`vm.swapusage`) and a sample time, read with `libc::sysctlbyname`. On a non-macOS target return "unsupported" so callers treat pressure as normal and the estimate as unavailable.
- `watchman_status`: `None` when no watchman server is alive. Check the pid (the pidfile under `~/.local/state/watchman/<user>-state/pid`, or the process list) and never invoke the `watchman` CLI otherwise, because the CLI starts a server. When alive: its RSS via `proc_pidinfo` the way `crates/daemon/src/proc.rs` reads it, and its roots from `watchman watch-list` (JSON).
- `watchman_forget(root)`: runs `watchman watch-del <root>`.
- Call `watchman_forget` from `worktree_remove` in `app/src-tauri/src/git/commands.rs` when a server is alive, so a worktree gavin deletes stops costing memory. Watchman keeps a deleted root's whole tree in memory for five days unless told to drop it.

**Frontend.** `app/src/lib/memoryState.ts`: a module-level poller started and torn down like `startPauseClock` in `agentPauseState.ts` (every 5 s, every 2 s while pressure is not normal). It also takes the daemon's `SessionProcesses` sample app-wide: today only the sessions manager asks for it, and only while open. Expose a `systemMemory` store, a per-session `agentSessions` store (rss, command, process count) and a derived `fleetMemory` (agent RSS total, agent count, mean tree RSS per agent profile).

**Pure module.** `app/src/lib/memory.ts` with tests: pressure from the sysctl value, watch-list JSON to roots, bytes formatting, mean-per-profile with a 1.5 GB floor.

**Tests.** Rust unit tests for the parsers with fake values; one macOS test that `system_memory` returns a sample. `memory.test.ts` for every pure helper. Done when `cargo test -p gavin` (the Tauri crate) and `cd app && npm test && npm run check` are green and the stores read real figures in the running app.

Nothing here touches the daemon or the protocol.
