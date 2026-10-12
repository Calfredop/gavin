---
order: 7200
kind: task
title: Headroom 01: the daemon runs Headroom
status: Done
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

- [x] Detection finds Headroom in the uv tool dir with a Dock-launch `PATH`, and honours a located path (tested)
- [x] The state table is correct at, below and above the floor and pin (tested)
- [x] Every start carries exactly the fixed flags (tested)
- [x] Two daemons (release and dev) run two Headroom processes on different ports and state directories without clashing (tested)
- [x] A killed Headroom is restarted on the same port; a restarted daemon re-adopts a matching Headroom and starts a fresh one otherwise (tested against a fake Headroom, in an isolated daemon under a temp `$HOME`)
- [x] The install and prefetch run under a lock, with a timeout and drained pipes
- [x] The concurrency probe passes against 0.39.1, or its failure is reported on this card
- [x] `cargo test --workspace` green; the `gavin::tests` module re-run alone before calling a failure a regression
- [ ] Decision: Headroom limits itself to 60 requests a minute per (token prefix, client address) by default, so every agent on one subscription login shares one bucket and Headroom itself answers 429 past it. Should the fixed flags turn that off before compressed sessions reach a fleet (headroom-02)?
  Options: A) Add --no-rate-limit (the provider's own limits still apply) B) Raise it with --rpm to a fleet-sized number C) Leave Headroom's default of 60

## Result (2026-09-29)

Done on branch `feat/headroom`, commits `0d9fb405` and `3424ef7d`. Not pushed.

`cargo test --workspace` is green: daemon 794, app 653, protocol 130, gavin-mcp 72, and the integration suites, among them `tests/headroom.rs` (10, against a real `gavin-daemon` under a temp `$HOME`). `gavin::tests` alone: 152 passed. Every guard the new tests rest on was also broken on purpose and seen to fail: the same port after a restart, the reuse guard, the floor at launch, the fixed flags, the environment scrub, the re-adoption rule in both directions, and the shutdown hook.

Where things are: `crates/daemon/src/headroom/` (`detect`, `version`, `launch`, `supervisor`, `install`, `store`, `http`, `run`). The fake Headroom is `crates/daemon/tests/fixtures/fake_headroom.rs`, built with `rustc` at test time so no fake lands in a release build.

### The concurrency probe

It passes against 0.39.1, through a daemon-run Headroom: 18 concurrent requests, every one of the pair compressed (82 KB to about 62 KB) by the log, JSON and model compressors, nothing crossed, every file read intact. It is `crates/daemon/tests/headroom_probe.rs`, ignored by default; the command is in its header.

**A pass is worth less than the spec assumes, and this was measured.**

- #3549 is not content crossing between bodies, which is what the spec asks the probe to check. The state the bug overwrote is the compression policy and the read-protection maps, so its symptom is a protected file read compressed because a concurrent request replaced the map naming it. The probe now checks that too.
- Against 0.37.0, which predates the fix, the pair's half of the probe also passes (16 requests, all compressed, nothing crossed). The read's half cannot be asked of 0.37.0: it compresses a log read even when sent alone.
- So the bug was never reproduced from outside the process. A failure of the probe is proof of a leak; a pass is not proof of its absence. The floor rests on the fix being in the source (0.38.0's content router keeps its runtime state in a `ContextVar`, 0.37.0's on `self`), which I checked in both installs.
- #3556 closes #3486. #3549 is still open upstream and reads as the same bug reported again.

### Four things the spec does not say, and what was done

1. **A daemon asked to shut down stops its Headroom**, and keeps `wanted`, so the next daemon starts it again on the same port. Its sessions end with it, and a proxy left behind holds the compression model in memory with no owner. A daemon that crashes stops nothing, which is the case re-adoption is for. If the owner would rather a requested restart keep the proxy up, it is one line (`close_headroom` in `handle_connection`).
2. **Every inherited `HEADROOM_*` variable is removed before the fixed ones are set.** Each of Headroom's flags has an environment twin, and a daemon started from a terminal carries the human's shell profile. Without this, "exactly the fixed flags" is not true. `HTTPS_PROXY` and the provider target URLs are left alone.
3. **The first candidate at or above the floor wins**, in the spec's order. A stale uv install does not shadow a Headroom the human located.
4. **Stopping signals the process group.** A located file can be a wrapper that starts Python as a child. The proxy gets a group of its own when it is spawned.

### For the merge

**Protocol v45 here collides with `main`'s v45**, which is a different capability set, and `companion/wire` is at 49. This branch was cut at v44. The merge has to renumber Headroom's five requests to the next free number: `PROTOCOL_VERSION`, the `min_version_for` arm, and the two pinned tests.

No `daemonCompat.ts` entry was added. Nothing in the app sends these requests yet, and an entry with no consumer is a dead gate. headroom-04 owes it, with its `featureBlockedReason` consumer.

### Not verified

- **Windows.** The cross-check from this Mac fails before it reaches gavin's code: `ring` (from `ureq`'s TLS, already on the branch) needs an MSVC C compiler. The new code was read for `cfg(unix)` gating, not compiled for Windows.
- **A real `uv tool install` through the daemon.** The install is tested against a fake `uv`. The same command was run by hand into a throwaway directory and installed 0.39.1, and the prefetch command was run against that install and returned 0. headroom-04's human test covers the real button.

### Seen along the way

- **The prefetch fetches the model (264 MB) but not its tokenizer.** `answerdotai/ModernBERT-base` is downloaded on first load. Small, but the first compressed run is not fully offline.
- **The model loads about 6 s after `/readyz` answers.** Requests in that window are compressed without it. Nothing fails.
- **An all-INFO log of 400 lines is compressed to `[400 lines omitted]`**, with a retrieval hash. That is upstream #3590's territory and an argument for watching the savings against the quality of the work.
- `X-Headroom-Project` works: `/stats` reported savings per tagged request.

<!-- gavin:auto-commit -->
When the implementation is done, commit it. Commit only the files you touched — never `git add -A`. Do not push.
<!-- /gavin:auto-commit -->
