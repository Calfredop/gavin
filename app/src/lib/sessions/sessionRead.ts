// Marking a waiting session as READ: the human has seen the question and
// wants gavin to stop pointing at it.
//
// `waiting_for_input` is the one status the daemon will not take back on
// its own. An agent rings its notification bell exactly once, and the
// daemon deliberately refuses to let a quiet period downgrade the wait to
// idle (see status.rs and HeuristicInner::waiting_for_input) -- so a
// question the human has already dealt with by hand, or decided to come
// back to later, keeps its badge on the tab, its dot in the sidebar, its
// row in the hub's inbox and its tally in every recap until the agent
// happens to print something. That is a nag with no off switch.
//
// This is the off switch, and it is deliberately an ACKNOWLEDGEMENT
// rather than a status write. The daemon's status stays exactly what it
// was, because gavin ACTS on that status in ways that would be wrong if a
// silenced badge could move them:
//
//   - a rail completes an `agent` tool's step when its session goes idle
//     (orchestration.ts's agentTurnEnded). Advancing a rail past a
//     question because a human dismissed a badge is the same failure as
//     answering it by walking away.
//   - the follow-up queue refuses to deliver into a `waiting_for_input`
//     session on purpose: the message would land at the prompt of a
//     DIFFERENT question (server.rs's deliver_next_queued_if_idle).
//   - "Close Idle Tabs" would sweep a session that is still, in fact,
//     waiting for a human.
//
// So the split this module draws is: anything that decides what gavin
// DOES reads the daemon's status; anything that tells the human COME AND
// LOOK reads the acknowledged view below. The task manager sits on the
// first side too -- it is where you go to see what the daemon actually
// holds.
//
// A mark lasts only as long as the wait it acknowledged. Any status the
// daemon reports for that session afterwards -- including a second bell,
// which it re-emits per notification rather than only on a change --
// drops it, so the next question raises the badge again. Nothing is
// persisted for the same reason: a fresh app run has no idea which waits
// the human already looked at, and showing every one of them is the
// honest answer to that.

import type { SessionStatus } from "$lib/core/notifications";

/// The sessions whose current wait the human has acknowledged.
export type ReadSessions = ReadonlySet<string>;

/// Whether this session is in the one state a read mark can be made
/// about. Nothing else is markable: `failed` carries a reason the human
/// has to act on, and `working`/`idle` are not asking for anything.
export function canMarkRead(status: SessionStatus | undefined): boolean {
  return status === "waiting_for_input";
}

/// Whether the menu should carry the entry at all.
///
/// A session that is already marked keeps it, so the human can put the
/// badge back on a tab they silenced by mistake -- without it the only
/// way back is to wait for the agent to ask something else.
export function readEntryApplies(status: SessionStatus | undefined, read: boolean): boolean {
  return read || canMarkRead(status);
}

/// The entry's label, in the Pin/Unpin shape the same menu already uses:
/// it names the action, never the state.
export function readEntryLabel(read: boolean): string {
  return read ? "Mark as Unread" : "Mark as Read";
}

/// The set with one session's mark set or cleared. Returns the SAME set
/// when nothing changes, so a no-op cannot churn a store.
export function withSessionRead(marks: ReadSessions, sessionId: string, read: boolean): ReadSessions {
  if (marks.has(sessionId) === read) return marks;
  const next = new Set(marks);
  if (read) next.add(sessionId);
  else next.delete(sessionId);
  return next;
}

/// The set with one session's mark dropped, whatever it was -- what a
/// fresh status from the daemon does to it.
export function clearSessionRead(marks: ReadSessions, sessionId: string): ReadSessions {
  return withSessionRead(marks, sessionId, false);
}

/// One session's status as the attention surfaces should read it.
///
/// Only `waiting_for_input` is masked, and it is masked to `idle` rather
/// than to nothing: every consumer of this compares against the same
/// four words, and a session whose wait has been acknowledged belongs in
/// the bucket that draws no badge.
export function attentionStatus(
  status: SessionStatus | undefined,
  read: boolean
): SessionStatus | undefined {
  return read && status === "waiting_for_input" ? "idle" : status;
}

/// The whole status map as the attention surfaces should read it.
///
/// Hands back the ORIGINAL object when no mark applies, which is the
/// common case: the masked map feeds a derived store, and rebuilding it
/// on every unrelated layout change would invalidate every consumer that
/// only compares identities.
export function attentionStatuses(
  statusById: Record<string, SessionStatus>,
  marks: ReadSessions
): Record<string, SessionStatus> {
  if (marks.size === 0) return statusById;
  let masked: Record<string, SessionStatus> | null = null;
  for (const sessionId of marks) {
    if (statusById[sessionId] !== "waiting_for_input") continue;
    masked ??= { ...statusById };
    masked[sessionId] = "idle";
  }
  return masked ?? statusById;
}
