// Always-on Companion attention publisher: keeps the host's snapshot
// current so a Device's GetAttention answers even when the hub panel is
// closed (ADR 0005).
//
// Call `startCompanionAttentionPublisher` once from the app root; it
// returns a stop function for onDestroy.

import { get } from "svelte/store";
import { attentionState } from "$lib/core/layoutState";
import { kanbanState } from "$lib/board/kanbanState";
import { gavinTrees } from "$lib/core/gavinState";
import { orchestrations, stepAttentionsByWorkspace } from "$lib/orchestration/orchestrationState";
import { turnVerdictById, verdictsOf } from "$lib/agents/turnVerdictState";
import { attentionInbox } from "$lib/agents/attentionInbox";
import { allSessionIds } from "$lib/panes/layout";
import type { Workspace } from "$lib/core/workspace";
import { cardIndex } from "$lib/orchestration/orchestration";
import {
  humanTestsOnPlan,
  stoppedRailsIn,
  type AttentionTarget,
} from "$lib/companion/attentionAnswer";
import { publishCompanionAttention } from "$lib/companion/publishAttention";
import type { Rail, Orchestration } from "$lib/orchestration/orchestration";
import type { Unsubscriber } from "svelte/store";

function workspaceHoldingSession(
  workspaces: readonly Workspace[],
  sessionId: string
): string | null {
  for (const ws of workspaces) {
    if (ws.mainSessionId === sessionId) return ws.id;
    for (const page of ws.pages) {
      if (allSessionIds(page.layout).includes(sessionId)) return ws.id;
    }
  }
  return null;
}

function railTarget(rail: Rail, orch: Orchestration): AttentionTarget | null {
  for (const stage of rail.stages) {
    for (const step of stage.steps) {
      const run = orch.stepRuns.find((r) => r.stepId === step.id);
      if (run?.sessionId) return { kind: "session", id: run.sessionId };
      if (step.cardPath) return { kind: "card", path: step.cardPath };
    }
  }
  return null;
}

function publishNow(): void {
  const state = get(attentionState);
  const boards = get(kanbanState);
  const trees = get(gavinTrees);
  const orchs = get(orchestrations);
  const stepAttentions = get(stepAttentionsByWorkspace);
  const inbox = attentionInbox(
    {
      state,
      boards,
      trees,
      orchestrations: orchs,
      stepAttentions,
      verdicts: verdictsOf(get(turnVerdictById)),
    },
    Date.now()
  );

  const interrupted = [...state.interruptedSessionIds].map((sessionId) => ({
    workspaceId: workspaceHoldingSession(state.workspaces, sessionId) ?? "",
    sessionId,
    text: state.sessionNames[sessionId],
  }));

  const humanTests = [];
  for (const [workspaceId, tree] of Object.entries(trees)) {
    if (!tree) continue;
    for (const [, entry] of cardIndex(tree)) {
      humanTests.push(...humanTestsOnPlan(workspaceId, entry.plan));
    }
  }

  const stoppedRails = [];
  for (const [workspaceId, orch] of Object.entries(orchs)) {
    if (!orch) continue;
    stoppedRails.push(
      ...stoppedRailsIn(workspaceId, orch, (rail) => railTarget(rail, orch))
    );
  }

  publishCompanionAttention({ inbox, interrupted, humanTests, stoppedRails });
}

/// Subscribe to every store the answer reads and republish on change.
export function startCompanionAttentionPublisher(): () => void {
  const unsubs: Unsubscriber[] = [];
  const kick = () => publishNow();
  unsubs.push(attentionState.subscribe(kick));
  unsubs.push(kanbanState.subscribe(kick));
  unsubs.push(gavinTrees.subscribe(kick));
  unsubs.push(orchestrations.subscribe(kick));
  unsubs.push(stepAttentionsByWorkspace.subscribe(kick));
  unsubs.push(turnVerdictById.subscribe(kick));
  return () => {
    for (const u of unsubs) u();
  };
}
