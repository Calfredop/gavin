---
order: 39936
kind: task
title: [feat] effort handling
status: In Progress
complexity: complex
---
Allow effort handling in all agents configs: default agent, fallback, complexity, app/workspace settings… There should be precompiled effort levels taken from each agents’ api and a custom one.

<!-- gavin:auto-commit -->
When the implementation is done, commit it. Commit only the files you touched — never `git add -A`. Do not push.
<!-- /gavin:auto-commit -->

## Plan

Design: `docs/superpowers/specs/2026-09-30-agent-effort-design.md` (D64–D69).

- [x] Profile table: `effort_flag` + `efforts` per profile (claude-code `--effort`, codex `-c model_reasoning_effort=`), surfaced on `AgentProfileDto`
- [x] Protocol v56: `AgentConfig.effort`/`effort_flag`, `PlanFileInfo.effort`; daemon parses and writes them; gavin-mcp accepts `effort`
- [x] config.json: `agentEfforts`, `customEffortFlag`, `ComplexityAgent.effort` in `AgentDefaultsConfig`
- [x] Resolution: `resolveAgentConfig` resolves `effort`/`effortFlag` and composes them onto `launchCommand`; attributions carry effort
- [x] UI: app-wide Agent defaults, Custom agent, both Complexity tables, workspace Agent row, card Agent controls; compat gate `agentEffort`
- [x] Checks green: cargo test, app npm test/check/build
- [ ] Human test: After rebuilding and restarting the daemon: set Settings ▸ Agent defaults ▸ Effort ▸ Claude Code to "high", open a workspace's Settings ▸ Agent and check "Launches as" ends in `--effort high`; then set a card's Effort to "max", Run it, and check the tab's command line carries `--effort max`

Lands with the next daemon rebuild + restart (v56, the human's call): until
then the workspace Effort rows and the card's Effort picker are dark with the
reason, while the app-wide defaults, the custom agent's flag and both
complexity tables work at once. `app/src/lib/core/remoteAccessSurfaces.test.ts`
("forwards the three device pushes") and `mainThreadCommands.test.ts`
(forwarding.rs line 362) fail on a clean HEAD too — not this change.
