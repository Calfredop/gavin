---
order: 1200
kind: task
title: [feat] setup wizard can start kimi (and other prompt-injection profiles) on the PRD
status: Done
parent: bug-kimi-launch-integrations.md
priority: low
---
Follow-up of bug-kimi-launch-integrations.md ("Follow-ups NOT done here", third bullet).

## Today

The setup wizard's agent-written PRD (app/src/lib/wizardSteps/PrdStep.svelte) is offered only when `agentFlowAvailable(profile)` holds (app/src/lib/workspace/setupWizard.ts, around line 297). That is `promptArgs !== null`. kimi-code, and custom profiles with `promptInjection`, have `promptArgs: null` and get their prompt by PTY injection once their MCP server connects. So for them the wizard hides the option and shows a reason. `startMainAgentWithPrompt` (app/src/lib/core/layoutState.ts, around line 2724) has no injection branch either: it calls `buildRunCommand`, gets null, and errors.

Card runs already have that branch. `cardRun.ts` has the predicate (`promptArgs === null && promptInjection === true`, around line 461) and the launch that queues the prompt for injection. feat-custom-profile-prompt-injection.md line 24 records that the wizard's main-agent start was left out of injection on purpose, as scope rather than a product decision.

## Work

1. Find how a card run launches an injection profile (the bare command plus the queued prompt) and reuse that path. Do not copy it.
2. Widen `agentFlowAvailable` to accept injection profiles. Give `startMainAgentWithPrompt` the injection branch, and keep the main session recorded exactly as today. Logic goes in the .ts modules with unit tests; keep PrdStep.svelte a thin template.
3. Tests: `setupWizard` and `layoutState` unit tests for kimi-code (injection), a custom injection profile, and a profile with neither (still hidden, with the same reason).
4. Update the note at feat-custom-profile-prompt-injection.md line 24 so it no longer lists the wizard's main-agent start among the paths without injection.
5. `cd app && npm test && npm run check && npm run build`.
6. File a `Human test:`: in a scratch workspace on the Kimi Code profile, the wizard's PRD step offers the agent-written option, and kimi opens with the prompt delivered.

## Constraints

The working tree is shared: commit nothing, and edit only the files this needs. Check that app/src/lib/core/layoutState.ts has no other session's uncommitted edits before you edit it (`git diff`), and work around them if it does.

## Outcome (2026-10-12)

- [x] `startMainAgentWithPrompt` (layoutState.ts) takes the card runs' injection route: `usesPromptInjection(agent)` picks the bare `launchCommand`, and the prompt goes to `backend.queueInput` right after the spawn, before anything else is awaited. The main session is recorded as before. If the queue call fails, the session is still recorded, because the agent is already running, and the error is shown.
- [x] `agentFlowAvailable` (setupWizard.ts) accepts `promptArgs !== null || usesPromptInjection(agent)`.
- [x] PrdStep.svelte now gates on `$resolvedAgents(workspaceId)`, the same resolver the launch reads, not the raw built-in table. The old lookup never found a named custom, so a custom with an MCP file would have stayed hidden even with the predicate widened. The hint text is unchanged.
- [x] Tests: setupWizard (injection true, neither false). layoutState: kimi-code bare + queued, custom with `mcp_file` bare + queued, queue failure still recorded, cursor-like refused with no spawn.
- [x] feat-custom-profile-prompt-injection.md note updated. The wizard start is now on the injection-capable list and passes `profileId` to `noPromptReason`. That two-argument signature is that card's uncommitted change in cardRun.ts, so commit the two together.
- [x] `npm test` (7876 passed), `npm run check` (0 errors), `npm run build` green.

- [ ] Human test: In a scratch workspace on the Kimi Code profile, open the setup wizard's PRD step: "Ask the agent →" is offered (no "isn't available for Kimi Code" hint), and pressing it opens a bare `kimi` main session that receives the PRD prompt typed in within a few seconds of its gavin MCP server connecting.
