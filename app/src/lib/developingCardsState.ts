// The effects behind developingCards.ts: recording a develop run, reading
// whether a card has one, freeing it when the run ends, and putting the
// human in front of the agent holding it. The rules themselves live in the
// pure module; nothing here decides anything.
//
// Split out of cardRunActions.ts rather than added to it, for the reason
// the sweep exists at all: this watch is module-level and app-wide -- a
// develop run that finishes while the human is reading some other tab
// still has to release the card.

import { get } from "svelte/store";
import { layoutState, setDevelopingCards } from "$lib/layoutState";
import { sessionLiveness, type DevelopingCardRecord } from "$lib/workspace";
import { developRunOver, developingRunFor, DEVELOPING_BLOCK } from "$lib/developingCards";

/// Every develop run this workspace is holding. Empty for a workspace
/// that has never developed a card, and for one whose runs have all been
/// swept.
export function developingCardsIn(workspaceId: string): DevelopingCardRecord[] {
  return get(layoutState).workspaces.find((w) => w.id === workspaceId)?.developingCards ?? [];
}

/// The run developing this card, or null.
export function developingRunOn(workspaceId: string, path: string): DevelopingCardRecord | null {
  return developingRunFor(developingCardsIn(workspaceId), path);
}

/// The refusal every launch owes this card, or null when it is free.
///
/// One function so a board Run, a rail step, a Best-of-N and the column's
/// Start all refuse on exactly the same evidence -- the shape
/// `resolveAttachmentsForRun` already established for the other gate a
/// launch has to pass.
export function developingBlocker(workspaceId: string, path: string): string | null {
  return developingRunOn(workspaceId, path) ? DEVELOPING_BLOCK : null;
}

/// Records a run against its card. Written BEFORE the jump that follows
/// it, like the orchestration agent's: an unrecorded run is one the next
/// window cannot tell apart from any other agent on the Agents page.
export async function recordDevelopingCard(
  workspaceId: string,
  record: DevelopingCardRecord
): Promise<void> {
  // Re-read here rather than trusting a captured list: the sweep and
  // another launch both write this field, and a stale copy would put a
  // freed run back or drop a live one.
  const records = developingCardsIn(workspaceId).filter((r) => r.path !== record.path);
  await setDevelopingCards(workspaceId, [...records, record]);
}

let sweeping = false;
let sweepAgain = false;
let stopWatch: (() => void) | null = null;

/// Frees every card whose develop run is over (developRunOver).
///
/// A module-level subscription, not a component's `$effect`: a card whose
/// develop agent finished while the human was on another tab still has to
/// come back to life, and this same first pass is what ADOPTS a run that
/// outlived the window -- the records load with the workspaces, and the
/// pass over them decides whether last night's agent is still thinking or
/// long gone. There is no separate adoption path because there is no
/// separate question.
///
/// Deliberately tolerant of arriving early: `interruptedSessionIds` and
/// `sessionStatusById` are seeded from Attach baselines that land after
/// bootstrap, so a first pass can read a killed run as live. The next
/// emission corrects it -- which is why this is a subscription and not a
/// one-shot at startup.
export function startDevelopingCardsWatch(): () => void {
  stopWatch?.();
  const unsubscribe = layoutState.subscribe(() => void sweepDevelopingCards());
  const stop = () => {
    unsubscribe();
    // Guarded: a later start owns the field, and this teardown arriving
    // afterwards must not clear the live watch out of it.
    if (stopWatch === stop) stopWatch = null;
  };
  stopWatch = stop;
  return stop;
}

async function sweepDevelopingCards(): Promise<void> {
  // Clearing writes `layoutState`, which re-enters this subscription.
  // Collapsed into a single replay (the shape the scheduler's tick and
  // the orchestration agent sweep both use): re-entrant passes only raise
  // the flag, and the pass in flight runs once more afterwards so a
  // change that arrived mid-await is never the one nobody looked at.
  if (sweeping) {
    sweepAgain = true;
    return;
  }
  sweeping = true;
  try {
    do {
      sweepAgain = false;
      for (const ws of get(layoutState).workspaces) {
        const records = ws.developingCards ?? [];
        if (records.length === 0) continue;
        // Re-read per workspace: the write before this one persisted, and
        // liveness has to be judged against the state that came back.
        const state = get(layoutState);
        const alive = records.filter(
          (r) =>
            !developRunOver(sessionLiveness(state, r.sessionId), state.sessionStatusById[r.sessionId])
        );
        if (alive.length !== records.length) await setDevelopingCards(ws.id, alive);
      }
    } while (sweepAgain);
  } finally {
    sweeping = false;
    sweepAgain = false;
  }
}

/** @internal test-only reset for module-level state */
export function __resetForTesting(): void {
  stopWatch?.();
  stopWatch = null;
  sweeping = false;
  sweepAgain = false;
}
