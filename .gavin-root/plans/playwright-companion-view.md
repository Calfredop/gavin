---
kind: task
title: Companion live view of an agent's browser
parent: feat-tbdeveloped-playwright-integration.md
complexity: complex
---
Bring the same view-only live pane to the Companion. First read:

- the spec `docs/superpowers/specs/2026-10-08-playwright-integration-design.md`;
- the settled decisions in the parent card (`feat-tbdeveloped-playwright-integration.md`);
- `app/companion/README.md`;
- the device-wire docs.

What to build:

- **Transport:** frames reach the Device over the existing forwarding path, with the spec's throttling. Held streams must keep being read.
- **Reuse:** use the desktop pane's `.ts` module wherever the remote shim allows it, rather than a fork.
- **Surface:** the view sits beside the session's terminal on the phone.
- **No setting:** the phone does not read `playwrightPaneOpen`. On the Companion the view is always one tap away from the session and never opens on its own, because a pane taking over a phone screen mid-glance would be worse than a missed frame.
- **Proof:** against the Demo Workstation, plus `crates/daemon/tests/device_wire.rs`-style coverage for the frame forwarding.

Done = `npm run companion:test`, `npm run companion:check` and `npm run companion:build` pass, and a device-wire test receives a frame.

Steps:

- [x] Host: `watch_browser_for_device` / `unwatch_browser_for_device` -- a leased phone-size `WatchBrowser` per session, each frame offered to Devices as `browser-frame`; `REMOTE_COMMAND_TABLE` rows; registry tests
- [x] Companion: the phone's ports over `browserView.ts`, the lease renewed while watched, `browser-frame` listened for only while watching
- [x] Companion: the view beside the session's terminal, one tap from its header, never opened on its own
- [x] Demo Workstation: an agent with a running browser and frames while watched; a seam suite reads the wire
- [x] `device_wire.rs`: a Device receives a phone frame through the Relay
- [x] README, and the checks
- [ ] Human test: On an iPhone in the Companion, open the terminal of an agent that is using its browser: it opens without the browser; the globe in its header puts the live browser above the terminal (beside it with the phone on its side) and it follows the agent's pages; replies still reach the terminal; the globe or the ✕ takes it away

<!-- gavin:auto-commit -->
When the implementation is done, commit it. Commit only the files you touched — never `git add -A`. Do not push.
<!-- /gavin:auto-commit -->
