// The live side of the pause feature: the stores, the polling and the
// one derived answer every surface asks.
//
// `agentPause.ts` and `agentUsage.ts` hold every judgement and every
// format; nothing here decides anything. What lives here is the state
// those pure functions need -- the configured cycle, the newest probe
// reading per profile, and a clock that makes a countdown tick -- because
// none of that can be tested and all of it has to be shared.
//
// ## Why a clock store at all
//
// `pauseVerdict` is a function of `now`, so a surface that renders it once
// shows a countdown frozen at the moment it mounted, and a scheduler that
// asks once never notices the pause lift. Svelte re-renders on store
// change, not on the passage of time, so the passage of time has to BE a
// store. One for the whole app: N components each running their own
// `setInterval` is N wakeups a minute and N different ideas of the time.

import { derived, get, readable, writable, type Readable } from "svelte/store";
import * as backend from "./backend";
import {
  DEFAULT_CYCLE,
  type PauseCycle,
  type PauseVerdict,
  pauseBlockedReason,
  pauseVerdict,
} from "./agentPause";
import type { AgentUsageReport } from "./agentUsage";
import {
  loadUsageHistory,
  projectUsage,
  recordUsage,
  saveUsageHistory,
  worstProjection,
  type UsageHistory,
  type UsageProjection,
} from "./usageProjection";
import { layoutState, resolvedAgentFor } from "./layoutState";

/// The app-wide cycle, or null for no cycle at all -- the shipped
/// default, so nothing pauses until somebody turns it on.
export const agentPauseStore = writable<PauseCycle | null>(null);

/// The newest reading per profile id. Absent means "not asked yet",
/// which is deliberately NOT the same as `unsupported`: a surface must be
/// able to say "checking…" instead of "this agent has no limits".
export const agentUsageStore = writable<Record<string, AgentUsageReport>>({});

/// Every reading kept, per profile and window, so the projection can
/// measure a burn rate off something other than a single number.
///
/// Loaded from localStorage at startup and written back whenever a
/// sample is actually stored. Persisting matters more here than for any
/// other view preference: a weekly window's first rate costs three hours
/// of samples, so a history that started again on every reload would
/// never once produce a weekly projection.
export const usageHistoryStore = writable<UsageHistory>({});

/// Ticks so countdowns move and the gate re-reads. Thirty seconds: a
/// "resets in 2h 14m" is wrong by at most half a minute, and a pause that
/// lifts is acted on within one tick.
const CLOCK_TICK_MS = 30_000;

/// How often a profile's limits are re-read. Longer than the host's own
/// two-minute floor so the poll is not mostly cache hits, and long enough
/// that leaving the panel open all day is a few dozen calls.
const POLL_MS = 180_000;

export const nowStore = writable<number>(Date.now());

let clockTimer: ReturnType<typeof setInterval> | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;

// ---- Loading and saving -----------------------------------------------------

/// Read once at bootstrap. Best-effort like the rest of the config reads:
/// a failure means no cycle, which is the shipped default and stops
/// nothing.
export async function loadAgentPause(): Promise<void> {
  try {
    agentPauseStore.set(await backend.getAgentPause());
  } catch {
    agentPauseStore.set(null);
  }
}

/// Saves the app-wide cycle, stamping an anchor only when there is not
/// one already.
///
/// The anchor is the whole reason the cycle survives a restart, so it is
/// minted ONCE -- when the cycle is first switched on -- and carried
/// unchanged through every later edit. Re-stamping it on save would slide
/// the pause forward every time somebody nudged a field, and a cycle that
/// keeps sliding never actually fires.
export async function saveAgentPause(cycle: PauseCycle | null): Promise<void> {
  const stamped =
    cycle && !cycle.anchorMs ? { ...cycle, anchorMs: Date.now() } : cycle;
  agentPauseStore.set(stamped);
  await backend.setAgentPause(stamped);
}

/// The cycle in force for a workspace: its own override, else the
/// app-wide one, else nothing.
///
/// A workspace's absent override means INHERIT, not off. Turning the
/// cycle off for one workspace stores a cycle with `enabled: false`,
/// which is why this cannot be a truthiness check.
export function effectiveCycle(workspaceId: string | null): PauseCycle | null {
  const appWide = get(agentPauseStore);
  if (!workspaceId) return appWide;
  const workspace = get(layoutState).workspaces.find((w) => w.id === workspaceId);
  return workspace?.agentPause ?? appWide;
}

