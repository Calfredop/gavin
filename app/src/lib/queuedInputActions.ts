// Doing what the follow-up queue strip offers: queueing a message,
// reordering one, sending one now, and cancelling one.
//
// The write side of queuedInput.ts, kept out of that module so the
// ordering arithmetic and the wording stay a pure, testable projection.
// Every function here returns an error string or null, the same shape
// cardRunActions uses, so a template never has to build a message of its
// own.
//
// All four calls answer with the queue they leave behind, and none of
// them is applied to the store here. `queued-inputs-changed` does that,
// for every window watching the session and not just the one that
// asked -- and it is also the only thing that reports a change nobody
// here made, which is most of them: the daemon delivering the head
// because the session went idle.

import { get } from "svelte/store";
import * as backend from "./backend";
import { featureBlockedReason } from "./daemonCompat";
import { daemonCompat, queuedInputsById, handleQueuedInputsChanged } from "./layoutState";
import {
  composeRefusal,
  moveQueued,
  queueBlockedReason,
  withoutQueued,
  type QueueTarget,
  type QueuedInput,
} from "./queuedInput";

/// What the app knows about a session's fitness to be queued for,
/// assembled from the stores. The strip reads this once and hands it to
/// both `composeRefusal` and `deliveryHold`, so the box that refuses and
/// the line that explains can never be answering different questions.
export function queueTargetFor(
  status: QueueTarget["status"],
  interrupted: boolean
): QueueTarget {
  return {
    status,
    interrupted,
    blockedReason: featureBlockedReason(get(daemonCompat), "queuedFollowUps"),
  };
}

/// The queue as it stands for one session. Absent means empty -- the map
/// deletes a key rather than storing `[]`.
export function queueFor(sessionId: string): QueuedInput[] {
  return get(queuedInputsById)[sessionId] ?? [];
}

/// Holds a follow-up, or hands it over at once if the daemon finds the
/// session already idle. Which of the two happens is not this side's
/// call, and deliberately so: a status read here would be a moment old
/// by the time the request landed.
///
/// The refusal is checked BEFORE the request, so a version-blocked
/// compose box says why instead of taking the text and reporting
/// nothing -- the failure the compat entry exists to prevent.
export async function queueFollowUp(
  sessionId: string,
  target: QueueTarget,
  text: string
): Promise<string | null> {
  const refusal = composeRefusal(target, text);
  if (refusal) return refusal;
  try {
    // Trimmed on the way in: a message the human sees as blank-padded is
    // still the message, but the trailing newline would be a submit the
    // daemon's own CR already provides.
    const queued = await backend.queueInput(sessionId, text.trim());
    // Applied optimistically as well as by the push, because the push is
    // routed to the ATTACHED writer -- and the strip has to be right for
    // the human looking at it even in the window where that has not
    // arrived.
    handleQueuedInputsChanged(sessionId, queued);
  } catch (e) {
    return `Couldn't queue that follow-up: ${e instanceof Error ? e.message : e}`;
  }
  return null;
}

/// Writes an id order back. Shared by the two gestures that produce one,
/// and null-in means "the gesture asked for nothing" -- which is not an
/// error and must not be reported as one.
async function writeOrder(sessionId: string, ids: string[] | null): Promise<string | null> {
  if (ids === null) return null;
  try {
    handleQueuedInputsChanged(sessionId, await backend.setQueuedInputs(sessionId, ids));
  } catch (e) {
    return `Couldn't update the queue: ${e instanceof Error ? e.message : e}`;
  }
  return null;
}

/// Moves one entry by `delta` places. A move off either end, or of an
/// entry the daemon has since delivered, is a no-op rather than a write:
/// `SetQueuedInputs` pushes to everyone attached, so a pointless one
/// repaints the strip under the human's cursor to say nothing changed.
export function moveFollowUp(
  sessionId: string,
  id: string,
  delta: number
): Promise<string | null> {
  return writeOrder(sessionId, moveQueued(queueFor(sessionId), id, delta));
}

/// Drops one entry. The same one writer as the reorder: cancel is the
/// human saying what the queue should be, expressed as the whole list,
/// which is what makes a cancel landing during a delivery resolve to a
/// queue that existed rather than to a merge of two half-applied edits.
export function cancelFollowUp(sessionId: string, id: string): Promise<string | null> {
  return writeOrder(sessionId, withoutQueued(queueFor(sessionId), id));
}

/// Delivers one entry NOW, whatever the session is doing -- the
/// override for an agent the human has decided not to wait for.
///
/// Not gated on the delivery rules the daemon applies to the automatic
/// path, because this IS the escape from them: the human is looking at
/// the terminal and has decided the interruption is worth it. The one
/// exception is an interrupted session, refused here for the same reason
/// the compose box refuses -- what is in that tab is a shell, and the
/// message would be run as a command.
export async function sendFollowUpNow(
  sessionId: string,
  target: QueueTarget,
  id: string
): Promise<string | null> {
  const blocked = queueBlockedReason(target);
  if (blocked) return blocked;
  try {
    handleQueuedInputsChanged(sessionId, await backend.sendQueuedInput(sessionId, id));
  } catch (e) {
    // The daemon refuses an id its queue no longer holds, which is the
    // ordinary race here rather than a fault: the follow-up was
    // delivered between the render and the click. Its own message says
    // so, so it is passed through rather than re-worded.
    return `Couldn't send that follow-up: ${e instanceof Error ? e.message : e}`;
  }
  return null;
}
