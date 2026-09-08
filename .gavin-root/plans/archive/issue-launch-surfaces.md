---
kind: task
title: Surfaces: queued marks, fleet strip, pressure banner, settings, Run all estimate
parent: issue.md
complexity: moderate
---
Make the gate and the queue visible. Depends on `issue-memory-probe.md` (`memoryState.ts`) and `issue-launch-gate-queue.md` (`launchGate.ts`, `launchQueue.ts`, the `launch` settings).

**Queued marks.** A `queued` agent state in `app/src/lib/ui/indicators.ts`, through `AGENT_STATES` / `agentIndicatorByState`, the app's one badge vocabulary (shape = axis, tone = answer). `StatusBadge` draws it on board cards, in the card detail modal, on the rail header and on the step chip, reading "Queued · waiting for a slot" or "Held · memory pressure", with the gate's sentence as the tooltip. Hang the tooltip on a non-disabled element: `tooltip.ts` binds mouseenter, which a disabled control never fires. A Cancel entry on a queued card's menu removes its intent from the queue.

**Fleet strip.** The sidebar footer gets a strip beside `pauseLabel`: "Agents 4/4 · 26 of 32 GB", warning tone under warn pressure, danger under critical. `appHub.fleetSummary` carries the same figures onto the hub strip. The sessions manager's totals row adds "outside gavin: watchman 0.6 GB, 12 roots" with a Drop roots action for the roots no live worktree of any open workspace owns, asking through `askConfirm` from `dialog.ts` first (buttons name the action, never OK; no native dialogs).

**Pressure banner.** On critical pressure, a banner in the daemon-request-error family: "Memory is critical: N agents hold X GB. New launches are held." with the buttons Open sessions (the sessions manager sorted by memory, descending) and Close idle tabs. It never kills anything.

**Settings.** Beside the pause cycle in `GlobalSettingsModal.svelte`: "Agents running at once" (blank means no ceiling) and "Hold new agents when memory is under pressure", writing through the `launch` config.

**Run all estimate.** A pure `app/src/lib/launchEstimate.ts` gives `runAllConfirm` (`railConfirm.ts`), `columnRunAllConfirm` (`columnRunAction.ts`) and the selection bar's confirm one line each: "11 agents ≈ 17 GB (1.5 GB each, from the 3 running now) on top of 14 GB in use, 32 GB total. 4 start now, 7 queue." The per-agent figure is the mean tree RSS of the running agents of the same profile in the current sample, else the last stored mean, else the 1.5 GB floor, and never below the floor. When the projection exceeds free memory, a warning-tone line says the queue will hold the rest until memory frees. Starting still goes through the queue.

**Tests.** `launchEstimate.test.ts` for every sentence shape (no sample, floor, partial fit, full fit); the indicator test for the new state; the three confirm tests extended with the estimate line; a settings test for the two fields. Done when `cd app && npm test && npm run check && npm run build` are green and a static pre-flight greps every string above against the committed source.