/// The cycle a surface should EDIT for a workspace: its override if it
/// has one, else a copy of what it inherits, else the shipped default.
/// Never null, because an editor needs fields to put on screen.
export function editableCycle(workspaceId: string | null): PauseCycle {
  return effectiveCycle(workspaceId) ?? { ...DEFAULT_CYCLE, anchorMs: 0 };
}

// ---- The probe ---------------------------------------------------------------

/// Reads one profile's limits into the store. `force` is a human pressing
/// refresh; the host still refuses inside its 429 backoff.
export async function refreshUsage(profileId: string, force = false): Promise<void> {
  if (!profileId) return;
  try {
    const report = await backend.agentUsage(profileId, force);
    agentUsageStore.update((all) => ({ ...all, [profileId]: report }));
    recordSample(profileId, report);
  } catch (e) {
    // A failed IPC is an unavailability like any other. It must never
    // leave a stale `ready` in the store reading as current -- a bar
    // frozen at yesterday's number is worse than an honest gap.
    agentUsageStore.update((all) => ({
      ...all,
      [profileId]: { state: "unavailable", reason: String(e), retryAfter: null },
    }));
  }
}

/// Folds one reading into the history, and persists only when it
/// actually became a sample.
///
/// `recordUsage` returns the SAME object when the reading was inside the
/// window's sampling interval, which most of them are -- the poller runs
/// every three minutes against a five-minute cadence. Comparing
/// identity is what keeps that from writing localStorage twenty times an
/// hour to store nothing.
function recordSample(profileId: string, report: AgentUsageReport): void {
  const before = get(usageHistoryStore);
  const after = recordUsage(before, profileId, report);
  if (after === before) return;
  usageHistoryStore.set(after);
  saveUsageHistory(after);
}

/// Every profile any workspace actually runs. The panel lists these and
/// the poller reads these -- asking about `cursor` when nobody uses it is
/// a call and a row that mean nothing.
export function profilesInUse(): string[] {
  const ids = new Set<string>();
  for (const workspace of get(layoutState).workspaces) {
    const agent = resolvedAgentFor(workspace.id);
    if (agent.profileId) ids.add(agent.profileId);
  }
  return [...ids];
}

async function pollAll(force = false): Promise<void> {
  await Promise.all(profilesInUse().map((id) => refreshUsage(id, force)));
}

// ---- The verdict -------------------------------------------------------------

/// Whether gavin may start new work in this workspace, and why not.
///
/// Reads the workspace's own agent, because the limits that matter are
/// the ones the agent it launches spends against -- a workspace on Gemini
/// is not held by a Claude Code window being full.
export function pauseFor(workspaceId: string | null, nowMs: number): PauseVerdict {
  const cycle = effectiveCycle(workspaceId);
  if (!cycle) return { paused: false, reason: null, why: null, until: null };
  const profileId = workspaceId ? resolvedAgentFor(workspaceId).profileId : null;
  const usage: AgentUsageReport = (profileId && get(agentUsageStore)[profileId]) || {
    state: "unsupported",
  };
  return pauseVerdict(cycle, usage, nowMs);
}

/// The active workspace's verdict, recomputed on every clock tick and
/// whenever the cycle, the readings or the workspace list change. This is
/// what the sidebar strip and the title bar read.
export const activePause: Readable<PauseVerdict> = derived(
  [nowStore, agentPauseStore, agentUsageStore, layoutState],
  ([now, , , state]) => pauseFor(state.activeWorkspaceId, now)
);

// ---- The projection ----------------------------------------------------------

/// Every window of every profile in use, projected forward.
///
/// The same inputs `activePause` rides, so the semaphore and the
/// pause badge that share a sidebar row can never disagree about what
/// time it is or which reading they are looking at.
export const usageProjections: Readable<UsageProjection[]> = derived(
  [nowStore, agentUsageStore, usageHistoryStore, layoutState],
  ([now, reports, history]) =>
    projectUsage({
      // Recomputed rather than closed over: `profilesInUse` reads the
      // workspace list, which is the fourth dependency above.
      profileIds: profilesInUse(),
      reports,
      history,
      nowMs: now,
    })
);

