---
order: 50176
kind: task
title: "[sec] Organize and Reorganize skip the first-run card review and hand unreviewed cloned cards to an unsandboxed agent"
status: Done
priority: medium
complexity: moderate
---
Fix a medium-severity finding from the 2026-10-15 security audit (run-1). Fingerprint: `app/src/lib/orchestration/orchestrationState.ts:launchOrchestrationAgent:no-first-run-card-review`.

Full record: `findings.json` in `~/security-audit-skill/gavin/run-1/`, outside this repo. The audit card is `review-security-audit-2026-10-15.md`.

## What is wrong

The Orchestration tab's Organize button (from the desk or a Companion Device) and a rail's Reorganize button start a dedicated agent in the workspace root through launchOrchestrationAgent. The launch prompt inlines the repository-written titles of up to 30 unplaced cards, or a rail's step-card titles. The gavin-orchestrate skill that the prompt invokes tells the agent to weigh the card bodies, and it says the agent has a shell. Nothing on this path calls cardReviewed or ensureCardReviewed. So cards from a freshly cloned repository reach an agent that runs as the user, without the once-per-card review that cardReview.ts promises. Run, Develop, send-to-main, Best-of-N and rail card steps all enforce that review. Downstream execution of the placed cards is still gated: a rail card step stalls on an unreviewed card at orchestrationState.ts:1615. The gap is the organize agent's own exposure to the unreviewed titles and bodies.

## Root cause

launchOrchestrationAgent, requestOrganize and requestRailReorganize (orchestrationState.ts:3119-3256) treat the run as card-less ('this run writes no card status and binds no card'). The first-run review, keyed on card provenance, was never wired into them, although the prompt and the skill hand the agent card titles and bodies. developCard had the same gap and closed it with sec-fix-develop-run-review, because 'the agent's first move is to read the card'.

## The invariant to enforce

Before Organize or Reorganize spawns any session, each card whose content the run hands to the agent is checked with cardReviewed. For Organize that is every unplaced card passed in. For Reorganize it is the rail's card steps. If any card is unreviewed and the workspace's requireReview resolves on, the launch is refused with a message naming the cards to review, or one combined review sheet is shown, and nothing is spawned. The rail card-step stall is the precedent.

## Trace (lines as of 2026-10-16; re-read before editing)

- `app/src/lib/orchestration/OrchestrationHubView.svelte:697` (organize()): The desk's Organize button passes every unplaced card (pickable) to requestOrganize. reorganizeRail (:707) passes the rail and the card map to requestRailReorganize. The Device equivalents are app/companion/src/companion/state/rails.ts:240 and :256, which use DEVICE_AGENT_HOST.
- `app/src/lib/orchestration/orchestrationState.ts:3205` (requestOrganize): Composes the prompt from the unplaced CardEntry list with composeOrganizePrompt and calls launchOrchestrationAgent. It makes no review check. requestRailReorganize (:3230) does the same with composeRailPrompt.
- `app/src/lib/orchestration/orchestrationPrompts.ts:122` (composeOrganizePrompt): Inlines each card's frontmatter title and path verbatim, up to 30 cards. stepName (:73) inlines the rail's step-card titles. The DEFAULT_ORGANIZE and DEFAULT_REORGANIZE templates tell the agent to use the gavin-orchestrate skill (actionPromptDefaults.ts:76).
- `app/src/lib/orchestration/orchestrationState.ts:3156` (launchOrchestrationAgent): The only guards are the workspace and slot checks, the root check, sshLaunchBlocker, the launch wall (host.hold) and the no-prompt refusal. There is no cardReviewed or ensureCardReviewed. A queued intent re-enters through launchQueuedOrchestrationAgent (:3345) with queued=true and also skips any review.
- `app/src/lib/orchestration/orchestrationState.ts:3181` (launchOrchestrationAgent): backend.createSession(root, command, root, profile) spawns the agent CLI as the user, unsandboxed, in the workspace root, with the unreviewed card titles in the quoted argv prompt.

## Fix

Gate both orchestration launches on the first-run review, the way the rail step is gated. In requestOrganize and requestRailReorganize, before launchOrchestrationAgent and host.hold, read each card the run hands the agent: every unplaced card passed in for Organize (not only the 30 inlined), and the rail's non-tool steps for Reorganize. Check each with cardReviewed. Refuse with a message naming the unreviewed cards, or raise one combined review sheet. The Device path inherits the fix because rails.ts calls the same functions, and queued intents only exist after the check. Regression test: with requireReview on and no digests, both functions return a refusal and backend.createSession is never called; with digests stamped, they launch.

`app/src/lib/orchestration/orchestrationState.ts`, as a sketch only:

```
async function unreviewedTitles(workspaceId: string, entries: CardEntry[]): Promise<string[]> {
  const out: string[] = [];
  for (const e of entries) {
    const file = await backend.readFileForViewer(e.plan.path);
    const body = file.exists ? stripFrontmatter(file.content).trim() : "";
    if (!cardReviewed(workspaceId, e.plan.path, { title: e.plan.title, body, attachments: e.plan.attachments ?? [] })) out.push(e.plan.title);
  }
  return out;
}

export async function requestOrganize(workspaceId: string, unplaced: CardEntry[], conflictSummary: string[], host: OrchestrationLaunchHost = DESK_ORCHESTRATION_HOST): Promise<string | null> {
  const unreviewed = await unreviewedTitles(workspaceId, unplaced);
  if (unreviewed.length > 0) return `Review these cards before an agent reads them: ${unreviewed.join(", ")}`;
  // ...unchanged launch
}
// requestRailReorganize: the same check over rail.stages.flatMap(s => s.steps).filter(s => !isToolStep(s)).map(s => cards.get(s.cardPath)).filter(Boolean)
```

## Done when

- requestOrganize and requestRailReorganize check every card the run hands the agent (the full unplaced set, not only the 30 inlined) before host.hold; the Device path inherits it.
- While here, give the gavin-orchestrate skill's worktree recipe the config-trust condition (see the needs-validation lead app/src-tauri/src/gavin_orchestrate_skill.md:worktree-setup-bypasses-config-trust): pass the trusted setup list to the agent instead of telling it to read [worktree] setup itself.
- The fix enforces the invariant above at the last trusted decision point, not in a caller.
- The regression cases named in the fix are tests, and they fail before the change.
- The checks in CLAUDE.md pass for every part you touched, and you commit only your own files.
