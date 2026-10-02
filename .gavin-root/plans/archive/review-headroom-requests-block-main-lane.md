---
kind: task
title: Headroom status, reach and detect requests run blocking HTTP and `headroom --version` on the in-order main command lane
status: Done
priority: medium
complexity: simple
---
Branch `feat/headroom` (headroom-04/05/06). Work in `.gavin-worktrees/feat-headroom`.

## The defect

The daemon serves each connection strictly in order on one thread. So the host routes reads that can take seconds to the second connection, by listing them in `is_slow_read` (`app/src-tauri/src/command_lane.rs:113`, routing at `:431`). Three Headroom requests can take seconds and are not listed. They ride the main lane, where `CreateSession`, board writes and rail step-run writes queue behind them.

- **`DetectHeadroom`** (Check again, Locate…; host `session.rs:5949`). It runs `headroom --version` inline on the connection thread (`detect.rs:259`). That is about 1.8 s warm (Python start plus the package import), and up to `VERSION_TIMEOUT` = 20 s (`detect.rs:23`).
- **`GetHeadroomStatus`** (host `session.rs:5904`). Settings polls it every 1.5–5 s while open. Whenever the savings reading is older than `SAVINGS_FRESH` = 10 s (`supervisor.rs:60`), `Supervisor::snapshot` (`supervisor.rs:332`) makes a `/stats` GET inline. That is 500 ms connect plus a 3 s read timeout (`http.rs:21-22`), and the code's own comments call `/stats` "megabytes on a long-lived proxy".
- **`HeadroomReach`** (host `session.rs:5843`). The app sends it at every working→idle of a compressed run session until the answer is `reached` (`headroomReachDriver.ts`). `Headroom::reach` (`headroom/mod.rs:308`) makes the same inline `/stats` GET and full parse. In a fleet past 50 tagged sessions the answer stays `unknown` (reach.rs), so it is re-asked at EVERY turn end of every compressed run.

## The cases that break it

- Settings is open and Headroom is running with a large `/stats`. Every 10 s a status poll holds the main lane for the `/stats` read, and a card run's `CreateSession` issued in that window waits for it.
- A rail fleet of compressed runs: every turn end queues a `/stats` read on the main lane, one after another, ahead of the rail scheduler's step-run writes.
- Locate… picks a file that hangs on `--version`: the main lane stalls for 20 s, for every window.

## What to do

1. Add `Request::GetHeadroomStatus`, `Request::DetectHeadroom { .. }` and `Request::HeadroomReach { .. }` to `is_slow_read`. None is a write that a later request must follow. `DetectHeadroom` does write the located path, but its caller awaits the reply before acting on it, so check that every caller does before you move it, and say so in the commit body.
2. Add `is_slow_read` assertions in `command_lane.rs`'s tests, following the existing ones.
3. Optional, and a separate commit: `http::project_view` and `http::session_savings` each fetch and parse `/stats` separately. One typed read of `per_project` could serve both.

Run `cargo test -p app` for the app host's `command_lane` tests. Saving under `app/src-tauri` relaunches the owner's dev app, so batch the Rust edits.
