// The status map the surfaces that say COME AND LOOK read: the
// acknowledged view, with a quiet session the turn verdict recognises as
// a question shown as a wait.
//
// The verdict already decided rails, auto-resume, the hub's attention
// inbox and the follow-up queue. It did not decide the four surfaces a
// human actually glances at -- the tab badge, the sidebar's dots and
// tallies, the board card's session dot and the card modal's session bar
// -- and those read the daemon's own word for a prose question, which is
// `idle`. So an agent that asked something in a sentence, rang no bell
// and is waiting on a human drew exactly the badge a finished one draws:
// none.
//
// This closes that gap and nothing else. Three rules, all narrow:
//
//   1. Only `idle` is reinterpreted, and only as `asking`.
//      `verdictAsksQuietly` is that rule and the comment there says why
//      -- a `working`, `failed` or `waiting_for_input` session is
//      something the daemon OBSERVED, and the verdict's job is to read
//      quiet, not to overrule observation.
//   2. The rule is that function and not a copy of it. `reasonFor`
//      (attentionInbox.ts) and `stepAttentions` (orchestration.ts) ask
//      the same question of the same entry, and a badge that said "done"
//      while the hub's inbox said "waiting for you" is the disagreement
//      this file exists to remove, not one it may introduce.
//   3. The acknowledgement still wins. The upgrade is skipped for a
//      session the human has marked as read, so "Mark as Read" silences
//      a verdict-raised badge exactly as it silences a bell-raised one.
//      Without that a mark would be undone on the next store emission --
//      `attentionStatuses` masks `waiting_for_input` to `idle`, and this
//      map would read that `idle` and put the wait straight back.
//
// `blocked` is the reading this deliberately does NOT raise. An agent
// that gave up already reports through `verdictStallReason`: the rail
// stalls with the agent's own sentence and pauses, which says more than
// a badge could and is what every other consumer of the verdict does
// with it. Raising a badge for it here would be rule 2 broken on the
// first day.
//
// Nothing that ACTS on a session reads this. The split sessionRead.ts
// draws is unchanged and this file sits on the same side of it as
// `attentionStatusById`: orchestration, the follow-up queue, auto-resume,
// the idle-tab sweep and the task manager all still read
// `sessionStatusById`, because a rail that completed a step on a badge
// would be advancing past the very question the badge is about.
//
// A module of its own rather than a fifth export in `turnVerdictState.ts`
// for that file's stated reason: it holds the verdict STORES and reads
// no other store, so that `orchestrationState` can import it statically
// from the other side of the cycle. This one has to read `layoutState`,
// which is exactly what that file refuses to do.

import { derived, type Readable } from "svelte/store";

import { verdictAsksQuietly, type TurnVerdictEntry } from "$lib/agents/turnVerdict";
import { turnVerdictById, verdictsOf } from "$lib/agents/turnVerdictState";
import { attentionState, type LayoutState } from "$lib/core/layoutState";
import type { ReadSessions } from "$lib/sessions/sessionRead";
import type { SessionStatus } from "$lib/core/notifications";

const NO_READ_MARKS: ReadSessions = new Set();

/// The whole acknowledged map with every verdict-raised wait shown.
///
/// `waiting_for_input` rather than a state of its own, because the
/// surfaces this feeds draw from the app's agent vocabulary and adding a
/// word to it would mean a new glyph, a new tally column and a new tone
/// in every one of them. The question a badge answers is "does this need
/// me?", and a question asked in prose is the same answer as one that
/// rang a bell -- which is exactly why `reasonFor` gives both the one
/// word `asking`.
///
/// Walks the VERDICTS rather than the statuses: there is one entry per
/// session gavin has asked about, which is a fraction of the sessions in
/// the map, and this runs on every layoutState emission. Hands back the
/// original object when nothing is raised -- the common case -- so the
/// derived store below stays identity-stable and its consumers are not
/// invalidated by every unrelated layout change.
export function verdictAttentionStatuses(
  statusById: Record<string, SessionStatus>,
  verdicts: ReadonlyMap<string, TurnVerdictEntry>,
  marks: ReadSessions = NO_READ_MARKS
): Record<string, SessionStatus> {
  if (verdicts.size === 0) return statusById;
  let raised: Record<string, SessionStatus> | null = null;
  for (const [sessionId, entry] of verdicts) {
    if (marks.has(sessionId)) continue;
    if (!verdictAsksQuietly(statusById[sessionId], entry)) continue;
    raised ??= { ...statusById };
    raised[sessionId] = "waiting_for_input";
  }
  return raised ?? statusById;
}

/// The same substitution as `attentionState`, one layer further on: the
/// acknowledged layout with verdict-raised waits shown, for the pure
/// modules that take a whole state object (sidebarSummary, appHub).
///
/// LAZY, and that is load-bearing rather than tidiness. A module-level
/// `derived([attentionState, turnVerdictById], ...)` reads both stores
/// the moment anything imports this file, and a dozen suites mock
/// `$lib/core/layoutState` with only the handful of exports they use --
/// so `attentionState` is `undefined` there and `derived` throws while
/// the module is still evaluating, failing tests that never touch a
/// badge. Building on first subscribe moves that to the one place it can
/// be meant: a component that actually draws from it.
let state: Readable<LayoutState> | null = null;

function verdictState(): Readable<LayoutState> {
  state ??= derived([attentionState, turnVerdictById], ([$state, $verdicts]): LayoutState => {
    const sessionStatusById = verdictAttentionStatuses(
      $state.sessionStatusById,
      verdictsOf($verdicts),
      $state.readSessionIds ?? NO_READ_MARKS
    );
    return sessionStatusById === $state.sessionStatusById
      ? $state
      : { ...$state, sessionStatusById };
  });
  return state;
}

export const verdictAttentionState: Readable<LayoutState> = {
  subscribe: (run, invalidate) => verdictState().subscribe(run, invalidate),
};

/// The map on its own, for the surfaces that only need one session's
/// status: the tab badge, the board card's dot, the card modal's bar.
let statuses: Readable<Record<string, SessionStatus>> | null = null;

function verdictStatuses(): Readable<Record<string, SessionStatus>> {
  statuses ??= derived(verdictState(), ($state) => $state.sessionStatusById);
  return statuses;
}

export const verdictAttentionStatusById: Readable<Record<string, SessionStatus>> = {
  subscribe: (run, invalidate) => verdictStatuses().subscribe(run, invalidate),
};

/// Test seam, matching `turnVerdictState.__resetForTesting`: drops the
/// lazily built stores so a suite that re-mocks `layoutState` between
/// cases does not keep a derivation over the previous mock.
export function __resetForTesting(): void {
  state = null;
  statuses = null;
}
