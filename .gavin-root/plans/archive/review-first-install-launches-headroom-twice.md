---
kind: task
title: Installing Headroom while a workspace already wants it launches it, kills it, and launches it again
status: Done
priority: low
complexity: trivial
---
Branch `feat/headroom` (headroom-04, e170016d). Work in `.gavin-worktrees/feat-headroom`.

## The defect

`Supervisor::replace` (`crates/daemon/src/headroom/supervisor.rs:285-295`) sets `replace = true` whenever the supervising thread exists, whether or not a process is running. In the loop (`supervisor.rs:478-507`), the no-process branch sleeps in `pause(backoff)`, wakes on the replace's nudge, and calls `launch()` without taking the flag. On the next pass, `take_replace()` (`:479`) is true, so the loop stops the process it has just launched and launches another.

## The case that breaks it

1. A workspace's compression is switched on before Headroom is installed (the switch allows this). The supervisor runs, and each launch fails with "Headroom has not been found on this machine."
2. The human presses Install.
3. The install thread calls `replace()` (the path went from none to some, `headroom/mod.rs:410`), then `nudge()`.

An instrumented run logged `LAUNCH pid=87868 v0.39.1`, then `REPLACE owned=true`, then `LAUNCH pid=87870`. The same happens for Update from Too old, where nothing was running either. It costs one wasted Headroom start (the compression model starts loading), a stop wait of up to 5 s, and that much longer before the first compressed launch. Every launch in that window is uncompressed with `not-ready`.

## What to do

Set the flag in `replace()` only when a process is running (`shared.pid.is_some()`), or clear it in the no-process branch before `launch()`. Either keeps "one install is one replacement". Add a supervisor test against the fake Headroom: with no process and the thread paused, `replace()` followed by a nudge must launch exactly once.

Run `cargo test -p gavin-daemon --bin gavin-daemon headroom::supervisor`.

Coordinate with `review-headroom-update-leaves-old-proxy-serving.md`, which changes when `replace()` is called; whichever lands second rebases onto the other.
