// Where a limit window is HEADING, as opposed to where it stands.
//
// `agentUsage.ts` answers "how full is this window" from one reading.
// That is the wrong question for the decision a human actually makes at
// 10am -- start the big rail, or throttle -- because a 5-hour window at
// 40% means "plenty" when nothing is running and "you have twenty
// minutes" when three agents are. The difference is not in the number,
// it is in how fast the number is moving, and a single probe cannot see
// motion at all.
//
// So this module keeps a short history per window and reads a burn rate
// off it, then races that rate against the window's own reset:
//
//   red     the window is projected to run dry BEFORE it resets
//   amber   it lands after the reset, but with little slack
//   green   it lands comfortably past the reset
//
// ## Why sampling cadence is per window, not per poller
//
// The poller reads every profile on one 3-minute clock. That clock is
// wrong for BOTH windows if it is also the sampling clock:
//
// - A 5-hour window moves ~20%/h at a full burn, so five minutes is a
//   real, readable step. Sampling it hourly would mean one usable
//   reading per window and no projection until it was too late to act.
// - A 7-day window moves ~0.6%/h at a full burn. Over five minutes that
//   is 0.05% -- entirely inside the endpoint's own rounding, so a rate
//   read off two 5-minute-apart samples is quantization noise amplified
//   by 12. Sampled every three hours and measured over a DAY, the same
//   window reports the rate that actually matters, and a day-long
//   baseline is what lets a quiet weekend count as quiet instead of
//   reading the Friday afternoon burst as the week's pace.
//
// Hence two classes, each with its own sample interval and its own rate
// baseline. Both numbers came off the card that asked for this.
//
// ## Why a gap in sampling is not a gap in knowledge
//
// `usedPercent` is CUMULATIVE inside one window epoch: the endpoint
// reports how much of this five hours, or this week, has been spent so
// far. Two samples therefore bracket everything consumed between them,
// however far apart they are and however long gavin was closed. A
// weekend with the app shut is not lost data -- it is one long interval
// with very little burn in it, which is exactly the thing the weekly
// projection must not miss.
//
// What DOES break the arithmetic is a reset, because the counter starts
// again. Three signals say one happened, and any of them starts a fresh
// epoch: the percentage went down, `resetsAt` moved, or the gap exceeded
// the window's own span (nothing can stay inside one epoch longer than
// the epoch lasts).

import {
  CRITICAL_PERCENT,
  WARN_PERCENT,
  formatDuration,
  type AgentUsageReport,
  type UsageWindow,
} from "$lib/agents/agentUsage";

// ---- Window classes ----------------------------------------------------------

