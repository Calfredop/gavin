// The live side of the memory wall: one poller, app-wide, and the three
// stores everything downstream reads.
//
// `memory.ts` holds every judgement and every format; nothing here
// decides anything. What lives here is the state those pure functions
// need -- the newest machine sample, the newest per-session sample, and
// the mean tree size per agent profile -- because none of it can be
// tested and all of it has to be shared.
//
// ## Why the daemon's process sample moves here
//
// `SessionProcesses` has existed since v25 and exactly one surface asked
// for it: the sessions manager, and only while its modal was open. That
// is the right cost for a task manager and the wrong one for a launch
// gate, which has to know what the fleet is holding at the moment
// somebody presses Run -- with no modal open, in a window that is not
// even showing the workspace the launch is for. So the poll becomes the
// app's, started once by bootstrap the way `startPauseClock` is, and the
// sessions manager keeps its own faster poll for the columns it draws.
//
// ## Why a module-level poller and not a component `$effect`
//
// The same reason `startScheduler` is module-level: a hold that only
// re-checks while one particular tab is mounted is a hold that never
// lifts. This one is worse than the rail case would have been -- the
// queue it feeds drains launches, so a stalled poll means work that
// silently never starts.

import { derived, get, writable, type Readable } from "svelte/store";
import * as backend from "$lib/backend";
import {
  fleetMemory as computeFleetMemory,
  loadStoredMeans,
  pressureOf,
  rootsFromWatchList,
  saveStoredMeans,
  type AgentSample,
  type FleetMemory,
  type MemoryPressure,
  type SystemMemorySample,
  type WatchmanSample,
} from "$lib/agents/memory";
import { layoutState, resolvedAgentFor } from "$lib/layoutState";
import { findSessionLocation } from "$lib/workspace";
import type { ManagedSession } from "$lib/sessions/sessionsManager";

/// The newest machine reading, or null before the first poll lands.
/// Null is "not asked yet", which every caller must read as "no reason
/// to hold" rather than as a machine that is full.
export const systemMemory = writable<SystemMemorySample | null>(null);

/// The live watchman server, or null when there is not one. Polled on
/// the same tick as the machine because it is the same question: what is
/// holding memory that gavin did not launch.
export const watchmanStore = writable<WatchmanSample | null>(null);

/// Every AGENT session the daemon is holding, with what its process tree
/// costs. Keyed by session id.
///
/// Agents only: a plain shell carries no command (the daemon reports
/// `command: null` for one), and counting shells toward the ceiling
/// would hold work because somebody left four terminals open.
export const agentSessions = writable<Record<string, AgentSample & { command: string }>>({});

/// What the fleet's agents are holding, and the mean tree size per
/// profile the estimate is built on.
export const fleetMemory: Readable<FleetMemory> = derived(agentSessions, (sessions) =>
  computeFleetMemory(Object.values(sessions))
);

/// The last mean tree size seen for each agent profile, kept across
/// reloads and restarts.
///
/// The estimate's second source, and the one that carries the FIRST
/// launch after a restart: nothing is running then, so there is no
/// sample to average, and without this every estimate would fall back to
/// the floor -- which understates a Claude Code tree by two thirds.
export const storedMeans = writable<Record<string, number>>({});

/// The machine's pressure in one word, recomputed as samples land.
export const memoryPressure: Readable<MemoryPressure> = derived(systemMemory, (sample) =>
  pressureOf(sample)
);

/// The roots a live watchman is watching. Empty when there is no server,
/// which is not the same claim as a server watching nothing -- callers
/// that need the difference read `watchmanStore` itself.
export const watchmanRoots: Readable<string[]> = derived(watchmanStore, (w) =>
  w ? rootsFromWatchList(w.rootsJson) : []
);

/// The quiet cadence. Five seconds: a machine does not fill in less than
/// that, and the poll costs one sysctl read plus one walk of the process
/// table per session.
const POLL_MS = 5_000;

/// The cadence once pressure is off normal. The gate's hysteresis is
/// measured in tens of seconds, so a reading every two is enough to see
/// a hold lift promptly without turning the probe into the load.
const POLL_UNDER_PRESSURE_MS = 2_000;

/// How often the WATCHMAN half is re-read, as opposed to the machine.
///
/// Its own cadence because its cost is a different order: the machine is
/// four sysctls, and this is a process lookup plus a CLI round trip. The
/// figure it produces moves on the scale of somebody cutting or merging
/// a worktree, so a reading every half minute is already finer than the
/// thing it measures -- and a subprocess every five seconds for the life
/// of the app would be exactly the kind of background cost this whole
/// feature exists to remove.
const WATCHMAN_POLL_MS = 30_000;

let lastWatchmanMs = 0;

let timer: ReturnType<typeof setTimeout> | null = null;
/// Guards against two polls overlapping when one runs long -- a wedged
/// watchman is exactly the case where that happens, and a second poll
/// stacked on it would multiply the stall rather than recover from it.
let polling = false;

// ---- The sample ---------------------------------------------------------

