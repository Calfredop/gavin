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
import * as backend from "$lib/core/backend";
import {
  DEFAULT_CYCLE,
  type PauseCycle,
  type PauseVerdict,
  pauseVerdict,
  cyclePhase,
} from "$lib/agents/agentPause";
import type { AgentUsageReport } from "$lib/agents/agentUsage";
import {
  dropExpiredWindows,
  loadUsageCache,
  pruneUsageCache,
  saveUsageCache,
} from "$lib/agents/agentUsage";
import {
  loadUsageHistory,
  projectUsage,
  recordUsage,
  saveUsageHistory,
  worstProjection,
  type UsageHistory,
  type UsageProjection,
} from "$lib/agents/usageProjection";
import { layoutState, resolvedAgentFor, agentDefaultsStore } from "$lib/core/layoutState";
import {
  decideLaunch,
  effectiveFallbackChain,
  fallbackBlockedReason,
  type FallbackDecision,
} from "$lib/agents/agentFallback";

/// The app-wide cycle, or null for no cycle at all -- the shipped
/// default, so nothing pauses until somebody turns it on.
export const agentPauseStore = writable<PauseCycle | null>(null);

/// The newest reading per profile id. Absent means "not asked yet",
/// which is deliberately NOT the same as `unsupported`: a surface must be
/// able to say "checking…" instead of "this agent has no limits".
///
/// Hydrated from last-known ready readings at startup so a restart
/// draws yesterday's bars while the probes run, then replaced as each
/// live answer lands.
export const agentUsageStore = writable<Record<string, AgentUsageReport>>({});

/// Profiles whose probe is in flight. Surfaces that already have a
/// reading draw the refreshing badge; surfaces with nothing yet keep
/// saying "Checking…".
export const usageRefreshingStore = writable<Record<string, boolean>>({});

type MaybeStorage = Pick<Storage, "getItem" | "setItem" | "removeItem"> | undefined;

/// Every reading kept, per profile and window, so the projection can
/// measure a burn rate off something other than a single number.
///
/// Loaded from localStorage at startup and written back whenever a
/// sample is actually stored. Persisting matters more here than for any
/// other view preference: a weekly window's first rate costs half an hour
/// of samples on a heavy burn and up to three on a quiet one, so a
/// history that started again on every reload would rarely produce a
/// weekly projection at all.
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
let staleTimer: ReturnType<typeof setTimeout> | null = null;

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
///
/// A probe that throws keeps a still-open last reading: the bars on
/// screen at restart must not vanish because the first curl of the
/// session failed. Only when there is nothing still-open to keep does
/// the failure become `unavailable`.
export async function refreshUsage(profileId: string, force = false): Promise<void> {
  if (!profileId) return;
  usageRefreshingStore.update((all) => ({ ...all, [profileId]: true }));
  try {
    const report = await backend.agentUsage(profileId, force);
    agentUsageStore.update((all) => ({ ...all, [profileId]: report }));
    recordSample(profileId, report);
    persistUsageCache();
    armStaleTimer();
  } catch (e) {
    agentUsageStore.update((all) => {
      const existing = all[profileId];
      const kept = existing ? dropExpiredWindows(existing, Date.now()) : null;
      if (kept) return all;
      return {
        ...all,
        [profileId]: { state: "unavailable", reason: String(e), retryAfter: null },
      };
    });
  } finally {
    usageRefreshingStore.update((all) => {
      const next = { ...all };
      delete next[profileId];
      return next;
    });
  }
}

function persistUsageCache(nowMs: number = Date.now(), storage?: MaybeStorage): void {
  saveUsageCache(get(agentUsageStore), storage, nowMs);
}

/// Last known ready readings, so the panel is not blank while the
/// first probes of the session run. Expired windows are already gone
/// from what load returns.
export function hydrateUsageCache(nowMs: number = Date.now(), storage?: MaybeStorage): void {
  const loaded = loadUsageCache(nowMs, storage);
  agentUsageStore.set(loaded);
  saveUsageCache(loaded, storage, nowMs);
  armStaleTimer(nowMs, storage);
}

/// The cache's TTL is each window's own reset, not a fixed age. Arm
/// a timer for the soonest one so a 5-hour window that closed a
/// second ago does not sit at 96% until the next poll.
function armStaleTimer(nowMs: number = Date.now(), storage?: MaybeStorage): void {
  if (staleTimer) {
    clearTimeout(staleTimer);
    staleTimer = null;
  }
  const nextAt = earliestResetMs(get(agentUsageStore));
  if (nextAt == null) return;
  const delay = Math.max(0, Math.min(nextAt - nowMs + 50, 2_147_483_647));
  staleTimer = setTimeout(() => {
    pruneCachedUsage(Date.now(), storage);
    armStaleTimer(Date.now(), storage);
  }, delay);
}

function earliestResetMs(reports: Record<string, AgentUsageReport>): number | null {
  let earliest: number | null = null;
  for (const report of Object.values(reports)) {
    if (report.state !== "ready") continue;
    for (const window of report.windows) {
      if (window.resetsAt == null) continue;
      const at = window.resetsAt * 1000;
      if (earliest == null || at < earliest) earliest = at;
    }
  }
  return earliest;
}