/// How a window is sampled and measured. Two classes rather than a
/// per-id table of four numbers: the split is genuinely binary -- a
/// window you can burn through in an afternoon, and one you spend a week
/// against -- and every route's ids fall on one side or the other.
export interface WindowClass {
  /// Shortest gap between two stored samples.
  sampleIntervalMs: number;
  /// How far back the rate reaches. Older samples are pruned, except the
  /// single anchor that keeps a rate computable across a long gap.
  rateBaselineMs: number;
  /// The window's own length. A sampling gap longer than this cannot sit
  /// inside one epoch, so it is read as a reset gavin did not witness.
  spanMs: number;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export const SHORT_WINDOW: WindowClass = {
  sampleIntervalMs: 5 * MINUTE,
  rateBaselineMs: HOUR,
  spanMs: 5 * HOUR,
};

export const LONG_WINDOW: WindowClass = {
  sampleIntervalMs: 3 * HOUR,
  rateBaselineMs: 24 * HOUR,
  spanMs: 7 * 24 * HOUR,
};

/// Anthropic's ids first, codex's second. `spend_limit` is long because
/// it is billed over a month, not a session.
const CLASS_BY_ID: Record<string, WindowClass> = {
  five_hour: SHORT_WINDOW,
  primary: SHORT_WINDOW,
  seven_day: LONG_WINDOW,
  secondary: LONG_WINDOW,
  spend_limit: LONG_WINDOW,
};

/// An unrecognised window is sampled as a SHORT one. Not symmetric on
/// purpose: five-minute samples still produce a usable rate for a weekly
/// window (they just carry more noise into the first hour), while a
/// three-hour cadence inside a five-hour window yields at most one
/// sample per epoch and therefore no projection, ever. The failure that
/// is merely noisy beats the one that is silent.
export function windowClass(windowId: string): WindowClass {
  return CLASS_BY_ID[windowId] ?? SHORT_WINDOW;
}

// ---- The history -------------------------------------------------------------

/// One reading, kept.
export interface UsageSample {
  /// Epoch ms of the moment the reading was TRUE -- the report's
  /// `observedAt`, which for the codex route is the rollout event's own
  /// timestamp and can be hours behind the read. Sampling on read time
  /// would stamp a burst of stale readings as if they had all just
  /// happened, and invent a vertical rate out of one file.
  atMs: number;
  usedPercent: number;
}

/// The samples for one window of one profile, inside one epoch.
export interface WindowHistory {
  /// Oldest first.
  samples: UsageSample[];
  /// The `resetsAt` these samples belong to. A different value is a
  /// different epoch, so the samples are dropped rather than continued.
  resetsAt: number | null;
}

/// Every window of every profile: `history[profileId][windowId]`.
export type UsageHistory = Record<string, Record<string, WindowHistory>>;

/// Whether a new reading continues the stored epoch or starts a new one.
/// Split out because it is the whole correctness of the rate and each
/// clause is a case worth naming in a test.
export function isSameEpoch(
  stored: WindowHistory,
  window: UsageWindow,
  sample: UsageSample,
  cls: WindowClass
): boolean {
  if (stored.resetsAt !== window.resetsAt) return false;
  const newest = stored.samples[stored.samples.length - 1];
  if (!newest) return true;
  // A counter that went backwards has been reset under us. The tolerance
  // is for float noise in a route that reports fractions, not for a real
  // decline: inside one epoch these numbers only ever grow.
  if (sample.usedPercent < newest.usedPercent - 0.5) return false;
  return sample.atMs - newest.atMs <= cls.spanMs;
}

/// Drop what the rate can no longer reach, keeping ONE sample older than
/// the baseline.
///
/// That anchor is the point: without it, coming back to a workspace after
/// a weekend leaves a single sample and no rate at all, when the pair
/// spanning the weekend is the most informative reading the weekly window
/// will ever produce. With it, the baseline slides forward normally while
/// samples keep arriving and stretches over a gap when they do not.
export function pruneSamples(samples: UsageSample[], baselineMs: number): UsageSample[] {
  if (samples.length === 0) return samples;
  const boundary = samples[samples.length - 1].atMs - baselineMs;
  const inside = samples.filter((s) => s.atMs >= boundary);
  const older = samples.filter((s) => s.atMs < boundary);
  return older.length > 0 ? [older[older.length - 1], ...inside] : inside;
}

/// Fold one report into the history, returning a new object when
/// anything was stored and the SAME reference when nothing was.
///
/// Identity is the caller's signal: `refreshUsage` runs on a 3-minute
/// poll against a 5-minute cadence, so most calls store nothing, and a
/// store write plus a localStorage write per poll would be pure churn.
export function recordUsage(
  history: UsageHistory,
  profileId: string,
  report: AgentUsageReport
): UsageHistory {
  // Only a reading is a sample. An `unavailable` probe says nothing
  // about the burn, and writing a gap marker would make an outage look
  // like a pause in spending.
  if (report.state !== "ready") return history;
  const observedMs = report.observedAt * 1000;
  const forProfile = history[profileId] ?? {};
  let changed = false;
  const next: Record<string, WindowHistory> = { ...forProfile };

  for (const window of report.windows) {
    const cls = windowClass(window.id);
    const sample: UsageSample = { atMs: observedMs, usedPercent: window.usedPercent };
    const stored = forProfile[window.id];
    const newest = stored?.samples[stored.samples.length - 1];
    // A cached report replays the reading it already gave, and the codex
    // route can hand back an event older than one already stored.
    //
    // Dropped BEFORE the epoch test, not after: a stale event carries a
    // stale percentage, `isSameEpoch` reads a counter that went backwards
    // as a reset, and the history it was meant to extend is thrown away
    // and replaced by the stale sample alone.
    if (newest && sample.atMs <= newest.atMs) continue;
    if (!stored || !newest || !isSameEpoch(stored, window, sample, cls)) {
      next[window.id] = { samples: [sample], resetsAt: window.resetsAt };
      changed = true;
      continue;
    }
    if (sample.atMs - newest.atMs < cls.sampleIntervalMs) continue;
    next[window.id] = {
      resetsAt: window.resetsAt,
      samples: pruneSamples([...stored.samples, sample], cls.rateBaselineMs),
    };
    changed = true;
  }

  // Windows the route stopped reporting are dropped: the host removes a
  // window whose reset has passed, so keeping its samples would leave a
  // dead epoch projecting forever.
  for (const id of Object.keys(next)) {
    if (!report.windows.some((w) => w.id === id)) {
      delete next[id];
      changed = true;
    }
  }

  if (!changed) return history;
  return { ...history, [profileId]: next };
}

// ---- The rate ----------------------------------------------------------------

export interface BurnRate {
  /// Percentage points per hour. Never negative: a decline is a reset,
  /// which `isSameEpoch` has already caught, so anything left is noise.
  perHour: number;
  /// How far apart the two samples it was measured between are. The
  /// modal prints it, because a rate over 8 minutes and the same rate
  /// over 6 hours are not the same claim.
  spanMs: number;
  samples: number;
}

/// The burn between the oldest retained sample and the newest, or null
/// when there is not yet a full sampling interval between them.
///
/// First-to-last rather than a fit or a last-pair difference. The last
/// pair is what quantization ruins -- a weekly window that ticks one
/// whole point between two samples reads as a rate 12x the truth -- and a
/// regression buys nothing over the endpoints when the underlying series
/// is monotone and evenly spaced.
export function burnRate(history: WindowHistory | undefined, cls: WindowClass): BurnRate | null {
  const samples = history?.samples ?? [];
  if (samples.length < 2) return null;
  const first = samples[0];
  const last = samples[samples.length - 1];
  const spanMs = last.atMs - first.atMs;
  if (spanMs < cls.sampleIntervalMs) return null;
  const delta = Math.max(0, last.usedPercent - first.usedPercent);
  return { perHour: (delta / spanMs) * HOUR, spanMs, samples: samples.length };
}

// ---- The verdict -------------------------------------------------------------

/// The semaphore. Three answers, in the words the card asked for: stop,
/// throttle, carry on.
export type ProjectionBand = "over" | "tight" | "clear";

const BAND_RANK: Record<ProjectionBand, number> = { clear: 0, tight: 1, over: 2 };

/// The worse of two bands, with null meaning "this side has nothing to
/// say". Two nulls stay null: the semaphore is not drawn at all rather
/// than drawn green, because "gavin has no idea yet" and "you have room"
/// must never share a colour.
export function worseBand(
  a: ProjectionBand | null,
  b: ProjectionBand | null
): ProjectionBand | null {
  if (a === null) return b;
  if (b === null) return a;
  return BAND_RANK[a] >= BAND_RANK[b] ? a : b;
}

/// How far past the reset the projection must land to count as green,
/// as a fraction of the time left in the window.
///
/// A quarter, so "green" means the window survives a burn a quarter
/// heavier than the one measured. Tighter than that and an ordinary busy
/// hour flips the light; looser and nothing is ever green while work is
/// happening at all.
export const CLEAR_MARGIN = 0.25;

export type ProjectionStatus =
  /// The window is already at or past its ceiling. Answered before the
  /// rate, because at 100% the burn no longer decides anything: the
  /// window is spent until it resets whatever happens next.
  | "exhausted"
  /// Not enough samples yet for a rate.
  | "measuring"
  /// A rate, and it is zero: nothing is spending this window.
  | "flat"
  /// A rate, but the route never said when the window resets, so there
  /// is a runway and no finish line to race it against.
  | "no-reset"
  /// A rate and a reset: the projection is real.
  | "projected";

export interface UsageProjection {
  /// The profile id, never its display label: a projection is a fact
  /// about a window, and which agents are called what is the surface's
  /// business. Keeping the label out is also what stops this reaching
  /// the profile table, which `agentPauseState` would then have to
  /// import into the pause module's whole dependency graph.
  profileId: string;
  windowId: string;
  label: string;
  usedPercent: number;
  /// Epoch SECONDS, as the window carries it.
  resetsAt: number | null;
  ratePerHour: number | null;
  /// Epoch ms this window is projected to reach 100%, or null when it is
  /// not projected to (a flat burn) or cannot be (no rate yet).
  exhaustAtMs: number | null;
  /// `(exhaustAt - resetsAt) / (resetsAt - now)`: how much of the time
  /// left in the window is slack. Negative means the window runs dry
  /// first. Null without both a projection and a reset.
  marginRatio: number | null;
  /// What to draw, or null when there is nothing honest to draw.
  band: ProjectionBand | null;
  status: ProjectionStatus;
  /// The measurement behind the rate, for the sentence that qualifies it.
  spanMs: number;
  samples: number;
}

/// The band the LEVEL alone justifies, on the bands `agentUsage.ts`
/// already owns. `ok` maps to null rather than to green: being under
/// three quarters is not evidence of anything, and the projection is
/// what earns a green light.
function levelBand(usedPercent: number): ProjectionBand | null {
  if (!Number.isFinite(usedPercent)) return null;
  if (usedPercent >= CRITICAL_PERCENT) return "over";
  if (usedPercent >= WARN_PERCENT) return "tight";
  return null;
}

/// One window's projection.
///
/// The band is the worse of the trajectory and the LEVEL, and that
/// composition is the point rather than an afterthought. A window sitting
/// at 96% with nothing running projects "never runs out", which is true
/// and useless: the next agent started against it hits the wall in
/// minutes. A green light beside a red bar would be the panel
/// contradicting itself, so the level floors the light and the sentence
/// says which of the two is talking.
export function projectWindow(
  window: UsageWindow,
  history: WindowHistory | undefined,
  profileId: string,
  nowMs: number
): UsageProjection {
  const cls = windowClass(window.id);
  const rate = burnRate(history, cls);
  const level = levelBand(window.usedPercent);
  const base = {
    profileId,
    windowId: window.id,
    label: window.label,
    usedPercent: window.usedPercent,
    resetsAt: window.resetsAt,
    spanMs: rate?.spanMs ?? 0,
    samples: rate?.samples ?? history?.samples.length ?? 0,
  };

  // Nothing about a rate changes the answer once the window is full,
  // and "0%/h, projected to run out two hours ago" is what saying it
  // through the projection would produce.
  if (window.usedPercent >= 100) {
    return {
      ...base,
      ratePerHour: rate?.perHour ?? null,
      exhaustAtMs: nowMs,
      marginRatio: null,
      band: "over",
      status: "exhausted",
    };
  }

  if (!rate) {
    return {
      ...base,
      ratePerHour: null,
      exhaustAtMs: null,
      marginRatio: null,
      band: level,
      status: "measuring",
    };
  }

  const remaining = 100 - window.usedPercent;
  // A flat burn never exhausts the window, whatever is left in it.
  if (rate.perHour <= 0) {
    return {
      ...base,
      ratePerHour: 0,
      exhaustAtMs: null,
      marginRatio: null,
      band: worseBand("clear", level),
      status: "flat",
    };
  }

  const exhaustAtMs = nowMs + (remaining / rate.perHour) * HOUR;
  if (window.resetsAt == null) {
    return {
      ...base,
      ratePerHour: rate.perHour,
      exhaustAtMs,
      marginRatio: null,
      band: level,
      status: "no-reset",
    };
  }

  const resetsAtMs = window.resetsAt * 1000;
  const leftMs = resetsAtMs - nowMs;
  // A reset already behind us leaves nothing to race. The host drops
  // expired windows, so this is only reachable when the clock crossed
  // with the panel open, and the honest answer is the level's.
  if (leftMs <= 0) {
    return {
      ...base,
      ratePerHour: rate.perHour,
      exhaustAtMs,
      marginRatio: null,
      band: level,
      status: "no-reset",
    };
  }
  const marginRatio = (exhaustAtMs - resetsAtMs) / leftMs;
  const projected: ProjectionBand =
    marginRatio < 0 ? "over" : marginRatio < CLEAR_MARGIN ? "tight" : "clear";
  return {
    ...base,
    ratePerHour: rate.perHour,
    exhaustAtMs,
    marginRatio,
    band: worseBand(projected, level),
    status: "projected",
  };
}

export interface ProjectionInput {
  /// Profile ids some workspace actually runs, as `profilesInUse` gives
  /// them. Asking about an agent nobody here launches is a row that
  /// means nothing, exactly as it is in the usage panel.
  profileIds: string[];
  reports: Record<string, AgentUsageReport>;
  history: UsageHistory;
  nowMs: number;
}

/// Every window of every profile in use, in the order the routes list
/// them.
export function projectUsage(input: ProjectionInput): UsageProjection[] {
  const out: UsageProjection[] = [];
  for (const profileId of input.profileIds) {
    const report = input.reports[profileId];
    if (!report || report.state !== "ready") continue;
    for (const window of report.windows) {
      out.push(
        projectWindow(window, input.history[profileId]?.[window.id], profileId, input.nowMs)
      );
    }
  }
  return out;
}

/// The projection a single semaphore should show: the worst band, and
/// within a band the tightest margin.
///
/// Ties go to the smaller margin rather than to the first window,
/// because the two amber windows a human is looking at are rarely equally
/// close and the sidebar has room for exactly one sentence.
export function worstProjection(projections: UsageProjection[]): UsageProjection | null {
  let worst: UsageProjection | null = null;
  for (const p of projections) {
    if (p.band === null) continue;
    if (worst === null) {
      worst = p;
      continue;
    }
    const rank = BAND_RANK[p.band] - BAND_RANK[worst.band as ProjectionBand];
    if (rank > 0) {
      worst = p;
      continue;
    }
    if (rank < 0) continue;
    const a = p.marginRatio ?? Number.POSITIVE_INFINITY;
    const b = worst.marginRatio ?? Number.POSITIVE_INFINITY;
    if (a < b) worst = p;
  }
  return worst;
}

// ---- The words ---------------------------------------------------------------

/// A rate a human can read. One decimal under 10%/h, none above: the
/// difference between 2.3 and 2.8 points an hour decides whether a
/// weekly window holds, and the difference between 23 and 24 decides
/// nothing.
export function formatRate(perHour: number): string {
  if (!Number.isFinite(perHour) || perHour <= 0) return "0%/h";
  return perHour < 10 ? `${perHour.toFixed(1)}%/h` : `${Math.round(perHour)}%/h`;
}

/// The one sentence every surface prints about a projection, so the
/// sidebar's bubble and the modal's line cannot drift apart.
export function projectionSentence(p: UsageProjection, nowMs: number): string {
  const cls = windowClass(p.windowId);
  switch (p.status) {
    case "exhausted":
      return "already at its ceiling — nothing more will run against it until it resets";
    case "measuring":
      return p.samples === 0
        ? "no reading yet — the projection needs two samples"
        : `measuring — the next sample is due within ${formatDuration(
            cls.sampleIntervalMs / 1000
          )}`;
    case "flat":
      return `nothing is spending this window (measured over ${formatDuration(
        p.spanMs / 1000
      )})`;
    case "no-reset": {
      const runway = p.exhaustAtMs == null ? null : (p.exhaustAtMs - nowMs) / 1000;
      const head = `${formatRate(p.ratePerHour ?? 0)} — about ${formatDuration(
        runway ?? 0
      )} of room left`;
      return `${head}, but this route never says when the window resets`;
    }
    default: {
      const resetsAtMs = (p.resetsAt ?? 0) * 1000;
      const gap = Math.abs((p.exhaustAtMs ?? 0) - resetsAtMs) / 1000;
      const rate = formatRate(p.ratePerHour ?? 0);
      if (p.band === "over" || (p.marginRatio ?? 0) < 0) {
        return `${rate} — projected to run out about ${formatDuration(gap)} before it resets`;
      }
      if ((p.marginRatio ?? 0) < CLEAR_MARGIN) {
        return `${rate} — projected to last only about ${formatDuration(
          gap
        )} past its reset`;
      }
      return `${rate} — projected to last about ${formatDuration(gap)} past its reset`;
    }
  }
}

/// The sidebar's bubble: which agent, which window, and the sentence.
/// The agent's display name is passed in rather than carried on the
/// projection -- see `UsageProjection.profileId`.
export function projectionTooltip(
  p: UsageProjection,
  profileLabel: string,
  nowMs: number
): string {
  return `${profileLabel} · ${p.label} ${Math.floor(p.usedPercent)}% — ${projectionSentence(
    p,
    nowMs
  )}`;
}

// ---- Persistence -------------------------------------------------------------
//
// localStorage, where the sidebar's expansion and the hub's tab
// preferences already live. No daemon request, so no protocol bump and
// no compat gate -- and nothing outside this window needs the samples.
//
// Persisting at all is not a nicety here: a weekly window's first rate
// costs three hours of uptime, and a feature that starts that clock again
// on every reload would never once show a weekly projection.

export const USAGE_HISTORY_KEY = "gavin.usageHistory";

/// Injected (defaulting to the browser's) for the same reason every
/// other preference module injects it: vitest's node environment has no
/// localStorage, and an SSR pass has none either.
type MaybeStorage = Pick<Storage, "getItem" | "setItem" | "removeItem"> | undefined;

function defaultStorage(): MaybeStorage {
  return typeof localStorage === "undefined" ? undefined : localStorage;
}

/// A stored blob, with every field checked. Hand-edited or half-written
/// history must read as "no history" rather than crash the sidebar, and
/// a NaN sample would poison a rate silently.
export function parseUsageHistory(raw: string | null): UsageHistory {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const out: UsageHistory = {};
  for (const [profileId, windows] of Object.entries(parsed as Record<string, unknown>)) {
    if (!windows || typeof windows !== "object" || Array.isArray(windows)) continue;
    const kept: Record<string, WindowHistory> = {};
    for (const [windowId, value] of Object.entries(windows as Record<string, unknown>)) {
      const record = value as Partial<WindowHistory> | null;
      if (!record || !Array.isArray(record.samples)) continue;
      const samples = record.samples
        .filter(
          (s): s is UsageSample =>
            !!s &&
            typeof s === "object" &&
            Number.isFinite((s as UsageSample).atMs) &&
            Number.isFinite((s as UsageSample).usedPercent)
        )
        .map((s) => ({ atMs: s.atMs, usedPercent: s.usedPercent }))
        .sort((a, b) => a.atMs - b.atMs);
      if (samples.length === 0) continue;
      const resetsAt =
        typeof record.resetsAt === "number" && Number.isFinite(record.resetsAt)
          ? record.resetsAt
          : null;
      kept[windowId] = {
        samples: pruneSamples(samples, windowClass(windowId).rateBaselineMs),
        resetsAt,
      };
    }
    if (Object.keys(kept).length > 0) out[profileId] = kept;
  }
  return out;
}

export function loadUsageHistory(storage: MaybeStorage = defaultStorage()): UsageHistory {
  try {
    return parseUsageHistory(storage?.getItem(USAGE_HISTORY_KEY) ?? null);
  } catch {
    return {};
  }
}

export function saveUsageHistory(
  history: UsageHistory,
  storage: MaybeStorage = defaultStorage()
): void {
  try {
    if (Object.keys(history).length === 0) storage?.removeItem(USAGE_HISTORY_KEY);
    else storage?.setItem(USAGE_HISTORY_KEY, JSON.stringify(history));
  } catch {
    // A full or disabled store costs the projection its memory across a
    // reload and nothing else. Never the sidebar.
  }
}
