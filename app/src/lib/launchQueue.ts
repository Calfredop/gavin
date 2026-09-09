// Where a refused launch waits, and the loop that lets it go.
//
// `launchGate.ts` decides; this module holds the state that decision is
// made from and the queue that makes a refusal survivable. Without the
// queue the gate would be a wall: press Run on eleven cards, four start,
// seven silently do nothing, and the human is left pressing buttons
// until one takes. With it, "held" means "not yet".
//
// Four things live here and nowhere else:
//
//   * the app-wide `launch` config, loaded once and written through the
//     host's own get/set pair (never the workspaces save, which is where
//     a carried-through field goes to be silently wiped);
//   * the in-flight count -- agent sessions that are working or asking,
//     across EVERY workspace and every window, because the machine is
//     one machine;
//   * `pressureSinceMs`, the clock the gate's hysteresis runs on;
//   * the queue itself, persisted per window so a reload keeps it.
//
// ## Rails are not queued
//
// The scheduler IS the rail's queue. `executeActions` skips a `launch`
// the gate refuses at the same seam `mayStartWork` already uses, and the
// gate's deduped flag joins `tickInputStores()` so a lifted hold ticks
// the scheduler and the action is emitted again. Putting a rail step in
// this queue as well would give one launch two owners.
//
// ## Two windows, two queues, one machine
//
// Each window persists and drains its own queue while the in-flight
// count is global. That is accepted rather than solved: both windows
// read the same daemon sample and the same ceiling, so the SECOND window
// to drain sees the first one's launch and holds. The cost is that the
// order between two windows' queues is not defined, which is a smaller
// problem than a shared queue no window owns.

import { derived, get, readable, writable, type Readable } from "svelte/store";
import * as backend from "$lib/backend";
import {
  DEFAULT_LAUNCH,
  DRAIN_SPACING_MS,
  countsInFlight,
  gateBlockedReason,
  launchVerdict,
  mayDrain,
  type LaunchConfig,
  type LaunchVerdict,
} from "$lib/launchGate";
import { fleetStrip, usedBytes as usedBytesOf, type FleetStrip } from "$lib/memory";
import { launchEstimate, type LaunchEstimate } from "$lib/launchEstimate";
import { agentSessions, fleetMemory, memoryPressure, storedMeans, systemMemory } from "$lib/memoryState";
import { layoutState, resolvedAgentFor } from "$lib/layoutState";
import { currentWindowLabel } from "$lib/appWindowState";
import { setGateReasonHook } from "$lib/agentPauseState";
import type { ReviewedCard } from "$lib/review/codeReview";

// ---- The config -------------------------------------------------------------

/// The app-wide wall in force. Never null: a config that has never been
/// edited resolves to `DEFAULT_LAUNCH`, so every reader has numbers.
export const launchConfigStore = writable<LaunchConfig>(DEFAULT_LAUNCH);

/// Read once at bootstrap. Best-effort like every other config read: a
/// failure leaves the shipped default, which is the safe direction here
/// -- unlike the pause, whose default is "no cycle", this feature's
/// default is the guard being ON.
export async function loadLaunchConfig(): Promise<void> {
  try {
    launchConfigStore.set((await backend.getLaunchConfig()) ?? DEFAULT_LAUNCH);
  } catch {
    launchConfigStore.set(DEFAULT_LAUNCH);
  }
}

/// Saves the wall. Wholesale, the shape `setAgentPause` uses: the panel
/// holds both fields, so there is no way for one to be written while the
/// other is dropped.
export async function saveLaunchConfig(config: LaunchConfig): Promise<void> {
  launchConfigStore.set(config);
  await backend.setLaunchConfig(config);
}

// ---- What the gate reads ----------------------------------------------------

/// Agent sessions that are working or asking, app-wide.
///
/// The JOIN is the point: `agentSessions` says which sessions are agents
/// (a plain shell carries no command), and `sessionStatusById` says what
/// each is doing. Counting either alone would be wrong in opposite
/// directions -- every open terminal, or every agent tab ever left
/// behind.
export const inFlightCount: Readable<number> = derived(
  [agentSessions, layoutState],
  ([sessions, state]) =>
    Object.keys(sessions).filter((id) => countsInFlight(state.sessionStatusById[id])).length
);

/// When pressure was last seen at something other than normal.
///
/// Module-level rather than derived, because it is a MEMORY: the gate
/// needs to know that the machine was struggling twenty seconds ago,
/// which no current reading can say.
let pressureSinceMs: number | null = null;

/// Re-exported as a store so the verdict below recomputes when it moves.
const pressureSinceStore = writable<number | null>(null);

