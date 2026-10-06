---
complexity: complex
order: 39936
kind: plan
title: [feat][rework] agent’s settings
status: In Progress
---
Centralize agent management in one Agents settings hub (app + workspace),
with multiple named custom agents as first-class profiles, and the same hub
on Companion.

## Done when
- App Settings and Workspace Settings each have one **Agents** nav item with
  inner tabs: Defaults · Customs · Complexity · Fallback · Pause (workspace
  also has a **This agent** tab for profile/command/model/effort/flags and
  the setup controls that already live under Agent).
- Headroom, Tools, and TypeSafe stay separate top-level sections.
- Named customs are real profile ids (not one hard-coded `custom`): app-wide
  library plus workspace-local customs; scoped ids; in a workspace the picker
  lists built-ins, then app-wide customs, then that workspace’s locals
  (locals marked); local wins when both are offered.
- Today’s single app-wide custom migrates to one named profile; stored
  references to `custom` are rewritten; the hard-coded `custom` id is gone.
- Cards, complexity, fallback, Best-of-N, arm/change wizards gain the new
  ids from the profile store without a UI redesign — only fixes for the
  retired `custom` id.
- Init wizard Agent step briefly says multiple agents are managed in Settings
  (no redesign of that step).
- Companion Phone app + workspace settings get the same Agents hub.
- Settings search still finds the moved controls.

## Out of scope
- Redesigning Best-of-N, card agent controls, or arm/change wizards beyond
  profile-list pickup / `custom` cleanup.
- Full init-wizard redesign around customs.
- Moving Headroom, Tools, or TypeSafe into Agents.

## Plan
- [x] [Custom profiles model + migrate `custom`](./custom-profiles-model.md)
- [x] [Desktop Agents hub (app + workspace)](./desktop-agents-hub.md)
- [x] [Companion Agents hub](./companion-agents-hub.md)
- [x] Init wizard: short note that multiple agents are managed in Settings

## Rework 2026-10-05: General + per-agent tabs

The human reviewed the landed hub (aca9727f) and rejected the
Defaults · Customs · Complexity · Fallback · Pause layout. Agreed design:

- **One General tab + one tab per agent** (built-ins, then app-wide customs,
  then workspace locals, locals marked), in both App Settings and Workspace
  Settings, on desk and Companion.
- **General tab**: default agent picker (a NEW app-wide setting; today a
  profile-less workspace silently falls back to claude-code), the fallback
  chain of the selected default agent (switching the default agent switches
  the chain shown), complexity routing, pause.
- **Per-agent tabs**: that agent's own fields — command, model/effort flags,
  model/effort defaults, API family, and its fallback chain as primary
  ("each agent must have its fallback"). Customs CRUD lives on the custom's
  own tab. In workspace settings the "This agent" content folds into the
  per-agent tabs: the workspace's chosen agent + setup wizard moves to
  General, setup controls (agent file, MCP, Superpowers) show on the active
  agent's tab.
- **Fallback chains become per-primary-agent** (app-wide and workspace),
  keyed by the launch's resolved profile id. Migration folds the old single
  chain onto every profile known at migration time so behaviour is unchanged
  for existing configs. Thresholds stay keyed by profile id, unchanged.

### Checklist
- [x] [Data model: default-agent setting + per-primary fallback chains (Rust config/session/workspace_settings, TS types, migrations, decideLaunch/launchDecision keying, fixture updates)](./done/data-model-default-agent-setting-per-primary-fallback-chains-rust-config-session-workspace-settings-ts-types-migrations-decidelaunch-launchdecision-keying-fixture-updates.md)
- [x] [Desktop: General + per-agent tabs in GlobalSettingsView and SettingsHubView; settings search lands on the new tabs](./done/desktop-general-per-agent-tabs-in-globalsettingsview-and-settingshubview-settings-search-lands-on-the-new-tabs.md)
- [x] [Companion: same tab layout on PhoneAppSettings and PhoneWorkspaceSettings](./done/companion-same-tab-layout-on-phoneappsettings-and-phoneworkspacesettings.md)
- [x] Code review of the rework diff

## Review round 2 (2026-10-05): per-agent everything

Human reviewed the running rework and asked for four changes. Principle,
in their words: max granularity on the agent + General edits the selected
default agent's own config (same data, no override layer — the fallback
chain pattern).

- **Add custom becomes a "+" tab** at the end of the tab strip, with the
  existing tooltip component showing the hint text that currently sits at
  the bottom of General's add section. The add section leaves General.
- **Complexity is per agent**: a FULL table (agent + model + effort per
  level) per primary agent; the table that applies is the one belonging to
  the agent the workspace/launch runs. General edits the selected default
  agent's table. Migration folds the old single table onto every known
  primary, same pattern as fallbackChains. Workspace overrides per primary
  with inherit semantics, same as fallbackChains.
- **Pause is per agent**: same model — per-primary cycles app-wide,
  workspace override/inherit per primary, General edits the default agent's
  cycle. Migration folds the existing cycle onto every known primary.
- **Prompt params per agent**: each agent gets two add/remove line lists —
  extra prompt-text lines (appended to the composed prompt) and extra CLI
  args (appended to its launch command). General edits the default agent's
  lists. Workspace settings get the same lists per agent, defaulting to the
  app's (same inherit semantics as fallbackChains: key absent = inherit,
  present = override, empty = none).

