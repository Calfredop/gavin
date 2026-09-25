// Whether each workspace has anything waiting on the human, as the hub
// tab strip needs it.
//
// A derived store here rather than a `$derived` inside the tab, and the
// reason is the same one `stepAttentionsByWorkspace` gives: the mark
// belongs to a TAB the human is not looking at. `+page.svelte` renders
// one hub view at a time and destroys the rest on every switch, so a
// count computed inside DecisionsHubView would exist only while the
// Decisions tab was already on screen -- which is precisely when nobody
// needs to be told.
//
// Derived and never stored: it is a live read of the same stores the tab
// itself reads, so the pip and the list can never disagree about whether
// this workspace needs you.

import { derived, type Readable } from "svelte/store";
import { attentionInbox } from "$lib/agents/attentionInbox";
import { nowStore } from "$lib/agents/agentPauseState";
import { turnVerdictById, verdictsOf } from "$lib/agents/turnVerdictState";
import { kanbanState } from "$lib/board/kanbanState";
import { featureBlockedReason } from "$lib/core/daemonCompat";
import { attentionState, daemonCompat } from "$lib/core/layoutState";
import { gavinTrees } from "$lib/core/gavinState";
import { cardIndex } from "$lib/orchestration/orchestration";
import { orchestrations, stepAttentionsByWorkspace } from "$lib/orchestration/orchestrationState";
import { renderLibraryFor, toolRecords } from "$lib/orchestration/toolsState";
import { decisionsList, decisionsWaiting, type DecisionCard } from "$lib/decisions/decisions";

/// Per workspace, whether the Decisions tab has anything the human has
/// to answer. A workspace whose board or tree has not loaded is absent,
/// which every reader takes as "nothing waits" -- the honest answer
/// before anything has been read, and the one that keeps a mark from
/// appearing and vanishing during startup.
export const decisionsWaitingByWorkspace: Readable<Record<string, boolean>> = derived(
  [
    attentionState,
    kanbanState,
    gavinTrees,
    orchestrations,
    stepAttentionsByWorkspace,
    turnVerdictById,
    toolRecords,
    daemonCompat,
    nowStore,
  ],
  ([
    $attention,
    $kanban,
    $trees,
    $orchestrations,
    $marks,
    $verdicts,
    $tools,
    $compat,
    $now,
  ]) => {
    // One walk of the fleet's inbox for every workspace, not one per
    // workspace: `attentionInbox` iterates the whole fleet whatever it
    // is asked about, and this store re-runs on every status change.
    const inbox = attentionInbox(
      {
        state: $attention,
        boards: $kanban,
        trees: $trees,
        orchestrations: $orchestrations,
        stepAttentions: $marks,
        verdicts: verdictsOf($verdicts),
      },
      $now
    );
    // The same gate the tab's controls read: an older daemon parses no
    // item lines, so a mark built from their absence would be a claim
    // nobody measured. The sessions and gates it CAN see still count.
    const itemsBlockedReason = featureBlockedReason($compat, "humanItems");
    const out: Record<string, boolean> = {};
    for (const ws of $attention.workspaces) {
      const tree = $trees[ws.id];
      const board = $kanban[ws.id];
      if (!tree && !board) continue;
      const cards = new Map<string, DecisionCard>(
        [...cardIndex(tree)].map(([path, entry]) => [
          path,
          { plan: entry.plan, contextFolder: entry.contextFolder },
        ])
      );
      const list = decisionsList({
        workspaceId: ws.id,
        cards,
        bindings: new Map((board?.cardSessions ?? []).map((cs) => [cs.path, cs.sessionId])),
        inbox,
        rails: $orchestrations[ws.id]?.rails ?? [],
        marks: $marks[ws.id] ?? new Map(),
        tools: renderLibraryFor($tools, ws.id),
        itemsBlockedReason,
      });
      out[ws.id] = decisionsWaiting(list.summary);
    }
    return out;
  }
);
