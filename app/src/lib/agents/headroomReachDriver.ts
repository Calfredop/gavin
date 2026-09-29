// The "not reaching Headroom" check's DRIVER: when a compressed session's
// turn ends, ask the daemon whether Headroom has seen any of its requests.
//
// Why at all: a session is compressed by environment, and environment is
// only as good as the agent CLI's respect for it. One that stops honouring
// the routing is marked compressed, talks to its model directly, and
// nothing about it looks wrong (spec, "Failures"). What the answer means
// -- and when an absence can be believed -- is the daemon's to say
// (`crates/daemon/src/headroom/reach.rs`); when to ask is the rule in
// headroomMark.ts (`reachCheckDue`). This file is the wiring between the
// status stream and those two, shaped like turnVerdictDriver.ts: started
// from the orchestration listeners, owned by their teardown, never
// imported statically, because it reads `orchestrations` and
// `kanbanState` to tell a run from a terminal the human opened.

import { get } from "svelte/store";

import * as backend from "$lib/core/backend";
import { addSessionStatusListener, daemonCompat } from "$lib/core/layoutState";
import { featureBlockedReason } from "$lib/core/daemonCompat";
import type { SessionStatus } from "$lib/core/notifications";
import { kanbanState } from "$lib/board/kanbanState";
import { orchestrations } from "$lib/orchestration/orchestrationState";
import { parseReach, reachCheckDue } from "$lib/agents/headroomMark";
import {
  noteHeadroomReach,
  sessionCompressionById,
  isAwaitingFirstSubmit,
} from "$lib/agents/headroomMarkState";

/// The supersession token per session, so an answer to an older ask never
/// lands after a newer one's. A counter rather than an identity check, per
/// CLAUDE.md: Svelte 5 proxies `$state`.
const tokens = new Map<string, number>();

/// Why the daemon will not be asked, or null when it will. A daemon older
/// than v50 has no `HeadroomReach`, and asking it at the end of every
/// compressed turn would be a version error each time.
export function reachCheckBlocked(): string | null {
  return featureBlockedReason(get(daemonCompat), "headroomFailures");
}

/// Whether this session is gavin's work: bound to a card run, or standing
/// behind a rail step. The same reading `turnVerdictDriver`'s gate makes,
/// from the same bindings -- a launch-time register would be a second list
/// to keep in step.
function isRun(sessionId: string): boolean {
  for (const board of Object.values(get(kanbanState))) {
    if (board?.cardSessions.some((cs) => cs.sessionId === sessionId)) return true;
  }
  for (const orch of Object.values(get(orchestrations))) {
    if (orch?.stepRuns.some((run) => run.sessionId === sessionId)) return true;
  }
  return false;
}

/// The status listener. A reopened conversation is passed over at every
/// quiet until a line has been submitted to it (`noteInputSubmitted`):
/// before that it is waiting on the human, however often it goes quiet.
function onSessionStatus(
  sessionId: string,
  status: SessionStatus,
  previousStatus: SessionStatus | undefined
): void {
  const turnEnded = previousStatus === "working" && status === "idle";
  const reopenedPaint = turnEnded && isAwaitingFirstSubmit(sessionId);
  const due = reachCheckDue({
    previousStatus,
    status,
    compression: get(sessionCompressionById)[sessionId],
    run: turnEnded && isRun(sessionId),
    reopenedPaint,
    blocked: reachCheckBlocked(),
  });
  if (due) void ask(sessionId);
}

/// Fire-and-forget: the caller is a status listener that must not wait,
/// and a failed ask is the same as an `unknown` answer -- nothing marked.
async function ask(sessionId: string): Promise<void> {
  const token = (tokens.get(sessionId) ?? 0) + 1;
  tokens.set(sessionId, token);
  try {
    const word = await backend.headroomReach(sessionId);
    if (tokens.get(sessionId) !== token) return;
    noteHeadroomReach(sessionId, parseReach(word));
  } catch {
    // A refused request, a lost daemon: nothing is known, so nothing is
    // marked. The next turn asks again.
  }
}

/// Starts listening. Returns its own teardown, the shape
/// `startTurnVerdict` and `startAutoResume` use.
export function startHeadroomReach(): () => void {
  const stop = addSessionStatusListener(onSessionStatus);
  return () => {
    stop();
    // Every answer still in flight lands nowhere.
    for (const [id, token] of tokens) tokens.set(id, token + 1);
  };
}

/// @internal - for testing only
export function __resetForTesting(): void {
  tokens.clear();
}
