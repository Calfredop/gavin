---
kind: task
title: Playwright spike: shared CDP browser + screencast
parent: feat-tbdeveloped-playwright-integration.md
complexity: intricate
---
Prove the architecture before anyone builds it, then write the design spec at `docs/superpowers/specs/2026-10-08-playwright-integration-design.md`. The settled decisions are in the parent card (`feat-tbdeveloped-playwright-integration.md`). Copy them in as the spec's opening and don't reopen them.

Answer each of these with evidence from runs on this Mac, not from docs:

1. Which Chromium the daemon launches: Playwright's `chromium-headless-shell` from `npx playwright install` or another. Say how the daemon finds its path on macOS, Windows and Linux, and how it reads the CDP port (`--remote-debugging-port=0` + `DevToolsActivePort`).
2. Whether a pinned `@playwright/mcp` with `--cdp-endpoint` drives that browser correctly. Cover a new context vs the existing one, new tabs, popups, and what happens when the browser dies mid-call. Pick the version to pin.
3. Whether `Page.startScreencast` can follow whichever target the agent is on while the MCP drives it, as a second CDP client. Cover tab switches and navigations.
4. Frame size and rate at reasonable `quality`/`everyNthFrame` settings, and what that costs on the local socket, the ssh bridge and the Relay to a phone. Propose throttling numbers.
5. How the blocking, sync daemon speaks CDP's websocket. See what `gavin-relay`'s `client` feature and the workspace already depend on.
6. The protocol shape: the request(s) the shim and the pane need, and the push that carries frames. Follow the compat-gate rules in CLAUDE.md, and take the next free `PROTOCOL_VERSION` on `main` at landing time.

Throwaway spike code goes in the scratchpad, not the repo. The deliverable is the spec plus a short "what the broker card must do" section.

Done = the spec is committed and answers all six with what you observed.

<!-- gavin:auto-commit -->
When the implementation is done, commit it. Commit only the files you touched — never `git add -A`. Do not push.
<!-- /gavin:auto-commit -->
