// The turn verdict's STORES, and nothing that reads another store.
//
// Split from the driver (`turnVerdictDriver.ts`) for a load-order reason
// rather than a taste one. The driver has to read `kanbanState` and
// `orchestrations` to know whether a session is gavin's work at all, and
// `layoutState` to know what the daemon can answer; `orchestrationState`
// in turn has to read the verdict map STATICALLY, to build
// `stepAttentionsByWorkspace` and to tick the scheduler when an answer
// lands. Put the map beside the driver and those two modules import each
// other both ways -- and whichever of them a page happens to import
// first finds the other half-evaluated, with `turnVerdictById` still
// undefined at the moment `derived([...])` asks for it. autoResumeState
// and agentPauseState are kept one-way by dynamic imports for exactly
// this reason; this file is the same discipline applied to a module that
// has to be readable from both sides.
//
// So this file imports the pure module and the backend, and nothing that
// imports it back. Every consumer that only READS a verdict -- the
// scheduler, the attention inbox, the follow-up queue, the Settings panel
// -- imports this. The one thing that WRITES one is the driver, started
// from the orchestration listeners once every store it reads exists.

import { get, writable } from "svelte/store";

import * as backend from "$lib/core/backend";
import type { TurnVerdictEntry } from "$lib/agents/turnVerdict";

/// What the Settings panel is told, and all this side ever knows about
/// the key.
export interface TypeSafeSettings {
  enabled: boolean;
  hasKey: boolean;
}

/// Null until the first read. Null is NOT "off": it is "nobody has
/// asked yet", and the driver's gate treats it as off anyway -- an
/// unknown setting must never authorise a send.
export const typesafeSettings = writable<TypeSafeSettings | null>(null);

/// Every session's verdict, by session id. Read by `stepAttentions`, the
/// scheduler, the attention inbox and the follow-up queue -- all of them
/// through the pure predicates in `turnVerdict.ts`, never by pattern
/// matching on the entry here.
export const turnVerdictById = writable<Record<string, TurnVerdictEntry>>({});

/// How long a pending entry may hold a rail step.
///
/// The host's own budget is 2s (`TOTAL_BUDGET` in `typesafe.rs`); this is
/// that plus enough for the two IPC hops around it. It is a BACKSTOP, not
/// the timeout -- the host answers first in every ordinary case, and this
/// only covers the one where the command itself never returns. A pending
/// entry that outlived its request would hold a step for ever, which is
/// the one way this feature could do more damage than the bug it fixes.
///
/// Here rather than in the driver because `whenTurnVerdictSettles` below
/// bounds itself by it: a reader waiting on a pending entry must never
/// wait longer than the driver could keep it pending.
export const PENDING_BACKSTOP_MS = 3_000;

/// Re-reads the key/toggle state from the host. Called when the driver
/// starts and after every Settings change.
export async function loadTypesafeSettings(): Promise<void> {
  try {
    typesafeSettings.set(await backend.typesafeSettings());
  } catch {
    // An unreadable config is not consent. Left null, which gates off.
    typesafeSettings.set(null);
  }
}

/// The verdict map as the pure consumers want it, for a caller that
/// already holds the store's value.
export function verdictsOf(
  map: Record<string, TurnVerdictEntry>
): ReadonlyMap<string, TurnVerdictEntry> {
  return new Map(Object.entries(map));
}

/// Resolves once this session's verdict is no longer pending: with the
/// settled entry, or with undefined when there is none -- which is what
/// a session nobody asked about looks like, and what a cleared one looks
/// like too.
///
/// For a reader that decides ONCE, at the moment a status lands, and
/// cannot re-decide when the answer arrives a second later -- auto-resume
/// is the one: its failure hook fires straight after the `failed` status
/// that provoked the request, so without this it would read every verdict
/// as pending and the cause would never reach it. Bounded by the driver's
/// own backstop plus a margin, so a reader can never hang on an entry
/// that will not settle; the reactive consumers (the scheduler, the
/// chips, the queue) never need it, because a store emission re-runs
/// them for free.
export function whenTurnVerdictSettles(sessionId: string): Promise<TurnVerdictEntry | undefined> {
  return new Promise((resolve) => {
    let done = false;
    let unsubscribe: (() => void) | null = null;
    const finish = (entry: TurnVerdictEntry | undefined) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      unsubscribe?.();
      resolve(entry);
    };
    const timer = setTimeout(
      () => finish(get(turnVerdictById)[sessionId]),
      PENDING_BACKSTOP_MS + 500
    );
    unsubscribe = turnVerdictById.subscribe((m) => {
      const entry = m[sessionId];
      if (entry?.state !== "pending") finish(entry);
    });
    // `subscribe` runs its callback synchronously before handing back the
    // unsubscribe, so an entry that was already settled finished above
    // with nothing to unsubscribe yet.
    if (done) unsubscribe();
  });
}

/// Test seam, matching `orchestrationState.__resetForTesting`.
export function __resetForTesting(): void {
  turnVerdictById.set({});
  typesafeSettings.set(null);
}