function notePressure(pressure: string): void {
  if (pressure === "normal") return;
  pressureSinceMs = Date.now();
  pressureSinceStore.set(pressureSinceMs);
}

memoryPressure.subscribe(notePressure);

/// The gate's answer right now.
///
/// Recomputed whenever the config, the fleet, the machine sample or the
/// pressure memory move. `systemMemory` is an input rather than only a
/// value read inside, because it is also the CLOCK: the poller replaces
/// it every two to five seconds, which is what makes the hysteresis
/// countdown tick without a timer of its own.
export const launchGateVerdict: Readable<LaunchVerdict> = derived(
  [launchConfigStore, inFlightCount, memoryPressure, systemMemory, pressureSinceStore],
  ([config, inFlight, pressure, sample]) =>
    launchVerdict({
      config,
      inFlight,
      pressure,
      usedBytes: usedBytesOf(sample),
      totalBytes: sample?.supported ? sample.totalBytes : null,
      nowMs: Date.now(),
      pressureSinceMs,
    })
);

/// Whether the gate is holding, emitting ONLY when it flips.
///
/// The same shape and the same reason as `activePaused`: the verdict
/// rides a five-second poll, so a scheduler subscribed to it would run a
/// pass twelve times a minute for the life of the app. The deduped flag
/// emits exactly twice per hold -- once when starts stop, once when they
/// may resume, which is the second that matters.
export const launchHolding: Readable<boolean> = readable(false, (set) => {
  let last: boolean | null = null;
  return launchGateVerdict.subscribe((verdict) => {
    if (verdict.allowed === last) return;
    last = verdict.allowed;
    set(!verdict.allowed);
  });
});

/// Whether a launch may happen right now. The one question the
/// scheduler, the auto-resume gate and every action module ask.
export function mayLaunch(): boolean {
  return get(launchGateVerdict).allowed;
}

/// Why it may not, in one sentence. Null while starts are allowed.
export function launchBlockedReason(): string | null {
  return gateBlockedReason(get(launchGateVerdict));
}

/// What a press that started `count` agents in this workspace would
/// cost, ready for a confirm dialog.
///
/// Assembled here rather than in each dialog because every input is a
/// live store this module already holds -- and because three surfaces
/// computing the same projection three ways is the shape that drifts.
export function estimateFor(workspaceId: string | null, count: number): LaunchEstimate {
  const fleet = get(fleetMemory);
  return launchEstimate({
    count,
    profileId: workspaceId ? resolvedAgentFor(workspaceId).profileId || null : null,
    means: fleet.meanByProfile,
    storedMeans: get(storedMeans),
    // How many agents the mean was actually taken from, which is what
    // the line's provenance clause reports -- not the fleet's size.
    measuredAgents: Object.values(get(agentSessions)).filter((s) => s.rssBytes > 0).length,
    sample: get(systemMemory),
    maxInFlight: get(launchConfigStore).maxInFlight,
    inFlight: get(inFlightCount),
  });
}

/// The one line the sidebar footer and the app hub both draw: how many
/// agents are running against the ceiling, and how full the machine is.
///
/// A store rather than a call, because both surfaces are permanently
/// mounted and both have to move as the poller lands. Null while there
/// is nothing worth a row (see `fleetStrip`).
export const fleetStripLine: Readable<FleetStrip | null> = derived(
  [inFlightCount, launchConfigStore, systemMemory, memoryPressure],
  ([inFlight, config, sample, pressure]) =>
    fleetStrip({ inFlight, ceiling: config.maxInFlight, sample, pressure })
);

// ---- The intents ------------------------------------------------------------

/// Which launch a queued intent stands for. One entry per action module
/// that can start an agent, because re-running it means calling back
/// into that module.
export type LaunchIntentKind = "card" | "tool" | "review" | "commit" | "orchestration";

/// The card launches, in the vocabulary `cardRunActions` already uses.
export type CardLaunchMode = "run" | "resume" | "review" | "develop" | "relaunch";

interface IntentBase {
  /// Minted here, not by the caller: the queue has to be able to cancel
  /// exactly one entry, and two presses on one card are two intents.
  id: string;
  kind: LaunchIntentKind;
  workspaceId: string;
  /// What to call it in a queue row and in a tooltip.
  label: string;
  askedAtMs: number;
}

export interface CardIntent extends IntentBase {
  kind: "card";
  cardPath: string;
  mode: CardLaunchMode;
  /// Only an AUTOMATIC resume spends the persisted budget; a queued one
  /// has to carry that fact across the wait, or a held auto-resume would
  /// come back as a human's press and never count.
  automatic: boolean;
}

