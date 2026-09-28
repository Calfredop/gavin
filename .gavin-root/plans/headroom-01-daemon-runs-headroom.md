---
order: 7200
kind: task
title: Headroom 01: the daemon runs Headroom
status: To Do
labels: ready-for-agent
parent: headroom.md
complexity: intricate
---
Blocked by: nothing

Part of `headroom.md`. Read the spec (sections "The daemon runs Headroom" and "Detection and install") and ADR 0007 first.

## What to build

- **Detection, in the daemon.** Look for Headroom in uv's tool bin directory, then `PATH`, then a path the human located. Store the resolved absolute path per machine, and never search `PATH` again at launch. Read the version with `headroom --version` (`headroom, version X.Y.Z`).
- **Floor 0.38.0, pin 0.39.1.** The states are Verified (with a "newer than tested" note above the pin), Too old, Absent, and Unavailable on Intel Macs and Windows.
- **Start it with the fixed flags:** `--host 127.0.0.1 --port <daemon's port>`, `HEADROOM_WORKSPACE_DIR=<state dir>/headroom` or `headroom-dev`, following the socket's dev suffix, `HEADROOM_BEACON=off`, `DO_NOT_TRACK=1`, `HEADROOM_UPDATE_CHECK=off`, `--no-subscription-tracking`. Start it through `crate::program::command`, as an argv array.
- **Lifetime.** Run it while any workspace has compression on. The per-workspace setting itself arrives in 02, so this ticket exposes start and stop, and 02 drives them. Poll `/readyz` for readiness. When the process dies, restart it on the same port.
- **Re-adoption after a daemon crash.** Record the pid and its start time. A restarted daemon re-adopts its Headroom when the pid (start time as the reuse guard, as orphan recovery does), `/health`'s `service: "headroom-proxy"` and `version`, and the port all match. Otherwise it starts a fresh one. It never stops a Headroom it did not start. Do not use Headroom's `HEADROOM_WRAP_OWNED` watchdog.
- **Requests** for status (state, version, pin, port, running, lifetime savings from `/stats`' `persistent_savings`), start and stop, plus the install that 04's button calls: `uv tool install --python 3.13 "headroom-ai[all]==<pin>"`, then the model prefetch through the tool's Python (`prefetch_kompress_artifacts()`). The install runs with a timeout, both pipes drained on threads, and one machine-wide lock (the `superpowers.rs` shape). Bump the protocol.
- **The concurrency probe.** Against the real pinned Headroom, send two concurrent compressed requests with distinct content and check that neither's upstream body carries the other's (#3549). If it fails, stop and report: the floor rises or the default goes lossless.

## Acceptance criteria

- [ ] Detection finds Headroom in the uv tool dir with a Dock-launch `PATH`, and honours a located path (tested)
- [ ] The state table is correct at, below and above the floor and pin (tested)
- [ ] Every start carries exactly the fixed flags (tested)
- [ ] Two daemons (release and dev) run two Headroom processes on different ports and state directories without clashing (tested)
- [ ] A killed Headroom is restarted on the same port; a restarted daemon re-adopts a matching Headroom and starts a fresh one otherwise (tested against a fake Headroom, in an isolated daemon under a temp `$HOME`)
- [ ] The install and prefetch run under a lock, with a timeout and drained pipes
- [ ] The concurrency probe passes against 0.39.1, or its failure is reported on this card
- [ ] `cargo test --workspace` green; the `gavin::tests` module re-run alone before calling a failure a regression

<!-- gavin:auto-commit -->
When the implementation is done, commit it. Commit only the files you touched — never `git add -A`. Do not push.
<!-- /gavin:auto-commit -->
