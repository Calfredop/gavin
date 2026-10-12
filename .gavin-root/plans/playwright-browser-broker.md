---
kind: task
title: Playwright browser broker in the daemon + gavin-mcp shim
parent: feat-tbdeveloped-playwright-integration.md
complexity: intricate
---
Build what the broker section of `docs/superpowers/specs/2026-10-08-playwright-integration-design.md` describes. First read the spec and the settled decisions in the parent card (`feat-tbdeveloped-playwright-integration.md`).

- **Daemon:** one headless Chromium per session, launched on the first request and tied to the session's lifecycle.
  - Kill and orphan cleanup follow the existing session-tree and orphan-recovery patterns. No Chromium may outlive its session or survive a daemon restart.
  - Expose the CDP endpoint and a screencast subscription as protocol requests and pushes. That means a protocol bump, a `min_version_for` entry and a `FEATURE_MIN_VERSION` entry in `app/src/lib/daemonCompat.ts`.
- **Platforms:** launch and Chromium path discovery work on macOS, Windows and Linux, and CI covers all three.
- **`gavin-mcp playwright`:** a subcommand that resolves this session's endpoint through the daemon (`GAVIN_SESSION_ID`) and execs the pinned `@playwright/mcp --cdp-endpoint …`, with stdio passed straight through. With no session id, or with Playwright not installed, it fails with a message that says why.
- **Tests:** a daemon integration test under a temp `$HOME` (the isolated-daemon pattern; never touch the shared daemon). It launches a browser for a session, receives at least one frame, and confirms the process is gone after the session is killed. Where no Chromium is installed, it skips with a stated reason.

Done = that test and `cargo test --workspace` pass, and `gavin-mcp playwright` drives a page from a real Claude Code session against an isolated daemon.

<!-- gavin:auto-commit -->
When the implementation is done, commit it. Commit only the files you touched — never `git add -A`. Do not push.
<!-- /gavin:auto-commit -->
