// What the OS notification for a quiet turn SAYS once the verdict is in,
// and which transitions wait for one.
//
// The bug this closes is one sentence long: the tray line for a session
// going quiet is composed at the quiet transition itself
// (`handleSessionStatusChanged` -> `notifyStatus` ->
// `maybeNotifyStatusChange`), and the verdict is still in flight for
// another second or two. So an agent that asked a question in prose --
// the case the whole feature exists for, 0 of 16 on the real set without
// it -- reached the human as "<label> finished", and a turn the verdict
// read as broken was never announced as one. Every other consumer of the
// verdict (the rails, auto-resume, the hub's inbox, the follow-up queue,
// the badges) already waits; the tray was the last one reading the
// daemon's word for quiet as the final word.
//
// Two functions, and the split matters. `verdictHoldsNotification` is
// asked ONCE, synchronously, at the transition: it decides whether the
// tray waits. `verdictNotice` is asked once more when the wait is over,
// with whatever the verdict settled on. Neither waits, reads a store or
// sends anything -- `layoutState.ts` owns the waiting and
// `notifications.ts` owns the sending, and both of those are a handful
// of lines because the decisions live here.
//
// The rule threaded through both: a quiet turn produces at most ONE
// notification, and only a transition that already speaks today is ever
// held. A transition that has always been silent -- `waiting_for_input
// -> idle`, a session's first-ever `idle` -- stays silent, because
// delaying nothing would mean inventing something.
//
// What DOES change is which toggle answers for the line, and that is
// intended rather than a leak. A workspace silenced for endings but not
// for questions has said "tell me when an agent needs me, not when one
// finishes" -- so a turn the verdict reads as a question reaches them,
// where today's `notifyFinished` check swallowed it. The toggles are
// about kinds of event, not about transitions, and the whole bug is
// that the daemon could not tell these two events apart.

import {
  blockedStepReason,
  readingOf,
  type TurnVerdictEntry,
} from "$lib/agents/turnVerdict";
import { failureBody, type SessionStatus } from "$lib/core/notifications";

/// One tray line, and the workspace toggle that may silence it.
///
/// The toggle travels WITH the body because the verdict can change
/// which one applies: a turn today's code would announce under
/// `notifyFinished` is, once read as a question, a `notifyNeedsInput`
/// line instead. A notice that carried only the body would be governed
/// by the toggle for the sentence it no longer says.
export interface VerdictNotice {
  /// A key of `NotifyPrefs`, so the caller indexes rather than branches.
  toggle: "needsInput" | "finished";
  body: string;
}

/// Whether this status transition's notification waits for the verdict.
///
/// Exactly one transition qualifies: `working -> idle` on a session the
/// verdict is actually judging. That is the transition whose tray line
/// is the word "finished", and the word is what the verdict may take
/// back.
///
/// Everything else notifies at the moment it always did:
///
///  - **No pending entry.** The feature off, no key, a daemon older than
///    v39, a bare terminal the human opened, a `command` tool step: the
///    driver writes no entry at all for any of them, deliberately, so
///    that every consumer's "no entry" path is the one that runs. A
///    settled entry is not pending either -- there is nothing left to
///    wait for, and the reading is read on this very tick.
///  - **`waiting_for_input` and `failed`.** The daemon's other two
///    notification-worthy transitions, and neither is the verdict's
///    business: one rang a bell, the other already carries the agent's
///    own sentence. Holding either would be the verdict overruling
///    something the daemon OBSERVED, which is the line
///    `verdictAsksQuietly` draws for the badges, drawn here for the
///    tray.
///  - **Any previous status but `working`.** `waiting_for_input -> idle`
///    and a session's first-ever `idle` notify nothing today. Deferring
///    them would not delay a notification; it would INVENT one for a
///    transition that has always been silent, which is the one way this
///    card could make the tray noisier rather than truer.
export function verdictHoldsNotification(
  previousStatus: SessionStatus | undefined,
  status: SessionStatus,
  entry: TurnVerdictEntry | null | undefined
): boolean {
  return status === "idle" && previousStatus === "working" && entry?.state === "pending";
}

/// The line a settled verdict earns, or null to say nothing at all.
///
/// Null is reachable from exactly one reading, `working`: the screen
/// still shows the agent moving, so the turn did not end and there is
/// nothing to announce. The next quiet transition will be judged on its
/// own and speak then. Every other reading produces a line, because the
/// transition that got us here would have produced one.
///
/// The two fallbacks are the same fallback: a `finished` reading and no
/// reading at all both give exactly today's sentence. That equivalence
/// is the feature's safety property -- a refused key, a dead network, a
/// 500 or a judgement under the confidence floor must leave the tray
/// saying what it says today, just late.
export function verdictNotice(
  label: string,
  entry: TurnVerdictEntry | null | undefined
): VerdictNotice | null {
  const reading = readingOf(entry);
  switch (reading?.kind) {
    case "working":
      return null;
    case "asking":
      // Word for word what `maybeNotifyStatusChange` says for a
      // `waiting_for_input` transition, because it is the same fact: an
      // agent waiting on a human. The bell is the only difference, and
      // the human cannot hear the difference from the tray.
      return { toggle: "needsInput", body: `${label} needs your input` };
    case "failed":
      // Through `failureBody` rather than a sentence of its own, so a
      // failure gavin's model read off the screen and a failure the
      // daemon matched in its own table reach the human identically --
      // the human acts on the quoted line, not on which of the two
      // noticed it.
      return { toggle: "finished", body: failureBody(label, reading.said) };
    case "blocked":
      // `blockedStepReason` is already the app's sentence for this
      // exact fact -- a rail step stalls with it, and the card modal
      // shows it -- so the tray quotes the sentence rather than growing
      // a second wording of it. Prefixed with the label the way
      // `agentCommitBody` is, because a tray line has to name its
      // session before it says anything about it.
      //
      // The `finished` toggle, not `needsInput`, and the precedent is
      // the failure line beside it: both say "this run reached an end",
      // which is the thing that toggle answers for. An agent that gave
      // up is not sitting at a prompt waiting to be answered -- it
      // stopped -- and a workspace the human silenced for endings
      // should not start speaking because the ending was a bad one.
      return { toggle: "finished", body: `${label}: ${blockedStepReason(reading.said)}` };
    default:
      // `finished`, a null reading, no entry, and an entry somehow still
      // pending when the wait ran out. All four are today's answer.
      return { toggle: "finished", body: `${label} finished` };
  }
}
