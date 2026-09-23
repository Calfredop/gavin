// Doing what the Decisions tab offers: answering an item, telling its
// agent, and the two things a rail gate can be answered with.
//
// The write side of `decisions.ts`, kept out of that module so the list,
// the payloads and the wording stay a pure, testable projection. Every
// function here returns an error string or null, the same shape
// `cardRunActions` and `queuedInputActions` use, so a template never has
// to build a message of its own.
//
// Nothing here applies anything to a store. `ResolveHumanItem` writes
// the card file, and the daemon's `.gavin*` watcher pushes the tree back
// to every window -- which is also the only thing that reports an answer
// written in ANOTHER window, and an item an agent re-filed while the tab
// was open.

import { get } from "svelte/store";
import * as backend from "$lib/core/backend";
import { askConfirm } from "$lib/core/dialog";
import { layoutState } from "$lib/core/layoutState";
import { cardSessionState } from "$lib/board/columnRunAction";
import { markStepDone, skipStep } from "$lib/orchestration/orchestrationState";
import { queueFollowUp, queueTargetFor } from "$lib/agents/queuedInputActions";
import { queueBlockedReason } from "$lib/agents/queuedInput";
import { turnVerdictById } from "$lib/agents/turnVerdictState";
import type { HumanItem, HumanItemOutcome } from "$lib/core/gavin";
import {
  NO_SESSION_REASON,
  SESSION_GONE_REASON,
  failAndCloseConfirm,
  notifyMessage,
  notifySkipped,
} from "$lib/decisions/decisions";

/// What one answer left behind.
///
/// `error` and `notice` are separate because they are different kinds
/// of news: `error` is the write refusing (an agent rewrote the card
/// under the tab), and `notice` is the write SUCCEEDING while the agent
/// heard nothing. Collapsing them would draw a silent success in the
/// colour of a failure.
///
/// `wrote` is separate from both, and it is not derivable from them: a
/// cancelled "Fail and close" reports no error and no notice, which is
/// indistinguishable from a clean write. The controls clear the human's
/// option and note on this field alone, so a refused write -- and a
/// prompt they dismissed -- leaves what they typed where they typed it.
export interface AnswerResult {
  wrote: boolean;
  error: string | null;
  notice: string | null;
}

/// Asks first when the outcome is the one that ENDS something, then
/// writes it, then tells the card's agent.
///
/// The confirm is inside this function rather than in the component on
/// purpose: it is a property of the OUTCOME ("fail and close" closes a
/// test for good), not of the surface that offered it, and a second
/// caller that forgot to ask would be the one bug this guard exists to
/// stop.
export async function answerHumanItem(
  workspaceId: string,
  cardPath: string,
  item: HumanItem,
  outcome: HumanItemOutcome,
  /// The card's bound session id, from `cardSessionFor(board, cardPath)`.
  /// Null when nothing has ever run the card.
  sessionId: string | null
): Promise<AnswerResult> {
  if (outcome.kind === "failAndClose") {
    if (!(await askConfirm(failAndCloseConfirm(item)))) {
      return { wrote: false, error: null, notice: null };
    }
  }
  try {
    // `lineText` and not `text`: the daemon guards the write on the
    // line's raw remainder, exactly as `SetChecklistItem` does, so a
    // card an agent rewrote under the tab is refused rather than
    // half-answered at a line that has moved.
    await backend.resolveHumanItem(cardPath, item.lineText, outcome);
  } catch (e) {
    return {
      wrote: false,
      error: `Couldn't write that answer: ${e instanceof Error ? e.message : e}`,
      notice: null,
    };
  }
  return {
    wrote: true,
    error: null,
    notice: await notifyCardAgent(cardPath, item, outcome, sessionId),
  };
}

/// Queues the one message that tells a card's agent its item was
/// answered, or says why nothing was sent.
///
/// The rule is the parent plan's: one message, to `cardSessionFor(card)`,
/// when that session is LIVE and not interrupted -- otherwise nothing is
/// sent and the answer waits on the card for the next agent to read.
/// `queuedInput.ts`'s own refusals are then asked on top of it, and the
/// asking one is not redundant with anything above: an agent with a
/// question on screen would have this message filed as the answer to
/// THAT question, which is a different question from the one on the
/// card.
///
/// Returns the human-facing notice, or null when the message went.
async function notifyCardAgent(
  cardPath: string,
  item: HumanItem,
  outcome: HumanItemOutcome,
  sessionId: string | null
): Promise<string | null> {
  if (!sessionId) return notifySkipped(NO_SESSION_REASON);
  // `layoutState` and not `attentionState` for the liveness read: this
  // is an action, and a wait the human marked as read is still a live
  // session (see attentionState's own note -- reading the masked map
  // here is how a silenced badge would come to change what a write
  // does).
  const state = get(layoutState);
  if (cardSessionState(state, { sessionId }) !== "live") {
    return notifySkipped(SESSION_GONE_REASON);
  }
  const target = queueTargetFor(
    state.sessionStatusById[sessionId],
    state.interruptedSessionIds.has(sessionId),
    get(turnVerdictById)[sessionId] ?? null
  );
  const blocked = queueBlockedReason(target);
  if (blocked) return notifySkipped(blocked);
  const error = await queueFollowUp(sessionId, target, notifyMessage(cardPath, item, outcome));
  return error ? notifySkipped(error) : null;
}

/// The two answers a rail `review` gate takes, reported rather than
/// thrown.
///
/// Thin wrappers over `orchestrationState`'s own actions -- the rail
/// half of this is not the Decisions tab's to reinvent, and `skipStep`
/// in particular does a second thing the tab must not re-implement: it
/// puts a PAUSED rail back to running, without which skipping the gate
/// would advance nothing. The Orchestration tab calls them
/// fire-and-forget; this tab has an error line, so a failure is said
/// out loud rather than swallowed.
export async function skipGate(workspaceId: string, stepId: string): Promise<string | null> {
  try {
    await skipStep(workspaceId, stepId);
  } catch (e) {
    return `Couldn't skip that step: ${e instanceof Error ? e.message : e}`;
  }
  return null;
}

export async function markGateDone(workspaceId: string, stepId: string): Promise<string | null> {
  try {
    await markStepDone(workspaceId, stepId);
  } catch (e) {
    return `Couldn't mark that step done: ${e instanceof Error ? e.message : e}`;
  }
  return null;
}
