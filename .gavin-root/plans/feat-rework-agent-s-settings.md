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
- [ ] Human test: App Settings → Agents — General tab (default agent, its fallback chain follows the selection, complexity, pause); one tab per agent; create a custom and get its tab; restart and confirm migration from an old single-`custom` / single-chain config
- [ ] Human test: Workspace Settings → Agents — choose the workspace agent in General; per-agent tabs edit overrides; workspace-local custom appears (marked) with its own tab; This agent launches as shown
- [ ] Human test: Companion — same General + per-agent tabs on app + workspace settings; CRUD and picks match the desk

<!-- gavin:auto-commit -->
When the implementation is done, commit it. Commit only the files you touched — never `git add -A`. Do not push.
<!-- /gavin:auto-commit -->
