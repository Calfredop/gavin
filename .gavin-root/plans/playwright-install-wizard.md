---
kind: task
title: Playwright install per agent profile + wizard step + Home catchup
parent: feat-tbdeveloped-playwright-integration.md
complexity: complex
---
Make Playwright installable per workspace, for every stock agent profile. First read:

- the spec `docs/superpowers/specs/2026-10-08-playwright-integration-design.md`;
- the settled decisions in the parent card (`feat-tbdeveloped-playwright-integration.md`);
- `docs/superpowers/specs/2026-10-05-mattpocock-skills-install-matrix.md`;
- `app/src-tauri/src/agent_skills.rs`.

That module's two rules apply here too: never guess a detector, and the detector, not the installer, reports what happened.

- **Rust** — a new `app/src-tauri/src/agent_playwright.rs` beside `agent_skills.rs`:
  - Detection checks that Node/npx is present, that the Chromium is installed, and that the `playwright` server entry is in this profile's MCP config.
  - Install runs the browser install, then merges the entry (command = the launcher + `playwright`) through `agent_setup.rs`'s merge-aware writers, JSON and TOML.
  - Every stock profile with an MCP layout is covered. A custom profile reports `Unavailable` and takes the human's word.
  - The AG-07 foreign-server scan treats the `playwright` entry as gavin's.
  - ssh workspaces go through `WorkspaceFiles`, and the install runs on the host.
- **Wizard:**
  - A `playwright` step in `SETUP_STEPS`, after the tooling steps.
  - Its logic lives in `setupWizard.ts` (`playwrightStepDone`/`playwrightStepSettled`), with a thin `wizardSteps/PlaywrightStep.svelte` over it.
  - "Not now" is remembered per root and counts as settled.
  - The Home banner's count and nag read `SETUP_STEPS`, so a workspace that existed before the step is prompted once.
- **Tests:**
  - Rust detection and write tests for each profile format, including a pre-existing MCP file with foreign servers.
  - `setupWizard.test.ts` cases for done, settled and not-now.

Done = `cargo test --workspace`, `npm test` and `npm run check` pass, and installing into a fresh temp workspace writes a correct entry for each stock profile.

<!-- gavin:auto-commit -->
When the implementation is done, commit it. Commit only the files you touched — never `git add -A`. Do not push.
<!-- /gavin:auto-commit -->
