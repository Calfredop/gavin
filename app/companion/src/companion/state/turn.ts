// The turn verdict for the session a phone is looking at.
//
// The desk takes one whenever an agent it ran goes quiet
// (`turnVerdictDriver.ts`), but keeps the answer in its own webview,
// where a Device cannot read it. So the phone asks for its own -- through
// the same driver, so every one of the desk's gates still stands (the
// switch and the key at the desk, only a card's or a rail's agent, never
// a bare terminal) -- and only for the one session on its screen, so a
// phone left open costs a verdict per turn it is actually shown.
//
// What the answer is FOR is the quick replies: whether a quiet agent is
// asking at all (quickReplies.ts). The session list's badges read the
// same entries, which is why they are dropped for EVERY session the
// moment it moves on, shown or not: a verdict is about one turn, and one
// kept past it would call a finished agent a waiting one.
import { get } from "svelte/store";
import { clearTurnVerdict, noteQuietTransition } from "$lib/agents/turnVerdictDriver";
import { loadTypesafeSettings, turnVerdictById } from "$lib/agents/turnVerdictState";
import { layoutState } from "$lib/core/layoutState";
import { parseSessionStatus, type SessionStatus } from "$lib/core/notifications";

/// The desk's switch and key, read once per visit: until they are in
/// hand the driver reads the feature as off, and would ask nothing.
let settings: Promise<void> | null = null;

function quiet(status: SessionStatus | undefined): boolean {
  return status === "idle" || status === "failed";
}

/// Keeps a verdict for one session while it is shown: asked when it is
/// opened quiet with none in hand, and each time it goes quiet again --
/// the transitions the desk's driver takes one at.
export function watchTurn(sessionId: string): () => void {
  let stopped = false;
  let last: SessionStatus | undefined;

  async function ask(): Promise<void> {
    settings ??= loadTypesafeSettings();
    await settings;
    // Re-read after the wait: the agent may have started again.
    if (!stopped && quiet(get(layoutState).sessionStatusById[sessionId])) noteQuietTransition(sessionId);
  }

  const unsubscribe = layoutState.subscribe((state) => {
    const status = state.sessionStatusById[sessionId];
    if (status === last) return;
    last = status;
    if (quiet(status) && !get(turnVerdictById)[sessionId]) void ask();
  });
  return () => {
    stopped = true;
    unsubscribe();
  };
}

/// A session's status, as the Workstation just said it. Anything but
/// quiet ends the turn a verdict was about.
export function turnMovedOn(sessionId: string, rawStatus: string): void {
  if (!quiet(parseSessionStatus(rawStatus))) clearTurnVerdict(sessionId);
}

/// What a visit to one Workstation knew about its turns. Through the
/// driver's own clear, so an answer still in flight lands nowhere.
export function resetTurns(): void {
  settings = null;
  for (const sessionId of Object.keys(get(turnVerdictById))) clearTurnVerdict(sessionId);
}
