---
kind: task
title: Desktop Agents hub (app + workspace)
parent: feat-rework-agent-s-settings.md
complexity: moderate
---
Rework desktop Settings so agent controls live under one **Agents** section
with inner tabs, on both GlobalSettingsView and SettingsHubView.

## Tabs
- **App:** Defaults | Customs | Complexity | Fallback | Pause
- **Workspace:** This agent | Customs | Complexity | Fallback | Pause
- Leave Headroom, Tools, TypeSafe (and everything else) as their own
  top-level nav items.

## Behaviour
- Customs tab: add / rename / delete named customs; edit command, flags,
  API family; Defaults includes model/effort rows for built-ins and for
  customs that exist in scope.
- Workspace Customs tab only manages that workspace’s locals; picking an
  agent anywhere in the workspace lists built-ins, app-wide, then locals
  (locals marked).
- Move / update settings-search keywords so search still lands on the new
  section/tabs (no orphaned agent-defaults / custom-agent ids).
- Extract shared tab shell / editors into plain modules where the two
  panels would otherwise duplicate logic; keep .svelte thin.

## Verify
- settings search tests updated for new section ids/keywords.
- Surface greps/tests that pinned old section structure updated.
- Static pre-flight: strings for tab labels and Customs CRUD present in
  both views.