function pruneCachedUsage(nowMs: number, storage?: MaybeStorage): void {
  const before = get(agentUsageStore);
  const after = pruneUsageCache(before, nowMs);
  if (after === before) return;
  agentUsageStore.set(after);
  saveUsageCache(after, storage, nowMs);
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
  const appChain = get(agentDefaultsStore).agentFallback ?? [];
  for (const workspace of get(layoutState).workspaces) {
    const agent = resolvedAgentFor(workspace.id);
    if (agent.profileId) ids.add(agent.profileId);
    for (const id of effectiveFallbackChain(workspace.agentFallback, appChain)) {
      ids.add(id);
    }
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
  return pauseVerdict(cycle, usage, nowMs, profileId);
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
  [nowStore, agentPauseStore, agentUsageStore, layoutState, agentDefaultsStore],
  ([now, , , state]) =>
    state.workspaces
      .map((w) => ({ id: w.id, name: w.name, verdict: pauseFor(w.id, now) }))
      .filter((w) => launchPauseHold(w.id, now).paused)
);

/// WHICH workspaces are paused, as one comparable key, emitting ONLY
/// when that set changes. The scheduler's pause input.
///
/// `pausedWorkspaces` rides the clock, so it emits every thirty seconds
/// forever. That is fine for a list on screen and wrong as a scheduler
/// input: the scheduler would run a pass twice a minute for the life of
/// the app, whether or not anything changed. Deduping to the id set
/// means it emits exactly twice per pause -- once when work stops and
/// once when it may start again, which is the second that matters.
///
/// Every workspace and not just the active one, because the scheduler
/// ticks every LOADED workspace (see startScheduler): a rail paused in
/// the workspace you are not looking at is the one whose resume nothing
/// else would announce, and it would sit there until some unrelated
/// push happened along -- in a paused workspace, where every session is
/// by definition quiet, that can be a long time.
///
/// A joined id string rather than a boolean or the array: the array is a
/// fresh object every clock tick and a boolean cannot tell "A paused" from
/// "A resumed as B paused", which is one workspace owed a tick it would
/// never get.
///
/// `readable` with its own subscription rather than `derived`, because
/// `derived` re-emits on every input change regardless of value.
export const pausedWorkspaceKey: Readable<string> = readable("", (set) => {
  let last: string | null = null;
  return pausedWorkspaces.subscribe((paused) => {
    const key = paused
      .map((w) => w.id)
      .sort()
      .join(" ");
    if (key === last) return;
    last = key;
    set(key);
  });
});

/// Which agent a launch should use right now, or why it must wait.
///
/// Cycle pause is a hard hold. Usage-limit pause walks the fallback
/// chain. The workspace's own profile counts as armed; other profiles
/// need a completed setup-only arming.
export function launchDecision(
  workspaceId: string,
  resolvedProfileId: string,
  resume: boolean,
  nowMs: number = get(nowStore)
): FallbackDecision {
  const cycle = effectiveCycle(workspaceId);
  const cyclePaused = cycle ? cyclePhase(cycle, nowMs).paused : false;
  const workspace = get(layoutState).workspaces.find((w) => w.id === workspaceId);
  const chain = effectiveFallbackChain(
    workspace?.agentFallback,
    get(agentDefaultsStore).agentFallback
  );
  const workspaceProfile = resolvedAgentFor(workspaceId).profileId;
  const armed = new Set<string>([
    ...(workspaceProfile ? [workspaceProfile] : []),
    ...(workspace?.armedAgents ?? []),
  ]);
  // No cycle at all means limits are off — the same early return
  // `pauseFor` takes. Inventing DEFAULT_CYCLE.limitEnabled here would
  // start pausing installs that never configured a pause.
  return decideLaunch({
    resolvedProfileId: resolvedProfileId ?? "",
    workspaceProfileId: workspaceProfile,
    chain,
    usageByProfile: get(agentUsageStore),
    armed,
    limitEnabled: cycle?.limitEnabled ?? false,
    limitPercent: cycle?.limitPercent ?? DEFAULT_CYCLE.limitPercent,
    fallbackThresholds: get(agentDefaultsStore).fallbackThresholds,
    cyclePaused,
    resume,
  });
}

/// Pause-shaped hold for the launch wall's `startVerdict`: cycle and a
/// spent chain still hold; a ready fallback does not.
export function launchPauseHold(
  workspaceId: string | null,
  nowMs: number
): { paused: boolean; why: string | null } {
  if (!workspaceId) return { paused: false, why: null };
  const decision = launchDecision(
    workspaceId,
    resolvedAgentFor(workspaceId).profileId,
    false,
    nowMs
  );
  if (decision.kind === "use") return { paused: false, why: null };
  if (decision.kind === "arm") {
    return { paused: true, why: fallbackBlockedReason(decision) };
  }
  const pause = pauseFor(workspaceId, nowMs);
  if (decision.why === "cycle" || pause.reason?.kind === "usage-limit") {
    return { paused: pause.paused, why: pause.why };
  }
  return { paused: true, why: fallbackBlockedReason(decision) };
}

/// Whether gavin may start work in this workspace right now. The one
/// question the scheduler and the auto-resume gate ask.
///
/// True only when a launch of the workspace's own agent (or its
/// fallback) may go. An unarmed chain entry holds automated starts so a
/// rail does not spin opening the wizard every tick — a board Run asks
/// `launchDecision` itself and forces the wizard.
export function mayStartWork(workspaceId: string): boolean {
  return (
    launchDecision(workspaceId, resolvedAgentFor(workspaceId).profileId, false).kind === "use"
  );
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
  const hold = launchPauseHold(workspaceId, get(nowStore));
  if (hold.paused && hold.why) {
    return hold.why.startsWith("work is ") ? hold.why : `work is paused: ${hold.why}`;
  }
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
  // ...and last known bars, so a restart is not a blank "Checking…"
  // for the length of the probes.
  hydrateUsageCache();
  void pollAll();
  return stopPauseClock;
}

export function stopPauseClock(): void {
  if (clockTimer) clearInterval(clockTimer);
  if (pollTimer) clearInterval(pollTimer);
  if (staleTimer) clearTimeout(staleTimer);
  clockTimer = null;
  pollTimer = null;
  staleTimer = null;
}
