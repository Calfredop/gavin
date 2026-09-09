// The store behind the Tools tab's last-run chips: one list per
// workspace, fetched when the tab mounts and re-read whenever a session
// ends.
//
// The re-read is the whole reason this module is not two lines. There is
// NO push for tool runs: the daemon closes a `command` or `script` run
// by itself, off the session exit it already watches, and says nothing
// -- so a tab left open would sit showing `running` on a tool that
// finished thirty seconds ago and stay that way until the human
// navigated away and back. `sessionExits` is the app's own record of
// every session that ended in this run (layoutState.ts), it is a store,
// and subscribing to it is exactly the seam the orchestration scheduler
// already uses for the same fact.
//
// Deliberately not part of toolsState.ts, which holds the LIBRARY: a
// tool outlives every run of it, the library is written by this app and
// the runs are written by the daemon, and the two are fetched on
// completely different occasions.
//
// Supersession is guarded with a token counter rather than by comparing
// objects: Svelte 5's `$state` proxies everything it touches, so a
// stored value is never identity-equal to the one that was put in.

import { get, writable } from "svelte/store";
import * as backend from "$lib/core/backend";
import { featureBlockedReason, type DaemonCompat } from "$lib/core/daemonCompat";
import { daemonCompat, sessionExits } from "$lib/core/layoutState";
// TYPE-only, deliberately: this module is reached from
// `layoutState.bootstrap`, and a value import of workspaceTools would
// pull the whole `@lucide/svelte` barrel onto the start-up path. The
// derivation the tab wants (`lastRunsFor`) lives there instead.
import type { ToolRun } from "$lib/workspace/workspaceTools";

export interface ToolRunsView {
  runs: ToolRun[];
  loading: boolean;
  /// Null is not "no error": a workspace that has never fetched has no
  /// entry at all. This is the last fetch's failure, shown above the
  /// list rather than in place of it -- the tools are still there and
  /// still runnable, it is only their history that is missing.
  error: string | null;
  token: number;
}

export const toolRunsStore = writable<Record<string, ToolRunsView>>({});

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/// Reads this workspace's runs. Rows a previous read left behind are
/// KEPT while the fetch is in flight: a chip that blanks and comes back
/// on every session exit reads as a run that was lost.
///
/// Gated on the daemon, and SILENT about it: the reason a v29 daemon
/// keeps no runs is already on every Run button (`runBlockedReason`),
/// and repeating it as a fetch error above the list would say the same
/// thing twice about a list that is empty for that exact reason.
export async function refreshToolRuns(
  workspaceId: string,
  compat: DaemonCompat | null
): Promise<void> {
  if (featureBlockedReason(compat, "toolRuns")) return;
  const token = (get(toolRunsStore)[workspaceId]?.token ?? 0) + 1;
  toolRunsStore.update((all) => ({
    ...all,
    [workspaceId]: {
      runs: all[workspaceId]?.runs ?? [],
      loading: true,
      error: null,
      token,
    },
  }));
  try {
    const runs = await backend.toolRuns(workspaceId);
    apply(workspaceId, token, (view) => ({ ...view, runs, loading: false, error: null }));
  } catch (e) {
    apply(workspaceId, token, (view) => ({ ...view, loading: false, error: errorText(e) }));
  }
}

/// A token counter, not an identity check: `stateVar !== rawObject` is
/// always true under Svelte 5's proxies, so "is this still the fetch I
/// started" has to be a number.
function apply(
  workspaceId: string,
  token: number,
  fn: (view: ToolRunsView) => ToolRunsView
): void {
  toolRunsStore.update((all) => {
    const view = all[workspaceId];
    if (!view || view.token !== token) return all;
    return { ...all, [workspaceId]: fn(view) };
  });
}

/// Optimistic local record of a launch, so the row says `running` the
/// instant the session appears rather than after the next fetch.
///
/// The daemon has the real row -- `StartToolRun` was filed by the same
/// launch -- and the next refresh overwrites this with it. What this
/// buys is the half-second in between, which is precisely when the human
/// is looking at the button they just pressed.
///
/// The id is `Date.now()`, which is larger than any row id the daemon
/// will mint for years, so `lastRunByTool` prefers it while it stands.
export function noteToolRunStarted(input: {
  workspaceId: string;
  toolId: string;
  sessionId: string;
  command: string | null;
  launchCwd: string | null;
  conversationId: string | null;
}): void {
  const optimistic: ToolRun = {
    id: Date.now(),
    toolId: input.toolId,
    sessionId: input.sessionId,
    command: input.command,
    launchCwd: input.launchCwd,
    conversationId: input.conversationId,
    startedAt: Math.floor(Date.now() / 1000),
    endedAt: null,
    exitCode: null,
    outcome: "running",
  };
  toolRunsStore.update((all) => {
    const view = all[input.workspaceId] ?? { runs: [], loading: false, error: null, token: 0 };
    return {
      ...all,
      [input.workspaceId]: {
        ...view,
        // Every other row of this tool is dropped: the tab reads one run
        // per tool, and keeping a superseded row would only give
        // `lastRunByTool` something to discard.
        runs: [...view.runs.filter((r) => r.toolId !== input.toolId), optimistic],
      },
    };
  });
}

let stopWatching: (() => void) | null = null;

/// Re-reads every loaded workspace's runs whenever a session ends.
///
/// Every loaded one rather than only the active one, unlike the
/// orchestration scheduler: this is a read, it costs one request, and a
/// tool launched from a workspace the human then switched away from is
/// exactly the run they will come back to check.
///
/// Started by the app, not by the tab, for the reason the rail scheduler
/// moved out of its hub view: a tab that owns its own listener stops
/// listening the moment somebody looks at something else, which is when
/// the interesting exits happen.
export function startToolRunWatcher(): () => void {
  stopWatching?.();
  let seeded = false;
  const unsubscribe = sessionExits.subscribe(() => {
    // A store emits its current value on subscribe. That first emission
    // is not a session ending, and refreshing on it would fire a request
    // per app start for workspaces nobody has opened a tab on.
    if (!seeded) {
      seeded = true;
      return;
    }
    const compat = get(daemonCompat);
    for (const workspaceId of Object.keys(get(toolRunsStore))) {
      void refreshToolRuns(workspaceId, compat);
    }
  });
  const stop = () => {
    unsubscribe();
    // Guarded: a later start owns the field, and this teardown arriving
    // afterwards must not clear the live watcher out of it.
    if (stopWatching === stop) stopWatching = null;
  };
  stopWatching = stop;
  return stop;
}

/** @internal test-only reset for module-level state */
export function __resetForTesting(): void {
  stopWatching?.();
  stopWatching = null;
  toolRunsStore.set({});
}
