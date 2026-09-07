---
kind: task
title: [feat] windows process probe
parent: feat-windows-port.md
---
Implement the Windows side of `crates/daemon/src/proc.rs`, keeping its contract that every probe fails toward "gone".

- `identify(pid)`: `OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION)` plus `GetProcessTimes` creation time, converted from FILETIME to microseconds since the Unix epoch for `started_at_us`. `None` when the handle cannot be opened, when `GetExitCodeProcess` is not `STILL_ACTIVE`, or when the process belongs to another user.
- `usage(pid)`: `GetProcessMemoryInfo` WorkingSetSize for `rss_bytes`; kernel + user from `GetProcessTimes` for `cpu_time_us`.
- `children(pid)`: `CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS)` filtered by `th32ParentProcessID`, capped at `MAX_TREE_PROCESSES`, and each child's creation time checked to be after the parent's, because pids recycle on Windows too.
- `terminate`: there is no SIGTERM. Re-check identity, then `TerminateProcess`, and rewrite the doc comment so the "polite" contract is stated honestly for Windows. Gate the existing `libc::kill` path under `#[cfg(unix)]`.

Use the `windows` crate (features `Win32_System_Threading`, `Win32_System_ProcessStatus`, `Win32_System_Diagnostics_ToolHelp`) as a `[target.'cfg(windows)'.dependencies]` entry so the macOS build is unchanged. Mirror the existing proc.rs tests with `cmd /C` in place of `/bin/sh -c`, gated `#[cfg(windows)]`.

Depends on the transport child (`feat-windows-port-transport.md`) landing first, since nothing in the daemon compiles on Windows before it.

Done when `cargo test -p gavin-daemon proc` passes on Windows (the parent card's CI job or a Windows machine) and the macOS suite is untouched. Then tick the parent's "Process probe" item.
