// The snapshots behind the hub's savings, as the hub reads them.
//
// Asked of the LOCAL daemon, which is the only one that runs Headroom
// (an ssh workspace's is Unavailable), and only while the hub is on
// screen: the hub owns the poll, the way it owns its session recap. What
// the rows make of the snapshots is `headroomSavings.ts`'s.

import { writable, type Readable } from "svelte/store";
import * as backend from "$lib/core/backend";
import { featureBlockedReason, type DaemonCompat } from "$lib/core/daemonCompat";
import type { RunSavings } from "$lib/agents/headroomSavings";

const snapshots = writable<RunSavings[] | null>(null);

/// Every snapshot since the earliest window the hub shows. Null until the
/// first read answers, and for as long as the daemon is too old to have
/// taken any -- "not read" is not "saved nothing".
export const headroomSavingsStore: Readable<RunSavings[] | null> = { subscribe: snapshots.subscribe };

/// One read. `undefined` when there is nothing to ask: no daemon yet, one
/// older than v49 (`FEATURE_MIN_VERSION.headroomSavings` -- it would
/// refuse the request on every tick), no window with a known start, or a
/// read that failed. The caller keeps whatever it had: a poll that failed
/// does not unmake the last one that worked.
export async function readHeadroomSavings(
  compat: DaemonCompat | null,
  since: number | null,
  ask: (since: number) => Promise<RunSavings[]>
): Promise<RunSavings[] | undefined> {
  if (!compat || since === null) return undefined;
  if (featureBlockedReason(compat, "headroomSavings")) return undefined;
  try {
    return await ask(since);
  } catch {
    return undefined;
  }
}

/// Bumped by every read, so an answer that lands after a newer one was
/// asked for is dropped rather than overwriting it. A counter, because
/// Svelte 5 proxies what a store holds and identity decides nothing.
let epoch = 0;

/// Handed the compat rather than reading it, so the hub's effect re-asks
/// the moment the daemon's version is known -- not a timer tick later.
export async function loadHeadroomSavings(compat: DaemonCompat | null, since: number | null): Promise<void> {
  const mine = ++epoch;
  const runs = await readHeadroomSavings(compat, since, backend.headroomSavings);
  if (runs === undefined || mine !== epoch) return;
  snapshots.set(runs);
}
