---
kind: task
title: Launch gate and queue, every start routed through it
parent: issue.md
complexity: intricate
---
Build the one gate every agent start passes through, and the queue a held start waits in. Depends on the stores from `issue-memory-probe.md` (`memoryState.ts`).

**`app/src/lib/launchGate.ts`** (pure, tested). Inputs: the ceiling (a number, or null for none), the in-flight count (agent sessions whose status is `working` or `asking` across EVERY workspace, from `layoutState.sessionStatusById` joined with which sessions are agents), pressure, free percent, and the next launch's estimate. Output: a verdict, allowed or held, with a reason and ONE sentence: "Waiting for a slot: 4 of 4 agents running", "Held: memory pressure, 28 of 32 GB in use". Hysteresis: after a pressure hold, starts resume only once pressure has read normal for 30 s; the queue drains one launch at a time, spaced 20 s apart or until the new session's tree appears in the sample, so a burst cannot outrun the probe.

**`app/src/lib/launchQueue.ts`.** An ordered app-wide list of intents (card run, resume, develop, review, tool, commit agent, Generate/Reorganize, auto-resume) with workspace, payload and asked-at. Persisted in localStorage per window, the way the orchestration conflicts box is, so a reload keeps it. Cancellable. Drained by a module-level subscription in the manner of `startScheduler`, never by a component.

**Rails are not queued: the scheduler is the rail's queue.** `executeActions` in `orchestrationState.ts` skips a `launch` action the gate refuses at the same seam `mayStartWork` uses today (the `if (!mayStartWork(workspaceId)) continue;` line), and the gate's stores join `tickInputStores()` so a lifted hold re-ticks and the action is emitted again. Use the deduped-flag pattern `activePaused` uses, not a store that emits every poll.

**Route every start.** `cardRunActions.ts` (runCard, resumeCard, reviewCardSession, developCard, relaunchCard; the column's Run all and the selection bar's Run selected reach runCard), `workspaceToolsActions.ts`, `codeReviewActions.ts`, `gitState.ts`'s commit via agent, `orchestrationState.ts`'s Generate/Reorganize launch, and `autoResumeState.ts` (a pause DEFERS a resume there; the gate does the same). Plain shells created with no command are never gated. `startBlockedReason` in `agentPauseState.ts` answers with the pause reason first, then the gate's, so every surface keeps one sentence.

**Settings.** An app-wide `launch` config (`maxInFlight`: 4, `holdOnPressure`: true) in config.json through the same load/save path `AgentPauseConfig` uses, never the persist_workspaces path (that path has a carry-through trap: a save site can silently wipe a field it does not pass).

**Traps.** Svelte 5 `$state` proxies objects, so never gate on identity; guard async supersession with a token counter. Two windows each hold their own queue while the in-flight count is global (the daemon's sample plus the layout's statuses); that is acceptable. No daemon change, no protocol bump.

**Tests.** `launchGate.test.ts`: verdicts, the ceiling at the boundary, hysteresis, one-at-a-time drain. `launchQueue.test.ts`: persist, restore, cancel, drain order, no double launch of one intent. `orchestrationState` tests: a rail launch skipped under a full ceiling is emitted again when a slot frees, mirroring the existing pause test. Done when `cd app && npm test && npm run check` are green and, in the running app, Run all on a column with more cards than slots starts the first N and the rest start by themselves as agents go idle.
