---
order: 4096
kind: plan
title: [feat] Superpowers integration
status: To Do
---
On workspace init wizard and as an option in workspace's settings, the user should be able to install the agentic plugin called "Superpower". Read the docs:

https://github.com/obra/superpowers

With paths dipendents of the currently using agent the plugin should be installed if not present. During the wizard the user should be explained that the plugin deeply improves the plan and debug flows with Gavin.
In the settings the button should be shown only if superpower is not installed. If installed a "Supowerpowers plugin" with a green indicator (led like) should be shown.

## Decided (2026-09-01)

- **S1 — All five profiles get a Superpowers row.** Install where gavin can
  run it; the paste-able command where it cannot (Cursor and Kimi install
  through an in-TUI slash command, Codex and opencode document no command
  at all).
- **S2 — A real fifth wizard step, third in order:** Agent → Integration →
  **Superpowers** → PRD → Launch. It is agent tooling, so it belongs beside
  Integration; PRD and Launch stay last.
- **S3 — Source is `superpowers@claude-plugins-official`.** That marketplace
  is configured on every Claude Code install, so there is no
  `marketplace add` and no trust prompt for gavin to answer on the human's
  behalf.
- **S4 — Install at project scope** (`--scope project`), so the record
  travels with the repo.
- **S5 — Green means "active for this workspace on this machine".** User,
  project and local scope all count: a plugin enabled machine-wide is
  working in that session, and offering to install it again would be a lie
  in the other direction.
- **S6 — The step is done when detection says installed OR the marker is
  set** (below). Without that second route, declining once leaves the Home
  banner nagging forever.
- **S7 — The install runs hidden, with a "Show output" drawer** on both
  surfaces.
- **S8 — Real detection per profile as far as the spike can verify.** A
  profile whose detection cannot be verified falls back to the manual
  "I've installed it", and the row shows that it is an assertion rather
  than a check.
- **S9 — The marker is machine-local** (the app's `config.json`), because a
  repo can travel to a machine that has no Superpowers: an assertion made
  on one machine must not silently vouch for another. Consequence, recorded
  so nobody adds one later: **no protocol bump and no `FEATURE_MIN_VERSION`
  entry.** The alternative — an `[agent].superpowers` key in
  `.gavin-root/config.toml` — was rejected for exactly that reason, and it
  would have cost a v20 bump: the daemon allow-lists config keys
  (`crates/daemon/src/gavin.rs:1032`), so a new key widens
  `SetRootConfigField`, which `min_version_for` gates by type and therefore
  cannot see.

## Steps

- [ ] `app/src-tauri/src/superpowers.rs`: `superpowers_status(root)` and `superpowers_install(root)` Tauri commands driven by the spike's matrix, subprocesses run in `git/run.rs`'s shape (argv array, timeout, pipes drained on threads). Status returns `{ state, detail, command, output }`; unit tests parse recorded fixture output per detector.
- [ ] Detection asks "active here, on this machine" — `claude plugin list --json`, any marketplace, any scope, `enabled: true` — not just `<root>/.claude/settings.json`: a repo carried to a new machine ships the settings entry without the plugin.
- [ ] Install runs `claude plugin install superpowers@claude-plugins-official --scope project -y` in the workspace root; failure surfaces stderr verbatim (a Finder-launched app's stripped PATH is the first thing that will bite).
- [ ] Machine-local marker in the app's `config.json`, keyed by workspace root: `installed` (the human's word) or `skipped`. Straight to Tauri like `setAgentModelDefault`, so it needs no daemon request and keeps working against any daemon.
- [ ] `app/src/lib/superpowers.ts` + tests: the pure model — `verified` / `asserted` / `absent` / `unavailable(reason)`, the per-profile copy command, and `superpowersDone()`.
- [ ] `setupWizard.ts`: `"superpowers"` joins `SetupStep` and `ORDER` in third place; done per S6; its inputs join the existing `pending` rule so a mid-read state never reads as "not done".
- [ ] Every four-step assumption becomes five — the wizard stepper, the Home hub's "N of 4" setup banner, `setupWizard.test.ts`. Grep for it so none is left behind.
- [ ] `wizardSteps/SuperpowersStep.svelte`: the explainer (Superpowers deepens gavin's plan and debug flows), Install for profiles that support it, the copy-command block for those that do not, "I've installed it", "Not now", and the output drawer.
- [ ] Settings → Agent section: the Install button **only** when absent; otherwise a "Superpowers plugin" row with a green LED — visibly distinct for `asserted`, which is the human's word rather than a check; the same output drawer; a named reason where the profile cannot be installed into.
- [ ] Both surfaces note that a freshly installed plugin only reaches sessions started after it.
- [ ] `cargo test --workspace` and `cd app && npm test && npm run check && npm run build` green; smoke items appended to `smokeChecklist.ts` for the wizard step and the settings row.
