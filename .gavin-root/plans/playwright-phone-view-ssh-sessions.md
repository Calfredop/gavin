---
kind: task
title: Phone live view of an agent's browser in an ssh workspace
status: To Do
priority: low
complexity: complex
---
The Companion's live view of an agent's browser (c4b6b703) works only for a session on the desk's own machine. For an ssh workspace's session the phone says why instead of streaming. A phone-size `WatchBrowser` would have to ride the host's one streaming connection, and a `BrowserFrame` carries no size, so the desk could not tell the phone's frames from its own pane's.

Make the phone view work for an ssh session too. First read `docs/superpowers/specs/2026-10-08-playwright-integration-design.md` (Q4, Q6) and the commit message of c4b6b703. Then pick one of these two, and say in the commit why the other lost:
- (a) A protocol bump. `BrowserFrame` gains its `size` (`serde(default)` = desk). The desk then routes the host's phone frames to the Device lease and its desk frames to the pane, on the one connection. This needs a `FEATURE_MIN_VERSION` consumer, because it widens a push, not a request.
- (b) A second streaming connection to the host for phone frames only, held only while a Device lease is live, which costs a second ssh process.

Prove it with an isolated daemon behind a local `gavin-daemon bridge` (the pattern in `crates/daemon/tests/playwright.rs`). Then file `Human test:` — an ssh workspace's agent's browser shows live on the phone.
