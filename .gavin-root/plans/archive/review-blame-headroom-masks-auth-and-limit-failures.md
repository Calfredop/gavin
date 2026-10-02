---
kind: task
title: A compressed session's login or usage-limit failure is renamed "Headroom stopped answering" when Headroom is down at the verdict
status: Done
priority: low
complexity: moderate
---
Branch `feat/headroom` (headroom-06, c1de88b8). Work in `.gavin-worktrees/feat-headroom`.

## The defect

`blame_headroom` (`crates/daemon/src/server.rs:555-561`) replaces the failure reason with `HEADROOM_REASON_PREFIX` whenever the session was compressed and `/readyz` does not answer at that moment, WHATEVER line matched. The spec scopes the new cause to the failure that "would be classified `network`" (`docs/superpowers/specs/2026-09-28-headroom-design.md`, "Failures"). The code applies it to every matched line, and to the slept verdict too (`failure_verdict`, `server.rs:498-516`).

Claude Code's patterns match auth lines (`Please run /login`, `OAuth token has expired`) and usage-limit lines (`hit your session limit`) as well as network ones (`app/src-tauri/src/agent_setup.rs:763-795`). Those lines can only have reached the screen from upstream THROUGH Headroom, so they are never Headroom's fault. Once renamed, though, the app classifies them `headroom`, and auto-resume resumes a `headroom` failure on reachability, uncompressed.

## The case that breaks it

- `blame_headroom("API Error: 401 … · Please run /login".into(), true, || false)` returns the Headroom reason. Only `API Error: Connection error` is tested (`server.rs:11489-11517`).
- In the running system: a compressed Claude Code session hits its 5-hour limit, or a 401. Within the seconds before its quiet verdict, Headroom is not answering `/readyz`: an Update's `replace()`, a crash-restart by the supervisor, or `/readyz` taking longer than the 3.5 s budget under a loaded proxy (`http.rs:21-22`).
- The result: auth becomes `headroom`, and auto-resume relaunches uncompressed straight into the login wall, spending the run's attempt. A usage limit is relaunched at once instead of waiting for the reset. In both cases the human's notification names Headroom, not the real cause.

## What to do

Blame Headroom only for a line that is not already somebody else's. The daemon holds each session's failure PATTERNS (`set_failure_patterns`, `server.rs:3550`) but not the causes table; that lives in the app host. Choose one:

- **A.** Widen what the app pushes with the patterns to include each pattern's cause. It is a widened payload, so it needs a `FEATURE_MIN_VERSION` entry and a consumer (see CLAUDE.md, "The compat gate is per request TYPE"). Then blame only a match whose cause is `network` (or has no cause).
- **B.** Keep it daemon-only. Never blame when the matched line also matches an auth or usage-limit marker. That needs a small list pinned against `agent_setup.rs`'s rows by a test in the host, the way `HEADROOM_REASON_PREFIX` is pinned in both languages.

Say which you chose, and why, in the commit body. Add `blame_headroom` tests for an auth line and a usage-limit line with Headroom down: each must keep its own reason.

Run `cargo test -p gavin-daemon --bin gavin-daemon blame` and the host's `agent_setup` tests.
