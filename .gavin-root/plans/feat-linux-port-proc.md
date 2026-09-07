---
kind: task
title: Linux process probe via /proc
parent: feat-linux-port.md
---
Give `crates/daemon/src/proc.rs` a real Linux implementation. Today
`identify`, `usage` and `children` are libproc calls behind
`#[cfg(target_os = "macos")]` with stubs returning "gone"/nothing
everywhere else, so on Linux recovery never sees a surviving orphan and
the Sessions manager shows blank memory and CPU for every row.

Read the module doc first — every decision in it (fail toward "gone",
the pid+start-time pair as the identity, the tree walk's ceiling) is the
contract the Linux side has to keep, not something to redesign.

What Linux needs, all of it from `/proc`:

- **`identify(pid)`** — parse `/proc/<pid>/stat`. Field 22 (`starttime`)
  is the identity half, in clock ticks since boot: divide by
  `sysconf(_SC_CLK_TCK)` (100 on every mainstream build, but read it)
  and add the boot time from `/proc/stat`'s `btime` line to get an
  absolute microsecond stamp comparable across daemon restarts, the way
  the macOS arm's is. Field 3 (`state`) `Z` is a zombie and must return
  `None`. **The comm field (2) can contain spaces and parentheses**, so
  split at the LAST `)` and index the rest — splitting on whitespace
  from the left is the classic bug here and silently shifts every field.
- **`usage(pid)`** — RSS from `/proc/<pid>/statm` field 2 (in PAGES,
  multiply by `sysconf(_SC_PAGESIZE)`) or `/proc/<pid>/stat` field 24;
  CPU from `utime` + `stime` (fields 14 and 15), ticks again.
- **`children(pid)`** — read `/proc/<pid>/task/*/children`, which is one
  space-separated line per thread. It needs `CONFIG_PROC_CHILDREN`
  (on by default on Ubuntu/Fedora); when the file is absent, fall back
  to scanning `/proc/*/stat` for field 4 (`ppid`) == pid rather than
  returning an empty list, because `tree_usage` reporting only the root
  is how a session pinning four cores reads as 0.2%.

Requirements:

- Nothing in the shared code (`still_running`, `terminate`,
  `tree_usage`) changes: they already ask only the three functions.
- The whole existing `mod tests` must pass unmodified on Linux — it is
  written against behaviour, not against libproc, and it is the
  acceptance criterion. `cargo test -p gavin-daemon proc::` in the
  Linux container (`docker run --rm -v "$PWD":/w -w /w rust:1 …`) is
  how to check without a VM.
- Add a Linux-only test for the comm-with-spaces case: spawn a child
  whose argv[0] contains `) ` and assert `identify` still reads a
  sane start time. Nothing else catches that parse.
- Keep the "fails toward gone" rule: any unreadable or unparseable
  `/proc` entry is `None`, never a guess.
