---
order: 3072
kind: task
title: Data model: default-agent + per-primary fallback
parent: feat-rework-agent-s-settings.md
complexity: complex
status: Done
---
Add the app-wide default-agent setting and per-primary fallback chains.

## Shape
- `AgentDefaults.defaultAgent` / Rust `default_agent`: empty means `claude-code`
  (today’s silent fallback). `resolveAgentConfig` uses it when the workspace
  has no profile.
- Replace the single `agentFallback: string[]` with
  `agentFallbackByPrimary: Record<profileId, string[]>` at app and workspace
  (`Workspace.agentFallbackByPrimary?: Record<…>` — absent inherits).
- Keep legacy `agentFallback` fields deserializable; migrate on load.

## Migration
- After `migrate_custom_profiles`: if legacy app `agentFallback` is non-empty
  and the by-primary map is empty, copy that chain onto every known profile
  id (stock ∪ app customs ∪ workspace locals ∪ complexity / model keys).
- Workspace: if legacy `agentFallback: Some(chain)` and by-primary is absent,
  fold the same way into `Some(map)`; `Some([])` → every known → `[]`.
- Clear legacy fields. Idempotent. Thresholds unchanged.

## Launch
- `effectiveFallbackChain(workspaceMap, appMap, primaryId)` looks up the
  resolved profile id.
- `launchDecision` / owed-arming / AgentStep / editors key by primary.

## Verify
- Rust migrate once + second load no-op; roundtrip of map + defaultAgent.
- TS unit tests for effectiveFallbackChain keying and launchDecision.
- Fixtures that stub `agentFallback: []` updated to the map (or empty map).
