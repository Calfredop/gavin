// The one poll behind every PR the app shows.
//
// `pull_request.rs` runs `gh`; `pullRequest.ts` says what its answer
// means; this owns *when to ask*, and holds the answers in a store the
// rail header and the scheduler both read. One poll, so a green chip row
// and a waiting rail can never be looking at different pull requests.
//
// The poll is DEMAND-DRIVEN rather than a timer over every rail. Two
// things want to know about a PR and neither wants to know for long:
//
//  - the rail header, while the human is looking at it. It calls
//    `requestPr` from its render, so interest refreshes as fast as Svelte
//    re-renders and expires a minute after the tab is closed.
//  - a `pr` step that is waiting. The scheduler calls `requestPr` on
//    every tick it sees one, so a rail waiting on CI keeps polling with
//    the Orchestration tab shut -- which is the whole point of a rail
//    that runs while nobody watches.
//
// A workspace with no rails on screen and nothing waiting therefore
// spends nothing at all, which a timer over every branch-bound rail
// would not. The host's own freshness floor is what turns "asked on
// every render" into one request a minute (see MIN_INTERVAL_SECS there).

import { get, writable } from "svelte/store";
import * as backend from "$lib/core/backend";
import { prKey } from "$lib/git/pullRequest";
import type { PrReport } from "$lib/git/pullRequest";

// Re-exported so a caller reaching for the store does not have to know
// the key lives with the pure rules. The scheduler imports it from
// there, because it may not import this module at all.
export { prKey };

/// How often the ticker looks for keys worth refreshing. Deliberately
/// well under the host's 60s floor: the floor is what paces the real
/// calls, and a short tick is what makes a newly-interested key answer in
/// seconds rather than after a minute of blank chips.
const TICK_MS = 15_000;

/// How long a `requestPr` keeps a key alive with nobody asking again.
/// Longer than TICK_MS by enough that one skipped render -- a re-layout,
/// a dropped frame -- does not drop the key and blank the chips.
const INTEREST_MS = 90_000;

/// Every PR the app currently knows about, by `prKey`. A key with no
/// entry means "not asked yet", which every reader treats as waiting --
/// never as "no PR" (see prWaitVerdict).
export const prReports = writable<Record<string, PrReport>>({});

/// Bumped by every sweep, whether or not any report changed.
///
/// This is what a SURFACE reads to keep its own interest alive: an
/// `$effect` that watched `prReports` alone would stop re-running the
/// moment the polls stopped changing anything -- a `gh` that is failing,
/// or a pull request that has settled -- and ninety seconds later its
/// interest would expire and its chips would vanish while the human was
/// still looking at them.
///
/// Deliberately NOT a scheduler input (orchestrationState's
/// tickInputStores): it emits on a timer, and a tick every fifteen
/// seconds forever is exactly what that list is careful not to have.
export const prPollTick = writable(0);

interface Interest {
  cwd: string;
  branch: string;
  /// When somebody last said they cared. Wall clock, so a machine that
  /// slept expires stale interest on waking rather than believing it.
  at: number;
}

const interests = new Map<string, Interest>();
/// Keys with a call in flight. `gh` can take twenty seconds and the
/// ticker fires every fifteen, so without this a slow network would
/// stack requests for the same branch.
const inFlight = new Set<string>();

/// Say that something wants to know about this branch's pull request.
/// Cheap and idempotent -- safe to call from a render or from every
/// scheduler tick, which is exactly how it is called.
export function requestPr(cwd: string | null | undefined, branch: string | null | undefined): void {
  if (!cwd || !branch) return;
  interests.set(prKey(cwd, branch), { cwd, branch, at: Date.now() });
}

/// The report for a branch, or undefined when nothing has asked yet.
export function prReportFor(
  reports: Record<string, PrReport>,
  cwd: string | null | undefined,
  branch: string | null | undefined
): PrReport | undefined {
  if (!cwd || !branch) return undefined;
  return reports[prKey(cwd, branch)];
}

/// Ask now, and keep the answer. `force` skips the host's freshness
/// floor -- for a human who pressed refresh, never for the scheduler.
///
/// Never throws: a failed invoke leaves the previous report in place
/// rather than blanking a chip row over one dropped call.
export async function refreshPr(cwd: string, branch: string, force = false): Promise<void> {
  const key = prKey(cwd, branch);
  if (inFlight.has(key)) return;
  inFlight.add(key);
  try {
    const report = await backend.prStatus(cwd, branch, force);
    prReports.update((all) => ({ ...all, [key]: report }));
  } catch {
    // The host command itself failed -- the app is mid-teardown, or the
    // backend is not there. Keeping the last report beats replacing it
    // with an error the human cannot act on.
  } finally {
    inFlight.delete(key);
  }
}

let timer: ReturnType<typeof setInterval> | null = null;

/// Start the ticker. Module-level and self-paced, on the same reasoning
/// `startScheduler` documents: a poll owned by whichever component
/// happens to be mounted stops the moment the human navigates away, and a
/// rail waiting on CI has to keep looking while they are elsewhere.
///
/// Returns its own teardown, and starting twice replaces the first.
export function startPrPolling(): () => void {
  stopPrPolling();
  const sweep = () => {
    prPollTick.update((n) => n + 1);
    const cutoff = Date.now() - INTEREST_MS;
    for (const [key, interest] of [...interests]) {
      if (interest.at < cutoff) {
        interests.delete(key);
        // The report goes with the interest. A stale PR redrawn from a
        // reading nobody has refreshed for an hour is worse than an
        // empty chip row: it looks current.
        prReports.update((all) => {
          if (!(key in all)) return all;
          const next = { ...all };
          delete next[key];
          return next;
        });
        continue;
      }
      void refreshPr(interest.cwd, interest.branch);
    }
  };
  timer = setInterval(sweep, TICK_MS);
  // Once immediately, so the first render of a rail header is not a
  // blank row for fifteen seconds.
  sweep();
  return stopPrPolling;
}

export function stopPrPolling(): void {
  if (timer !== null) clearInterval(timer);
  timer = null;
}

/// Test seam. Clears the interest table, the in-flight set and the store,
/// so one test's poll cannot leak into the next.
export function __resetForTesting(): void {
  stopPrPolling();
  interests.clear();
  inFlight.clear();
  prReports.set({});
  prPollTick.set(0);
}

/// The keys something is currently interested in. Exported for the tests
/// and for nothing else -- the interest table is deliberately not a
/// store, because every reader of it wants the REPORTS.
export function __interestKeys(): string[] {
  return [...interests.keys()];
}

/// Whether the ticker is running, for a caller that must not start a
/// second one (bootstrap runs more than once in dev).
export function prPollingRunning(): boolean {
  return timer !== null;
}

/// Read the store without subscribing -- for the scheduler, which reads
/// it once per tick inside an async pass.
export function currentPrReports(): Record<string, PrReport> {
  return get(prReports);
}
