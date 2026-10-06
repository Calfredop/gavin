// Whether each workspace has a human test waiting on the human, as the
// hub tab strip needs it for the Review tab's mark.
//
// A derived store for decisionsAttention.ts's reason: the mark belongs
// to a tab the human is not looking at, and `+page.svelte` destroys every
// hub view but the one on screen, so a count computed inside
// ReviewHubView would exist only while the Review tab was already open.
// Derived and never stored, over the same stores the tab reads, so the
// mark and the list cannot disagree.

import { derived, type Readable } from "svelte/store";
import { kanbanState } from "$lib/board/kanbanState";
import { featureBlockedReason } from "$lib/core/daemonCompat";
import { daemonCompat } from "$lib/core/layoutState";
import { gavinTrees } from "$lib/core/gavinState";
import { cardIndex, doneColumnOf } from "$lib/orchestration/orchestration";
import type { DecisionCard } from "$lib/decisions/decisions";
import { humanTestList, humanTestsWaiting } from "$lib/review/humanTests";

/// Per workspace, whether the Review tab has a test the human can run.
/// A workspace whose tree has not loaded is absent, which every reader
/// takes as "nothing waits" -- the honest answer before anything has
/// been read.
export const humanTestsWaitingByWorkspace: Readable<Record<string, boolean>> = derived(
  [kanbanState, gavinTrees, daemonCompat],
  ([$kanban, $trees, $compat]) => {
    // The gate the tab's controls read: an older daemon parses no item
    // lines, so a mark built from their absence would be a claim nobody
    // measured.
    const itemsBlockedReason = featureBlockedReason($compat, "humanItems");
    const out: Record<string, boolean> = {};
    for (const [workspaceId, tree] of Object.entries($trees)) {
      if (!tree) continue;
      const board = $kanban[workspaceId];
      const cards = new Map<string, DecisionCard>(
        [...cardIndex(tree)].map(([path, entry]) => [
          path,
          { plan: entry.plan, contextFolder: entry.contextFolder },
        ])
      );
      const list = humanTestList({
        cards,
        bindings: new Map((board?.cardSessions ?? []).map((cs) => [cs.path, cs.sessionId])),
        doneStatus: doneColumnOf(board?.columns ?? [])?.name ?? null,
        itemsBlockedReason,
      });
      out[workspaceId] = humanTestsWaiting(list.summary);
    }
    return out;
  }
);