### Checklist
- [x] "+"" add-custom tab with tooltip; add section out of General (desk + Companion)
- [x] Per-primary complexity tables (storage, migration, attribution keying, UI binding, workspace inherit)
- [x] Per-primary pause cycles (storage, migration, launchDecision/mayStartWork keying, UI binding, workspace inherit)
- [x] Per-agent prompt lines + CLI args (storage, compose_agent_prompt + launch composition, list editor UI)
- [x] Code review of review-round-2 diff
- [ ] Human test: App Settings → Agents — General tab (default agent; under it that agent's fallback chain, complexity, pause, prompt lines and CLI arguments, which re-point when the default changes); one tab per agent with its own; the trailing "+" tab (hover for its hint) adds a custom and opens its tab; restart and confirm migration from an old single-`custom` / single-chain / single-complexity / single-pause config
- [ ] Human test: Workspace Settings → Agents — choose the workspace agent in General; every block follows the app-wide value until its "give this workspace its own …" box is ticked; per-agent tabs edit overrides; workspace-local custom appears (marked) with its own tab; This agent launches as shown, CLI arguments included
- [ ] Human test: Companion — same General + per-agent tabs on app + workspace settings; CRUD and picks match the desk

### How round 2 landed (decisions a later reader should not re-derive)

- **One panel, two homes.** `AgentPrimaryPanel.svelte` (desk) and
  `PhoneAgentPrimary.svelte` (Companion) draw fallback · complexity · pause ·
  prompt lines · CLI arguments for ONE agent in either scope. General points
  it at the default agent (app) or the workspace's resolved agent (workspace);
  every agent tab points it at its own agent — the same data, so there is no
  "override layer" between General and a tab. What applies where is
  `agentPrimary.ts` (`primaryView`, the `save*` writers), unit-tested.
- **Inherit means key-absent, never empty.** A workspace key for an agent
  replaces the app's value WHOLE: an own empty list is "none", an own empty
  complexity table is "no routing here", an own cycle with `enabled:false` is
  "never paused" — each block has its own "give this workspace its own …"
  toggle for that reason. App scope strips empties (nothing inherits from it).
- **The key is the launch's resolved primary**, not the workspace's agent: a
  card whose complexity routes it to codex is held by codex's pause cycle and
  walks codex's chain. The complexity table itself is read once, from the
  workspace agent's table (`agentForCard`), because that is what rates a card.
  A primary with no cycle is never held — including at usage limits, since the
  limit gate is part of the cycle; migration folds the old single cycle onto
  every known primary so existing installs behave as before.
- **Prompt lines** are appended (blank line, then one per line) to every prompt
  gavin composes for a visible agent: card run/resume/review/develop, Best-of-N
  candidates, rail card and agent-tool steps, code/critical review launches,
  workspace agent tools, and the setup flows (host-side `append_prompt_extras`,
  same format). Not to hidden headless runs (the commit-via-agent run).
  **CLI arguments** ride `ResolvedAgent.launchCommand` (after model/effort
  flags, before the session id and prompt), so they reach every launch and
  headless run built from it. They are verbatim argv words, so a bare-positional
  agent (claude, codex, a custom) also gets `-- ` as its prompt prefix whenever
  there are extras (`withExtraCliArgs`): a variadic option in them
  (`--add-dir <dirs...>`) would otherwise read the prompt as one more value.
- **Gone:** `get_agent_pause` / `set_agent_pause` (cycles ride
  `set_agent_defaults` / the workspace settings patch), `loadAgentPause`,
  `complexityEntry`, the app-wide single `complexity` table. The Tauri
  `AgentPause` state and the positional `agent_pause` of `persist_workspaces`
  remain as deserialization-only legacy (always `None` once migrated).
- Verified in the Companion's Demo Workstation (real render): General + agent
  tabs, "+" adds a custom and selects its tab, a prompt line round-trips and is
  per agent, workspace toggles seed from the app value. The desk pages cannot
  be rendered outside Tauri, so they are covered by type-check, the shared
  panel's logic tests and static-source guards only — hence the human tests.

### Review of the landed diff (2026-10-06) — what it found, what was done

Fixed in the follow-up commit: the workspace migration lost the old PER-LEVEL
fall-through (a workspace's rows now overlay the app table per level when
folded); workspace-local customs were missed by the app-wide fold (seeded from
the legacy table/cycle); extras could swallow the prompt (the `--` above); the
list editor's draft leaked between agents (keyed by scope/workspace/agent); a
fallback hop ignored the candidate's OWN pause window (`cyclePausedFor`);
agents reachable only through a complexity table were never polled; a rail
step skipped for a routed agent's pause was never told it lifted (the tick key
now includes routed agents' own pauses); the agent-change wizard defaulted to
remap/clear on a table that is now per agent (default is Keep, copy rewritten);
deleting an app-wide custom now sweeps every workspace; own-key lookups for
slugs like `constructor`.

Known and left alone:
- **Downgrade / mixed builds.** The legacy single-table and single-cycle keys
  are read once and never written again. A release build older than this one
  reads the shared `config.json` with no pause or complexity routing, and its
  next save drops the new keys. The same is true of every widening of that
  file; mirroring the legacy keys would make every load re-fold them.
- **The scheduler's pre-filter reads the workspace agent's cycle.** A rail
  whose card is routed to another agent is held while the WORKSPACE agent is in
  its pause window even if the routed agent could run (conservative), and the
  routed agent's own pause is enforced at launch by `launchDecision`. Auto-resume
  of a run gates on the workspace agent's cycle too, and the sidebar badge shows
  the workspace agent's verdict.
- Prompt lines do not reach the hidden commit-via-agent run (CLI args do); the
  panel copy says so.

<!-- gavin:auto-commit -->
When the implementation is done, commit it. Commit only the files you touched — never `git add -A`. Do not push.
<!-- /gavin:auto-commit -->
