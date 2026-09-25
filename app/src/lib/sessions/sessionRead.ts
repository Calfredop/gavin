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
// A second wait with the same shape arrived with the turn verdict: a
// question asked in PROSE rings no bell, so the daemon says `idle` and
// will never say anything else until the agent prints again.
// `verdictAttention.ts` raises a badge for it, and `canMarkRead` below
// therefore has to be able to take that badge down -- a judged wait
// needs its off switch more than an observed one, not less.
//
// A mark lasts only as long as the wait it acknowledged. Any status the
// daemon reports for that session afterwards -- including a second bell,
// which it re-emits per notification rather than only on a change --
// drops it, so the next question raises the badge again. Nothing is
// persisted for the same reason: a fresh app run has no idea which waits
// the human already looked at, and showing every one of them is the
// honest answer to that.

import type { SessionStatus } from "$lib/core/notifications";
import { verdictAsksQuietly, type TurnVerdictEntry } from "$lib/agents/turnVerdict";

/// The sessions whose current wait the human has acknowledged.
export type ReadSessions = ReadonlySet<string>;

/// Whether this session is in a state a read mark can be made about.
///
/// Two of them, and the status is only half of the answer for the
/// second. `waiting_for_input` is the bell. The other is a session the
/// daemon calls `idle` whose turn verdict reads as a question asked in
/// prose -- the wait `verdictAttention.ts` now raises a badge for on the
/// tab, the sidebar, the board card and the card modal.
///
/// That second case is a REQUIREMENT of raising those badges, not a
/// convenience. The verdict is a judgement, not an observation: it reads
/// roughly 3 of this repository's 44 finished turns as asking, and a
/// false one would put a badge on a tab that has nothing waiting on it.
/// Without an off switch there is no way to take that badge down --
/// `idle` is already the daemon's answer, so no later status can
/// contradict it and there is no keystroke the human can make on the
/// agent's behalf. A wrong badge with no way to dismiss it is worse than
/// the missing badge this feature set out to fix.
///
/// The mark still lasts only as long as the wait it acknowledged: it is
/// dropped by any status the daemon reports for the session afterwards
/// (layoutState's handleSessionStatusChanged), which is unchanged and
/// covers this case for free -- the next thing the agent prints moves it
/// to `working`, and the verdict for the turn after that raises the
/// badge again if it is still a question.
///
/// Nothing else is markable: `failed` carries a reason the human has to
/// act on, and a plain `working`/`idle` session is not asking for
/// anything.
export function canMarkRead(
  status: SessionStatus | undefined,
  verdict?: TurnVerdictEntry | null
): boolean {
  return status === "waiting_for_input" || verdictAsksQuietly(status, verdict);
}

/// Whether the menu should carry the entry at all.
///
/// A session that is already marked keeps it, so the human can put the
/// badge back on a tab they silenced by mistake -- without it the only
/// way back is to wait for the agent to ask something else.
export function readEntryApplies(
  status: SessionStatus | undefined,
  read: boolean,
  verdict?: TurnVerdictEntry | null
): boolean {
  return read || canMarkRead(status, verdict);
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