/// The single projection a semaphore stands for: the worst band, and
/// within it the tightest margin. Null while nothing is known, which is
/// the signal to draw no badge at all.
export const worstUsageProjection: Readable<UsageProjection | null> = derived(
  usageProjections,
  (projections) => worstProjection(projections)
);

export interface PausedWorkspace {
  id: string;
  name: string;
  verdict: PauseVerdict;
}

/// Every workspace being held right now, fleet-wide.
///
/// `activePause` above answers for ONE workspace because the surfaces
/// that read it -- the sidebar strip, the title bar -- are only ever
/// about the one in front of you. The app hub is about all of them at
/// once, and the answers genuinely differ: a workspace on codex is not
/// held by a Claude window being full, and a per-workspace cycle
/// override holds only its own.
///
/// Same inputs as `activePause`, so it moves on the same clock tick and
/// cannot lag behind the strip.
export const pausedWorkspaces: Readable<PausedWorkspace[]> = derived(
  [nowStore, agentPauseStore, agentUsageStore, layoutState],
  ([now, , , state]) =>
    state.workspaces
      .map((w) => ({ id: w.id, name: w.name, verdict: pauseFor(w.id, now) }))
      .filter((w) => w.verdict.paused)
);

/// The active workspace's paused flag, emitting ONLY when it flips.
///
/// `activePause` rides the clock, so it emits every thirty seconds
/// forever. That is fine for a countdown on screen and wrong as a
/// scheduler input: the scheduler would run a pass twice a minute for the
/// life of the app, whether or not anything changed. Deduping to the
/// boolean means it emits exactly twice per pause -- once when work stops
/// and once when it may start again, which is the second that matters.
///
/// `readable` with its own subscription rather than `derived`, because
/// `derived` re-emits on every input change regardless of value.
export const activePaused: Readable<boolean> = readable(false, (set) => {
  let last: boolean | null = null;
  return activePause.subscribe((verdict) => {
    if (verdict.paused === last) return;
    last = verdict.paused;
    set(verdict.paused);
  });
});

/// Whether gavin may start work in this workspace right now. The one
/// question the scheduler and the auto-resume gate ask.
export function mayStartWork(workspaceId: string): boolean {
  return !pauseFor(workspaceId, get(nowStore)).paused;
}

/// The reason it may not, phrased for an audit trail. Null while running.
///
/// The PAUSE first, then the launch wall. Both can hold at once and only
/// one sentence fits on a badge, so the order has to be a decision: the
/// pause is the human's own instruction ("don't spend between 2 and 4"),
/// and telling somebody they are waiting for a slot when they are
/// actually waiting for their own schedule would send them to the wrong
/// setting.
///
/// Read through a hook the queue installs at startup rather than by
/// importing it: `launchQueue` reads `memoryState`, which reads
/// `layoutState`, which starts THIS module -- so a static import the
/// other way would close a cycle for one string.
export function startBlockedReason(workspaceId: string): string | null {
  const paused = pauseBlockedReason(pauseFor(workspaceId, get(nowStore)));
  if (paused) return paused;
  return gateReason();
}

/// The launch wall's reason, read through a hook the queue installs at
/// startup. Null until it does, which is exactly the answer before the
/// wall is running: nothing is being held by a gate that does not exist
/// yet.
let gateReasonHook: (() => string | null) | null = null;

export function setGateReasonHook(hook: (() => string | null) | null): void {
  gateReasonHook = hook;
}

function gateReason(): string | null {
  return gateReasonHook ? gateReasonHook() : null;
}

// ---- Lifecycle ---------------------------------------------------------------

/// Starts the clock and the poller. Module-level, like `startScheduler`
/// -- NOT a component `$effect`, because a pause that only advances while
/// one particular tab is mounted is the bug that made rails tick only on
/// their own tab. Returns its own teardown.
export function startPauseClock(): () => void {
  stopPauseClock();
  clockTimer = setInterval(() => nowStore.set(Date.now()), CLOCK_TICK_MS);
  pollTimer = setInterval(() => void pollAll(), POLL_MS);
  void loadAgentPause();
  // Before the first poll, so the reading that lands has yesterday's
  // samples to continue rather than starting an epoch of its own.
  usageHistoryStore.set(loadUsageHistory());
  void pollAll();
  return stopPauseClock;
}

export function stopPauseClock(): void {
  if (clockTimer) clearInterval(clockTimer);
  if (pollTimer) clearInterval(pollTimer);
  clockTimer = null;
  pollTimer = null;
}