/// Which agent profile launched a session, as far as anything can say.
///
/// By the workspace that HOLDS the session, not by parsing its command:
/// the command is a shell line with a prompt in it, and matching profile
/// names against that would attribute an opencode run to claude-code the
/// first time somebody's prompt mentioned claude. A session no open
/// workspace holds resolves to null, and `perAgentEstimate` reads that
/// as "use the floor".
function profileForSession(session: ManagedSession): string | null {
  const state = get(layoutState);
  const located = findSessionLocation(state, session.id);
  const workspaceId =
    located?.workspaceId ??
    (session.workspacePath
      ? (state.workspaces.find((w) => w.rootPath === session.workspacePath)?.id ?? null)
      : null);
  if (!workspaceId) return null;
  return resolvedAgentFor(workspaceId).profileId || null;
}

/// One pass: the machine, the watchman, and every agent session's tree.
///
/// Best-effort throughout. A failed IPC leaves the previous sample
/// standing rather than blanking it, because a blank sample reads as
/// "nothing running" -- which would open the ceiling wide at exactly the
/// moment the app has lost contact with the daemon.
async function poll(force = false): Promise<void> {
  if (polling) return;
  polling = true;
  try {
    try {
      systemMemory.set(await backend.systemMemory());
    } catch {
      // Leave the last reading. It is stale, and `sampledAtMs` says so.
    }
    if (force || Date.now() - lastWatchmanMs >= WATCHMAN_POLL_MS) {
      lastWatchmanMs = Date.now();
      try {
        watchmanStore.set(await backend.watchmanStatus());
      } catch {
        watchmanStore.set(null);
      }
    }
    try {
      const managed = await backend.listManagedSessions();
      // An older daemon answers with rows and no figures. Keeping those
      // as zeroes would report a fleet holding nothing, so the map is
      // built either way -- the count is real, and `meanRssByProfile`
      // already refuses to average an unmeasured zero.
      const next: Record<string, AgentSample & { command: string }> = {};
      for (const session of managed.sessions) {
        // No command is a plain shell, and an exited row is a record
        // with nothing behind it: neither is an agent holding memory.
        if (!session.command || session.status === "exited") continue;
        next[session.id] = {
          sessionId: session.id,
          profileId: profileForSession(session),
          rssBytes: managed.metrics ? session.rssBytes : 0,
          processCount: session.processCount,
          command: session.command,
        };
      }
      agentSessions.set(next);
      rememberMeans(get(fleetMemory).meanByProfile);
    } catch {
      // Same reasoning: a lost daemon must not read as an empty fleet.
    }
  } finally {
    polling = false;
  }
}

/// Folds a fresh set of means into what is remembered, and persists only
/// when something actually moved.
///
/// Merged rather than replaced: a profile with nothing running right now
/// keeps the figure it last measured, which is the whole reason this is
/// stored. The comparison is what stops a localStorage write every five
/// seconds for a fleet whose means have not changed.
function rememberMeans(fresh: Record<string, number>): void {
  if (Object.keys(fresh).length === 0) return;
  const before = get(storedMeans);
  const after = { ...before, ...fresh };
  if (Object.keys(after).every((k) => before[k] === after[k]) &&
      Object.keys(before).length === Object.keys(after).length) {
    return;
  }
  storedMeans.set(after);
  saveStoredMeans(after);
}

/// Arms the next poll at the cadence the CURRENT pressure asks for.
///
/// A self-rescheduling timeout rather than a fixed interval, because the
/// cadence is a function of the last reading: an interval would have to
/// be town down and rebuilt on every pressure change, and the window
/// where neither is armed is the window a hold never lifts in.
function arm(): void {
  if (timer) clearTimeout(timer);
  const wait = get(memoryPressure) === "normal" ? POLL_MS : POLL_UNDER_PRESSURE_MS;
  timer = setTimeout(() => {
    void poll().finally(arm);
  }, wait);
}

/// Starts the memory poller. Module-level, like `startPauseClock` and
/// `startScheduler`, and for the reason the header gives. Returns its
/// own teardown.
export function startMemoryPoll(): () => void {
  stopMemoryPoll();
  // Before the first poll, so the first sample has yesterday's means to
  // merge into rather than starting an epoch of its own.
  storedMeans.set(loadStoredMeans());
  void poll().finally(arm);
  return stopMemoryPoll;
}

export function stopMemoryPoll(): void {
  if (timer) clearTimeout(timer);
  timer = null;
}

/// One immediate reading, for a surface that has just been opened and
/// should not show a five-second-old figure. Never replaces the poller.
export async function refreshMemory(): Promise<void> {
  // Forced, so a panel that has just dropped a watchman root sees the
  // shorter list rather than the one cached half a minute ago.
  await poll(true);
}

/// Test-only reset, so one suite's fleet cannot be another's.
export function __resetMemoryForTesting(): void {
  stopMemoryPoll();
  polling = false;
  lastWatchmanMs = 0;
  systemMemory.set(null);
  watchmanStore.set(null);
  agentSessions.set({});
  storedMeans.set({});
}
