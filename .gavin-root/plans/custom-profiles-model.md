---
kind: task
title: Custom profiles model + migrate custom
parent: feat-rework-agent-s-settings.md
complexity: complex
---
Replace the hard-coded `custom` profile with a dynamic set of named custom
profiles (app-wide + per-workspace), and migrate existing configs.

## Storage
- App-wide customs in `config.json` (with the other agent defaults): id,
  label, command, model flag, effort flag, API family; optional default
  model/effort for that profile.
- Workspace-local customs in that workspace’s `config.toml`, same fields;
  ids scoped so they never collide with app-wide ids in resolution.
- `agentProfiles` (and every resolver that today indexes `AGENT_PROFILES` /
  `custom`) must expose built-ins ∪ app-wide customs ∪ (when a workspace
  is in scope) that workspace’s locals. Locals marked in UI-facing metadata.

## Migration
- On read: if the old single custom fields (or profile id `custom`) are
  present, create one named app-wide custom, rewrite workspace/card/
  complexity/fallback references from `custom` to that id, clear the old
  fields. Idempotent.
- Drop the hard-coded `custom` entry from the Rust profile table and any
  TS special cases that treat `profileId === "custom"` as the only custom.

## Verify
- Unit/integration tests: migrate once; second read no-ops; workspace-local
  id resolution and “local wins”; launch composition for a named custom
  (command + model/effort flags) matches today’s custom behaviour; unknown
  retired `custom` id does not slip through.
