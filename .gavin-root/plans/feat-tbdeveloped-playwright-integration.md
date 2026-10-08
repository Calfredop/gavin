---
complexity: complex
order: 36864
kind: plan
title: [feat] Playwright integration
status: In Progress
---
Playwright integration: every agent in a gavin workspace can drive a real browser through Microsoft's `@playwright/mcp`, and the human watches that browser live in a pane beside the agent's tab — on the desktop and on the Companion.

**Settled in the interview (2026-10-08) — do not re-litigate:**

- **What:** the Playwright **MCP server** — not the test runner, not the CLI/skill.
- **Init + catchup:** a new **optional** setup-wizard step `playwright`, after `headroom`/`memory` among the tooling steps: detect per profile → Install / "Not now". "Not now" is remembered per root and counts as settled, so workspaces that existed before the step are prompted once by the Home setup banner, not forever.
- **Every stock agent profile** with an MCP layout gets the server entry, in the same file and format gavin writes its own entry to. Custom profiles fall back to the human's word (like agent skills). The AG-07 foreign-server chooser must recognise the entry as gavin's.
- **One headless Chromium per agent session**, launched by the daemon on the agent's first Playwright call. The MCP entry runs a `gavin-mcp playwright` shim that asks the daemon for its session's browser (`GAVIN_SESSION_ID`) and execs a **pinned** `@playwright/mcp` with `--cdp-endpoint`. The browser dies with the session.
- **Live view:** CDP screencast frames streamed by the daemon. The pane is **view-only**, and **when it opens is a setting**: *Open automatically* (default — beside the agent's tab on the first frame) or *Open from the tab chip* (only when the tab's browser chip is clicked). App-wide in Settings, overridable per workspace in workspace settings; the workspace override is stored as an absence like terminal font size (absent = inherit the app value, present = replace it). Closing the pane only hides it; the chip always reopens it. The Companion ignores the setting: there the view is always one tap away, never opened on its own.
- **Rail:** a new `builtin:browser-test-playwright` "Browser test (Playwright)" with the same `url`/`checks` params; `builtin:browser-test` (Chrome) is untouched.
- **In scope:** the Companion live view, ssh workspaces (browser on the host, frames across the bridge), macOS + Windows + Linux.
- **Assumptions:** the `@playwright/mcp` version is pinned in gavin and bumped by hand (supply chain); the browser is headless with no pop-out window; Node/npx is a prerequisite the step detects, not installs.

The spike's spec (`docs/superpowers/specs/2026-10-08-playwright-integration-design.md`) is the design record every child reads first.

Order: spike → broker → (install-wizard ∥ live-pane) → companion → the items below → human tests. The install-wizard card only depends on the shim's name (`gavin-mcp playwright`), so it can start once the spike lands.

- [x] [The spike lands its spec, and the spec answers every open question it lists](./playwright-spike.md)
- [x] [Per-session Chromium + screencast in the daemon, plus the `gavin-mcp playwright` shim](./playwright-browser-broker.md)
- [x] [Per-profile install, wizard step, Home catchup](./playwright-install-wizard.md)
- [ ] [The desktop pane beside the agent's tab, with the app + workspace open setting](./playwright-live-pane.md)
- [ ] [The same view on the phone](./playwright-companion-view.md)
- [x] `builtin:browser-test-playwright` added in `orchestrationTools.ts` (+ `actionPrompts.ts`, the orchestration tools spec table and `gavin_orchestrate_skill.md`); the builtins tests pass
- [x] gavin's managed instructions block and `gavin_skill.md` tell agents the `browser_*` tools exist when Playwright is installed, and to use them to verify UI changes; covered by an `agent_setup.rs` test
- [ ] ssh workspace: install runs on the host, the browser launches there, frames reach the desktop pane through the bridge — proven with an isolated daemon behind a local `gavin-daemon bridge`
- [ ] Human test: on macOS, an agent session that calls `browser_navigate` opens a live pane beside its tab, which follows the agent's clicks and closes with the session
- [ ] Human test: with the workspace override set to "Open from the tab chip" while the app default stays automatic, an agent's first `browser_navigate` opens no pane, and the tab's browser chip opens it
- [ ] Human test: the same macOS run on a Windows machine and on a Linux machine
- [ ] Human test: an ssh workspace on a real remote host shows the live pane
- [ ] Human test: the Companion on a phone shows the live view of a running agent's browser
- [ ] Human test: a workspace created before this step shows the Home banner once, and "Not now" clears it

<!-- gavin:auto-commit -->
When the implementation is done, commit it. Commit only the files you touched — never `git add -A`. Do not push.
<!-- /gavin:auto-commit -->
