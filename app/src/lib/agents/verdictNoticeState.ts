// The OS notification for a quiet turn, held until the verdict is in.
//
// `verdictNotice.ts` is the mapping and can be argued with in a test;
// this file is the WAITING. It owns one slot on layoutState
// (`setStatusNoticeHold`) and one rule: for a session the verdict is
// actually judging, the tray line for `working -> idle` is not sent at
// the transition but when the answer lands -- and then it is the line
// the answer earned.
//
// Why it is not in layoutState.ts, where the notification lives: that
// module must never import the verdict map. `turnVerdictState.ts`'s
// header has the load-order reason in full and
// `turnVerdictSurfaces.test.ts` pins it, so this side registers itself
// the way auto-resume and the rail's notification voice already do.
// Started and stopped by `startTurnVerdict`, because a hold is
// meaningless without the driver that marks sessions pending.
//
// Why it is not in `turnVerdictDriver.ts`, which owns the sibling slot:
// that file is four gates and a supersession token about whether to ASK
// at all, and nothing in it has ever spoken to the human. Announcing is
// a different job with a different failure mode -- a notification lost
// rather than a request wasted -- and it wants the timer and the token
// below to be readable on their own.
//
// The invariant, stated once: a quiet turn produces exactly ONE
// notification, here or in layoutState, never both and never neither.
// `hold` returning true is layoutState handing this file that
// obligation, and every early return below is guarded by something
// that makes the notification wrong rather than merely late.

import { get } from "svelte/store";

import { layoutState, notifyPrefsFor, setStatusNoticeHold } from "$lib/core/layoutState";
import { sessionLabel } from "$lib/core/paths";
import { maybeNotifyTurnVerdict } from "$lib/core/notifications";
import type { SessionStatus } from "$lib/core/notifications";
import { verdictHoldsNotification, verdictNotice } from "$lib/agents/verdictNotice";
import {
  PENDING_BACKSTOP_MS,
  turnVerdictById,
  whenTurnVerdictSettles,
} from "$lib/agents/turnVerdictState";

/// How long a held notification waits before giving up and sending
/// today's line anyway.
///
/// A backstop behind a backstop, deliberately. `whenTurnVerdictSettles`
/// already bounds itself by `PENDING_BACKSTOP_MS + 500`, which is itself
/// behind the driver's own `PENDING_BACKSTOP_MS` timer -- so in every
/// ordinary case, and in every failure case the driver models, this
/// timer is cleared unfired. It covers the one thing neither of those
/// can: a settle that never arrives at all, because the map was replaced
/// wholesale (the driver's teardown does exactly that) or the promise
/// was lost with the window it was made in. A notification the human
/// never gets is strictly worse than one that says the old, duller
/// thing, so the wait has to END.
export const VERDICT_NOTICE_WAIT_MS = PENDING_BACKSTOP_MS + 1_000;

/// The supersession token per held notification, for the reason the
/// driver keeps one: a session can go quiet, start again and go quiet a
/// second time inside the wait, and only the newest hold may speak. A
/// counter rather than an object comparison, per CLAUDE.md -- Svelte 5
/// proxies `$state`, so identity guards silently never fire.
const tokens = new Map<string, number>();

/// The slot layoutState asks at every transition. True means this file
/// has taken the notification.
///
/// False for everything `verdictHoldsNotification` does not recognise,
/// which is the overwhelming majority of transitions, and layoutState
/// then notifies inline exactly as it always did.
function hold(
  sessionId: string,
  previousStatus: SessionStatus | undefined,
  status: SessionStatus
): boolean {
  if (!verdictHoldsNotification(previousStatus, status, get(turnVerdictById)[sessionId])) {
    return false;
  }
  const token = (tokens.get(sessionId) ?? 0) + 1;
  tokens.set(sessionId, token);
  void announceWhenSettled(sessionId, token);
  return true;
}

/// The other half of the obligation: wait, then say the one thing the
/// verdict earned.
///
/// Two guards, and both are about the same hazard -- the turn being over
/// by the time there is anything to say about it:
///
///  1. **The token.** A second quiet transition inside the wait owns the
///     notification now; the first must not also send one.
///  2. **The status, re-read.** The verdict describes ONE turn, and a
///     session that has started talking again has moved past it. A tray
///     line saying "needs your input" about a question the human has
///     already answered is worse than no line at all. This also covers a
///     CLEARED entry: the driver deletes the map row when a session
///     starts working, so the settle resolves with `undefined` -- which
///     reads as today's answer and would otherwise be announced for a
///     session that is no longer quiet.
///
/// Everything it needs is re-read from the store rather than captured at
/// the transition: the session's label, its owning workspace and that
/// workspace's toggles can all have changed in the seconds this waited,
/// and the toggles especially must be the ones in force NOW.
async function announceWhenSettled(sessionId: string, token: number): Promise<void> {
  // A plain setTimeout, never a detached `window.setTimeout`: that
  // throws in WKWebView (CLAUDE.md).
  let fallback: ReturnType<typeof setTimeout> | undefined;
  const entry = await Promise.race([
    whenTurnVerdictSettles(sessionId),
    new Promise<undefined>((resolve) => {
      fallback = setTimeout(() => resolve(undefined), VERDICT_NOTICE_WAIT_MS);
    }),
  ]);
  clearTimeout(fallback);
  if (tokens.get(sessionId) !== token) return;
  tokens.delete(sessionId);
  const state = get(layoutState);
  if (state.sessionStatusById[sessionId] !== "idle") return;
  // Null is the `working` reading, and the only reading that sends
  // nothing: the turn did not end, so there is nothing to announce, and
  // the next quiet transition is judged on its own.
  const notice = verdictNotice(
    sessionLabel(state.sessionNames, state.cwdBySessionId, sessionId),
    entry
  );
  if (!notice) return;
  void maybeNotifyTurnVerdict(sessionId, notice, notifyPrefsFor(state, sessionId));
}

/// Starts holding. Returns its own teardown, the shape `startTurnVerdict`
/// and `startAutoResume` both use.
///
/// The teardown bumps every token, so a hold still waiting announces
/// nothing: the window is going away, and the verdict it was waiting for
/// was cleared by the driver's teardown on the same tick.
export function startVerdictNotices(): () => void {
  setStatusNoticeHold(hold);
  return () => {
    setStatusNoticeHold(null);
    for (const [id, token] of tokens) tokens.set(id, token + 1);
  };
}

/// Test seam, matching `turnVerdictDriver.__resetForTesting`.
export function __resetForTesting(): void {
  tokens.clear();
}