export interface ToolIntent extends IntentBase {
  kind: "tool";
  toolId: string;
  values: Record<string, string>;
}

/// The review dialog's request, flattened. Snapshotted rather than kept
/// as a store reference because the dialog closes the moment the launch
/// is queued -- and because this has to survive a reload.
export interface ReviewIntent extends IntentBase {
  kind: "review";
  cwd: string;
  base: string;
  rulesPath: string;
  contextFolder: string;
  plansFolder: string;
  card: ReviewedCard | null;
}

export interface CommitIntent extends IntentBase {
  kind: "commit";
  retries: number;
}

export interface OrchestrationIntent extends IntentBase {
  kind: "orchestration";
  /// The composed prompt. Carried rather than recomposed: it is a
  /// snapshot of the board at the moment the human asked, and rebuilding
  /// it after a wait would send the agent a different request from the
  /// one it was queued for.
  prompt: string;
  agentLabel: string;
  railId: string | null;
}

export type LaunchIntent =
  | CardIntent
  | ToolIntent
  | ReviewIntent
  | CommitIntent
  | OrchestrationIntent;

/// A new intent, before the queue stamps it.
export type NewLaunchIntent =
  | Omit<CardIntent, "id" | "askedAtMs">
  | Omit<ToolIntent, "id" | "askedAtMs">
  | Omit<ReviewIntent, "id" | "askedAtMs">
  | Omit<CommitIntent, "id" | "askedAtMs">
  | Omit<OrchestrationIntent, "id" | "askedAtMs">;

/// The queue, oldest first. Order is arrival order and nothing else: a
/// priority scheme would need a rule for what outranks what, and the
/// honest answer is that the human pressed these buttons in this order.
export const launchQueue = writable<LaunchIntent[]>([]);

/// Every queued intent for one card, so a board card can draw its mark.
export function queuedForCard(workspaceId: string, cardPath: string): CardIntent | null {
  return (
    get(launchQueue).find(
      (i): i is CardIntent =>
        i.kind === "card" && i.workspaceId === workspaceId && i.cardPath === cardPath
    ) ?? null
  );
}

/// How many intents one workspace is holding, for a header count.
export function queuedCount(workspaceId?: string): number {
  const all = get(launchQueue);
  return workspaceId ? all.filter((i) => i.workspaceId === workspaceId).length : all.length;
}

let nextId = 1;

function mint(intent: NewLaunchIntent): LaunchIntent {
  return {
    ...intent,
    id: `q${Date.now().toString(36)}-${nextId++}`,
    askedAtMs: Date.now(),
  } as LaunchIntent;
}

/// Whether this intent is already waiting.
///
/// Identity is the ACTION, not the object: pressing Run twice on one
/// card must not queue two launches of it, and neither must a rail tick
/// that re-emits. Compared on the fields that name what will happen,
/// which is why this is a switch and not a deep equality.
function sameIntent(a: LaunchIntent, b: NewLaunchIntent): boolean {
  if (a.kind !== b.kind || a.workspaceId !== b.workspaceId) return false;
  switch (b.kind) {
    case "card":
      return (a as CardIntent).cardPath === b.cardPath && (a as CardIntent).mode === b.mode;
    case "tool":
      return (a as ToolIntent).toolId === b.toolId;
    case "review":
      return (a as ReviewIntent).cwd === b.cwd && (a as ReviewIntent).base === b.base;
    case "commit":
      return true;
    case "orchestration":
      return (a as OrchestrationIntent).railId === b.railId;
  }
}

/// Puts an intent in the queue, unless the same one is already there.
/// Returns the intent that is waiting, either way.
export function enqueueLaunch(intent: NewLaunchIntent): LaunchIntent {
  const existing = get(launchQueue).find((i) => sameIntent(i, intent));
  if (existing) return existing;
  const minted = mint(intent);
  launchQueue.update((q) => [...q, minted]);
  persist();
  return minted;
}

/// Drops one intent. The Cancel entry on a queued card's menu, and what
/// a successful drain calls when its launch is away.
export function cancelLaunch(id: string): void {
  launchQueue.update((q) => q.filter((i) => i.id !== id));
  persist();
}

/// Drops every intent for one card -- what a card being run by hand, or
/// archived, or deleted should do to whatever was still waiting on it.
export function cancelCardLaunches(workspaceId: string, cardPath: string): void {
  launchQueue.update((q) =>
    q.filter((i) => !(i.kind === "card" && i.workspaceId === workspaceId && i.cardPath === cardPath))
  );
  persist();
}

