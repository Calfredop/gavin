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

<!-- gavin:auto-commit -->
When the implementation is done, commit it. Commit only the files you touched — never `git add -A`. Do not push.
<!-- /gavin:auto-commit -->