// ---- The gate seam ----------------------------------------------------------

/// The one call every launch site makes.
///
/// Returns null when the launch may go ahead now, and the gate's
/// sentence when it was QUEUED instead -- which is not an error and must
/// never be shown as one. A caller that wants to tell the human
/// something says "Queued: <sentence>"; most of them say nothing,
/// because the badge on the card is the feedback.
export function holdOrQueue(intent: NewLaunchIntent): string | null {
  const verdict = get(launchGateVerdict);
  if (verdict.allowed) return null;
  enqueueLaunch(intent);
  return verdict.why;
}

// ---- Persistence ------------------------------------------------------------
//
// localStorage, per WINDOW, the way the orchestration conflicts box is
// per workspace: no daemon request, so no protocol bump and no compat
// gate. A reload keeps the queue because a reload is not a decision --
// the human asked for eleven runs and got four, and the other seven must
// not evaporate because the frontend restarted.

export function launchQueueKey(windowLabel = currentWindowLabel()): string {
  return `gavin.launchQueue.${windowLabel}`;
}

type MaybeStorage = Pick<Storage, "getItem" | "setItem" | "removeItem"> | undefined;

function defaultStorage(): MaybeStorage {
  return typeof localStorage === "undefined" ? undefined : localStorage;
}

/// A stored blob, with every entry checked.
///
/// Hand-edited or half-written state must read as "nothing queued"
/// rather than as an intent with an undefined kind, because the drain
/// would then call a launcher with no arguments. Anything that does not
/// look like an intent this build knows is dropped, entry by entry --
/// one bad row must not cost the other ten.
export function parseLaunchQueue(raw: string | null): LaunchIntent[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const kinds: LaunchIntentKind[] = ["card", "tool", "review", "commit", "orchestration"];
  return parsed.filter((entry): entry is LaunchIntent => {
    if (!entry || typeof entry !== "object") return false;
    const i = entry as Partial<LaunchIntent>;
    if (typeof i.id !== "string" || !i.id) return false;
    if (typeof i.workspaceId !== "string" || !i.workspaceId) return false;
    if (typeof i.label !== "string") return false;
    if (typeof i.askedAtMs !== "number" || !Number.isFinite(i.askedAtMs)) return false;
    if (!i.kind || !kinds.includes(i.kind)) return false;
    if (i.kind === "card") {
      const c = entry as CardIntent;
      return typeof c.cardPath === "string" && !!c.cardPath && typeof c.mode === "string";
    }
    if (i.kind === "tool") return typeof (entry as ToolIntent).toolId === "string";
    if (i.kind === "review") return typeof (entry as ReviewIntent).cwd === "string";
    if (i.kind === "orchestration") return typeof (entry as OrchestrationIntent).prompt === "string";
    return true;
  });
}

export function loadLaunchQueue(storage: MaybeStorage = defaultStorage()): LaunchIntent[] {
  try {
    return parseLaunchQueue(storage?.getItem(launchQueueKey()) ?? null);
  } catch {
    return [];
  }
}

export function saveLaunchQueue(
  queue: LaunchIntent[],
  storage: MaybeStorage = defaultStorage()
): void {
  try {
    if (queue.length === 0) storage?.removeItem(launchQueueKey());
    else storage?.setItem(launchQueueKey(), JSON.stringify(queue));
  } catch {
    // A full or disabled store costs the queue its memory across a
    // reload and nothing else. Never a launch.
  }
}

function persist(): void {
  saveLaunchQueue(get(launchQueue));
}

// ---- The drain --------------------------------------------------------------

/// When the last queued launch was released, and whether the sample has
/// caught up with it. Both feed `mayDrain`, which is where the pacing
/// rule actually lives.
let lastLaunchMs: number | null = null;
let lastLaunchSessions = 0;
/// One drain at a time. Releasing an intent is async -- it composes a
/// prompt, reads a file, spawns a session -- and a second pass entering
/// while the first is mid-await would release two against one slot.
let draining = false;
let timer: ReturnType<typeof setTimeout> | null = null;
let unsubscribes: Array<() => void> = [];

/// Whether a session started since the last release has turned up in the
/// memory sample.
///
/// Counted rather than identified: the drain does not know which session
/// id its launch produced (the action modules own that), and "the fleet
/// grew" is the fact it actually needs -- it is waiting for evidence
/// that the launch landed, not for a particular row.
function lastLaunchObserved(): boolean {
  return Object.keys(get(agentSessions)).length > lastLaunchSessions;
}

/// Runs one intent, by handing it back to the module that owns that kind
/// of launch.
///
/// Dynamically imported, every one of them: those modules import this
/// one (that is the whole point of `holdOrQueue`), so a static import
/// here would close a cycle. By the time a drain runs, the app is up and
/// the load is a cache hit.
async function execute(intent: LaunchIntent): Promise<void> {
  switch (intent.kind) {
    case "card": {
      const m = await import("$lib/cards/cardRunActions");
      await m.launchQueuedCard(intent);
      return;
    }
    case "tool": {
      const m = await import("$lib/workspaceToolsActions");
      await m.launchQueuedTool(intent);
      return;
    }
    case "review": {
      const m = await import("$lib/review/codeReviewActions");
      await m.launchQueuedReview(intent);
      return;
    }
    case "commit": {
      const m = await import("$lib/git/gitState");
      await m.launchQueuedCommit(intent);
      return;
    }
    case "orchestration": {
      const m = await import("$lib/orchestration/orchestrationState");
      await m.launchQueuedOrchestrationAgent(intent);
      return;
    }
  }
}

/// One pass: release at most ONE intent, then arm a re-check.
///
/// At most one because the gate's answer is about the fleet as it is
/// now, and every release changes that fleet. Draining two against one
/// reading is the burst this whole card exists to stop.
async function drain(): Promise<void> {
  if (draining) return;
  const queue = get(launchQueue);
  if (queue.length === 0) return;
  const verdict = get(launchGateVerdict);
  if (!mayDrain({ verdict, lastLaunchMs, nowMs: Date.now(), lastLaunchObserved: lastLaunchObserved() })) {
    // Not now, but the spacing expires on a clock nothing else ticks, so
    // the re-check has to be armed here.
    armRecheck();
    return;
  }
  const next = queue[0];
  draining = true;
  try {
    // Removed BEFORE it runs, not after. A launch that throws must not
    // sit at the head of the queue retrying for ever, and the action
    // modules already report their own failures where the human can see
    // them.
    cancelLaunch(next.id);
    lastLaunchMs = Date.now();
    lastLaunchSessions = Object.keys(get(agentSessions)).length;
    await execute(next);
  } catch {
    // A launcher that threw has already lost its own launch; the queue's
    // job is to keep going.
  } finally {
    draining = false;
  }
  armRecheck();
}

/// Re-checks after the spacing, because nothing else emits on that
/// clock. Cheap: one timer at a time, and only while the queue has
/// something in it.
function armRecheck(): void {
  if (timer) clearTimeout(timer);
  if (get(launchQueue).length === 0) return;
  timer = setTimeout(() => void drain(), DRAIN_SPACING_MS / 4);
}

/// Starts the queue. Module-level, like `startScheduler` and
/// `startPauseClock`, and for the sharpest version of that reason: a
/// queue that only drains while one tab is mounted is work that never
/// starts. Returns its own teardown.
export function startLaunchQueue(): () => void {
  stopLaunchQueue();
  void loadLaunchConfig();
  // MERGED, not replaced. Nothing enqueues before bootstrap in the app,
  // but a dev-server remount re-runs this with a live queue in the
  // store, and a restore that overwrote it would drop launches the human
  // is waiting on. Deduped by id, stored entries first, so the order
  // survives a reload.
  launchQueue.update((live) => {
    const stored = loadLaunchQueue();
    const seen = new Set(stored.map((i) => i.id));
    return [...stored, ...live.filter((i) => !seen.has(i.id))];
  });
  // `startBlockedReason` answers with the pause reason first and this
  // one second, so every surface keeps ONE sentence. Installed as a hook
  // rather than imported there, because `agentPauseState` must stay out
  // of this module's dependency cone.
  setGateReasonHook(launchBlockedReason);
  // The verdict covers the config, the fleet and the machine; the queue
  // itself covers an intent arriving while starts are already allowed.
  unsubscribes = [
    launchGateVerdict.subscribe(() => void drain()),
    launchQueue.subscribe(() => void drain()),
  ];
  return stopLaunchQueue;
}

export function stopLaunchQueue(): void {
  setGateReasonHook(null);
  for (const unsubscribe of unsubscribes) unsubscribe();
  unsubscribes = [];
  if (timer) clearTimeout(timer);
  timer = null;
}

/// Test-only reset, so one suite's queue cannot be another's.
export function __resetLaunchQueueForTesting(): void {
  stopLaunchQueue();
  draining = false;
  lastLaunchMs = null;
  lastLaunchSessions = 0;
  pressureSinceMs = null;
  pressureSinceStore.set(null);
  launchQueue.set([]);
  launchConfigStore.set(DEFAULT_LAUNCH);
}
